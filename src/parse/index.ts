import postcss from 'postcss';
import safeParser from 'postcss-safe-parser';
import CssParseError from '../CssParseError';
import Position from '../CssPosition';
import {
  type CssAtRuleAST,
  type CssCharsetAST,
  type CssCommentAST,
  type CssContainerAST,
  type CssCounterStyleAST,
  type CssCustomMediaAST,
  type CssDeclarationAST,
  type CssDocumentAST,
  type CssFontFaceAST,
  type CssFontFeatureValuesAST,
  type CssGenericAtRuleAST,
  type CssHostAST,
  type CssImportAST,
  type CssKeyframeAST,
  type CssKeyframesAST,
  type CssLayerAST,
  type CssMediaAST,
  type CssNamespaceAST,
  type CssPageAST,
  type CssPageMarginBoxAST,
  type CssPositionTryAST,
  type CssPropertyAST,
  type CssRuleAST,
  type CssScopeAST,
  type CssStartingStyleAST,
  type CssStylesheetAST,
  type CssSupportsAST,
  CssTypes,
  type CssViewTransitionAST,
} from '../type';
import { splitWithBracketAndQuoteSupport } from '../utils/stringSearch';

const commentRegex = /\/\*[^]*?(?:\*\/|$)/g;

function trim(str: string): string {
  return str ? str.trim() : '';
}

// Returns true if the CSS contains any unclosed block comment.
// Closed comment: /* ... */. Unclosed: /* ... <eof>
function hasUnclosedComment(css: string): boolean {
  const re = /\/\*[^]*?(?:\*\/|$)/g;
  let match: RegExpExecArray | null;
  match = re.exec(css);
  while (match !== null) {
    if (!match[0].endsWith('*/')) return true;
    match = re.exec(css);
  }
  return false;
}

// Splits CSS into top-level rule/at-rule/statement segments for error detection.
// Handles string literals and comments to avoid false boundaries.
function splitTopLevelSegments(css: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;

  while (i < css.length) {
    const ch = css[i];

    // Skip string literals
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < css.length && css[i] !== quote) {
        if (css[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }

    // Skip block comments
    if (ch === '/' && i + 1 < css.length && css[i + 1] === '*') {
      i += 2;
      while (i < css.length && !(css[i - 1] === '*' && css[i] === '/')) i++;
      i++;
      continue;
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          segments.push(css.slice(start, i + 1));
          start = i + 1;
        }
      } else {
        // Orphan close brace
        const before = css.slice(start, i);
        if (before.trim()) segments.push(before);
        segments.push('}');
        start = i + 1;
      }
    } else if (ch === ';' && depth === 0) {
      segments.push(css.slice(start, i + 1));
      start = i + 1;
    }

    i++;
  }

  const tail = css.slice(start);
  if (tail.trim()) segments.push(tail);

  return segments;
}

// Collect parse errors in silent mode by strict-parsing each top-level segment.
function collectSilentErrors(css: string, sourceName: string): CssParseError[] {
  const errors: CssParseError[] = [];
  for (const segment of splitTopLevelSegments(css)) {
    if (!segment.trim()) continue;
    try {
      postcss.parse(segment);
    } catch (e) {
      if (e instanceof postcss.CssSyntaxError) {
        errors.push(
          new CssParseError(
            sourceName,
            e.reason,
            e.line ?? 1,
            e.column ?? 1,
            css,
          ),
        );
      }
    }
  }
  return errors;
}

// PostCSS end is inclusive (last char); css-tools end is exclusive (past last char).
function convertPos(
  source: postcss.Source | undefined,
  sourceName: string,
): Position | undefined {
  if (!source) return undefined;
  return new Position(
    { line: source.start.line, column: source.start.column },
    { line: source.end.line, column: source.end.column + 1 },
    sourceName,
  );
}

function convertSelectors(selectorStr: string): string[] {
  const cleaned = trim(selectorStr).replace(commentRegex, '');
  return splitWithBracketAndQuoteSupport(cleaned, [',']).map((v) => trim(v));
}

function convertComment(
  node: postcss.Comment,
  sourceName: string,
): CssCommentAST {
  const raws = node.raws as { left?: string; right?: string };
  return {
    type: CssTypes.comment,
    comment: (raws.left ?? '') + node.text + (raws.right ?? ''),
    position: convertPos(node.source, sourceName),
  };
}

function convertDeclaration(
  node: postcss.Declaration,
  sourceName: string,
): CssDeclarationAST {
  // PostCSS stores !important separately; reconstruct full value string
  const important = node.important
    ? typeof (node.raws as Record<string, unknown>)?.important === 'string'
      ? ((node.raws as Record<string, unknown>).important as string)
      : ' !important'
    : '';
  // PostCSS moves the IE6 star hack (*property) into raws.before — restore it.
  const rawsBefore =
    ((node.raws as Record<string, unknown>).before as string) ?? '';
  const starPrefix = rawsBefore.endsWith('*') ? '*' : '';
  return {
    type: CssTypes.declaration,
    property: starPrefix + node.prop,
    value: node.value + important,
    position: convertPos(node.source, sourceName),
  };
}

function convertRule(node: postcss.Rule, sourceName: string): CssRuleAST {
  const selectors = convertSelectors(node.selector);
  const declarations: Array<CssDeclarationAST | CssCommentAST | CssAtRuleAST> =
    [];

  for (const child of node.nodes ?? []) {
    const converted = convertChildNode(child, sourceName);
    if (converted)
      declarations.push(
        converted as CssDeclarationAST | CssCommentAST | CssAtRuleAST,
      );
  }

  return {
    type: CssTypes.rule,
    selectors,
    declarations,
    position: convertPos(node.source, sourceName),
  };
}

function convertKeyframe(
  node: postcss.Rule,
  sourceName: string,
): CssKeyframeAST {
  const values = node.selector.split(',').map((v) => trim(v));
  const declarations: Array<CssDeclarationAST | CssCommentAST> = [];

  for (const child of node.nodes ?? []) {
    if (child.type === 'decl') {
      declarations.push(
        convertDeclaration(child as postcss.Declaration, sourceName),
      );
    } else if (child.type === 'comment') {
      declarations.push(convertComment(child as postcss.Comment, sourceName));
    }
  }

  return {
    type: CssTypes.keyframe,
    values,
    declarations,
    position: convertPos(node.source, sourceName),
  };
}

const PAGE_MARGIN_BOX_NAMES = new Set([
  'top-left-corner',
  'top-left',
  'top-center',
  'top-right',
  'top-right-corner',
  'bottom-left-corner',
  'bottom-left',
  'bottom-center',
  'bottom-right',
  'bottom-right-corner',
  'left-top',
  'left-middle',
  'left-bottom',
  'right-top',
  'right-middle',
  'right-bottom',
]);

function convertKeyframes(
  node: postcss.AtRule,
  nameLower: string,
  params: string,
  sourceName: string,
): CssKeyframesAST {
  const vendorMatch = /^([-\w]+)?keyframes$/.exec(nameLower);
  const vendor = vendorMatch?.[1] || undefined;

  const keyframes: Array<CssKeyframeAST | CssCommentAST> = [];
  for (const child of node.nodes ?? []) {
    if (child.type === 'comment') {
      keyframes.push(convertComment(child as postcss.Comment, sourceName));
    } else if (child.type === 'rule') {
      keyframes.push(convertKeyframe(child as postcss.Rule, sourceName));
    }
  }

  return {
    type: CssTypes.keyframes,
    name: params,
    vendor,
    keyframes,
    position: convertPos(node.source, sourceName),
  };
}

function convertBlockNodes(
  nodes: postcss.ChildNode[],
  sourceName: string,
): Array<CssAtRuleAST | CssDeclarationAST> {
  const result: Array<CssAtRuleAST | CssDeclarationAST> = [];
  for (const child of nodes) {
    const converted = convertChildNode(child, sourceName);
    if (converted) result.push(converted as CssAtRuleAST | CssDeclarationAST);
  }
  return result;
}

function convertDeclNodes(
  nodes: postcss.ChildNode[],
  sourceName: string,
): Array<CssDeclarationAST | CssCommentAST> {
  const result: Array<CssDeclarationAST | CssCommentAST> = [];
  for (const child of nodes) {
    if (child.type === 'decl') {
      result.push(convertDeclaration(child as postcss.Declaration, sourceName));
    } else if (child.type === 'comment') {
      result.push(convertComment(child as postcss.Comment, sourceName));
    }
  }
  return result;
}

function convertAtRule(node: postcss.AtRule, sourceName: string): CssAtRuleAST {
  let nameLower = node.name.toLowerCase();
  let params = trim(node.params);

  // safe-parser artifact: @import:... tokenizes as name='import:' with colon attached.
  // Strip the trailing colon from name and prepend it to params.
  if (nameLower.endsWith(':')) {
    nameLower = nameLower.slice(0, -1);
    params = `:${params}`;
  }

  if (/^([-\w]+)?keyframes$/.test(nameLower)) {
    return convertKeyframes(node, nameLower, params, sourceName);
  }

  switch (nameLower) {
    case 'media':
      return {
        type: CssTypes.media,
        media: params,
        rules: convertBlockNodes(node.nodes ?? [], sourceName),
        position: convertPos(node.source, sourceName),
      } as CssMediaAST;

    case 'supports':
      return {
        type: CssTypes.supports,
        supports: params,
        rules: convertBlockNodes(node.nodes ?? [], sourceName),
        position: convertPos(node.source, sourceName),
      } as CssSupportsAST;

    case 'container':
      return {
        type: CssTypes.container,
        container: params,
        rules: convertBlockNodes(node.nodes ?? [], sourceName),
        position: convertPos(node.source, sourceName),
      } as CssContainerAST;

    case 'import':
      return {
        type: CssTypes.import,
        import: params,
        position: convertPos(node.source, sourceName),
      } as CssImportAST;

    case 'charset':
      return {
        type: CssTypes.charset,
        charset: params,
        position: convertPos(node.source, sourceName),
      } as CssCharsetAST;

    case 'namespace':
      return {
        type: CssTypes.namespace,
        namespace: params,
        position: convertPos(node.source, sourceName),
      } as CssNamespaceAST;

    case 'custom-media': {
      // Normalize whitespace so multiline params split correctly
      const normalizedParams = params.replace(/\s+/g, ' ');
      const spaceIdx = normalizedParams.indexOf(' ');
      return {
        type: CssTypes.customMedia,
        name:
          spaceIdx !== -1
            ? normalizedParams.slice(0, spaceIdx)
            : normalizedParams,
        media: spaceIdx !== -1 ? trim(normalizedParams.slice(spaceIdx)) : '',
        position: convertPos(node.source, sourceName),
      } as CssCustomMediaAST;
    }

    case 'font-face':
      return {
        type: CssTypes.fontFace,
        declarations: convertDeclNodes(node.nodes ?? [], sourceName),
        position: convertPos(node.source, sourceName),
      } as CssFontFaceAST;

    case 'font-feature-values':
      return {
        type: CssTypes.fontFeatureValues,
        fontFamily: params,
        rules: convertBlockNodes(node.nodes ?? [], sourceName),
        position: convertPos(node.source, sourceName),
      } as CssFontFeatureValuesAST;

    case 'host':
      return {
        type: CssTypes.host,
        rules: convertBlockNodes(node.nodes ?? [], sourceName),
        position: convertPos(node.source, sourceName),
      } as CssHostAST;

    case 'layer': {
      if (!node.nodes) {
        return {
          type: CssTypes.layer,
          layer: params,
          position: convertPos(node.source, sourceName),
        } as CssLayerAST;
      }
      return {
        type: CssTypes.layer,
        layer: params,
        rules: convertBlockNodes(node.nodes, sourceName),
        position: convertPos(node.source, sourceName),
      } as CssLayerAST;
    }

    case 'page': {
      const selectors = params ? convertSelectors(params) : [];
      const declarations: Array<
        CssDeclarationAST | CssCommentAST | CssAtRuleAST
      > = [];
      for (const child of node.nodes ?? []) {
        if (child.type === 'decl') {
          declarations.push(
            convertDeclaration(child as postcss.Declaration, sourceName),
          );
        } else if (child.type === 'comment') {
          declarations.push(
            convertComment(child as postcss.Comment, sourceName),
          );
        } else if (child.type === 'atrule') {
          declarations.push(convertAtRule(child as postcss.AtRule, sourceName));
        }
      }
      return {
        type: CssTypes.page,
        selectors,
        declarations,
        position: convertPos(node.source, sourceName),
      } as CssPageAST;
    }

    case 'property':
      return {
        type: CssTypes.property,
        name: params,
        declarations: convertDeclNodes(node.nodes ?? [], sourceName),
        position: convertPos(node.source, sourceName),
      } as CssPropertyAST;

    case 'counter-style':
      return {
        type: CssTypes.counterStyle,
        name: params,
        declarations: convertDeclNodes(node.nodes ?? [], sourceName),
        position: convertPos(node.source, sourceName),
      } as CssCounterStyleAST;

    case 'scope':
      return {
        type: CssTypes.scope,
        scope: params,
        rules: convertBlockNodes(node.nodes ?? [], sourceName),
        position: convertPos(node.source, sourceName),
      } as CssScopeAST;

    case 'starting-style':
      return {
        type: CssTypes.startingStyle,
        rules: convertBlockNodes(node.nodes ?? [], sourceName),
        position: convertPos(node.source, sourceName),
      } as CssStartingStyleAST;

    case 'view-transition':
      return {
        type: CssTypes.viewTransition,
        declarations: convertDeclNodes(node.nodes ?? [], sourceName),
        position: convertPos(node.source, sourceName),
      } as CssViewTransitionAST;

    case 'position-try':
      return {
        type: CssTypes.positionTry,
        name: params,
        declarations: convertDeclNodes(node.nodes ?? [], sourceName),
        position: convertPos(node.source, sourceName),
      } as CssPositionTryAST;
  }

  // Document with optional vendor prefix (@-moz-document, @document)
  if (/^([-\w]+)?document$/.test(nameLower)) {
    const vendorMatch = /^([-\w]+)?document$/.exec(nameLower);
    const vendor = vendorMatch?.[1] || undefined;
    return {
      type: CssTypes.document,
      document: params,
      vendor,
      rules: convertBlockNodes(node.nodes ?? [], sourceName),
      position: convertPos(node.source, sourceName),
    } as CssDocumentAST;
  }

  // Page margin boxes (@top-left, @bottom-right, etc.)
  if (PAGE_MARGIN_BOX_NAMES.has(nameLower)) {
    return {
      type: CssTypes.pageMarginBox,
      name: nameLower,
      declarations: convertDeclNodes(node.nodes ?? [], sourceName),
      position: convertPos(node.source, sourceName),
    } as CssPageMarginBoxAST;
  }

  // Generic/unknown at-rule fallback
  if (!node.nodes) {
    return {
      type: CssTypes.atRule,
      name: node.name,
      prelude: params,
      position: convertPos(node.source, sourceName),
    } as CssGenericAtRuleAST;
  }
  return {
    type: CssTypes.atRule,
    name: node.name,
    prelude: params,
    rules: convertBlockNodes(node.nodes, sourceName),
    position: convertPos(node.source, sourceName),
  } as CssGenericAtRuleAST;
}

function convertChildNode(
  child: postcss.ChildNode,
  sourceName: string,
): CssAtRuleAST | CssDeclarationAST | undefined {
  switch (child.type) {
    case 'rule':
      return convertRule(child as postcss.Rule, sourceName);
    case 'atrule':
      return convertAtRule(child as postcss.AtRule, sourceName);
    case 'decl':
      return convertDeclaration(child as postcss.Declaration, sourceName);
    case 'comment':
      return convertComment(child as postcss.Comment, sourceName);
    default:
      return undefined;
  }
}

function addParent<T extends { type?: string }>(obj: T, parent?: unknown): T {
  const isNode = obj && typeof obj.type === 'string';
  const childParent = isNode ? obj : parent;

  for (const k in obj) {
    const value = obj[k];
    if (Array.isArray(value)) {
      value.forEach((v) => {
        addParent(v as { type?: string }, childParent);
      });
    } else if (value && typeof value === 'object') {
      addParent(value as { type?: string }, childParent);
    }
  }

  if (isNode) {
    Object.defineProperty(obj, 'parent', {
      configurable: true,
      writable: true,
      enumerable: false,
      value: parent ?? null,
    });
  }

  return obj;
}

// Returns the brace-nesting depth in css at the given 1-based line/column.
// Used to distinguish top-level parse errors from errors inside rule bodies.
function depthAtPosition(css: string, line: number, col: number): number {
  const lines = css.split('\n');
  let depth = 0;
  for (let l = 0; l < lines.length && l < line; l++) {
    const end = l === line - 1 ? col - 1 : lines[l].length;
    const text = lines[l].slice(0, end);
    for (const ch of text) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return depth;
}

function buildStylesheet(
  root: postcss.Root,
  sourceName: string,
  source: string | undefined,
  parsingErrors: CssParseError[],
): CssStylesheetAST {
  const rules: CssAtRuleAST[] = [];
  for (const node of root.nodes ?? []) {
    const converted = convertChildNode(node as postcss.ChildNode, sourceName);
    if (converted) rules.push(converted as CssAtRuleAST);
  }
  return addParent({
    type: CssTypes.stylesheet,
    stylesheet: { source, rules, parsingErrors },
  } as CssStylesheetAST);
}

export const parse = (
  css: string,
  options?: { source?: string; silent?: boolean },
): CssStylesheetAST => {
  const sourceName = options?.source ?? '';
  const silent = options?.silent ?? false;

  // Pre-check: unclosed comments must throw even before parsing
  if (!silent && hasUnclosedComment(css)) {
    throw new CssParseError(sourceName, 'End of comment missing', 1, 1, css);
  }

  if (silent) {
    // Silent mode: use safe-parser for error recovery, collect errors via segment analysis
    const parsingErrors = collectSilentErrors(css, sourceName);
    const root = safeParser(css);
    return buildStylesheet(root, sourceName, options?.source, parsingErrors);
  }

  // Non-silent mode: try strict parse first.
  // Only fall back to safe-parser for top-level syntax errors (depth 0),
  // not for errors inside rule bodies which represent truly invalid CSS.
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch (e) {
    if (e instanceof postcss.CssSyntaxError) {
      const depth = depthAtPosition(css, e.line ?? 1, e.column ?? 1);
      if (depth > 0) {
        // Error inside a rule body — the CSS is invalid, re-throw
        throw new CssParseError(
          sourceName,
          e.reason,
          e.line ?? 1,
          e.column ?? 1,
          css,
        );
      }
    }
    // Top-level syntax error — use safe-parser as lenient fallback
    root = safeParser(css);
  }

  // Post-check: empty selectors must throw
  for (const node of root.nodes ?? []) {
    if (node.type === 'rule' && !(node as postcss.Rule).selector.trim()) {
      throw new CssParseError(sourceName, 'Missing selector', 1, 1, css);
    }
  }

  return buildStylesheet(root, sourceName, options?.source, []);
};

export default parse;
