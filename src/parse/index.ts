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
const knownAtRuleRegex =
  /^(?:import|charset|namespace|media|supports|container|host|font-face|page|property|counter-style|font-feature-values|scope|view-transition|position-try|starting-style)$/;
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

function walkNodes(
  root: postcss.Container,
  visit: (node: postcss.ChildNode, index: number) => void,
): void {
  const pending: Array<{
    container: postcss.Container;
    index: number;
    visited?: postcss.ChildNode;
  }> = [{ container: root, index: 0 }];
  while (pending.length) {
    const frame = pending[pending.length - 1];
    if (frame.visited) {
      if (frame.container.nodes?.[frame.index] === frame.visited) frame.index++;
      frame.visited = undefined;
      continue;
    }
    const node = frame.container.nodes?.[frame.index];
    if (!node) {
      pending.pop();
      continue;
    }
    visit(node, frame.index);
    // Descendants can remove this node; advance only after their traversal.
    frame.visited = node;
    if ((node.type === 'rule' || node.type === 'atrule') && node.nodes) {
      pending.push({ container: node, index: 0 });
    }
  }
}

function prepareCompatibilityInput(css: string): {
  css: string;
  ruleStarts: ReadonlySet<number>;
} {
  const ruleStarts = new Set<number>();
  if (!css.includes('--') && !css.includes('@')) return { css, ruleStarts };
  const contexts: Array<{ nesting: boolean; keyframes: boolean }> = [];
  let nesting = true;
  let keyframes = false;
  let parentheses = 0;
  let brackets = 0;
  let quote = '';
  let start: number | undefined;
  let colon = false;
  let characters: string[] | undefined;

  // Equal-length masking preserves V4 block classification and source offsets.
  function mask(from: number, until: number): void {
    characters ??= css.split('');
    for (let offset = from; offset < until; offset++) {
      if (css[offset] !== '\n' && css[offset] !== '\r') {
        characters[offset] = ' ';
      }
    }
  }

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
    if (start === undefined && !/\s/.test(char)) {
      start = offset;
      colon = false;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') parentheses++;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if (char === '[') brackets++;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    if (
      char === ':' &&
      !parentheses &&
      start !== undefined &&
      css[start] !== '@'
    ) {
      colon = true;
    }
    if (!parentheses && char === '{' && colon && !nesting && !keyframes) {
      mask(offset, offset + 1);
      continue;
    }
    if (parentheses || brackets) continue;

    if (char === '{') {
      const name =
        start !== undefined && css[start] === '@'
          ? /^@([-\w]+)/.exec(css.slice(start, offset))?.[1]
          : undefined;
      if (nesting && start !== undefined && css.startsWith('--', start)) {
        ruleStarts.add(start);
        characters ??= css.split('');
        characters[start] = '_';
        characters[start + 1] = '_';
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
    } else if (char === ';') {
      start = undefined;
    }
  }
  return { css: characters?.join('') ?? css, ruleStarts };
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

function blockPrelude(header: string): RegExpExecArray | null {
  return (
    /^@(?:media|supports|container) *([^{]+)/.exec(header) ??
    /^@([-\w]+)?document *([^{]+)/.exec(header) ??
    /^@font-feature-values\s+([^{]+)/.exec(header) ??
    /^@scope\s*([^{]*)/.exec(header)
  );
}

function atRuleErrorName(name: string): string {
  if (keyframesRegex.test(name)) return 'keyframes';
  if (/^([-\w]+)?document$/.test(name)) return 'document';
  return name;
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
    let closedAt: number | undefined;
    for (const node of children) {
      const start = node.source?.start?.offset;
      if (
        start !== undefined &&
        (start < consumedEnd || (closedAt !== undefined && start >= closedAt))
      )
        continue;
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
      if (
        (container.type === 'rule' || container.type === 'atrule') &&
        container.source &&
        source.css[consumedEnd] === '}' &&
        consumedEnd + 1 < (container.source.end?.offset ?? source.css.length)
      ) {
        closedAt = consumedEnd;
        container.source.end = { ...node.source.end };
        container.raws.semicolon = false;
      }
    }
    if (retained.length !== children.length) {
      container.removeAll();
      container.append(retained);
    }
    const last = container.last;
    if (
      (last?.type === 'rule' || last?.type === 'atrule') &&
      last.source?.end?.offset !== undefined &&
      container.type !== 'root' &&
      container.source
    ) {
      let cursor = last.source.end.offset;
      while (/\s/.test(source.css[cursor] ?? '')) cursor++;
      if (
        source.css[cursor] === '}' &&
        cursor + 1 < (container.source.end?.offset ?? source.css.length)
      ) {
        container.source.end = {
          ...source.pointAt(cursor),
          offset: cursor + 1,
        };
      }
    }
  }

  const containers: postcss.Container[] = [root];
  walkNodes(root, (node, index) => {
    const start = node.source?.start?.offset;
    if (node.type === 'rule' && start !== undefined) {
      const selector = node.raws.selector?.raw ?? node.selector;
      node.selector = source.css.slice(start, start + selector.length);
      delete node.raws.selector;
      const suffix = node.raws.ownSemicolon;
      const end = node.source?.end?.offset;
      if (ruleStarts.has(start) && suffix && end !== undefined && node.source) {
        const offset = end - suffix.length;
        node.source.end = {
          ...source.pointAt(offset - 1),
          offset,
        };
        delete node.raws.ownSemicolon;
      }
    } else if (node.type === 'atrule' && start !== undefined && node.source) {
      let parsedEnd = node.source.end?.offset;
      let semicolon =
        parsedEnd !== undefined && source.css[parsedEnd - 1] === ';';
      const prelude =
        !node.nodes && semicolon ? blockPrelude(source.css.slice(start)) : null;
      const siblings = node.parent?.nodes;
      if (prelude && siblings && node.parent) {
        const cursor = start + prelude[0].length;
        const bodyIndex = siblings.findIndex(
          (sibling, siblingIndex) =>
            siblingIndex > index &&
            (sibling.type === 'rule' || sibling.type === 'atrule') &&
            blockOpeningOffset(sibling) === cursor,
        );
        const body = siblings[bodyIndex];
        if (body?.type === 'rule' || body?.type === 'atrule') {
          const children = [...(body.nodes ?? [])];
          body.removeAll();
          node.nodes = [];
          node.append(children);
          node.source.end = body.source?.end;
          node.raws.semicolon = body.raws.semicolon;
          node.raws.afterName = '';
          node.params = source.css.slice(start + node.name.length + 1, cursor);
          node.raws.between = '';
          delete node.raws.params;
          const retained = [
            ...siblings.slice(0, index + 1),
            ...siblings.slice(bodyIndex + 1),
          ];
          const parent = node.parent;
          parent.removeAll();
          parent.append(retained);
          parsedEnd = node.source.end?.offset;
          semicolon = false;
        }
      }
      const open = blockOpeningOffset(node);
      const parentEnd =
        node.parent?.type === 'root'
          ? source.css.length
          : (node.parent?.source?.end?.offset ?? source.css.length) - 1;
      const end =
        open ??
        (semicolon && parsedEnd !== undefined ? parsedEnd - 1 : parentEnd);
      let paramsStart = start + node.name.length + 1;
      while (paramsStart < end && /\s/.test(source.css[paramsStart]))
        paramsStart++;
      let paramsEnd = end;
      while (paramsEnd > paramsStart && /\s/.test(source.css[paramsEnd - 1]))
        paramsEnd--;
      node.raws.afterName = source.css.slice(
        start + node.name.length + 1,
        paramsStart,
      );
      node.params = source.css.slice(paramsStart, paramsEnd);
      node.raws.between = source.css.slice(paramsEnd, end);
      delete node.raws.params;

      if (!node.nodes && !semicolon) {
        const name = node.name.endsWith(':')
          ? node.name.slice(0, -1)
          : node.name;
        const known =
          knownAtRuleRegex.test(name) ||
          keyframesRegex.test(node.name) ||
          /^([-\w]+)?document$/.test(node.name) ||
          PAGE_MARGIN_BOX_NAMES.has(node.name) ||
          (node.name === 'layer' &&
            /^@layer *([^{;@]+)/.test(source.css.slice(start, end)));
        const cursor = known ? end : paramsStart;
        if (!known) {
          node.params = '';
          node.raws.between = '';
        }
        const point = source.pointAt(cursor);
        node.source.end = {
          line: point.line,
          column: point.column - 1,
          offset: cursor,
        };
      }
    }
    if (node.type === 'rule' || node.type === 'atrule') containers.push(node);
  });
  for (let index = containers.length - 1; index >= 0; index--) {
    restoreContainer(containers[index]);
  }
}

function commentAt(
  root: postcss.Root,
  source: CompatibilitySource,
  start: number,
  end: number,
): postcss.Comment {
  const closed = source.css.slice(end - 2, end) === '*/';
  const comment = postcss.comment({
    text: source.css.slice(start + 2, closed ? end - 2 : end),
  });
  if (root.source) {
    comment.source = {
      input: root.source.input,
      start: { ...source.pointAt(start), offset: start },
      end: { ...source.pointAt(end - 1), offset: end },
    };
  }
  return comment;
}

function genericStatementAt(
  root: postcss.Root,
  source: CompatibilitySource,
  start: number,
  until: number,
): postcss.AtRule | undefined {
  const keyword = /^@([-\w]+)\s*/.exec(source.css.slice(start, until));
  const name = keyword?.[1];
  if (
    !keyword ||
    !name ||
    knownAtRuleRegex.test(name) ||
    name === 'layer' ||
    name === 'custom-media' ||
    keyframesRegex.test(name) ||
    /^([-\w]+)?document$/.test(name) ||
    PAGE_MARGIN_BOX_NAMES.has(name)
  )
    return;
  const end = start + keyword[0].length;
  const point = source.pointAt(end);
  const statement = postcss.atRule({ name, params: '' });
  statement.raws.afterName = keyword[0].slice(name.length + 1);
  if (root.source) {
    statement.source = {
      input: root.source.input,
      start: { ...source.pointAt(start), offset: start },
      end: { line: point.line, column: point.column - 1, offset: end },
    };
  }
  return statement;
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

function recoveryRule(
  node: postcss.Rule | postcss.AtRule,
  source: CompatibilitySource,
  start: number,
  open: number,
): postcss.Rule {
  const rule = postcss.rule({
    selector: source.css.slice(start, open),
    nodes: node.nodes,
    source: node.source,
  });
  rule.raws.between = '';
  rule.raws.semicolon = node.raws.semicolon;
  if (node.source) {
    rule.source = {
      ...node.source,
      start: { ...source.pointAt(start), offset: start },
    };
  }
  return rule;
}

function recoverRootText(
  root: postcss.Root,
  source: CompatibilitySource,
  errors: CssParseError[],
  from: number,
  until: number,
): void {
  const { css } = source;
  for (let offset = from; offset < until; offset++) {
    if (/\s/.test(css[offset])) continue;
    if (css.startsWith('/*', offset)) {
      const close = css.indexOf('*/', offset + 2);
      if (close !== -1) {
        root.append(commentAt(root, source, offset, close + 2));
        offset = close + 1;
        continue;
      }
      errors.push(source.error('End of comment missing', offset));
    }
    errors.push(
      source.error(
        css[offset] === '}' ? "extra '}'" : 'selector missing',
        offset,
      ),
    );
  }
}

function recoverBodyText(
  root: postcss.Root,
  parent: postcss.Container,
  source: CompatibilitySource,
  errors: CssParseError[],
  from: number,
  until: number,
  preserveComments: boolean,
): void {
  const { css } = source;
  let cursor = from;
  // V4 attempts a declaration after a failed at-rule, even at a comment.
  while (cursor < until) {
    while (cursor < until && /[;\s]/.test(css[cursor])) cursor++;
    if (cursor >= until) break;
    const start = cursor;
    const property = propertyPrefixRegex.exec(css.slice(cursor, until));
    if (property) {
      cursor += property[0].length;
      if (css[cursor] === ':') {
        cursor++;
        while (cursor < until && /\s/.test(css[cursor])) cursor++;
        const valueStart = cursor;
        const relativeEnd = declarationValueEnd(
          css.slice(valueStart, until + Number(css[until] === '}')),
          preserveComments,
        );
        if (relativeEnd !== -1) cursor += relativeEnd;
        const declaration = postcss.decl({
          prop: property[1],
          value: trim(css.slice(valueStart, cursor)),
        });
        declaration.raws.between = css.slice(
          start + property[1].length,
          valueStart,
        );
        if (root.source) {
          declaration.source = {
            input: root.source.input,
            start: { ...source.pointAt(start), offset: start },
            end: { ...source.pointAt(cursor), offset: cursor + 1 },
          };
        }
        parent.append(declaration);
        continue;
      }
      errors.push(source.error("property missing ':'", cursor));
    }
    const semicolon = css.indexOf(';', cursor);
    const close = css.indexOf('}', cursor);
    if (
      semicolon === -1 ||
      semicolon >= until ||
      (close !== -1 && close < semicolon)
    )
      break;
    cursor = semicolon + 1;
  }
  parent.nodes?.sort(
    (a, b) => (a.source?.start?.offset ?? 0) - (b.source?.start?.offset ?? 0),
  );
}

function collectCompatibilityErrors(
  source: CompatibilitySource,
  root: postcss.Root,
  silent: boolean,
  boundaryCSS: string,
  syntaxError?: postcss.CssSyntaxError,
): CssParseError[] {
  const { css } = source;
  const errors: CssParseError[] = [];
  const segments = splitTopLevelSegments(boundaryCSS).map((segment) => ({
    ...segment,
    text: css.slice(segment.offset, segment.offset + segment.text.length),
  }));
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
      if (css.startsWith('/*', offset)) {
        const close = css.indexOf('*/', offset + 2);
        const end = close === -1 ? until : close + 2;
        retainedRoots.push(commentAt(root, source, offset, end));
        offset = end - 1;
        continue;
      }
      if (css[offset] === '@') {
        const statement = genericStatementAt(root, source, offset, until);
        if (statement) {
          retainedRoots.push(statement);
          offset = statement.source?.end?.offset ?? offset + 1;
          offset--;
          continue;
        }
      }
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

  walkNodes(root, (container, index) => {
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
            ? `@${atRuleErrorName(container.name)} missing '}'`
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
        recoverRootText(root, source, errors, offset, end);
      }
    }

    function scanGap(cursor: number, until: number): number {
      while (cursor < until) {
        while (cursor < until && /\s/.test(css[cursor])) cursor++;
        if (cursor >= until) break;
        if (css.startsWith('/*', cursor)) {
          const close = css.indexOf('*/', cursor + 2);
          if (close !== -1 && close + 2 <= until) {
            retained.push(commentAt(root, source, cursor, close + 2));
            cursor = close + 2;
            continue;
          }
        }
        if (css[cursor] === '@') {
          const statement = genericStatementAt(root, source, cursor, until);
          if (statement) {
            retained.push(statement);
            cursor = statement.source?.end?.offset ?? cursor + 1;
            continue;
          }
        }
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
      if (child.type === 'decl' && cursor <= childStart) {
        cursor = scanGap(
          childStart,
          Math.min(child.source?.end?.offset ?? limit, limit),
        );
      }
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
    if (
      container.type === 'atrule' &&
      keyframesRegex.test(container.name) &&
      cursor < limit
    ) {
      stopAt(cursor);
      container.remove();
      return;
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
  preserveComments: boolean,
): void {
  const { css } = source;
  const recoveryEnds = new Map<postcss.Container, number>();
  walkNodes(root, (node) => {
    if (node.type !== 'comment') return;
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
  walkNodes(root, (node) => {
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
          node.type === 'atrule'
            ? `@${atRuleErrorName(node.name)} missing '}'`
            : "missing '}'",
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
    } else if (node.type === 'atrule') {
      const header = css.slice(start);
      let cursor: number | undefined;
      let reason = `@${node.name} missing '{'`;
      if (keyframesRegex.test(node.name)) {
        const keyword = /^@([-\w]+)?keyframes\s*/.exec(header);
        const identifier =
          keyword && /^([-\w]+)\s*/.exec(header.slice(keyword[0].length));
        if (keyword && !identifier) {
          cursor = start + keyword[0].length;
          reason = '@keyframes missing name';
        } else if (keyword && identifier && !node.nodes) {
          cursor = start + keyword[0].length + identifier[0].length;
          reason = "@keyframes missing '{'";
        }
      } else if (!node.nodes) {
        const prelude = blockPrelude(header);
        const named =
          /^@(?:property|position-try)\s+(--[-\w]+)\s*/.exec(header) ??
          /^@counter-style\s+([-\w]+)\s*/.exec(header);
        const keyword =
          /^(?:host|font-face|view-transition|starting-style)$/.test(
            node.name,
          ) || PAGE_MARGIN_BOX_NAMES.has(node.name)
            ? /^@[-\w]+\s*/.exec(header)
            : node.name === 'page'
              ? /^@page */.exec(header)
              : null;
        const matched = prelude ?? named ?? keyword;
        if (matched) {
          cursor = start + matched[0].length;
          if (/^([-\w]+)?document$/.test(node.name)) {
            reason = "@document missing '{'";
          }
        }
      }
      if (cursor === undefined) return;
      errors.push(source.error(reason, cursor));
      const parent = node.parent;
      const page =
        parent?.type === 'atrule' &&
        parent.name === 'page' &&
        parent.parent?.type === 'root'
          ? parent
          : undefined;
      const pageEnd = page?.source?.end?.offset;
      const parentEnd = parent?.source?.end?.offset ?? css.length;
      const recoveryEnd = Math.min(
        node.source?.end?.offset ?? parentEnd,
        parentEnd - Number(css[parentEnd - 1] === '}'),
      );
      const remaining = page?.nodes
        ?.slice((page.nodes?.indexOf(node) ?? -1) + 1)
        .filter((child) => child.type !== 'decl');
      node.remove();
      if (parent?.type === 'atrule' && parent.name === 'page') {
        errors.push(source.error("@page missing '}'", cursor));
        if (page && remaining) {
          page.removeAll();
          root.insertBefore(page, remaining);
        }
        parent.remove();
      }
      if (silent) {
        if (parent?.type === 'root' || page) {
          const nextBlock = root.nodes.find(
            (child) =>
              (child.source?.start?.offset ?? -1) >= cursor &&
              (child.type === 'rule' || child.type === 'atrule') &&
              child.nodes,
          );
          const open =
            nextBlock?.type === 'rule' || nextBlock?.type === 'atrule'
              ? blockOpeningOffset(nextBlock)
              : undefined;
          if (
            open !== undefined &&
            css[cursor] !== '{' &&
            (nextBlock?.type === 'rule' || nextBlock?.type === 'atrule')
          ) {
            const start = nextBlock.source?.start?.offset ?? cursor;
            const retained = root.nodes.filter(
              (child) =>
                child === nextBlock ||
                (child.source?.start?.offset ?? -1) < cursor ||
                (child.source?.start?.offset ?? -1) >= start,
            );
            root.removeAll();
            root.append(retained);
            nextBlock.replaceWith(
              recoveryRule(nextBlock, source, cursor, open),
            );
            const last = remaining?.[remaining.length - 1];
            const after = last?.source?.end?.offset;
            if (
              after !== undefined &&
              pageEnd !== undefined &&
              start < pageEnd &&
              after < pageEnd
            ) {
              recoverRootText(root, source, errors, after, pageEnd);
            }
            return;
          }
          const next = root.nodes.find(
            (child) => (child.source?.start?.offset ?? -1) >= cursor,
          );
          const until = next?.source?.start?.offset ?? css.length;
          if (css[cursor] === '}') {
            errors.push(source.error('selector missing', cursor));
          }
          recoverRootText(
            root,
            source,
            errors,
            cursor + Number(css[cursor] === '}'),
            until,
          );
          const last = remaining?.[remaining.length - 1];
          const after = last?.source?.end?.offset;
          if (after !== undefined && pageEnd !== undefined && after < pageEnd) {
            recoverRootText(root, source, errors, after, pageEnd);
          }
          if (cursor === css.length) {
            errors.push(source.error('selector missing', cursor));
          }
          return;
        }
        if (parent) {
          recoverBodyText(
            root,
            parent,
            source,
            errors,
            cursor,
            recoveryEnd,
            preserveComments,
          );
        }
      }
    }
  });
  root.nodes.sort(
    (a, b) => (a.source?.start?.offset ?? 0) - (b.source?.start?.offset ?? 0),
  );
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

type ConvertedNodes = WeakMap<
  postcss.ChildNode,
  CssAtRuleAST | CssDeclarationAST
>;

function convertRule(
  node: postcss.Rule,
  sourceName: string,
  convertedNodes: ConvertedNodes,
): CssRuleAST {
  const selectors = convertSelectors(node.selector);
  const declarations: Array<CssDeclarationAST | CssCommentAST | CssAtRuleAST> =
    [];

  for (const child of node.nodes ?? []) {
    const converted = convertedNodes.get(child);
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
  convertedNodes: ConvertedNodes,
): CssKeyframeAST {
  const values = node.selector.split(',').map((v) => trim(v));
  const declarations: Array<CssDeclarationAST | CssCommentAST> = [];

  for (const child of node.nodes ?? []) {
    const converted = convertedNodes.get(child);
    if (
      converted?.type === CssTypes.declaration ||
      converted?.type === CssTypes.comment
    ) {
      declarations.push(converted);
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
  convertedNodes: ConvertedNodes,
): CssKeyframesAST {
  const vendorMatch = keyframesRegex.exec(nameLower);
  const vendor = vendorMatch?.[1] || undefined;

  const keyframes: Array<CssKeyframeAST | CssCommentAST> = [];
  for (const child of node.nodes ?? []) {
    if (child.type === 'comment') {
      const converted = convertedNodes.get(child);
      if (converted?.type === CssTypes.comment) keyframes.push(converted);
    } else if (child.type === 'rule') {
      keyframes.push(convertKeyframe(child, sourceName, convertedNodes));
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
  convertedNodes: ConvertedNodes,
): Array<CssAtRuleAST | CssDeclarationAST> {
  const result: Array<CssAtRuleAST | CssDeclarationAST> = [];
  for (const child of nodes) {
    const converted = convertedNodes.get(child);
    if (converted) result.push(converted as CssAtRuleAST | CssDeclarationAST);
  }
  return result;
}

function convertDeclNodes(
  nodes: postcss.ChildNode[],
  convertedNodes: ConvertedNodes,
): Array<CssDeclarationAST | CssCommentAST> {
  const result: Array<CssDeclarationAST | CssCommentAST> = [];
  for (const child of nodes) {
    const converted = convertedNodes.get(child);
    if (
      converted?.type === CssTypes.declaration ||
      converted?.type === CssTypes.comment
    ) {
      result.push(converted);
    }
  }
  return result;
}

function convertAtRule(
  node: postcss.AtRule,
  sourceName: string,
  convertedNodes: ConvertedNodes,
): CssAtRuleAST {
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
    return convertKeyframes(
      node,
      nameLower,
      params,
      sourceName,
      convertedNodes,
    );
  }
  const hasPrelude = Boolean(
    params || node.raws.afterName || node.raws.between,
  );

  switch (nameLower) {
    case 'media':
      if (!hasPrelude) break;
      return {
        type: CssTypes.media,
        media: params,
        rules: convertBlockNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssMediaAST;

    case 'supports':
      if (!hasPrelude) break;
      return {
        type: CssTypes.supports,
        supports: params,
        rules: convertBlockNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssSupportsAST;

    case 'container':
      if (!hasPrelude) break;
      return {
        type: CssTypes.container,
        container: params,
        rules: convertBlockNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssContainerAST;

    case 'import':
      if (!hasPrelude) break;
      return {
        type: CssTypes.import,
        import: params,
        position: convertPos(node.source, sourceName),
      } as CssImportAST;

    case 'charset':
      if (!hasPrelude) break;
      return {
        type: CssTypes.charset,
        charset: params,
        position: convertPos(node.source, sourceName),
      } as CssCharsetAST;

    case 'namespace':
      if (!hasPrelude) break;
      return {
        type: CssTypes.namespace,
        namespace: params,
        position: convertPos(node.source, sourceName),
      } as CssNamespaceAST;

    case 'custom-media': {
      if (
        !/^--\S+\s+[^{;\s][^{;]*$/.test(params) ||
        node.source?.end?.offset === undefined ||
        node.source.input.css[node.source.end.offset - 1] !== ';'
      )
        break;
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
        declarations: convertDeclNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssFontFaceAST;

    case 'font-feature-values':
      return {
        type: CssTypes.fontFeatureValues,
        fontFamily: params,
        rules: convertBlockNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssFontFeatureValuesAST;

    case 'host':
      return {
        type: CssTypes.host,
        rules: convertBlockNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssHostAST;

    case 'layer': {
      if (!hasPrelude) break;
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
        rules: convertBlockNodes(node.nodes, convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssLayerAST;
    }

    case 'page': {
      const selectors = params ? convertSelectors(params) : [];
      const declarations: Array<
        CssDeclarationAST | CssCommentAST | CssAtRuleAST
      > = [];
      for (const child of node.nodes ?? []) {
        if (
          child.type === 'decl' ||
          child.type === 'comment' ||
          child.type === 'atrule'
        ) {
          const converted = convertedNodes.get(child);
          if (converted) declarations.push(converted);
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
        declarations: convertDeclNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssPropertyAST;

    case 'counter-style':
      return {
        type: CssTypes.counterStyle,
        name: params,
        declarations: convertDeclNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssCounterStyleAST;

    case 'scope':
      return {
        type: CssTypes.scope,
        scope: params,
        rules: convertBlockNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssScopeAST;

    case 'starting-style':
      return {
        type: CssTypes.startingStyle,
        rules: convertBlockNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssStartingStyleAST;

    case 'view-transition':
      return {
        type: CssTypes.viewTransition,
        declarations: convertDeclNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssViewTransitionAST;

    case 'position-try':
      return {
        type: CssTypes.positionTry,
        name: params,
        declarations: convertDeclNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssPositionTryAST;
  }

  // Document with optional vendor prefix (@-moz-document, @document)
  if (hasPrelude && /^([-\w]+)?document$/.test(nameLower)) {
    const vendorMatch = /^([-\w]+)?document$/.exec(nameLower);
    // v4 used "" (empty string) when no vendor prefix, not undefined
    const vendor = vendorMatch?.[1] ?? '';
    return {
      type: CssTypes.document,
      document: params,
      vendor,
      rules: convertBlockNodes(node.nodes ?? [], convertedNodes),
      position: convertPos(node.source, sourceName),
    } as CssDocumentAST;
  }

  // Page margin boxes (@top-left, @bottom-right, etc.)
  if (PAGE_MARGIN_BOX_NAMES.has(nameLower)) {
    return {
      type: CssTypes.pageMarginBox,
      name: nameLower,
      declarations: convertDeclNodes(node.nodes ?? [], convertedNodes),
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
    rules: convertBlockNodes(node.nodes, convertedNodes),
    position: convertPos(node.source, sourceName),
  } as CssGenericAtRuleAST;
}

function convertChildNode(
  child: postcss.ChildNode,
  sourceName: string,
  convertedNodes: ConvertedNodes,
): CssAtRuleAST | CssDeclarationAST | undefined {
  switch (child.type) {
    case 'rule':
      return convertRule(child, sourceName, convertedNodes);
    case 'atrule':
      return convertAtRule(child, sourceName, convertedNodes);
    case 'decl':
      return convertDeclaration(child as postcss.Declaration, sourceName);
    case 'comment':
      return convertComment(child as postcss.Comment, sourceName);
    default:
      return undefined;
  }
}

function addParent<T extends { type?: string }>(obj: T, parent?: unknown): T {
  const pending: Array<{ value: unknown; parent: unknown }> = [
    { value: obj, parent },
  ];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry?.value || typeof entry.value !== 'object') continue;
    const isNode =
      'type' in entry.value && typeof entry.value.type === 'string';
    if (isNode) {
      Object.defineProperty(entry.value, 'parent', {
        configurable: true,
        writable: true,
        enumerable: false,
        value: entry.parent ?? null,
      });
    }
    const childParent = isNode ? entry.value : entry.parent;
    for (const value of Object.values(entry.value)) {
      if (value && typeof value === 'object') {
        pending.push({ value, parent: childParent });
      }
    }
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
  const nodes: postcss.ChildNode[] = [];
  walkNodes(root, (node) => {
    nodes.push(node);
  });
  const convertedNodes: ConvertedNodes = new WeakMap();
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (
      node.type === 'rule' &&
      node.parent?.type === 'atrule' &&
      keyframesRegex.test(node.parent.name)
    )
      continue;
    const converted = convertChildNode(node, sourceName, convertedNodes);
    if (converted) convertedNodes.set(node, converted);
  }
  const rules: CssAtRuleAST[] = [];
  for (const node of root.nodes ?? []) {
    const converted = convertedNodes.get(node);
    if (converted) rules.push(converted as CssAtRuleAST);
  }
  if (stripCommentsInValues) stripValueComments(rules);
  return addParent({
    type: CssTypes.stylesheet,
    stylesheet: { source, rules, parsingErrors },
  } as CssStylesheetAST);
}

function stripValueComments(value: unknown): void {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if ('type' in current && current.type === CssTypes.declaration) {
      const declaration = current as CssDeclarationAST;
      declaration.value = declaration.value.replace(commentRegex, '');
    } else {
      for (const child of Object.values(current)) pending.push(child);
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
    walkNodes(root, (node) => {
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
    input.css,
    syntaxError,
  );
  recoverCompatibility(
    root,
    source,
    parsingErrors,
    silent,
    options?.stripCommentsInValues === false,
  );
  if (!silent) {
    const orphan = splitTopLevelSegments(input.css).find(
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
