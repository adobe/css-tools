import {
  CssAllNodesAST,
  CssCharsetAST,
  CssCommentAST,
  CssCommonPositionAST,
  CssContainerAST,
  CssCustomMediaAST,
  CssDeclarationAST,
  CssDocumentAST,
  CssFontFaceAST,
  CssHostAST,
  CssImportAST,
  CssKeyframeAST,
  CssKeyframesAST,
  CssLayerAST,
  CssMediaAST,
  CssNamespaceAST,
  CssPageAST,
  CssRuleAST,
  CssStartingStyleAST,
  CssStylesheetAST,
  CssSupportsAST,
  CssTypes,
} from '../type';

export type CompilerOptions = {
  indent?: string;
  compress?: boolean;
};

class Compiler {
  level = 0;
  indentation = '  ';
  compress = false;

  constructor(options?: CompilerOptions) {
    if (typeof options?.indent === 'string') {
      this.indentation = options?.indent;
    }
    if (options?.compress) {
      this.compress = true;
    }
  }

  // We disable no-unused-vars for _position. We keep position for potential reintroduction of source-map
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  emit(str: string, _position?: CssCommonPositionAST['position']) {
    return str;
  }

  /**
   * Increase, decrease or return current indentation.
   */
  indent(level?: number) {
    this.level = this.level || 1;

    if (level) {
      this.level += level;
      return '';
    }

    return Array(this.level).join(this.indentation);
  }

  visit(node: CssAllNodesAST): string {
    switch (node.type) {
      case CssTypes.stylesheet:
        return this.stylesheet(node);
      case CssTypes.rule:
        return this.rule(node);
      case CssTypes.declaration:
        return this.declaration(node);
      case CssTypes.comment:
        return this.comment(node);
      case CssTypes.container:
        return this.container(node);
      case CssTypes.charset:
        return this.charset(node);
      case CssTypes.document:
        return this.document(node);
      case CssTypes.customMedia:
        return this.customMedia(node);
      case CssTypes.fontFace:
        return this.fontFace(node);
      case CssTypes.host:
        return this.host(node);
      case CssTypes.import:
        return this.import(node);
      case CssTypes.keyframes:
        return this.keyframes(node);
      case CssTypes.keyframe:
        return this.keyframe(node);
      case CssTypes.layer:
        return this.layer(node);
      case CssTypes.media:
        return this.media(node);
      case CssTypes.namespace:
        return this.namespace(node);
      case CssTypes.page:
        return this.page(node);
      case CssTypes.startingStyle:
        return this.startingStyle(node);
      case CssTypes.supports:
        return this.supports(node);
    }
  }

  mapVisit(nodes: Array<CssAllNodesAST>, delim?: string) {
    let buf = '';
    delim = delim || '';

    for (let i = 0, length = nodes.length; i < length; i++) {
      buf += this.visit(nodes[i]);
      if (delim && i < length - 1) {
        buf += this.emit(delim);
      }
    }

    return buf;
  }

  compile(node: CssStylesheetAST) {
    if (this.compress) {
      return node.stylesheet.rules.map(this.visit, this).join('');
    }

    return this.stylesheet(node);
  }

  /**
   * Visit stylesheet node.
   */
  stylesheet(node: CssStylesheetAST) {
    return this.mapVisit(node.stylesheet.rules, '\n\n');
  }

  /**
   * Visit comment node.
   */
  comment(node: CssCommentAST) {
    if (this.compress) {
      return this.emit('', node.position);
    }
    return this.emit(this.indent() + '/*' + node.comment + '*/', node.position);
  }

  /**
   * Visit container node.
   */
  container(node: CssContainerAST) {
    if (this.compress) {
      return (
        this.emit('@container ' + node.container, node.position) +
        this.emit('{') +
        this.mapVisit(node.rules) +
        this.emit('}')
      );
    }
    return (
      this.emit(this.indent() + '@container ' + node.container, node.position) +
      this.emit(' {\n' + this.indent(1)) +
      this.mapVisit(node.rules, '\n\n') +
      this.emit('\n' + this.indent(-1) + this.indent() + '}')
    );
  }

  /**
   * Visit container node.
   */
  layer(node: CssLayerAST) {
    if (this.compress) {
      return (
        this.emit('@layer ' + node.layer, node.position) +
        (node.rules
          ? this.emit('{') +
            this.mapVisit(<CssAllNodesAST[]>node.rules) +
            this.emit('}')
          : ';')
      );
    }
    return (
      this.emit(this.indent() + '@layer ' + node.layer, node.position) +
      (node.rules
        ? this.emit(' {\n' + this.indent(1)) +
          this.mapVisit(<CssAllNodesAST[]>node.rules, '\n\n') +
          this.emit('\n' + this.indent(-1) + this.indent() + '}')
        : ';')
    );
  }

  /**
   * Visit import node.
   */
  import(node: CssImportAST) {
    return this.emit('@import ' + node.import + ';', node.position);
  }

  /**
   * Visit media node.
   */
  media(node: CssMediaAST) {
    if (this.compress) {
      return (
        this.emit('@media ' + node.media, node.position) +
        this.emit('{') +
        this.mapVisit(node.rules) +
        this.emit('}')
      );
    }
    return (
      this.emit(this.indent() + '@media ' + node.media, node.position) +
      this.emit(' {\n' + this.indent(1)) +
      this.mapVisit(node.rules, '\n\n') +
      this.emit('\n' + this.indent(-1) + this.indent() + '}')
    );
  }

  /**
   * Visit document node.
   */
  document(node: CssDocumentAST) {
    const doc = '@' + (node.vendor || '') + 'document ' + node.document;
    if (this.compress) {
      return (
        this.emit(doc, node.position) +
        this.emit('{') +
        this.mapVisit(node.rules) +
        this.emit('}')
      );
    }
    return (
      this.emit(doc, node.position) +
      this.emit(' ' + ' {\n' + this.indent(1)) +
      this.mapVisit(node.rules, '\n\n') +
      this.emit(this.indent(-1) + '\n}')
    );
  }

  /**
   * Visit charset node.
   */
  charset(node: CssCharsetAST) {
    return this.emit('@charset ' + node.charset + ';', node.position);
  }

  /**
   * Visit namespace node.
   */
  namespace(node: CssNamespaceAST) {
    return this.emit('@namespace ' + node.namespace + ';', node.position);
  }

  /**
   * Visit container node.
   */
  startingStyle(node: CssStartingStyleAST) {
    if (this.compress) {
      return (
        this.emit('@starting-style', node.position) +
        this.emit('{') +
        this.mapVisit(node.rules) +
        this.emit('}')
      );
    }
    return (
      this.emit(this.indent() + '@starting-style', node.position) +
      this.emit(' {\n' + this.indent(1)) +
      this.mapVisit(node.rules, '\n\n') +
      this.emit('\n' + this.indent(-1) + this.indent() + '}')
    );
  }

  /**
   * Visit supports node.
   */
  supports(node: CssSupportsAST) {
    if (this.compress) {
      return (
        this.emit('@supports ' + node.supports, node.position) +
        this.emit('{') +
        this.mapVisit(node.rules) +
        this.emit('}')
      );
    }
    return (
      this.emit(this.indent() + '@supports ' + node.supports, node.position) +
      this.emit(' {\n' + this.indent(1)) +
      this.mapVisit(node.rules, '\n\n') +
      this.emit('\n' + this.indent(-1) + this.indent() + '}')
    );
  }

  /**
   * Visit keyframes node.
   */
  keyframes(node: CssKeyframesAST) {
    if (this.compress) {
      return (
        this.emit(
          '@' + (node.vendor || '') + 'keyframes ' + node.name,
          node.position,
        ) +
        this.emit('{') +
        this.mapVisit(node.keyframes) +
        this.emit('}')
      );
    }
    return (
      this.emit(
        '@' + (node.vendor || '') + 'keyframes ' + node.name,
        node.position,
      ) +
      this.emit(' {\n' + this.indent(1)) +
      this.mapVisit(node.keyframes, '\n') +
      this.emit(this.indent(-1) + '}')
    );
  }

  /**
   * Visit keyframe node.
   */
  keyframe(node: CssKeyframeAST) {
    const decls = node.declarations;
    if (this.compress) {
      return (
        this.emit(node.values.join(','), node.position) +
        this.emit('{') +
        this.mapVisit(decls) +
        this.emit('}')
      );
    }

    return (
      this.emit(this.indent()) +
      this.emit(node.values.join(', '), node.position) +
      this.emit(' {\n' + this.indent(1)) +
      this.mapVisit(decls, '\n') +
      this.emit(this.indent(-1) + '\n' + this.indent() + '}\n')
    );
  }

  /**
   * Visit page node.
   */
  page(node: CssPageAST) {
    if (this.compress) {
      const sel = node.selectors.length ? node.selectors.join(', ') : '';

      return (
        this.emit('@page ' + sel, node.position) +
        this.emit('{') +
        this.mapVisit(node.declarations) +
        this.emit('}')
      );
    }
    const sel = node.selectors.length ? node.selectors.join(', ') + ' ' : '';

    return (
      this.emit('@page ' + sel, node.position) +
      this.emit('{\n') +
      this.emit(this.indent(1)) +
      this.mapVisit(node.declarations, '\n') +
      this.emit(this.indent(-1)) +
      this.emit('\n}')
    );
  }

  /**
   * Visit font-face node.
   */
  fontFace(node: CssFontFaceAST) {
    if (this.compress) {
      return (
        this.emit('@font-face', node.position) +
        this.emit('{') +
        this.mapVisit(node.declarations) +
        this.emit('}')
      );
    }
    return (
      this.emit('@font-face ', node.position) +
      this.emit('{\n') +
      this.emit(this.indent(1)) +
      this.mapVisit(node.declarations, '\n') +
      this.emit(this.indent(-1)) +
      this.emit('\n}')
    );
  }

  /**
   * Visit host node.
   */
  host(node: CssHostAST) {
    if (this.compress) {
      return (
        this.emit('@host', node.position) +
        this.emit('{') +
        this.mapVisit(node.rules) +
        this.emit('}')
      );
    }
    return (
      this.emit('@host', node.position) +
      this.emit(' {\n' + this.indent(1)) +
      this.mapVisit(node.rules, '\n\n') +
      this.emit(this.indent(-1) + '\n}')
    );
  }

  /**
   * Visit custom-media node.
   */
  customMedia(node: CssCustomMediaAST) {
    return this.emit(
      '@custom-media ' + node.name + ' ' + node.media + ';',
      node.position,
    );
  }

  /**
   * Visit rule node.
   */
  rule(node: CssRuleAST) {
    const decls = node.declarations;
    if (!decls.length) {
      return '';
    }

    if (this.compress) {
      return (
        this.emit(node.selectors.join(','), node.position) +
        this.emit('{') +
        this.mapVisit(decls) +
        this.emit('}')
      );
    }
    const indent = this.indent();

    return (
      this.emit(
        node.selectors
          .map(s => {
            return indent + s;
          })
          .join(',\n'),
        node.position,
      ) +
      this.emit(' {\n') +
      this.emit(this.indent(1)) +
      this.mapVisit(decls, '\n') +
      this.emit(this.indent(-1)) +
      this.emit('\n' + this.indent() + '}')
    );
  }

  /**
   * Visit declaration node.
   */
  declaration(node: CssDeclarationAST) {
    if (this.compress) {
      return (
        this.emit(node.property + ':' + node.value, node.position) +
        this.emit(';')
      );
    }
    if (node.property === 'grid-template-areas')
      return (
        this.emit(this.indent()) +
        this.emit(
          node.property +
            ': ' +
            node.value.split('\n').join('\n'.padEnd(22) + this.indent()),
          node.position,
        ) +
        this.emit(';')
      );
    return (
      this.emit(this.indent()) +
      this.emit(node.property + ': ' + node.value, node.position) +
      this.emit(';')
    );
  }
}

export default Compiler;
