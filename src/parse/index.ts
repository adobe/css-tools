import CssParseError from '../CssParseError';
import Position from '../CssPosition';
import {
  type CssAtRuleAST,
  type CssCharsetAST,
  type CssCommentAST,
  type CssCommonPositionAST,
  type CssContainerAST,
  type CssCustomMediaAST,
  type CssDeclarationAST,
  type CssDocumentAST,
  type CssFontFaceAST,
  type CssHostAST,
  type CssImportAST,
  type CssKeyframeAST,
  type CssKeyframesAST,
  type CssLayerAST,
  type CssMediaAST,
  type CssNamespaceAST,
  type CssPageAST,
  type CssRuleAST,
  type CssStartingStyleAST,
  type CssStylesheetAST,
  type CssSupportsAST,
  CssTypes,
} from '../type';
import {
  indexOfArrayWithBracketAndQuoteSupport,
  splitWithBracketAndQuoteSupport,
} from '../utils/stringSearch';

// http://www.w3.org/TR/CSS21/grammar.html
// https://github.com/visionmedia/css-parse/pull/49#issuecomment-30088027
// New rule => https://www.w3.org/TR/CSS22/syndata.html#comments
// [^] is equivalent to [.\n\r]
const commentRegex = /\/\*[^]*?(?:\*\/|$)/g;

export const parse = (
  css: string,
  options?: { source?: string; silent?: boolean },
): CssStylesheetAST => {
  options = options || {};

  /**
   * Positional.
   */
  let lineno = 1;
  let column = 1;

  /**
   * Update lineno and column based on `str`.
   */
  function updatePosition(str: string) {
    const lines = str.match(/\n/g);
    if (lines) {
      lineno += lines.length;
    }
    const i = str.lastIndexOf('\n');
    column = ~i ? str.length - i : column + str.length;
  }

  /**
   * Mark position and patch `node.position`.
   */
  function position() {
    const start = { line: lineno, column: column };
    return <T1 extends CssCommonPositionAST>(
      node: Omit<T1, 'position'>,
    ): T1 => {
      (node as T1).position = new Position(
        start,
        { line: lineno, column: column },
        options?.source || '',
      );
      whitespace();
      return node as T1;
    };
  }

  /**
   * Error `msg`.
   */
  const errorsList: Array<CssParseError> = [];

  function error(msg: string): undefined {
    const err = new CssParseError(
      options?.source || '',
      msg,
      lineno,
      column,
      css,
    );

    if (options?.silent) {
      errorsList.push(err);
    } else {
      throw err;
    }
  }

  /**
   * Parse stylesheet.
   */
  function stylesheet(): CssStylesheetAST {
    const rulesList = rules();

    const result: CssStylesheetAST = {
      type: CssTypes.stylesheet,
      stylesheet: {
        source: options?.source,
        rules: rulesList,
        parsingErrors: errorsList,
      },
    };

    return result;
  }

  /**
   * Opening brace.
   */
  function open(): boolean {
    const openMatch = /^{\s*/.exec(css);
    if (openMatch) {
      processMatch(openMatch);
      return true;
    }
    return false;
  }

  /**
   * Closing brace.
   */
  function close() {
    const closeMatch = /^}/.exec(css);
    if (closeMatch) {
      processMatch(closeMatch);
      return true;
    }
    return false;
  }

  /**
   * Parse ruleset.
   */
  function rules() {
    let node: CssRuleAST | CssAtRuleAST | undefined;
    const rules: Array<CssRuleAST | CssAtRuleAST> = [];
    whitespace();
    comments(rules);
    while (css.length && css.charAt(0) !== '}') {
      node = atRule() || rule();
      if (node) {
        rules.push(node);
        comments(rules);
      } else {
        break;
      }
    }
    return rules;
  }

  /**
   * Update position and css string. Return the matches
   */
  function processMatch(m: RegExpExecArray) {
    const str = m[0];
    updatePosition(str);
    css = css.slice(str.length);
    return m;
  }

  /**
   * Parse whitespace.
   */
  function whitespace() {
    const m = /^\s*/.exec(css);
    if (m) {
      processMatch(m);
    }
  }

  /**
   * Parse comments;
   */
  function comments<T1 extends CssCommonPositionAST>(
    rules?: Array<T1 | CssCommentAST>,
  ) {
    rules = rules || [];
    let c: CssCommentAST | undefined = comment();
    while (c) {
      rules.push(c);
      c = comment();
    }
    return rules;
  }

  /**
   * Parse comment.
   */
  function comment(): CssCommentAST | undefined {
    const pos = position();
    if ('/' !== css.charAt(0) || '*' !== css.charAt(1)) {
      return;
    }

    const m = /^\/\*[^]*?\*\//.exec(css);
    if (!m) {
      return error('End of comment missing');
    }
    processMatch(m);

    return pos<CssCommentAST>({
      type: CssTypes.comment,
      comment: m[0].slice(2, -2),
    });
  }

  /**
   * Parse selector.
   */
  function selector() {
    const m = /^([^{]+)/.exec(css);
    if (!m) {
      return;
    }
    processMatch(m);

    // remove comment in selector;
    const res = trim(m[0]).replace(commentRegex, '');

    return splitWithBracketAndQuoteSupport(res, [',']).map((v) => trim(v));
  }

  /**
   * Parse declaration.
   */
  function declaration(): CssDeclarationAST | undefined {
    const pos = position();

    // prop
    const propMatch = /^(\*?[-#/*\\\w]+(\[[0-9a-z_-]+\])?)\s*/.exec(css);
    if (!propMatch) {
      return;
    }
    processMatch(propMatch);
    const propValue = trim(propMatch[0]);

    // :
    const separatorMatch = /^:\s*/.exec(css);
    if (!separatorMatch) {
      return error("property missing ':'");
    }
    processMatch(separatorMatch);

    // val
    let value = '';
    const endValuePosition = indexOfArrayWithBracketAndQuoteSupport(css, [
      ';',
      '}',
    ]);
    if (endValuePosition !== -1) {
      value = css.substring(0, endValuePosition);
      const fakeMatch = [value] as unknown as RegExpExecArray;
      processMatch(fakeMatch);

      value = trim(value).replace(commentRegex, '');
    }

    const ret = pos<CssDeclarationAST>({
      type: CssTypes.declaration,
      property: propValue.replace(commentRegex, ''),
      value: value,
    });

    // ;
    const endMatch = /^[;\s]*/.exec(css);
    if (endMatch) {
      processMatch(endMatch);
    }

    return ret;
  }

  /**
   * Parse declarations.
   */
  function declarations() {
    const decls: Array<CssDeclarationAST | CssCommentAST> = [];

    if (!open()) {
      return error("missing '{'");
    }
    comments(decls);

    // declarations
    let decl: CssDeclarationAST | undefined = declaration();
    while (decl) {
      decls.push(decl);
      comments(decls);
      decl = declaration();
    }

    if (!close()) {
      return error("missing '}'");
    }
    return decls;
  }

  /**
   * Parse keyframe.
   */
  function keyframe() {
    const vals = [];
    const pos = position();

    let m: RegExpExecArray | null = /^((\d+\.\d+|\.\d+|\d+)%?|[a-z]+)\s*/.exec(
      css,
    );
    while (m) {
      const res = processMatch(m);
      vals.push(res[1]);
      const spacesMatch = /^,\s*/.exec(css);
      if (spacesMatch) {
        processMatch(spacesMatch);
      }
      m = /^((\d+\.\d+|\.\d+|\d+)%?|[a-z]+)\s*/.exec(css);
    }

    if (!vals.length) {
      return;
    }

    return pos<CssKeyframeAST>({
      type: CssTypes.keyframe,
      values: vals,
      declarations: declarations() || [],
    });
  }

  /**
   * Parse keyframes.
   */
  function atKeyframes(): CssKeyframesAST | undefined {
    const pos = position();
    const m1 = /^@([-\w]+)?keyframes\s*/.exec(css);

    if (!m1) {
      return;
    }
    const vendor = processMatch(m1)[1];

    // identifier
    const m2 = /^([-\w]+)\s*/.exec(css);
    if (!m2) {
      return error('@keyframes missing name');
    }
    const name = processMatch(m2)[1];

    if (!open()) {
      return error("@keyframes missing '{'");
    }

    let frames: Array<CssKeyframeAST | CssCommentAST> = comments();
    let frame: CssKeyframeAST | undefined = keyframe();
    while (frame) {
      frames.push(frame);
      frames = frames.concat(comments());
      frame = keyframe();
    }

    if (!close()) {
      return error("@keyframes missing '}'");
    }

    return pos<CssKeyframesAST>({
      type: CssTypes.keyframes,
      name: name,
      vendor: vendor,
      keyframes: frames,
    });
  }

  /**
   * Parse supports.
   */
  function atSupports(): CssSupportsAST | undefined {
    const pos = position();
    const m = /^@supports *([^{]+)/.exec(css);

    if (!m) {
      return;
    }
    const supports = trim(processMatch(m)[1]);

    if (!open()) {
      return error("@supports missing '{'");
    }

    const style = comments<CssAtRuleAST>().concat(rules());

    if (!close()) {
      return error("@supports missing '}'");
    }

    return pos<CssSupportsAST>({
      type: CssTypes.supports,
      supports: supports,
      rules: style,
    });
  }

  /**
   * Parse host.
   */
  function atHost() {
    const pos = position();
    const m = /^@host\s*/.exec(css);

    if (!m) {
      return;
    }
    processMatch(m);

    if (!open()) {
      return error("@host missing '{'");
    }

    const style = comments<CssAtRuleAST>().concat(rules());

    if (!close()) {
      return error("@host missing '}'");
    }

    return pos<CssHostAST>({
      type: CssTypes.host,
      rules: style,
    });
  }

  /**
   * Parse container.
   */
  function atContainer(): CssContainerAST | undefined {
    const pos = position();
    const m = /^@container *([^{]+)/.exec(css);

    if (!m) {
      return;
    }
    const container = trim(processMatch(m)[1]);

    if (!open()) {
      return error("@container missing '{'");
    }

    const style = comments<CssAtRuleAST>().concat(rules());

    if (!close()) {
      return error("@container missing '}'");
    }

    return pos<CssContainerAST>({
      type: CssTypes.container,
      container: container,
      rules: style,
    });
  }

  /**
   * Parse container.
   */
  function atLayer(): CssLayerAST | undefined {
    const pos = position();
    const m = /^@layer *([^{;@]+)/.exec(css);

    if (!m) {
      return;
    }
    const layer = trim(processMatch(m)[1]);

    if (!open()) {
      const m2 = /^[;\s]*/.exec(css);
      if (m2) {
        processMatch(m2);
      }
      return pos<CssLayerAST>({
        type: CssTypes.layer,
        layer: layer,
      });
    }

    const style = comments<CssAtRuleAST>().concat(rules());

    if (!close()) {
      return error("@layer missing '}'");
    }

    return pos<CssLayerAST>({
      type: CssTypes.layer,
      layer: layer,
      rules: style,
    });
  }

  /**
   * Parse media.
   */
  function atMedia(): CssMediaAST | undefined {
    const pos = position();
    const m = /^@media *([^{]+)/.exec(css);

    if (!m) {
      return;
    }
    const media = trim(processMatch(m)[1]);

    if (!open()) {
      return error("@media missing '{'");
    }

    const style = comments<CssAtRuleAST>().concat(rules());

    if (!close()) {
      return error("@media missing '}'");
    }

    return pos<CssMediaAST>({
      type: CssTypes.media,
      media: media,
      rules: style,
    });
  }

  /**
   * Parse custom-media.
   */
  function atCustomMedia(): CssCustomMediaAST | undefined {
    const pos = position();
    const m = /^@custom-media\s+(--\S+)\s+([^{;\s][^{;]*);/.exec(css);
    if (!m) {
      return;
    }
    const res = processMatch(m);

    return pos<CssCustomMediaAST>({
      type: CssTypes.customMedia,
      name: trim(res[1]),
      media: trim(res[2]),
    });
  }

  /**
   * Parse paged media.
   */
  function atPage(): CssPageAST | undefined {
    const pos = position();
    const m = /^@page */.exec(css);
    if (!m) {
      return;
    }
    processMatch(m);

    const sel = selector() || [];

    if (!open()) {
      return error("@page missing '{'");
    }
    let decls = comments<CssDeclarationAST>();

    // declarations
    let decl: CssDeclarationAST | undefined = declaration();
    while (decl) {
      decls.push(decl);
      decls = decls.concat(comments());
      decl = declaration();
    }

    if (!close()) {
      return error("@page missing '}'");
    }

    return pos<CssPageAST>({
      type: CssTypes.page,
      selectors: sel,
      declarations: decls,
    });
  }

  /**
   * Parse document.
   */
  function atDocument(): CssDocumentAST | undefined {
    const pos = position();
    const m = /^@([-\w]+)?document *([^{]+)/.exec(css);
    if (!m) {
      return;
    }
    const res = processMatch(m);

    const vendor = trim(res[1]);
    const doc = trim(res[2]);

    if (!open()) {
      return error("@document missing '{'");
    }

    const style = comments<CssAtRuleAST>().concat(rules());

    if (!close()) {
      return error("@document missing '}'");
    }

    return pos<CssDocumentAST>({
      type: CssTypes.document,
      document: doc,
      vendor: vendor,
      rules: style,
    });
  }

  /**
   * Parse font-face.
   */
  function atFontFace(): CssFontFaceAST | undefined {
    const pos = position();
    const m = /^@font-face\s*/.exec(css);
    if (!m) {
      return;
    }
    processMatch(m);

    if (!open()) {
      return error("@font-face missing '{'");
    }
    let decls = comments<CssDeclarationAST>();

    // declarations
    let decl: CssDeclarationAST | undefined = declaration();
    while (decl) {
      decls.push(decl);
      decls = decls.concat(comments());
      decl = declaration();
    }

    if (!close()) {
      return error("@font-face missing '}'");
    }

    return pos<CssFontFaceAST>({
      type: CssTypes.fontFace,
      declarations: decls,
    });
  }

  /**
   * Parse starting style.
   */
  function atStartingStyle(): CssStartingStyleAST | undefined {
    const pos = position();
    const m = /^@starting-style\s*/.exec(css);
    if (!m) {
      return;
    }
    processMatch(m);

    if (!open()) {
      return error("@starting-style missing '{'");
    }
    const style = comments<CssAtRuleAST>().concat(rules());

    if (!close()) {
      return error("@starting-style missing '}'");
    }

    return pos<CssStartingStyleAST>({
      type: CssTypes.startingStyle,
      rules: style,
    });
  }

  /**
   * Parse import
   */
  const atImport = _compileAtRule<CssImportAST>('import');

  /**
   * Parse charset
   */
  const atCharset = _compileAtRule<CssCharsetAST>('charset');

  /**
   * Parse namespace
   */
  const atNamespace = _compileAtRule<CssNamespaceAST>('namespace');

  /**
   * Parse non-block at-rules
   */
  function _compileAtRule<T1 extends CssCommonPositionAST>(
    name: string,
  ): () => T1 | undefined {
    const re = new RegExp(
      '^@' +
        name +
        '\\s*((?::?[^;\'"]|"(?:\\\\"|[^"])*?"|\'(?:\\\\\'|[^\'])*?\')+)(?:;|$)',
    );

    // ^@import\s*([^;"']|("|')(?:\\\2|.)*?\2)+(;|$)

    return (): T1 | undefined => {
      const pos = position();
      const m = re.exec(css);
      if (!m) {
        return;
      }
      const res = processMatch(m);
      const ret: Record<string, string> = { type: name };
      ret[name] = res[1].trim();
      return pos<T1>(ret as unknown as T1) as T1;
    };
  }

  /**
   * Parse at rule.
   */
  function atRule(): CssAtRuleAST | undefined {
    if (css[0] !== '@') {
      return;
    }

    return (
      atKeyframes() ||
      atMedia() ||
      atCustomMedia() ||
      atSupports() ||
      atImport() ||
      atCharset() ||
      atNamespace() ||
      atDocument() ||
      atPage() ||
      atHost() ||
      atFontFace() ||
      atContainer() ||
      atStartingStyle() ||
      atLayer()
    );
  }

  /**
   * Parse rule.
   */
  function rule() {
    const pos = position();
    const sel = selector();

    if (!sel) {
      return error('selector missing');
    }
    comments();

    return pos<CssRuleAST>({
      type: CssTypes.rule,
      selectors: sel,
      declarations: declarations() || [],
    });
  }

  return addParent(stylesheet());
};

/**
 * Trim `str`.
 */
function trim(str: string) {
  return str ? str.trim() : '';
}

/**
 * Adds non-enumerable parent node reference to each node.
 */
function addParent<T1 extends { type?: string }>(
  obj: T1,
  parent?: unknown,
): T1 {
  const isNode = obj && typeof obj.type === 'string';
  const childParent = isNode ? obj : parent;

  for (const k in obj) {
    const value = obj[k];
    if (Array.isArray(value)) {
      value.forEach((v) => {
        addParent(v, childParent);
      });
    } else if (value && typeof value === 'object') {
      addParent(value, childParent);
    }
  }

  if (isNode) {
    Object.defineProperty(obj, 'parent', {
      configurable: true,
      writable: true,
      enumerable: false,
      value: parent || null,
    });
  }

  return obj;
}

export default parse;
