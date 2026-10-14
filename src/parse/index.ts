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
const propertyPrefixRegex = /^(\*?[-#/*\\\w]+(\[[0-9a-z_-]+\])?)\s*/;
const keyframesRegex = /^([-\w]+)?keyframes$/;
const DECLARATION_ONLY_AT_RULES = new Set([
  'font-face',
  'page',
  'property',
  'counter-style',
  'view-transition',
  'position-try',
]);
const postcssOptions: postcss.ProcessOptions = { map: false };

export interface ParseOptions {
  source?: string;
  silent?: boolean;
  stripCommentsInValues?: boolean;
}

function trim(str: string): string {
  return str ? str.trim() : '';
}

function prepareCompatibilityInput(css: string): {
  css: string;
  ruleStarts: ReadonlySet<number>;
} {
  const ruleStarts = new Set<number>();
  if (!css.includes('--')) return { css, ruleStarts };
  const contexts: Array<{ nesting: boolean; keyframes: boolean }> = [];
  let nesting = true;
  let keyframes = false;
  let parentheses = 0;
  let brackets = 0;
  let quote = '';
  let start: number | undefined;

  for (let offset = 0; offset < css.length; offset++) {
    const char = css[offset];
    if (char === '\\') {
      if (start === undefined) start = offset;
      offset++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && css[offset + 1] === '*') {
      const end = css.indexOf('*/', offset + 2);
      if (end === -1) break;
      offset = end + 1;
      continue;
    }
    if (start === undefined && !/\s/.test(char)) start = offset;
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') parentheses++;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if (char === '[') brackets++;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    if (parentheses || brackets) continue;

    if (char === '{') {
      const name =
        start !== undefined && css[start] === '@'
          ? /^@([-\w]+)/.exec(css.slice(start, offset))?.[1]
          : undefined;
      if (nesting && start !== undefined && css.startsWith('--', start)) {
        ruleStarts.add(start);
      }
      contexts.push({ nesting, keyframes });
      const blockKeyframes = name !== undefined && keyframesRegex.test(name);
      nesting =
        name === undefined
          ? nesting && !keyframes
          : !blockKeyframes &&
            !DECLARATION_ONLY_AT_RULES.has(name) &&
            !PAGE_MARGIN_BOX_NAMES.has(name);
      keyframes = blockKeyframes;
      start = undefined;
    } else if (char === '}') {
      const context = contexts.pop();
      nesting = context?.nesting ?? true;
      keyframes = context?.keyframes ?? false;
      start = undefined;
    } else if (char === ';') start = undefined;
  }
  if (!ruleStarts.size) return { css, ruleStarts };

  // Mask only the custom-property prefix so PostCSS classifies V4 blocks as
  // rules in one parse. Equal-length substitutions keep every source offset.
  const parts: string[] = [];
  let cursor = 0;
  for (const start of ruleStarts) {
    parts.push(css.slice(cursor, start), '__');
    cursor = start + 2;
  }
  parts.push(css.slice(cursor));
  return { css: parts.join(''), ruleStarts };
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

class CompatibilitySource {
  private readonly lineStarts = [0];

  constructor(
    readonly css: string,
    readonly sourceName: string,
  ) {
    for (let offset = 0; offset < css.length; offset++) {
      if (css[offset] === '\n') this.lineStarts.push(offset + 1);
    }
  }

  pointAt(offset: number) {
    let low = 0;
    let high = this.lineStarts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.lineStarts[middle] <= offset) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: offset - this.lineStarts[low] + 1 };
  }

  offsetAt(line: number, column: number): number {
    return this.lineStarts[line - 1] + column - 1;
  }

  error(reason: string, offset: number): CssParseError {
    const point = this.pointAt(offset);
    return new CssParseError(
      this.sourceName,
      reason,
      point.line,
      point.column,
      this.css.slice(offset),
    );
  }
}

function declarationValueEnd(value: string, preserveComments: boolean): number {
  // V4 scans comment text as value text; the opt-out respects comment boundaries.
  let quote = '';
  let parentheses = 0;
  for (let offset = 0; offset < value.length; offset++) {
    const char = value[offset];
    if (char === '\\') offset++;
    else if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (preserveComments && char === '/' && value[offset + 1] === '*') {
      const end = value.indexOf('*/', offset + 2);
      if (end === -1) return -1;
      offset = end + 1;
    } else if (char === '(') parentheses++;
    else if (char === ')' && parentheses) parentheses--;
    else if (!parentheses && (char === ';' || char === '}')) return offset;
  }
  return -1;
}

// Restore V4 boundaries and raw fields from the unmodified input.
function restoreCompatibilitySpans(
  root: postcss.Root,
  source: CompatibilitySource,
  preserveComments: boolean,
  ruleStarts: ReadonlySet<number>,
): void {
  function restoreContainer(container: postcss.Container): void {
    if (!container.nodes) return;
    const children = container.nodes;
    const retained: postcss.ChildNode[] = [];
    let consumedEnd = -1;
    for (const node of children) {
      const start = node.source?.start?.offset;
      if (start !== undefined && start < consumedEnd) continue;
      retained.push(node);
      if (node.type !== 'decl' || start === undefined || !node.source) continue;
      const property = propertyPrefixRegex.exec(source.css.slice(start));
      if (!property) continue;
      const colon = start + property[0].length;
      if (source.css[colon] !== ':') continue;
      let valueStart = colon + 1;
      while (/\s/.test(source.css[valueStart] ?? '')) valueStart++;
      const parsedEnd = node.source.end?.offset;
      const hasSemicolon =
        parsedEnd !== undefined && source.css[parsedEnd - 1] === ';';
      const limit = hasSemicolon
        ? parsedEnd
        : (container.source?.end?.offset ?? parsedEnd ?? source.css.length);
      const relativeEnd = declarationValueEnd(
        source.css.slice(valueStart, limit),
        preserveComments,
      );
      if (relativeEnd === -1) continue;
      consumedEnd = valueStart + relativeEnd;
      if (node.prop !== property[1]) {
        node.prop = property[1];
        node.raws.before = node.raws.before?.replace(/[*_]$/, '');
        node.raws.between = source.css.slice(
          start + property[1].length,
          valueStart,
        );
      }
      node.value = trim(source.css.slice(valueStart, consumedEnd));
      node.important = false;
      delete node.raws.value;
      delete node.raws.important;
      node.source.end = {
        ...source.pointAt(consumedEnd),
        offset: consumedEnd + 1,
      };
    }
    if (retained.length !== children.length) {
      container.removeAll();
      container.append(retained);
    }
  }

  restoreContainer(root);
  root.walk((node) => {
    const start = node.source?.start?.offset;
    if (node.type === 'rule' && start !== undefined && ruleStarts.has(start)) {
      const selector = node.raws.selector?.raw ?? node.selector;
      node.selector = source.css.slice(start, start + selector.length);
      delete node.raws.selector;
      const suffix = node.raws.ownSemicolon;
      const end = node.source?.end?.offset;
      if (suffix && end !== undefined && node.source) {
        const offset = end - suffix.length;
        node.source.end = {
          ...source.pointAt(offset - 1),
          offset,
        };
        delete node.raws.ownSemicolon;
      }
    } else if (
      node.type === 'atrule' &&
      !node.nodes &&
      node.source?.start &&
      !node.source.end
    ) {
      const end = source.pointAt(source.css.length);
      node.source.end = {
        line: end.line,
        column: end.column - 1,
        offset: source.css.length,
      };
    }
    if (node.type === 'rule' || node.type === 'atrule') restoreContainer(node);
  });
}

function blockOpeningOffset(
  node: postcss.Rule | postcss.AtRule,
): number | undefined {
  const start = node.source?.start?.offset;
  if (start === undefined || !node.nodes) return undefined;
  const header =
    node.type === 'rule'
      ? (node.raws.selector?.raw ?? node.selector) + (node.raws.between ?? '')
      : `@${node.name}${node.raws.afterName ?? ''}${
          node.raws.params?.raw ?? node.params
        }${node.raws.between ?? ''}`;
  return start + header.length;
}

function collectCompatibilityErrors(
  source: CompatibilitySource,
  root: postcss.Root,
  silent: boolean,
  syntaxError?: postcss.CssSyntaxError,
): CssParseError[] {
  const { css } = source;
  const errors: CssParseError[] = [];
  const segments = splitTopLevelSegments(css);
  for (const segment of segments) {
    if (segment.text === '}')
      errors.push(source.error("extra '}'", segment.offset));
  }
  if (
    syntaxError &&
    !syntaxError.reason.startsWith('Unknown word') &&
    ![
      'Unexpected }',
      'Unclosed comment',
      'Unclosed string',
      'Unclosed block',
      'Missed semicolon',
      'Double colon',
    ].includes(syntaxError.reason)
  ) {
    const offset = source.offsetAt(
      syntaxError.line ?? 1,
      syntaxError.column ?? 1,
    );
    const segment = segments.find(
      (entry) =>
        offset >= entry.offset && offset < entry.offset + entry.text.length,
    );
    if (!segment || !/^\s*@(?:import|charset|namespace)\b/.test(segment.text)) {
      errors.push(source.error(syntaxError.reason, offset));
    }
  }

  function recordRootGap(from: number, until: number): void {
    for (let offset = from; offset < until; offset++) {
      if (!/\s/.test(css[offset]) && css[offset] !== '}') {
        errors.push(source.error('selector missing', offset));
        if (!silent) return;
      }
    }
  }

  const retainedRoots: postcss.ChildNode[] = [];
  let remainingBlocks = root.nodes.filter(
    (node) => node.type === 'rule' || (node.type === 'atrule' && node.nodes),
  ).length;
  let cursor = 0;
  for (let node of root.nodes) {
    if (node.type === 'decl') continue;
    const start = node.source?.start?.offset;
    if (start === undefined) {
      retainedRoots.push(node);
      continue;
    }
    const open =
      node.type === 'rule' || node.type === 'atrule'
        ? blockOpeningOffset(node)
        : undefined;
    if (open !== undefined) remainingBlocks--;
    while (cursor < start && (/\s/.test(css[cursor]) || css[cursor] === '}'))
      cursor++;
    if (cursor < start && remainingBlocks && open === undefined) continue;
    if (cursor < start && open !== undefined && css[open] === '{') {
      const selector = css.slice(cursor, open);
      if (node.type === 'rule') {
        node.selector = selector;
        node.raws.between = '';
        delete node.raws.selector;
      } else if (node.type === 'atrule') {
        node = postcss.rule({
          selector,
          source: node.source,
          nodes: node.nodes,
        });
      }
      if (node.source) {
        node.source.start = { ...source.pointAt(cursor), offset: cursor };
      }
    } else {
      recordRootGap(cursor, start);
    }
    retainedRoots.push(node);
    cursor = node.source?.end?.offset ?? css.length;
  }
  recordRootGap(cursor, css.length);
  if (
    retainedRoots.length !== root.nodes.length ||
    retainedRoots.some((node, index) => node !== root.nodes[index])
  ) {
    root.removeAll();
    root.append(retainedRoots);
  }

  root.walk((container, index) => {
    if (
      (container.type !== 'rule' && container.type !== 'atrule') ||
      !container.nodes
    )
      return;
    const open = blockOpeningOffset(container);
    if (open === undefined || css[open] !== '{') return;
    const end = container.source?.end?.offset ?? css.length;
    const limit = css[end - 1] === '}' ? end - 1 : end;
    const children = container.nodes;
    const retained: postcss.ChildNode[] = [];
    let nextClose: number | undefined;

    function stopAt(offset: number): void {
      errors.push(
        source.error(
          container.type === 'atrule'
            ? `@${container.name} missing '}'`
            : "missing '}'",
          offset,
        ),
      );
      if (container.type === 'rule') retained.length = 0;
      if (container.source) {
        const point = source.pointAt(offset);
        container.source.end = {
          line: point.line,
          column: point.column - 1,
          offset,
        };
      }
      if (silent) {
        const next =
          container.parent?.type === 'root'
            ? container.parent.nodes?.[index + 1]
            : undefined;
        const nextOpen =
          next?.type === 'rule' ? blockOpeningOffset(next) : undefined;
        if (nextOpen !== undefined && next?.type === 'rule' && next.source) {
          next.selector = css.slice(offset, nextOpen);
          next.raws.between = '';
          delete next.raws.selector;
          next.source.start = { ...source.pointAt(offset), offset };
          return;
        }
        for (let cursor = offset; cursor < end; cursor++) {
          if (!/\s/.test(css[cursor])) {
            errors.push(
              source.error(
                css[cursor] === '}' ? "extra '}'" : 'selector missing',
                cursor,
              ),
            );
          }
        }
      }
    }

    function scanGap(cursor: number, until: number): number {
      while (cursor < until) {
        while (cursor < until && /\s/.test(css[cursor])) cursor++;
        if (cursor >= until) break;
        const property = propertyPrefixRegex.exec(css.slice(cursor));
        if (property && css[cursor + property[0].length] === ':') break;
        if (property) {
          cursor += property[0].length;
          errors.push(source.error("property missing ':'", cursor));
          if (cursor >= limit) break;
        } else if (!silent) {
          stopAt(cursor);
          return limit;
        }
        if (
          nextClose === undefined ||
          (nextClose !== -1 && nextClose < cursor)
        ) {
          nextClose = css.indexOf('}', cursor);
        }
        const recoveryEnd =
          nextClose === -1 ? limit : Math.min(nextClose, limit);
        const semicolon = css.slice(cursor, recoveryEnd).indexOf(';');
        if (semicolon !== -1) {
          cursor += semicolon + 1;
        } else {
          stopAt(cursor);
          return limit;
        }
      }
      return cursor;
    }

    let cursor = open + 1;
    for (const child of children) {
      const childStart = child.source?.start?.offset;
      if (childStart === undefined) {
        retained.push(child);
        continue;
      }
      cursor = scanGap(cursor, childStart);
      if (childStart < cursor) continue;
      retained.push(child);
      cursor = Math.min(child.source?.end?.offset ?? limit, limit);
      while (
        cursor < limit &&
        (/\s/.test(css[cursor]) ||
          (child.type === 'decl' && css[cursor] === ';'))
      )
        cursor++;
    }
    scanGap(cursor, limit);
    if (retained.length !== children.length) {
      container.removeAll();
      container.append(retained);
    }
  });
  return errors;
}

function recoverCompatibility(
  root: postcss.Root,
  source: CompatibilitySource,
  errors: CssParseError[],
  silent: boolean,
): void {
  const { css } = source;
  const recoveryEnds = new Map<postcss.Container, number>();
  root.walkComments((node) => {
    const start = node.source?.start?.offset ?? 0;
    if (css.startsWith('/*', start) && css.indexOf('*/', start + 2) === -1) {
      errors.push(source.error('End of comment missing', start));
      const parent = node.parent;
      node.remove();
      let cursor = start;
      if (parent && parent.type !== 'root') {
        const property = propertyPrefixRegex.exec(css.slice(start));
        cursor += property?.[0].length ?? 0;
        recoveryEnds.set(parent, cursor);
        errors.push(source.error("property missing ':'", cursor));
      }
      if (silent) {
        for (let offset = cursor; offset < css.length; offset++) {
          if (!/\s/.test(css[offset])) {
            errors.push(source.error('selector missing', offset));
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
            source.error(
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
        const end = source.pointAt(offset);
        if (!silent) errors.push(source.error("missing '}'", offset));
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
        errors.push(source.error("property missing ':'", css.length));
      }
      errors.push(
        source.error(
          node.type === 'atrule' ? `@${node.name} missing '}'` : "missing '}'",
          cursor,
        ),
      );
      if (node.type === 'atrule') {
        node.remove();
        errors.push(source.error('selector missing', cursor));
        return;
      }
      node.removeAll();
      const end = source.pointAt(cursor);
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
        (keyframesRegex.test(node.name) && !node.params.trim()))
    ) {
      const missingName = /keyframes$/.test(node.name) && !node.params.trim();
      const cursor = missingName
        ? start + node.name.length + 1 + (node.raws.between?.length ?? 0)
        : (node.source?.end?.offset ?? css.length);
      errors.push(
        source.error(
          missingName ? '@keyframes missing name' : `@${node.name} missing '{'`,
          cursor,
        ),
      );
      node.remove();
      if (silent) {
        if (cursor === css.length) {
          errors.push(source.error('selector missing', cursor));
        } else {
          for (let offset = cursor; offset < css.length; offset++) {
            if (!/\s/.test(css[offset])) {
              errors.push(
                source.error(
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
  const endsWithSemicolon =
    node.source.end.offset !== undefined &&
    node.source.input.css[node.source.end.offset - 1] === ';';
  const noSemicolon =
    !endsWithSemicolon && isLastChild && parent?.raws?.semicolon === false;

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
  const vendorMatch = keyframesRegex.exec(nameLower);
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
  let params = trim(
    (node.raws.afterName ?? '') +
      (node.raws.params?.raw ?? node.params) +
      (node.raws.between ?? ''),
  );

  // safe-parser artifact: @import:... tokenizes as name='import:' with colon attached.
  // Strip the trailing colon from name and prepend it to params.
  if (nameLower.endsWith(':')) {
    nameLower = nameLower.slice(0, -1);
    params = `:${params}`;
  }

  if (keyframesRegex.test(nameLower)) {
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
      const spaceIdx = params.search(/\s/);
      return {
        type: CssTypes.customMedia,
        name: spaceIdx !== -1 ? params.slice(0, spaceIdx) : params,
        media: spaceIdx !== -1 ? trim(params.slice(spaceIdx)) : '',
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
          position: statementPos(node, sourceName),
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
      position: statementPos(node, sourceName),
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

// For layer and generic statements, V4 advanced past trailing whitespace to the
// start of the next token before recording end position.
function statementPos(
  node: postcss.AtRule,
  sourceName: string,
): Position | undefined {
  if (!node.source?.start || !node.source.end) return undefined;
  const css = (node.source.input as { css: string }).css;
  // source.end.offset points one past the last char (exclusive end)
  let offset = node.source.end.offset ?? 0;
  let endLine = node.source.end.line;
  let endCol = node.source.end.column + 1;
  while (offset < css.length && /\s/.test(css[offset])) {
    if (css[offset] === '\n') {
      endLine++;
      endCol = 1;
    } else {
      endCol++;
    }
    offset++;
  }
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
  const input = prepareCompatibilityInput(css);

  let root: postcss.Root;
  let syntaxError: postcss.CssSyntaxError | undefined;
  try {
    root = postcss.parse(input.css, postcssOptions);
  } catch (e) {
    if (!(e instanceof postcss.CssSyntaxError)) throw e;
    root = safeParser(input.css, postcssOptions);
    syntaxError = e;
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
  }
  if (root.source && (input.css !== css || css.startsWith('\uFEFF'))) {
    root.source.input.css = css;
  }

  const source = new CompatibilitySource(css, sourceName);
  restoreCompatibilitySpans(
    root,
    source,
    options?.stripCommentsInValues === false,
    input.ruleStarts,
  );
  let parsingErrors = collectCompatibilityErrors(
    source,
    root,
    silent,
    syntaxError,
  );
  recoverCompatibility(root, source, parsingErrors, silent);
  if (!silent) {
    const orphan = splitTopLevelSegments(css).find(
      (segment) => segment.text === '}',
    );
    if (orphan) {
      for (const node of [...root.nodes]) {
        if ((node.source?.start?.offset ?? 0) >= orphan.offset) node.remove();
      }
      parsingErrors = parsingErrors.filter(
        (error) => source.offsetAt(error.line, error.column) < orphan.offset,
      );
    }
    if (parsingErrors.length) throw parsingErrors[0];
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
