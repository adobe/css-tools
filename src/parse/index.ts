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
import {
  indexOfArrayNonEscaped,
  splitWithBracketAndQuoteSupport,
} from '../utils/stringSearch';

const commentRegex = /\/\*[^]*?(?:\*\/|$)/g;

export interface ParseOptions {
  source?: string;
  silent?: boolean;
  stripCommentsInValues?: boolean;
}

function trim(str: string): string {
  return str ? str.trim() : '';
}

// Splits CSS into top-level rule/at-rule/statement segments for error detection.
// Handles string literals and comments to avoid false boundaries.
function splitTopLevelSegments(
  css: string,
): Array<{ text: string; offset: number }> {
  const segments: Array<{ text: string; offset: number }> = [];
  let depth = 0;
  let parentheses = 0;
  let brackets = 0;
  let start = 0;
  let i = 0;

  while (i < css.length) {
    const ch = css[i];

    if (ch === '\\') {
      i += 2;
      continue;
    }

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

    if (ch === '(') parentheses++;
    else if (ch === ')') parentheses = Math.max(0, parentheses - 1);
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets = Math.max(0, brackets - 1);

    if (parentheses || brackets) {
      i++;
      continue;
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          segments.push({ text: css.slice(start, i + 1), offset: start });
          start = i + 1;
        }
      } else {
        // Orphan close brace
        const before = css.slice(start, i);
        if (before.trim()) segments.push({ text: before, offset: start });
        segments.push({ text: '}', offset: i });
        start = i + 1;
      }
    } else if (ch === ';' && depth === 0) {
      segments.push({ text: css.slice(start, i + 1), offset: start });
      start = i + 1;
    }

    i++;
  }

  const tail = css.slice(start);
  if (tail.trim()) segments.push({ text: tail, offset: start });

  return segments;
}

function pointAt(css: string, offset: number) {
  const before = css.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

function offsetAt(css: string, line: number, column: number): number {
  let offset = 0;
  for (let index = 1; index < line; index++) {
    offset = css.indexOf('\n', offset) + 1;
  }
  return offset + column - 1;
}

function compatibilityError(
  css: string,
  sourceName: string,
  reason: string,
  offset: number,
): CssParseError {
  const point = pointAt(css, offset);
  return new CssParseError(
    sourceName,
    reason,
    point.line,
    point.column,
    css.slice(offset),
  );
}

function collectCompatibilityErrors(
  css: string,
  sourceName: string,
  root: postcss.Root,
  silent: boolean,
): CssParseError[] {
  const errors: CssParseError[] = [];
  for (const segment of splitTopLevelSegments(css)) {
    if (!segment.text.trim()) continue;
    let text = segment.text;
    while (text.trim()) {
      try {
        postcss.parse(text);
        break;
      } catch (e) {
        if (!(e instanceof postcss.CssSyntaxError)) throw e;
        const offset =
          segment.offset + offsetAt(segment.text, e.line ?? 1, e.column ?? 1);
        if (e.reason.startsWith('Unknown word')) {
          let propertyComment = false;
          root.walkDecls((node) => {
            const start = node.source?.start?.offset ?? 0;
            const between = node.raws.between ?? '';
            if (
              between.includes('/*') &&
              offset >= start &&
              offset < start + node.prop.length + between.length
            ) {
              propertyComment = true;
            }
          });
          const property = /^(\*?[-#/*\\\w]+(\[[0-9a-z_-]+\])?)\s*/.exec(
            css.slice(offset),
          );
          if (!propertyComment) {
            errors.push(
              compatibilityError(
                css,
                sourceName,
                "property missing ':'",
                offset + (property?.[0].length ?? 0),
              ),
            );
          }
          const local = offset - segment.offset;
          const end = text.indexOf(';', local);
          if (end === -1) break;
          text =
            text.slice(0, local) +
            text.slice(local, end + 1).replace(/[^\r\n]/g, ' ') +
            text.slice(end + 1);
          continue;
        } else if (e.reason === 'Unexpected }') {
          errors.push(compatibilityError(css, sourceName, "extra '}'", offset));
        } else if (e.reason === 'Unclosed comment') {
          errors.push(
            compatibilityError(
              css,
              sourceName,
              'End of comment missing',
              offset,
            ),
          );
        } else if (e.reason === 'Unclosed string') {
          if (!silent && !/^\s*@(?:import|charset|namespace)\b/.test(text)) {
            errors.push(
              compatibilityError(css, sourceName, "missing '}'", offset),
            );
          }
        } else if (e.reason !== 'Unclosed block') {
          // V4 accepts arbitrary text in statement at-rules, including the
          // deliberately malformed @import input in the security fixtures.
          if (!/^\s*@(?:import|charset|namespace)\b/.test(segment.text)) {
            errors.push(compatibilityError(css, sourceName, e.reason, offset));
          }
        }
        break;
      }
    }
  }
  return errors;
}

function recoverCompatibility(
  root: postcss.Root,
  css: string,
  sourceName: string,
  errors: CssParseError[],
  silent: boolean,
): void {
  const recoveryEnds = new Map<postcss.Container, number>();
  root.walkComments((node) => {
    const start = node.source?.start?.offset ?? 0;
    if (css.startsWith('/*', start) && css.indexOf('*/', start + 2) === -1) {
      const parent = node.parent;
      node.remove();
      let cursor = start;
      if (parent && parent.type !== 'root') {
        const property = /^(\*?[-#/*\\\w]+(\[[0-9a-z_-]+\])?)\s*/.exec(
          css.slice(start),
        );
        cursor += property?.[0].length ?? 0;
        recoveryEnds.set(parent, cursor);
        errors.push(
          compatibilityError(css, sourceName, "property missing ':'", cursor),
        );
      }
      if (silent) {
        for (let offset = cursor; offset < css.length; offset++) {
          if (!/\s/.test(css[offset])) {
            errors.push(
              compatibilityError(css, sourceName, 'selector missing', offset),
            );
          }
        }
      }
    }
  });
  root.walk((node) => {
    const start = node.source?.start?.offset ?? 0;
    if (node.type === 'rule' && !node.selector.trim()) {
      node.remove();
      for (
        let offset = start;
        offset < (node.source?.end?.offset ?? css.length);
        offset++
      ) {
        if (!/\s/.test(css[offset])) {
          errors.push(
            compatibilityError(
              css,
              sourceName,
              css[offset] === '}' ? "extra '}'" : 'selector missing',
              offset,
            ),
          );
        }
      }
    } else if (node.type === 'decl') {
      const value = node.raws.value?.raw ?? node.value;
      if (
        (value.startsWith('"') || value.startsWith("'")) &&
        indexOfArrayNonEscaped(value, [value[0]], 1) === -1 &&
        node.source
      ) {
        const offset =
          start + node.prop.length + (node.raws.between?.length ?? 1);
        const end = pointAt(css, offset);
        node.value = '';
        delete node.raws.value;
        node.source.end = { ...end, offset };
      }
    } else if (
      (node.type === 'rule' || node.type === 'atrule') &&
      node.nodes &&
      node.source &&
      !node.source.end
    ) {
      const last = node.last;
      const cursor = recoveryEnds.get(node) ?? css.length;
      if (
        last?.type === 'decl' &&
        !recoveryEnds.has(node) &&
        !css
          .slice(last.source?.start?.offset ?? 0)
          .trimEnd()
          .endsWith(';')
      ) {
        last.remove();
        errors.push(
          compatibilityError(
            css,
            sourceName,
            "property missing ':'",
            css.length,
          ),
        );
      }
      errors.push(
        compatibilityError(
          css,
          sourceName,
          node.type === 'atrule' ? `@${node.name} missing '}'` : "missing '}'",
          cursor,
        ),
      );
      if (node.type === 'atrule') {
        node.remove();
        errors.push(
          compatibilityError(css, sourceName, 'selector missing', cursor),
        );
        return;
      }
      node.removeAll();
      const end = pointAt(css, cursor);
      node.source.end = {
        line: end.line,
        column: end.column - 1,
        offset: cursor,
      };
    } else if (
      node.type === 'atrule' &&
      ((!node.nodes &&
        /^(?:media|supports|container|host|document|font-face|page|property|counter-style|font-feature-values|scope|view-transition|position-try|starting-style)$/.test(
          node.name,
        )) ||
        (/^(?:[-\w]+)?keyframes$/.test(node.name) && !node.params.trim()))
    ) {
      const missingName = /keyframes$/.test(node.name) && !node.params.trim();
      const cursor = missingName
        ? start + node.name.length + 1 + (node.raws.between?.length ?? 0)
        : (node.source?.end?.offset ?? css.length);
      errors.push(
        compatibilityError(
          css,
          sourceName,
          missingName ? '@keyframes missing name' : `@${node.name} missing '{'`,
          cursor,
        ),
      );
      node.remove();
      if (silent) {
        if (cursor === css.length) {
          errors.push(
            compatibilityError(css, sourceName, 'selector missing', cursor),
          );
        } else {
          for (let offset = cursor; offset < css.length; offset++) {
            if (!/\s/.test(css[offset])) {
              errors.push(
                compatibilityError(
                  css,
                  sourceName,
                  css[offset] === '}' ? "extra '}'" : 'selector missing',
                  offset,
                ),
              );
            }
          }
        }
      }
    }
  });
  errors.sort(
    (a, b) =>
      a.line - b.line ||
      a.column - b.column ||
      Number(a.reason === 'selector missing') -
        Number(b.reason === 'selector missing'),
  );
}

// PostCSS end is inclusive (last char); v4 css-tools end is exclusive (past last char).
// Use for rules, at-rules, and comments where end = last char + 1.
function convertPos(
  source: postcss.Source | undefined,
  sourceName: string,
): Position | undefined {
  if (!source?.start || !source.end) return undefined;
  return new Position(
    { line: source.start.line, column: source.start.column },
    { line: source.end.line, column: source.end.column + 1 },
    sourceName,
  );
}

// Declarations use different end semantics:
// - With semicolon: end = position of ';' (PostCSS end, no +1)
// - Without semicolon: end = position of closing '}' (parent's end, no +1)
function convertDeclPos(
  node: postcss.Declaration,
  sourceName: string,
): Position | undefined {
  if (!node.source?.start || !node.source.end) return undefined;
  const parent = node.parent as postcss.Container & {
    raws?: { semicolon?: boolean };
  };
  const isLastChild = parent?.nodes?.[parent.nodes.length - 1] === node;
  const noSemicolon = isLastChild && parent?.raws?.semicolon === false;

  const endLine =
    noSemicolon && parent.source?.end
      ? parent.source.end.line
      : node.source.end.line;
  const endCol =
    noSemicolon && parent.source?.end
      ? parent.source.end.column
      : node.source.end.column;

  return new Position(
    { line: node.source.start.line, column: node.source.start.column },
    { line: endLine, column: endCol },
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
  const hackPrefix = /[*_]$/.exec(rawsBefore)?.[0] ?? '';
  return {
    type: CssTypes.declaration,
    property:
      hackPrefix +
      (node.prop + (node.raws.between ?? ':').split(':')[0])
        .replace(commentRegex, '')
        .trim(),
    value: trim((node.raws.value?.raw ?? node.value) + important),
    position: convertDeclPos(node, sourceName),
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
  let nameLower = node.name;
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
          position: layerStatementPos(node, sourceName),
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
    // v4 used "" (empty string) when no vendor prefix, not undefined
    const vendor = vendorMatch?.[1] ?? '';
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

// For @layer statements (no body), v4 advanced past trailing whitespace to the
// start of the next token before recording end position.
function layerStatementPos(
  node: postcss.AtRule,
  sourceName: string,
): Position | undefined {
  if (!node.source?.start || !node.source.end) return undefined;
  const css = (node.source.input as { css: string }).css;
  // source.end.offset points one past the last char (exclusive end)
  let offset = node.source.end.offset ?? 0;
  while (offset < css.length && /[ \t\r\n]/.test(css[offset])) {
    offset++;
  }
  const before = css.slice(0, offset);
  const lines = before.split('\n');
  const endLine = lines.length;
  const endCol = lines[lines.length - 1].length + 1;
  return new Position(
    { line: node.source.start.line, column: node.source.start.column },
    { line: endLine, column: endCol },
    sourceName,
  );
}

function buildStylesheet(
  root: postcss.Root,
  sourceName: string,
  source: string | undefined,
  parsingErrors: CssParseError[],
  stripCommentsInValues: boolean,
): CssStylesheetAST {
  const rules: CssAtRuleAST[] = [];
  for (const node of root.nodes ?? []) {
    const converted = convertChildNode(node as postcss.ChildNode, sourceName);
    if (converted) rules.push(converted as CssAtRuleAST);
  }
  if (stripCommentsInValues) stripValueComments(rules);
  return addParent({
    type: CssTypes.stylesheet,
    stylesheet: { source, rules, parsingErrors },
  } as CssStylesheetAST);
}

function stripValueComments(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) stripValueComments(child);
  } else if (value && typeof value === 'object') {
    if ('type' in value && value.type === CssTypes.declaration) {
      const declaration = value as CssDeclarationAST;
      declaration.value = declaration.value.replace(commentRegex, '');
    } else {
      for (const child of Object.values(value)) stripValueComments(child);
    }
  }
}

export const parse = (
  css: string,
  options?: ParseOptions,
): CssStylesheetAST => {
  const sourceName = options?.source ?? '';
  const silent = options?.silent ?? false;

  let root: postcss.Root;
  let parsingErrors: CssParseError[] = [];
  try {
    root = postcss.parse(css);
  } catch (e) {
    if (!(e instanceof postcss.CssSyntaxError)) throw e;
    root = safeParser(css);
    parsingErrors = collectCompatibilityErrors(css, sourceName, root, silent);
  }

  recoverCompatibility(root, css, sourceName, parsingErrors, silent);
  if (!silent) {
    const orphan = splitTopLevelSegments(css).find(
      (segment) => segment.text === '}',
    );
    if (orphan) {
      for (const node of [...root.nodes]) {
        if ((node.source?.start?.offset ?? 0) >= orphan.offset) node.remove();
      }
      parsingErrors = parsingErrors.filter(
        (error) => offsetAt(css, error.line, error.column) < orphan.offset,
      );
    }
    if (parsingErrors.length) throw parsingErrors[0];
  }

  if (css.startsWith('\uFEFF')) {
    root.walk((node) => {
      for (const point of [node.source?.start, node.source?.end]) {
        if (point) {
          if (point.line === 1) point.column++;
          if (point.offset !== undefined) point.offset++;
        }
      }
    });
    if (root.source) root.source.input.css = css;
  }

  return buildStylesheet(
    root,
    sourceName,
    options?.source,
    parsingErrors,
    options?.stripCommentsInValues !== false,
  );
};

export default parse;
