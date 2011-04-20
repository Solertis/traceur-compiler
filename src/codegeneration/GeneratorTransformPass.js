// Copyright 2011 Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the 'License');
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

traceur.define('codegeneration', function() {
  'use strict';

  var ParseTreeVisitor = traceur.syntax.ParseTreeVisitor;
  var FunctionDeclarationTree = traceur.syntax.trees.FunctionDeclarationTree;
  var GetAccessorTree = traceur.syntax.trees.GetAccessorTree;
  var SetAccessorTree = traceur.syntax.trees.SetAccessorTree;

  var ParseTreeTransformer = traceur.codegeneration.ParseTreeTransformer;
  var ForEachTransformer = traceur.codegeneration.ForEachTransformer;

  var ForInTransformPass = traceur.codegeneration.generator.ForInTransformPass;
  var GeneratorTransformer = traceur.codegeneration.generator.GeneratorTransformer;
  var AsyncTransformer = traceur.codegeneration.generator.AsyncTransformer;

  var createForEachStatement = traceur.codegeneration.ParseTreeFactory.createForEachStatement;
  var createVariableDeclarationList = traceur.codegeneration.ParseTreeFactory.createVariableDeclarationList;
  var createYieldStatement = traceur.codegeneration.ParseTreeFactory.createYieldStatement;
  var createIdentifierExpression = traceur.codegeneration.ParseTreeFactory.createIdentifierExpression;

  var TokenType = traceur.syntax.TokenType;

  /**
   * Can tell you if function body contains a yield statement. Does not search into
   * nested functions.
   * @param {ParseTree} tree
   * @extends {ParseTreeVisitor}
   * @constructor
   */
  function YieldFinder(tree) {
    this.visitAny(tree);
  }

  YieldFinder.prototype = {
    __proto__: ParseTreeVisitor.prototype,

    hasYield: false,
    hasYieldFor: false,
    hasForIn: false,
    hasAsync: false,

    /** @return {boolean} */
    hasAnyGenerator: function() {
      return this.hasYield || this.hasAsync;
    },

    /** @param {YieldStatementTree} tree */
    visitYieldStatementTree: function(tree) {
      this.hasYield = true;
      this.hasYieldFor = tree.isYieldFor;
    },

    /** @param {AwaitStatementTree} tree */
    visitAwaitStatementTree: function(tree) {
      this.hasAsync = true;
    },

    /** @param {ForInStatementTree} tree */
    visitForInStatementTree: function(tree) {
      this.hasForIn = true;
      ParseTreeVisitor.prototype.visitForInStatementTree.call(this, tree);
    },

    // don't visit function children or bodies
    visitFunctionDeclarationTree: function(tree) {},
    visitSetAccessorTree: function(tree) {},
    visitGetAccessorTree: function(tree) {}
  };

  /**
   * This transformer turns "yield for E" into a ForEach that
   * contains a yield and is lowered by the ForEachTransformer.
   */
  function YieldForTransformer(identifierGenerator) {
    ParseTreeTransformer.call(this);
    this.identifierGenerator_ = identifierGenerator;
  }

  YieldForTransformer.transformTree = function(identifierGenerator, tree) {
    return new YieldForTransformer(identifierGenerator).transformAny(tree);
  };

  YieldForTransformer.prototype = {
    __proto__: ParseTreeTransformer.prototype,

    transformYieldStatementTree: function(tree) {
      if (tree.isYieldFor) {
        // yield for E
        //   becomes
        // for (var $TEMP : E) { yield $TEMP; }

        var id = createIdentifierExpression(this.identifierGenerator_.generateUniqueIdentifier());

        var forEach = createForEachStatement(
            createVariableDeclarationList(
                TokenType.VAR,
                id,
                null // initializer
            ),
            tree.expression,
            createYieldStatement(id, false /* isYieldFor */));

        var result = ForEachTransformer.transformTree(
            this.identifierGenerator_,
            forEach);

        return result;
      }

      return tree;
    }
  };

  /**
   * This pass just finds function bodies with yields in them and passes them off to
   * the GeneratorTransformer for the heavy lifting.
   * @param {UniqueIdentifierGenerator} identifierGenerator
   * @param {ErrorReporter} reporter
   * @extends {ParseTreeTransformer}
   * @constructor
   */
  function GeneratorTransformPass(identifierGenerator, reporter) {
    ParseTreeTransformer.call(this);
    this.identifierGenerator_ = identifierGenerator;
    this.reporter_ = reporter;
  }

  GeneratorTransformPass.transformTree = function(identifierGenerator, reporter,
      tree) {
    return new GeneratorTransformPass(identifierGenerator, reporter).transformAny(tree);
  }

  GeneratorTransformPass.prototype = {
    __proto__: ParseTreeTransformer.prototype,

    /**
     * @param {FunctionDeclarationTree} tree
     * @return {ParseTree}
     */
    transformFunctionDeclarationTree: function(tree) {
      var body = this.transformBody_(tree.functionBody);
      if (body == tree.functionBody) {
        return tree;
      }
      return new FunctionDeclarationTree(
          null,
          tree.name,
          tree.isStatic,
          tree.formalParameterList,
          body);
    },

    /**
     * @param {BlockTree} tree
     * @return {BlockTree}
     */
    transformBody_: function(tree) {
      var finder = new YieldFinder(tree);

      // transform nested functions
      var body = ParseTreeTransformer.prototype.transformBlockTree.call(this, tree).asBlock();

      if (!finder.hasAnyGenerator()) {
        return body;
      }

      // We need to transform for-in loops because the object key iteration cannot be interrupted.
      if (finder.hasForIn) {
        body = ForInTransformPass.transformTree(this.identifierGenerator_, body).asBlock();
      }

      if (finder.hasYieldFor) {
        body = YieldForTransformer.transformTree(this.identifierGenerator_, body).asBlock();
      }

      var transformed;
      if (finder.hasYield) {
        transformed = GeneratorTransformer.transformGeneratorBody(this.reporter_, body);
      } else {
        transformed = AsyncTransformer.transformAsyncBody(this.reporter_, body);
      }
      return transformed;
    },

    /**
     * @param {GetAccessorTree} tree
     * @return {ParseTree}
     */
    transformGetAccessorTree: function(tree) {
      var body = this.transformBody_(tree.body);
      if (body == tree.body) {
        return tree;
      }
      return new GetAccessorTree(
          null,
          tree.propertyName,
          tree.isStatic,
          body);
    },

    /**
     * @param {SetAccessorTree} tree
     * @return {ParseTree}
     */
    transformSetAccessorTree: function(tree) {
      var body = this.transformBody_(tree.body);
      if (body == tree.body) {
        return tree;
      }
      return new SetAccessorTree(
          null,
          tree.propertyName,
          tree.isStatic,
          tree.parameter,
          body);
    }
  };

  return {
    GeneratorTransformPass: GeneratorTransformPass
  };
});
