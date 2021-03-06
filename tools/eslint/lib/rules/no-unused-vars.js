/**
 * @fileoverview Rule to flag declared but unused variables
 * @author Ilya Volodin
 */

"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

var lodash = require("lodash");
var astUtils = require("../ast-utils");

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

module.exports = {
    meta: {
        docs: {
            description: "disallow unused variables",
            category: "Variables",
            recommended: true
        },

        schema: [
            {
                oneOf: [
                    {
                        enum: ["all", "local"]
                    },
                    {
                        type: "object",
                        properties: {
                            vars: {
                                enum: ["all", "local"]
                            },
                            varsIgnorePattern: {
                                type: "string"
                            },
                            args: {
                                enum: ["all", "after-used", "none"]
                            },
                            argsIgnorePattern: {
                                type: "string"
                            },
                            caughtErrors: {
                                enum: ["all", "none"]
                            },
                            caughtErrorsIgnorePattern: {
                                type: "string"
                            }
                        }
                    }
                ]
            }
        ]
    },

    create: function(context) {

        var MESSAGE = "'{{name}}' is defined but never used";

        var config = {
            vars: "all",
            args: "after-used",
            caughtErrors: "none"
        };

        var firstOption = context.options[0];

        if (firstOption) {
            if (typeof firstOption === "string") {
                config.vars = firstOption;
            } else {
                config.vars = firstOption.vars || config.vars;
                config.args = firstOption.args || config.args;
                config.caughtErrors = firstOption.caughtErrors || config.caughtErrors;

                if (firstOption.varsIgnorePattern) {
                    config.varsIgnorePattern = new RegExp(firstOption.varsIgnorePattern);
                }

                if (firstOption.argsIgnorePattern) {
                    config.argsIgnorePattern = new RegExp(firstOption.argsIgnorePattern);
                }

                if (firstOption.caughtErrorsIgnorePattern) {
                    config.caughtErrorsIgnorePattern = new RegExp(firstOption.caughtErrorsIgnorePattern);
                }
            }
        }

        //--------------------------------------------------------------------------
        // Helpers
        //--------------------------------------------------------------------------

        var STATEMENT_TYPE = /(?:Statement|Declaration)$/;

        /**
         * Determines if a given variable is being exported from a module.
         * @param {Variable} variable - EScope variable object.
         * @returns {boolean} True if the variable is exported, false if not.
         * @private
         */
        function isExported(variable) {

            var definition = variable.defs[0];

            if (definition) {

                var node = definition.node;

                if (node.type === "VariableDeclarator") {
                    node = node.parent;
                } else if (definition.type === "Parameter") {
                    return false;
                }

                return node.parent.type.indexOf("Export") === 0;
            } else {
                return false;
            }
        }

        /**
         * Determines if a reference is a read operation.
         * @param {Reference} ref - An escope Reference
         * @returns {boolean} whether the given reference represents a read operation
         * @private
         */
        function isReadRef(ref) {
            return ref.isRead();
        }

        /**
         * Determine if an identifier is referencing an enclosing function name.
         * @param {Reference} ref - The reference to check.
         * @param {ASTNode[]} nodes - The candidate function nodes.
         * @returns {boolean} True if it's a self-reference, false if not.
         * @private
         */
        function isSelfReference(ref, nodes) {
            var scope = ref.from;

            while (scope) {
                if (nodes.indexOf(scope.block) >= 0) {
                    return true;
                }

                scope = scope.upper;
            }

            return false;
        }

        /**
         * Checks the position of given nodes.
         *
         * @param {ASTNode} inner - A node which is expected as inside.
         * @param {ASTNode} outer - A node which is expected as outside.
         * @returns {boolean} `true` if the `inner` node exists in the `outer` node.
         */
        function isInside(inner, outer) {
            return (
                inner.range[0] >= outer.range[0] &&
                inner.range[1] <= outer.range[1]
            );
        }

        /**
         * If a given reference is left-hand side of an assignment, this gets
         * the right-hand side node of the assignment.
         *
         * @param {escope.Reference} ref - A reference to check.
         * @param {ASTNode} prevRhsNode - The previous RHS node.
         * @returns {ASTNode} The RHS node.
         */
        function getRhsNode(ref, prevRhsNode) {
            var id = ref.identifier;
            var parent = id.parent;
            var granpa = parent.parent;
            var refScope = ref.from.variableScope;
            var varScope = ref.resolved.scope.variableScope;
            var canBeUsedLater = refScope !== varScope;

            /*
             * Inherits the previous node if this reference is in the node.
             * This is for `a = a + a`-like code.
             */
            if (prevRhsNode && isInside(id, prevRhsNode)) {
                return prevRhsNode;
            }

            if (parent.type === "AssignmentExpression" &&
                granpa.type === "ExpressionStatement" &&
                id === parent.left &&
                !canBeUsedLater
            ) {
                return parent.right;
            }
            return null;
        }

        /**
         * Checks whether a given function node is stored to somewhere or not.
         * If the function node is stored, the function can be used later.
         *
         * @param {ASTNode} funcNode - A function node to check.
         * @param {ASTNode} rhsNode - The RHS node of the previous assignment.
         * @returns {boolean} `true` if under the following conditions:
         *      - the funcNode is assigned to a variable.
         *      - the funcNode is bound as an argument of a function call.
         *      - the function is bound to a property and the object satisfies above conditions.
         */
        function isStorableFunction(funcNode, rhsNode) {
            var node = funcNode;
            var parent = funcNode.parent;

            while (parent && isInside(parent, rhsNode)) {
                switch (parent.type) {
                    case "SequenceExpression":
                        if (parent.expressions[parent.expressions.length - 1] !== node) {
                            return false;
                        }
                        break;

                    case "CallExpression":
                    case "NewExpression":
                        return parent.callee !== node;

                    case "AssignmentExpression":
                    case "TaggedTemplateExpression":
                    case "YieldExpression":
                        return true;

                    default:
                        if (STATEMENT_TYPE.test(parent.type)) {

                            /*
                             * If it encountered statements, this is a complex pattern.
                             * Since analyzeing complex patterns is hard, this returns `true` to avoid false positive.
                             */
                            return true;
                        }
                }

                node = parent;
                parent = parent.parent;
            }

            return false;
        }

        /**
         * Checks whether a given Identifier node exists inside of a function node which can be used later.
         *
         * "can be used later" means:
         * - the function is assigned to a variable.
         * - the function is bound to a property and the object can be used later.
         * - the function is bound as an argument of a function call.
         *
         * If a reference exists in a function which can be used later, the reference is read when the function is called.
         *
         * @param {ASTNode} id - An Identifier node to check.
         * @param {ASTNode} rhsNode - The RHS node of the previous assignment.
         * @returns {boolean} `true` if the `id` node exists inside of a function node which can be used later.
         */
        function isInsideOfStorableFunction(id, rhsNode) {
            var funcNode = astUtils.getUpperFunction(id);

            return (
                funcNode &&
                isInside(funcNode, rhsNode) &&
                isStorableFunction(funcNode, rhsNode)
            );
        }

        /**
         * Checks whether a given reference is a read to update itself or not.
         *
         * @param {escope.Reference} ref - A reference to check.
         * @param {ASTNode} rhsNode - The RHS node of the previous assignment.
         * @returns {boolean} The reference is a read to update itself.
         */
        function isReadForItself(ref, rhsNode) {
            var id = ref.identifier;
            var parent = id.parent;
            var granpa = parent.parent;

            return ref.isRead() && (

                // self update. e.g. `a += 1`, `a++`
                (
                    parent.type === "AssignmentExpression" &&
                    granpa.type === "ExpressionStatement" &&
                    parent.left === id
                ) ||
                (
                    parent.type === "UpdateExpression" &&
                    granpa.type === "ExpressionStatement"
                ) ||

                // in RHS of an assignment for itself. e.g. `a = a + 1`
                (
                    rhsNode &&
                    isInside(id, rhsNode) &&
                    !isInsideOfStorableFunction(id, rhsNode)
                )
            );
        }

        /**
         * Determine if an identifier is used either in for-in loops.
         *
         * @param {Reference} ref - The reference to check.
         * @returns {boolean} whether reference is used in the for-in loops
         * @private
         */
        function isForInRef(ref) {
            var target = ref.identifier.parent;


            // "for (var ...) { return; }"
            if (target.type === "VariableDeclarator") {
                target = target.parent.parent;
            }

            if (target.type !== "ForInStatement") {
                return false;
            }

            // "for (...) { return; }"
            if (target.body.type === "BlockStatement") {
                target = target.body.body[0];

            // "for (...) return;"
            } else {
                target = target.body;
            }

            // For empty loop body
            if (!target) {
                return false;
            }

            return target.type === "ReturnStatement";
        }

        /**
         * Determines if the variable is used.
         * @param {Variable} variable - The variable to check.
         * @returns {boolean} True if the variable is used
         * @private
         */
        function isUsedVariable(variable) {
            var functionNodes = variable.defs.filter(function(def) {
                    return def.type === "FunctionName";
                }).map(function(def) {
                    return def.node;
                }),
                isFunctionDefinition = functionNodes.length > 0,
                rhsNode = null;

            return variable.references.some(function(ref) {
                if (isForInRef(ref)) {
                    return true;
                }

                var forItself = isReadForItself(ref, rhsNode);

                rhsNode = getRhsNode(ref, rhsNode);

                return (
                    isReadRef(ref) &&
                    !forItself &&
                    !(isFunctionDefinition && isSelfReference(ref, functionNodes))
                );
            });
        }

        /**
         * Gets an array of variables without read references.
         * @param {Scope} scope - an escope Scope object.
         * @param {Variable[]} unusedVars - an array that saving result.
         * @returns {Variable[]} unused variables of the scope and descendant scopes.
         * @private
         */
        function collectUnusedVariables(scope, unusedVars) {
            var variables = scope.variables;
            var childScopes = scope.childScopes;
            var i, l;

            if (scope.type !== "TDZ" && (scope.type !== "global" || config.vars === "all")) {
                for (i = 0, l = variables.length; i < l; ++i) {
                    var variable = variables[i];

                    // skip a variable of class itself name in the class scope
                    if (scope.type === "class" && scope.block.id === variable.identifiers[0]) {
                        continue;
                    }

                    // skip function expression names and variables marked with markVariableAsUsed()
                    if (scope.functionExpressionScope || variable.eslintUsed) {
                        continue;
                    }

                    // skip implicit "arguments" variable
                    if (scope.type === "function" && variable.name === "arguments" && variable.identifiers.length === 0) {
                        continue;
                    }

                    // explicit global variables don't have definitions.
                    var def = variable.defs[0];

                    if (def) {
                        var type = def.type;

                        // skip catch variables
                        if (type === "CatchClause") {
                            if (config.caughtErrors === "none") {
                                continue;
                            }

                            // skip ignored parameters
                            if (config.caughtErrorsIgnorePattern && config.caughtErrorsIgnorePattern.test(def.name.name)) {
                                continue;
                            }
                        }

                        if (type === "Parameter") {

                            // skip any setter argument
                            if (def.node.parent.type === "Property" && def.node.parent.kind === "set") {
                                continue;
                            }

                            // if "args" option is "none", skip any parameter
                            if (config.args === "none") {
                                continue;
                            }

                            // skip ignored parameters
                            if (config.argsIgnorePattern && config.argsIgnorePattern.test(def.name.name)) {
                                continue;
                            }

                            // if "args" option is "after-used", skip all but the last parameter
                            if (config.args === "after-used" && def.index < def.node.params.length - 1) {
                                continue;
                            }
                        } else {

                            // skip ignored variables
                            if (config.varsIgnorePattern && config.varsIgnorePattern.test(def.name.name)) {
                                continue;
                            }
                        }
                    }

                    if (!isUsedVariable(variable) && !isExported(variable)) {
                        unusedVars.push(variable);
                    }
                }
            }

            for (i = 0, l = childScopes.length; i < l; ++i) {
                collectUnusedVariables(childScopes[i], unusedVars);
            }

            return unusedVars;
        }

        /**
         * Gets the index of a given variable name in a given comment.
         * @param {escope.Variable} variable - A variable to get.
         * @param {ASTNode} comment - A comment node which includes the variable name.
         * @returns {number} The index of the variable name's location.
         * @private
         */
        function getColumnInComment(variable, comment) {
            var namePattern = new RegExp("[\\s,]" + lodash.escapeRegExp(variable.name) + "(?:$|[\\s,:])", "g");

            // To ignore the first text "global".
            namePattern.lastIndex = comment.value.indexOf("global") + 6;

            // Search a given variable name.
            var match = namePattern.exec(comment.value);

            return match ? match.index + 1 : 0;
        }

        /**
         * Creates the correct location of a given variables.
         * The location is at its name string in a `/*global` comment.
         *
         * @param {escope.Variable} variable - A variable to get its location.
         * @returns {{line: number, column: number}} The location object for the variable.
         * @private
         */
        function getLocation(variable) {
            var comment = variable.eslintExplicitGlobalComment;
            var baseLoc = comment.loc.start;
            var column = getColumnInComment(variable, comment);
            var prefix = comment.value.slice(0, column);
            var lineInComment = (prefix.match(/\n/g) || []).length;

            if (lineInComment > 0) {
                column -= 1 + prefix.lastIndexOf("\n");
            } else {

                // 2 is for `/*`
                column += baseLoc.column + 2;
            }

            return {
                line: baseLoc.line + lineInComment,
                column: column
            };
        }

        //--------------------------------------------------------------------------
        // Public
        //--------------------------------------------------------------------------

        return {
            "Program:exit": function(programNode) {
                var unusedVars = collectUnusedVariables(context.getScope(), []);

                for (var i = 0, l = unusedVars.length; i < l; ++i) {
                    var unusedVar = unusedVars[i];

                    if (unusedVar.eslintExplicitGlobal) {
                        context.report({
                            node: programNode,
                            loc: getLocation(unusedVar),
                            message: MESSAGE,
                            data: unusedVar
                        });
                    } else if (unusedVar.defs.length > 0) {
                        context.report({
                            node: unusedVar.identifiers[0],
                            message: MESSAGE,
                            data: unusedVar
                        });
                    }
                }
            }
        };

    }
};
