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
const nonCssWhitespaceRegex = /[^\S\t\n\f\r ]/;
const propertyPrefixRegex = /^(\*?[-#/*\\\w]+(\[[0-9a-z_-]+\])?)\s*/;
// Sticky forms of V4's property and `:` matches, to read in place.
const propertyRegex = /\*?[-#/*\\\w]+(?:\[[0-9a-z_-]+\])?\s*/y;
const separatorRegex = /:\s*/y;
// Sticky forms of V4's keyframe value and `,` matches.
const keyframeValueRegex = /((?:\d+\.\d+|\.\d+|\d+)%?|[a-z]+)\s*/y;
const keyframeCommaRegex = /,\s*/y;
const atKeywordRegex = /@[-\w]+/y;
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
// V4 reads these at-rules only with a name or prelude after the at-keyword,
// and reads one without as a generic at-rule.
const namedHeaderRegexes = new Map([
  ['property', /@property\s+--[-\w]/y],
  ['position-try', /@position-try\s+--[-\w]/y],
  ['counter-style', /@counter-style\s+[-\w]/y],
  ['font-feature-values', /@font-feature-values\s[^{]/y],
  ['import', /@import[^;]/y],
  ['charset', /@charset[^;]/y],
  ['namespace', /@namespace[^;]/y],
]);
// The prelude of an `@custom-media` V4 reads: a name and a media query.
const customMediaRegex = /^--\S+\s+[^{;\s][^{;]*$/;
const postcssOptions: postcss.ProcessOptions = { map: false };

export interface ParseOptions {
  source?: string;
  silent?: boolean;
  stripCommentsInValues?: boolean;
}

function trim(str: string): string {
  return str ? str.trim() : '';
}

// Nodes in `skipped` are passed over together with their descendants.
function walkNodes(
  root: postcss.Container,
  visit: (node: postcss.ChildNode, index: number) => void,
  skipped?: ReadonlySet<postcss.ChildNode>,
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
    // Descendants can remove this node; advance only after their traversal.
    frame.visited = node;
    if (skipped?.has(node)) continue;
    visit(node, frame.index);
    if ((node.type === 'rule' || node.type === 'atrule') && node.nodes) {
      pending.push({ container: node, index: 0 });
    }
  }
}

function prepareCompatibilityInput(css: string): string {
  if (
    !css.includes('--') &&
    !css.includes('@') &&
    !nonCssWhitespaceRegex.test(css)
  )
    return css;
  const contexts: Array<{ nesting: boolean; keyframes: boolean }> = [];
  let nesting = true;
  let keyframes = false;
  let parentheses = 0;
  let brackets = 0;
  let quote = '';
  let start: number | undefined;
  let colon = false;
  let characters: string[] | undefined;

  // Equal-length masking preserves V4 token boundaries and source offsets.
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
    if (start === undefined) {
      if (/\s/.test(char)) {
        // The leading BOM is handled by the source-offset adjustment below.
        if (
          nonCssWhitespaceRegex.test(char) &&
          (offset !== 0 || char !== '\uFEFF')
        ) {
          mask(offset, offset + 1);
        }
      } else {
        start = offset;
        colon = false;
        // V4 reads whitespace after an at-keyword as whitespace, while
        // PostCSS reads non-CSS whitespace there into the at-keyword.
        atKeywordRegex.lastIndex = offset;
        if (char === '@' && atKeywordRegex.test(css)) {
          for (
            let end = atKeywordRegex.lastIndex;
            end < css.length && /\s/.test(css[end]);
            end++
          ) {
            if (nonCssWhitespaceRegex.test(css[end])) mask(end, end + 1);
          }
        }
      }
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
      const header =
        start !== undefined && css[start] === '@'
          ? css.slice(start, offset)
          : undefined;
      const name = header && /^@([-\w]+)/.exec(header)?.[1];
      if (nesting && start !== undefined && css.startsWith('--', start)) {
        characters ??= css.split('');
        characters[start] = '_';
        characters[start + 1] = '_';
      }
      // V4 reads the block of a root keyframes without a name as root text.
      const blockKeyframes =
        !!header &&
        !!name &&
        keyframesRegex.test(name) &&
        (contexts.length > 0 ||
          /^\s*[-\w]/.test(header.slice(name.length + 1)));
      contexts.push({ nesting, keyframes });
      nesting =
        !header || !name
          ? nesting && !keyframes
          : !blockKeyframes &&
            !(
              DECLARATION_ONLY_AT_RULES.has(name) &&
              !headerFails(name, header, 0)
            ) &&
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
  return characters?.join('') ?? css;
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
  private braceOffsets: number[] | undefined;
  private preludeStops:
    | { from: number; until: number; stops: Int32Array }
    | undefined;
  private selectorStops: Int32Array | undefined;
  private valueStops: Int32Array | undefined;
  private ruleStops: Int32Array | undefined;
  // Characters the whole-input searches may still scan directly before they
  // build their tables.
  private scanBudget: number;
  // Block at-rule preludes in source order; each ends at the next `{`.
  private readonly preludes: Array<{ start: number; end: number }> = [];
  // Top-level `}` offsets outside block at-rule preludes.
  readonly strayBraces: number[] = [];
  // Ascending `{` offsets of root rules without a selector: V4 reports each
  // and skips it, then reads the block content as root text.
  readonly skippedBraces: number[] = [];
  // Skipped braces that V4 instead reads as the opening of a rule after an
  // abandoned root block. The input is then parsed again keeping them.
  readonly braceConflicts: number[] = [];
  // Root keyframes without a name, from their `@` to their `{`: V4 reports
  // the name there and reads the rest like a rule without a selector.
  readonly namelessKeyframes = new Map<number, number>();
  // The first stray `}` outside every root node, where V4 stops strict parsing.
  orphanBrace: number | undefined;
  // PostCSS's unclosed bracket, reported only when nothing else is: V4 reads
  // brackets differently, but the input is still invalid.
  bracketError: CssParseError | undefined;
  // Where V4 reads a rule or an at-rule again after skipping the root text
  // after the last root node, which PostCSS reads all as one statement.
  rootResume: number | undefined;
  // Blocks V4 abandons at an unexpected token. Recovery still reports their
  // earlier children, then rules lose their content and at-rules are dropped.
  readonly abandoned = new Set<postcss.Rule | postcss.AtRule>();
  // Children of an abandoned root block that V4 reads as root nodes. They
  // stay in the block until recovery has visited them.
  readonly hoisted = new Set<postcss.ChildNode>();
  // The missing `}` reported where V4 stops reading an at-rule's body.
  readonly closingErrors = new Map<postcss.AtRule, CssParseError>();

  constructor(
    readonly css: string,
    readonly sourceName: string,
    // Braces of root rules without a selector that are not skipped.
    readonly keptBraces: ReadonlySet<number> = new Set(),
    // The input before any range was blanked to parse it again.
    readonly original: string = css,
  ) {
    this.scanBudget = css.length;
    for (
      let offset = css.indexOf('\n');
      offset !== -1;
      offset = css.indexOf('\n', offset + 1)
    ) {
      this.lineStarts.push(offset + 1);
    }
  }

  // Where V4 stops skipping `;` and whitespace from `offset`. A blanked
  // range stops it, as V4 reads other text there.
  semicolonsEnd(offset: number, until: number): number {
    while (offset < until && /[;\s]/.test(this.original[offset])) offset++;
    return offset;
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

  // Whether `other` breaks lines at the same offsets, so that a line and
  // column in either is the same offset in both.
  // Offset of the first `{` at or after `offset`, or the input length.
  nextBrace(offset: number): number {
    if (!this.braceOffsets) {
      this.braceOffsets = [];
      for (
        let brace = this.css.indexOf('{');
        brace !== -1;
        brace = this.css.indexOf('{', brace + 1)
      ) {
        this.braceOffsets.push(brace);
      }
    }
    let low = 0;
    let high = this.braceOffsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.braceOffsets[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return this.braceOffsets[low] ?? this.css.length;
  }

  // Whether V4 skipped the `{` at `offset` as a root rule without a selector.
  skippedBrace(offset: number): boolean {
    return this.nextSkippedBrace(offset) === offset;
  }

  // The first skipped `{` at or after `offset`, or -1.
  nextSkippedBrace(offset: number): number {
    const braces = this.skippedBraces;
    let low = 0;
    let high = braces.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (braces[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return braces[low] ?? -1;
  }

  addPrelude(start: number, end: number): void {
    this.preludes.push({ start, end });
  }

  // V4's generic at-rule prelude search from `offset`: the first `{` or `;`
  // before `until` outside quotes and parentheses, or -1. Searches in one
  // range share a table, so a range costs linear time however many search it.
  preludeStop(offset: number, until: number): number {
    if (offset >= until) return -1;
    let table = this.preludeStops;
    if (!table || table.until !== until || offset < table.from) {
      table = {
        from: offset,
        until,
        stops: preludeStops(this.css, offset, until),
      };
      this.preludeStops = table;
    }
    return table.stops[offset - table.from];
  }

  // The whole-input search for `stopChars` from `offset` by a direct scan,
  // or undefined once the scans have used up their budget. Valid input then
  // builds no table, and the searches stay linear in the input length.
  private scanStop(offset: number, stopChars: StopChars): number | undefined {
    if (this.scanBudget <= 0) return undefined;
    const until = Math.min(this.css.length, offset + this.scanBudget);
    const stop = bracketedIndex(this.css, offset, until, stopChars);
    this.scanBudget -= (stop === -1 ? until : stop + 1) - offset;
    return stop !== -1 || until === this.css.length ? stop : undefined;
  }

  // V4's selector search from `offset`: the first `{` outside quotes and
  // parentheses, or -1.
  selectorStop(offset: number): number {
    if (offset >= this.css.length) return -1;
    const stop = this.selectorStops ? undefined : this.scanStop(offset, '{');
    if (stop !== undefined) return stop;
    this.selectorStops ??= preludeStops(this.css, 0, this.css.length, '{');
    return this.selectorStops[offset];
  }

  // V4's declaration value search from `offset`: the first `;` or `}`
  // outside quotes and parentheses, or -1.
  valueStop(offset: number): number {
    if (offset >= this.css.length) return -1;
    const stop = this.valueStops ? undefined : this.scanStop(offset, ';}');
    if (stop !== undefined) return stop;
    this.valueStops ??= preludeStops(this.css, 0, this.css.length, ';}');
    return this.valueStops[offset];
  }

  // V4's check for a nested rule from `offset`: the first `{`, `;` or `}`
  // outside quotes and parentheses, or -1.
  ruleStop(offset: number): number {
    if (offset >= this.css.length) return -1;
    const stop = this.ruleStops ? undefined : this.scanStop(offset, '{;}');
    if (stop !== undefined) return stop;
    this.ruleStops ??= preludeStops(this.css, 0, this.css.length, '{;}');
    return this.ruleStops[offset];
  }

  // Whether V4 reads `offset` as block at-rule prelude text. Prelude ends
  // never decrease, so only the last prelude starting before it can match.
  inPrelude(offset: number): boolean {
    let low = 0;
    let high = this.preludes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.preludes[middle].start <= offset) low = middle + 1;
      else high = middle;
    }
    return low > 0 && offset < this.preludes[low - 1].end;
  }

  error(reason: string, offset: number): CssParseError {
    const point = this.pointAt(offset);
    // Texts parsed again keep the input length, so errors quote the input
    // itself and stay valid as they are in the outer parses.
    return new CssParseError(
      this.sourceName,
      reason,
      point.line,
      point.column,
      this.original.slice(offset),
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

// End of `blockPrelude(css.slice(start))`, without scanning to the next `{`.
// Whether it matches depends only on the at-keyword, the whitespace after it
// and the next character; a match always runs up to the next `{` or the end.
function blockPreludeEnd(
  source: CompatibilitySource,
  start: number,
): number | undefined {
  const { css } = source;
  if (css[start] !== '@') return undefined;
  let end = start + 1;
  while (end < css.length && /[-\w]/.test(css[end])) end++;
  while (end < css.length && /\s/.test(css[end])) end++;
  return blockPrelude(css.slice(start, end + 1))
    ? source.nextBrace(start)
    : undefined;
}

// Whether PostCSS ended a bodiless at-rule at a `}`, which closes its parent
// or is a stray at the root. V4 reads a block prelude on past that `}`.
function endsAtBrace(
  node: postcss.AtRule,
  css: string,
  start: number,
): boolean {
  let offset = node.source?.end?.offset ?? start + node.name.length + 1;
  while (offset < css.length && /\s/.test(css[offset])) offset++;
  return css[offset] === '}';
}

// V4's `@page` reads its selector up to the next `{` outside quotes and
// parentheses, across `;` and `}`. Returns that `{` when it ends a selector.
function pageSelectorEnd(
  source: CompatibilitySource,
  start: number,
): number | undefined {
  const { css } = source;
  if (!css.startsWith('@page', start)) return undefined;
  let from = start + 5;
  while (css[from] === ' ') from++;
  const brace = source.selectorStop(from);
  return brace > from ? brace : undefined;
}

// End of V4's `@import`, `@charset` or `@namespace` statement: past the first
// `;` outside quotes, the input end, or -1 when a quote is left open, as V4's
// regex then fails.
function statementEnd(css: string, start: number): number {
  let quote = '';
  for (let offset = start; offset < css.length; offset++) {
    const char = css[offset];
    if (quote) {
      if (char === '\\') offset++;
      else if (char === quote) quote = '';
    } else if (char === ';') return offset + 1;
    else if (char === '"' || char === "'") quote = char;
  }
  return quote ? -1 : css.length;
}

// The characters that end V4's selector, value and statement scans.
type StopChars = '{' | '{;' | ';}' | '{;}';

// First of `stops` in [from, until) outside quotes and parentheses, as V4's
// selector scan finds it, or -1.
function bracketedIndex(
  css: string,
  from: number,
  until: number,
  stops: StopChars,
): number {
  const brace = stops !== ';}';
  const semicolon = stops !== '{';
  const close = stops === ';}' || stops === '{;}';
  let quote = '';
  let depth = 0;
  for (let offset = from; offset < until; offset++) {
    const char = css[offset];
    if (char === '\\') offset++;
    else if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') {
      if (depth) depth--;
    } else if (
      !depth &&
      (char === '{' ? brace : char === ';' ? semicolon : char === '}' && close)
    )
      return offset;
  }
  return -1;
}

// `bracketedIndex(css, offset, until, stopChars)` for every offset in
// [from, until), right to left: a search that skips an escape, a quoted
// string or a parenthesized group goes on as a fresh search after it.
function preludeStops(
  css: string,
  from: number,
  until: number,
  stopChars: StopChars = '{;',
): Int32Array {
  const stops = new Int32Array(until - from);
  // First `)` that closes a group opened just before each offset.
  const closes = new Int32Array(until - from);
  const after = (table: Int32Array, end: number): number =>
    end === -1 || end + 1 >= until ? -1 : table[end + 1 - from];
  // Next unescaped quote of each kind from offset + 1 and offset + 2.
  let double1 = -1;
  let double2 = -1;
  let single1 = -1;
  let single2 = -1;
  for (let offset = until - 1; offset >= from; offset--) {
    const char = css[offset];
    const end =
      char === '\\'
        ? offset + 1
        : char === '"'
          ? double1
          : char === "'"
            ? single1
            : char === '('
              ? after(closes, offset)
              : offset;
    closes[offset - from] = char === ')' ? offset : after(closes, end);
    stops[offset - from] = stopChars.includes(char)
      ? offset
      : after(stops, end);
    [double1, double2] = [
      char === '\\' ? double2 : char === '"' ? offset : double1,
      double1,
    ];
    [single1, single2] = [
      char === '\\' ? single2 : char === "'" ? offset : single1,
      single1,
    ];
  }
  return stops;
}

function atRuleErrorName(name: string): string {
  if (keyframesRegex.test(name)) return 'keyframes';
  if (/^([-\w]+)?document$/.test(name)) return 'document';
  return name;
}

// The `{` of a keyframes block that V4 finds right after the keyword, where
// it reports a missing name and then a missing selector.
function namelessKeyframesOpening(
  node: postcss.AtRule,
  css: string,
): number | undefined {
  const start = node.source?.start?.offset;
  if (start === undefined || !node.nodes || !keyframesRegex.test(node.name))
    return undefined;
  let open = start + 1 + node.name.length;
  while (/\s/.test(css[open] ?? '')) open++;
  return css[open] === '{' && blockOpeningOffset(node) === open
    ? open
    : undefined;
}

// V4 matches a block at-rule without a usable body up to `cursor`, then
// fails with `reason`.
function atRuleMiss(
  node: postcss.AtRule,
  source: CompatibilitySource,
): { cursor: number; reason: string } | undefined {
  const start = node.source?.start?.offset ?? 0;
  const header = source.css.slice(start);
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
    const preludeEnd = blockPreludeEnd(source, start);
    const named =
      /^@(?:property|position-try)\s+(--[-\w]+)\s*/.exec(header) ??
      /^@counter-style\s+([-\w]+)\s*/.exec(header);
    const keyword =
      /^(?:host|font-face|view-transition|starting-style)$/.test(node.name) ||
      PAGE_MARGIN_BOX_NAMES.has(node.name)
        ? /^@[-\w]+\s*/.exec(header)
        : node.name === 'page'
          ? /^@page */.exec(header)
          : null;
    const matched = named ?? keyword;
    cursor = preludeEnd ?? (matched ? start + matched[0].length : undefined);
    if (cursor !== undefined && /^([-\w]+)?document$/.test(node.name)) {
      reason = "@document missing '{'";
    }
  }
  return cursor === undefined ? undefined : { cursor, reason };
}

// Whether V4 fails to match the header of the at-rule named `name` at
// `start`, as `@property` without a `--` name, and so reads it as a generic
// at-rule.
function headerFails(name: string, css: string, start: number): boolean {
  const header = namedHeaderRegexes.get(name);
  if (!header) return false;
  header.lastIndex = start;
  return !header.test(css);
}

// Whether V4 reads the bodiless `node` as a statement that ends where
// PostCSS ends it, at its `;`. V4 reads other ones on to a `{`, or fails.
function statementLikeV4(node: postcss.AtRule, css: string): boolean {
  const start = node.source?.start?.offset;
  const end = node.source?.end?.offset;
  if (start === undefined || end === undefined || css[end - 1] !== ';')
    return false;
  const { name } = node;
  return (
    /^(?:import|charset|namespace)$/.test(name) ||
    !(
      (knownAtRuleRegex.test(name) && !headerFails(name, css, start)) ||
      keyframesRegex.test(name) ||
      /^([-\w]+)?document$/.test(name) ||
      PAGE_MARGIN_BOX_NAMES.has(name)
    )
  );
}

// V4 matches a fixed header for some block at-rules, as `@font-face` or
// `@keyframes name`. Where text follows it before the `{`, V4 fails at that
// text with `reason`.
function headerMiss(
  node: postcss.AtRule,
  css: string,
): { cursor: number; reason: string } | undefined {
  const start = node.source?.start?.offset;
  const open = blockOpeningOffset(node);
  if (start === undefined || open === undefined || css[open] !== '{') return;
  const { name } = node;
  const header = css.slice(start, open);
  let reason = `@${name} missing '{'`;
  let matched: string | undefined;
  if (keyframesRegex.test(name)) {
    const keyword = /^@([-\w]+)?keyframes\s*/.exec(header);
    if (!keyword) return;
    const identifier = /^([-\w]+)\s*/.exec(header.slice(keyword[0].length));
    if (!identifier) reason = '@keyframes missing name';
    else reason = "@keyframes missing '{'";
    matched = keyword[0] + (identifier?.[0] ?? '');
  } else if (
    /^(?:host|font-face|view-transition|starting-style)$/.test(name) ||
    PAGE_MARGIN_BOX_NAMES.has(name)
  ) {
    matched = /^@[-\w]+\s*/.exec(header)?.[0];
  } else if (name === 'property' || name === 'position-try') {
    matched = /^@[-\w]+\s+--[-\w]+\s*/.exec(header)?.[0];
  } else if (name === 'counter-style') {
    matched = /^@counter-style\s+[-\w]+\s*/.exec(header)?.[0];
  }
  if (matched === undefined || matched.length >= header.length) return;
  return { cursor: start + matched.length, reason };
}

// The end of the keyframe selector V4 matches at `offset`, values such as
// `from` or `50%` with `,` and whitespace after each, or -1 where it
// matches none.
function keyframeSelectorEnd(css: string, offset: number): number {
  const digitsEnd = (from: number): number => {
    while (/\d/.test(css[from] ?? '')) from++;
    return from;
  };
  let matched = -1;
  for (;;) {
    let at = offset;
    if (/[a-z]/.test(css[at] ?? '')) {
      while (/[a-z]/.test(css[at] ?? '')) at++;
    } else {
      const whole = digitsEnd(at);
      if (whole > at && css[whole] === '.' && digitsEnd(whole + 1) > whole + 1)
        at = digitsEnd(whole + 1);
      else if (whole > at) at = whole;
      else if (css[at] === '.' && digitsEnd(at + 1) > at + 1)
        at = digitsEnd(at + 1);
      else return matched;
      if (css[at] === '%') at++;
    }
    while (/\s/.test(css[at] ?? '')) at++;
    if (css[at] === ',') at++;
    while (/\s/.test(css[at] ?? '')) at++;
    matched = offset = at;
  }
}

// Whether V4's keyframes reader takes the block at-rule `node` and fails
// where PostCSS reads on: V4 reads only its own header, then keyframes
// with selectors it matches and declarations, between whitespace and
// comments, up to the closing `}`.
function keyframesMiss(node: postcss.AtRule, css: string): boolean {
  if (!/^[-\w]*keyframes/.test(node.name)) return false;
  const start = node.source?.start?.offset;
  const open = blockOpeningOffset(node);
  const end = node.source?.end?.offset;
  if (
    start === undefined ||
    open === undefined ||
    end === undefined ||
    css[open] !== '{' ||
    css[end - 1] !== '}'
  )
    return true;
  const header = css.slice(start, open);
  const keyword = /^@([-\w]+)?keyframes\s*/.exec(header);
  const identifier =
    keyword && /^([-\w]+)\s*/.exec(header.slice(keyword[0].length));
  if (!identifier || keyword[0].length + identifier[0].length < header.length)
    return true;
  let offset = open + 1;
  for (const child of node.nodes ?? []) {
    while (/\s/.test(css[offset] ?? '')) offset++;
    const childEnd = child.source?.end?.offset;
    if (child.source?.start?.offset !== offset || childEnd === undefined)
      return true;
    if (child.type === 'comment') {
      if (childEnd - offset < 4 || !css.startsWith('*/', childEnd - 2))
        return true;
    } else if (
      child.type !== 'rule' ||
      keyframeSelectorEnd(css, offset) !== blockOpeningOffset(child) ||
      css[childEnd - 1] !== '}' ||
      child.nodes.some(
        (decl) => decl.type !== 'decl' && decl.type !== 'comment',
      )
    )
      return true;
    offset = childEnd;
  }
  while (/\s/.test(css[offset] ?? '')) offset++;
  return offset !== end - 1;
}

// V4 has no at-rule for a name that does not start with `[-\w]`, as in
// `@@media x{}`. It reads such a block at-rule as a rule, and one without a
// block inside a block as text that is not a declaration. After the last
// block V4 finds no `{` for a rule, so it skips one character at a time and
// reads the at-rule that starts at the first `@` followed by `[-\w]`.
function readInvalidAtRules(
  root: postcss.Root,
  source: CompatibilitySource,
): void {
  const { css } = source;
  // Every at-rule still starts at an `@` of the input here.
  if (!/@(?![-\w])/.test(css)) return;
  const invalid = (node: postcss.ChildNode): node is postcss.AtRule => {
    const start = node.source?.start?.offset;
    return (
      node.type === 'atrule' &&
      start !== undefined &&
      !/[-\w]/.test(css[start + 1] ?? '')
    );
  };
  const dropped = new Set<postcss.ChildNode>();
  walkNodes(root, (node, index) => {
    const parent = node.parent as postcss.Container | undefined;
    if (!invalid(node) || !node.source || !parent?.nodes) return;
    if (!node.nodes) {
      if (parent.type !== 'root') dropped.add(node);
      return;
    }
    const parentName =
      parent.type === 'atrule' ? (parent as postcss.AtRule).name : '';
    if (
      (DECLARATION_ONLY_AT_RULES.has(parentName) &&
        !headerFails(parentName, css, parent.source?.start?.offset ?? 0)) ||
      keyframesRegex.test(parentName) ||
      PAGE_MARGIN_BOX_NAMES.has(parentName)
    )
      return;
    const start = node.source.start?.offset ?? 0;
    const open = blockOpeningOffset(node);
    if (open === undefined || css[open] !== '{') return;
    const rule = postcss.rule({
      selector: css.slice(start, open),
      source: node.source,
    });
    rule.raws.before = node.raws.before;
    rule.raws.between = '';
    rule.raws.semicolon = node.raws.semicolon;
    rule.raws.after = node.raws.after;
    const children = node.nodes;
    node.nodes = [];
    rule.nodes = children;
    for (const child of children) child.parent = rule;
    parent.nodes[index] = rule;
    rule.parent = node.parent;
    node.parent = undefined;
  });
  const parents = new Set<postcss.Container>();
  for (const node of dropped) parents.add(node.parent as postcss.Container);
  for (const parent of parents) {
    const retained = parent.nodes?.filter((node) => !dropped.has(node)) ?? [];
    parent.removeAll();
    parent.append(retained);
  }
  for (let index = root.nodes.length - 1; index >= 0; index--) {
    const node = root.nodes[index];
    if ((node.type === 'rule' || node.type === 'atrule') && node.nodes) return;
    if (!invalid(node) || !node.source) continue;
    const start = node.source.start?.offset ?? 0;
    const end = node.source.end?.offset ?? css.length;
    let at = start + 1;
    for (let comment = false; at < end; at++) {
      if (comment) {
        if (css[at] === '*' && css[at + 1] === '/') {
          comment = false;
          at++;
        }
      } else if (css[at] === '/' && css[at + 1] === '*') {
        comment = true;
        at++;
      } else if (css[at] === '@' && /[-\w]/.test(css[at + 1] ?? '')) {
        break;
      }
    }
    if (at >= end) continue;
    // The at-word PostCSS would read from there.
    let wordEnd = at + 1;
    while (wordEnd < end && !/[\t\n\f\r "#'()/;[\\\]{}]/.test(css[wordEnd]))
      wordEnd++;
    node.name = css.slice(at + 1, wordEnd);
    node.source.start = { ...source.pointAt(at), offset: at };
  }
}

// Restore V4 boundaries and raw fields from the unmodified input.
function restoreCompatibilitySpans(
  root: postcss.Root,
  source: CompatibilitySource,
  preserveComments: boolean,
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
  // Siblings merged into a preceding bodiless at-rule; removed after the walk.
  const merged = new Set<postcss.ChildNode>();
  const mergedParents = new Set<postcss.Container>();
  const removeMerged = (parent: postcss.Container): void => {
    if (!mergedParents.delete(parent)) return;
    const retained = parent.nodes?.filter((node) => !merged.has(node)) ?? [];
    parent.removeAll();
    parent.append(retained);
  };
  // Containers before this index, except the root, are restored.
  let restored = 1;
  // Restores the walked subtrees, deepest first, so that root nodes get the
  // ends V4 reads before the walk visits the next root node.
  const restoreWalked = (): void => {
    for (let index = containers.length - 1; index >= restored; index--) {
      removeMerged(containers[index]);
      restoreContainer(containers[index]);
    }
    restored = containers.length;
  };
  let previousRootNode: postcss.ChildNode | undefined;
  // Root text before this offset was read by V4 as a skipped `{`.
  let rootFloor = 0;
  // Bounds the root nodes moved by unwrapping, keeping the restore linear.
  let unwrapBudget = source.css.length;
  // End of the last visited child of each container.
  const lastEnds = new Map<postcss.Container, number>();
  // Where V4 reads on after `node`, which ends at `end`.
  const readOnFrom = (node: postcss.ChildNode, end: number): number =>
    node.parent &&
    skipsSemicolons(node, source.css) &&
    (node.parent.type === 'root' || readsAtRules(node.parent, source.css))
      ? source.semicolonsEnd(end, source.css.length)
      : end;
  // V4 reads text before this offset as `@import`-like statement params.
  let statementsEnd = 0;
  // A root at-rule failed: V4 then reads a rule up to the next `{`.
  let pendingMiss = false;
  // Root text that is not a statement: V4 reads a rule up to the next `{`.
  let rootJunk = false;
  // A root statement ended at `}`: V4 reads its prelude on to a `;` or `{`.
  let runOn = false;
  // A nested statement ended its block at `}`: V4 blocks no longer align.
  let desync = false;
  const reached = (parent: postcss.Container, start: number): boolean =>
    !desync && start >= statementsEnd && !(parent.type === 'root' && runOn);
  const formed = new Map<postcss.Container, boolean>();
  // Whether V4 opens this block at the same `{` and parses at-rules in it.
  // Every V4 block at-rule reads its body as rules, generic ones included.
  const formedLikeV4 = (container: postcss.Container): boolean => {
    let result = formed.get(container);
    if (result === undefined) {
      const start = container.source?.start?.offset;
      const open =
        container.type === 'rule' || container.type === 'atrule'
          ? blockOpeningOffset(container as postcss.Rule | postcss.AtRule)
          : undefined;
      result =
        start !== undefined &&
        open !== undefined &&
        (container.type === 'rule'
          ? start < open &&
            bracketedIndex(
              source.css,
              start,
              open + 1,
              container.parent?.type === 'root' ? '{' : '{;}',
            ) === open
          : blockPreludeEnd(source, start) === open ||
            chainReader(container as postcss.AtRule, source.css) === 'rules');
      formed.set(container, result);
    }
    return result;
  };
  // Whether V4 reads this bodiless block at-rule, whose prelude then runs up
  // to `cursor`: a `{` at another level or inside a token, or the input end.
  const reachesMiss = (
    parent: postcss.Container,
    start: number,
    cursor: number,
  ): boolean => {
    const { css } = source;
    if (!reached(parent, start)) return false;
    const atRoot = parent.type === 'root';
    const open = atRoot
      ? -1
      : blockOpeningOffset(parent as postcss.Rule | postcss.AtRule);
    if (open === undefined) return false;
    const gap = Math.max(lastEnds.get(parent) ?? open + 1, statementsEnd);
    if (atRoot) {
      if (cursor === css.length) return true;
      // Text before the at-rule starts a V4 rule that reads up to the `{`.
      if (pendingMiss) return false;
      for (let offset = gap; offset < start; offset++) {
        if (!/\s/.test(css[offset]) && css[offset] !== '}') return false;
      }
      return true;
    }
    if (cursor !== css.length) return false;
    // Silent V4 skips a `;` after a nested block, except in a `@page` body.
    const skipsSemicolon =
      readsAtRules(parent, css) &&
      !(parent.type === 'atrule' && (parent as postcss.AtRule).name === 'page');
    for (let offset = gap; offset < start; offset++) {
      if (!/\s/.test(css[offset]) && !(skipsSemicolon && css[offset] === ';'))
        return false;
    }
    for (
      let ancestor: postcss.Container | undefined = parent;
      ancestor && ancestor.type !== 'root';
      ancestor = ancestor.parent as postcss.Container | undefined
    ) {
      if (!formedLikeV4(ancestor)) return false;
    }
    return true;
  };
  // Without a `;`, V4 reads a root `@import`, `@charset` or `@namespace` on
  // to the next `;` or the input end, so its params also take what PostCSS
  // parsed as its block or as following siblings. A node cut after its last
  // `;` leaves V4 only `}` to read: each is a stray. Returns false for other
  // cuts.
  const consumeStatement = (
    node: postcss.AtRule,
    index: number,
    start: number,
    parsedEnd: number,
    end: number,
  ): boolean => {
    const { css } = source;
    const keywordEnd = start + 1 + node.name.length;
    const stop = css[end - 1] === ';' ? end - 1 : end;
    if (keywordEnd >= stop || !node.source) return false;
    const strays: number[] = [];
    const closesAt = (until: number): boolean => {
      for (let offset = end; offset < until; offset++) {
        if (css[offset] === '}') strays.push(offset);
        else if (!/\s/.test(css[offset])) return false;
      }
      return css[until - 1] === '}';
    };
    // Whether a comment kept in raws runs past `end`: PostCSS has no nodes
    // for the CSS that V4 reads after the statement.
    const commentStraddles = (from: number): boolean => {
      for (let offset = from; offset < end; offset++) {
        const char = css[offset];
        if (char === '"' || char === "'") {
          for (offset++; offset < end && css[offset] !== char; offset++) {
            if (css[offset] === '\\') offset++;
          }
        } else if (char === '/' && css[offset + 1] === '*') {
          offset += 2;
          while (
            offset < end - 1 &&
            !(css[offset] === '*' && css[offset + 1] === '/')
          )
            offset++;
          if (offset >= end - 1) return true;
          offset++;
        }
      }
      return false;
    };
    const siblings = root.nodes;
    let consumed = index + 1;
    if (parsedEnd > end) {
      if (!closesAt(parsedEnd)) return false;
    } else {
      let cursor = parsedEnd;
      for (; consumed < siblings.length; consumed++) {
        const siblingStart = siblings[consumed].source?.start?.offset;
        // Unclosed blocks have no end; they run to the input end.
        const siblingEnd = siblings[consumed].source?.end?.offset ?? css.length;
        if (siblingStart === undefined) return false;
        if (siblingStart >= end) break;
        cursor = siblingEnd;
        if (siblingEnd > end) {
          if (!closesAt(siblingEnd)) return false;
          consumed++;
          break;
        }
      }
      if (commentStraddles(cursor)) return false;
    }
    if (node.nodes) {
      node.removeAll();
      node.nodes = undefined;
    }
    let paramsStart = keywordEnd;
    while (paramsStart < stop && /\s/.test(css[paramsStart])) paramsStart++;
    let paramsEnd = stop;
    while (paramsEnd > paramsStart && /\s/.test(css[paramsEnd - 1]))
      paramsEnd--;
    node.raws.afterName = css.slice(keywordEnd, paramsStart);
    node.params = css.slice(paramsStart, paramsEnd);
    node.raws.between = css.slice(paramsEnd, stop);
    delete node.raws.params;
    const point = source.pointAt(end);
    node.source.end = {
      line: point.line,
      column: point.column - 1,
      offset: end,
    };
    for (const sibling of siblings.slice(index + 1, consumed)) {
      merged.add(sibling);
    }
    if (consumed > index + 1) mergedParents.add(root);
    source.strayBraces.push(...strays);
    return true;
  };
  // Moves the children of a root rule without a selector to the root, so
  // the walk visits them as root nodes. Its `}` is then a stray.
  const unwrap = (
    node: postcss.Rule | postcss.AtRule,
    index: number,
    start: number,
  ): boolean => {
    const children = node.nodes ?? [];
    if (!children.length) {
      merged.add(node);
      mergedParents.add(root);
    } else if (children.length > 1) {
      const cost = root.nodes.length + children.length;
      if (cost > unwrapBudget) return false;
      unwrapBudget -= cost;
      root.nodes = root.nodes
        .slice(0, index)
        .concat(children, root.nodes.slice(index + 1));
    } else {
      root.nodes[index] = children[0];
    }
    for (const child of children) child.parent = root;
    if (children.length) {
      node.nodes = [];
      node.parent = undefined;
    }
    const parsedEnd = node.source?.end?.offset;
    const end =
      parsedEnd === undefined
        ? undefined
        : parsedEnd -
          ((node.type === 'rule' && node.raws.ownSemicolon?.length) || 0);
    if (end !== undefined && source.css[end - 1] === '}') {
      source.strayBraces.push(end - 1);
    }
    source.skippedBraces.push(start);
    previousRootNode = undefined;
    rootFloor = start + 1;
    lastEnds.set(root, start + 1);
    return true;
  };
  const restoreNode = (node: postcss.ChildNode, index: number): void => {
    const start = node.source?.start?.offset;
    const parsedStatementEnd = node.source?.end?.offset;
    let terminated =
      parsedStatementEnd !== undefined &&
      source.css[parsedStatementEnd - 1] === ';';
    if (node.parent === root) {
      restoreWalked();
    }
    // Other text before a root node starts a V4 rule that reads up to a `{`.
    const previousEnd = previousRootNode?.source?.end?.offset;
    const gapJunk =
      node.parent === root &&
      start !== undefined &&
      /[^\s}]/.test(
        source.css.slice(
          Math.max(
            previousRootNode && previousEnd !== undefined
              ? readOnFrom(previousRootNode, previousEnd)
              : 0,
            rootFloor,
            statementsEnd,
          ),
          start,
        ),
      );
    if (
      node.type === 'rule' &&
      node.parent === root &&
      start !== undefined &&
      source.css[start] === '{' &&
      !node.selector.trim() &&
      !source.keptBraces.has(start) &&
      !gapJunk &&
      !rootJunk &&
      !pendingMiss &&
      reached(root, start) &&
      unwrap(node, index, start)
    ) {
      return;
    }
    if (
      node.type === 'atrule' &&
      node.parent === root &&
      start !== undefined &&
      !gapJunk &&
      !rootJunk &&
      !pendingMiss &&
      reached(root, start)
    ) {
      const open = namelessKeyframesOpening(node, source.css);
      if (
        open !== undefined &&
        !source.keptBraces.has(open) &&
        unwrap(node, index, open)
      ) {
        source.namelessKeyframes.set(start, open);
        return;
      }
    }
    if (node.parent === root) previousRootNode = node;
    if (node.type === 'rule' && start !== undefined) {
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
    } else if (node.type === 'atrule' && start !== undefined && node.source) {
      let parsedEnd = node.source.end?.offset;
      let semicolon =
        parsedEnd !== undefined && source.css[parsedEnd - 1] === ';';
      const parent = node.parent;
      const page =
        node.name === 'page' &&
        parent !== undefined &&
        (parent.type === 'root' || readsAtRules(parent, source.css));
      const cursor =
        !node.nodes && (semicolon || endsAtBrace(node, source.css, start))
          ? (blockPreludeEnd(source, start) ??
            (page ? pageSelectorEnd(source, start) : undefined))
          : undefined;
      // V4 reads the prelude up to the next `{`, consuming siblings before it.
      let consumedEnd: number | undefined;
      if (cursor !== undefined && parent?.nodes) {
        const siblings = parent.nodes;
        let bodyIndex = -1;
        let consumed = index + 1;
        for (let next = index + 1; next < siblings.length; next++) {
          const sibling = siblings[next];
          const siblingStart = sibling.source?.start?.offset;
          if (siblingStart === undefined) continue;
          if (siblingStart > cursor) break;
          if (
            (sibling.type === 'rule' || sibling.type === 'atrule') &&
            blockOpeningOffset(sibling) === cursor
          ) {
            bodyIndex = next;
            break;
          }
          if (siblingStart < cursor) consumed = next + 1;
        }
        const body = siblings[bodyIndex];
        if (body?.type === 'rule' || body?.type === 'atrule') {
          if (reached(parent, start)) source.addPrelude(start, cursor);
          const children = [...(body.nodes ?? [])];
          body.removeAll();
          node.nodes = [];
          node.append(children);
          node.source.end = body.source?.end;
          // A rule's end covers a `;` after its `}`, which the block leaves.
          const suffix = body.type === 'rule' ? body.raws.ownSemicolon : '';
          const bodyEnd = node.source.end?.offset;
          if (suffix && bodyEnd !== undefined) {
            const offset = bodyEnd - suffix.length;
            node.source.end = { ...source.pointAt(offset - 1), offset };
          }
          node.raws.semicolon = body.raws.semicolon;
          node.raws.afterName = '';
          node.params = source.css.slice(start + node.name.length + 1, cursor);
          node.raws.between = '';
          delete node.raws.params;
          for (const sibling of siblings.slice(index + 1, bodyIndex + 1)) {
            merged.add(sibling);
          }
          mergedParents.add(parent);
          parsedEnd = node.source.end?.offset;
          semicolon = false;
        } else if (!page && reachesMiss(parent, start, cursor)) {
          source.addPrelude(start, cursor);
          consumedEnd = Math.max(parsedEnd ?? cursor, cursor);
          for (const sibling of siblings.slice(index + 1, consumed)) {
            merged.add(sibling);
            consumedEnd = Math.max(
              consumedEnd,
              sibling.source?.end?.offset ?? consumedEnd,
            );
          }
          if (consumed > index + 1) mergedParents.add(parent);
          // A prelude up to the input end also takes the `}` of each
          // ancestor: V4 closes none of them and reads nothing after it.
          for (
            let ancestor: postcss.Container = parent;
            cursor === source.css.length && ancestor.parent;
            ancestor = ancestor.parent as postcss.Container
          ) {
            if (ancestor.source) delete ancestor.source.end;
            const outer = ancestor.parent as postcss.Container;
            const following =
              outer.nodes?.slice(
                outer.index(ancestor as postcss.ChildNode) + 1,
              ) ?? [];
            for (const sibling of following) merged.add(sibling);
            if (following.length) mergedParents.add(outer);
          }
        }
      }
      const open = blockOpeningOffset(node);
      // An unclosed parent runs to the input end, without a `}`.
      const parentClose = node.parent?.source?.end?.offset;
      const parentEnd =
        node.parent?.type === 'root' || parentClose === undefined
          ? source.css.length
          : parentClose - 1;
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
          (knownAtRuleRegex.test(name) &&
            !headerFails(name, source.css, start)) ||
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
      if (consumedEnd !== undefined && consumedEnd !== parsedEnd) {
        node.source.end = {
          ...source.pointAt(consumedEnd - 1),
          offset: consumedEnd,
        };
      }
      if (
        start >= statementsEnd &&
        /^(?:import|charset|namespace)/.test(node.name)
      ) {
        const end = statementEnd(source.css, start);
        if (
          end !== -1 &&
          !terminated &&
          /^(?:import|charset|namespace):?$/.test(node.name) &&
          node.parent === root &&
          reached(root, start) &&
          !pendingMiss &&
          !rootJunk &&
          !gapJunk &&
          consumeStatement(
            node,
            index,
            start,
            parsedStatementEnd ?? source.css.length,
            end,
          )
        ) {
          terminated = true;
        }
        statementsEnd = end === -1 ? source.css.length : end;
      }
    }
    if (node.parent === root && start !== undefined) {
      const miss =
        node.type === 'atrule' &&
        !node.nodes &&
        /[-\w]/.test(source.css[start + 1] ?? '') &&
        blockPreludeEnd(source, start) === undefined
          ? atRuleMiss(node, source)
          : undefined;
      // V4's rule() then fails at a `}` after the miss and skips it.
      if (
        miss &&
        source.css[miss.cursor] === '}' &&
        reachesMiss(root, start, miss.cursor)
      ) {
        source.addPrelude(miss.cursor, miss.cursor + 1);
      }
      if (gapJunk || node.type === 'decl') rootJunk = true;
      if ((node.type === 'rule' || node.type === 'atrule') && node.nodes) {
        pendingMiss = false;
        rootJunk = false;
        runOn = false;
      } else if (node.type === 'atrule' || node.type === 'decl') {
        runOn = !terminated && (node.type === 'atrule' || runOn);
      }
      if (node.type === 'atrule' && !node.nodes) {
        if (!/[-\w]/.test(source.css[start + 1] ?? '')) {
          // No V4 at-rule matches, so V4 reads it as a rule.
          pendingMiss = true;
        } else if (miss && source.css[miss.cursor] !== '{') {
          pendingMiss = true;
        }
      }
    } else if (
      node.type === 'atrule' &&
      !node.nodes &&
      !terminated &&
      parsedStatementEnd !== undefined &&
      parsedStatementEnd < source.css.length
    ) {
      desync = true;
    }
    const end = node.source?.end?.offset;
    if (node.parent && end !== undefined)
      lastEnds.set(node.parent, readOnFrom(node, end));
    if (node.type === 'rule' || node.type === 'atrule') containers.push(node);
  };
  readInvalidAtRules(root, source);
  walkNodes(root, restoreNode, merged);
  restoreWalked();
  for (const parent of [...mergedParents]) removeMerged(parent);
  restoreContainer(root);
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

// V4's generic at-rule at `start` before `until`, read as a statement up to
// where V4 reads on, or undefined where V4 reads another at-rule. `block`
// where V4 instead reads a block from the `{` ending its prelude.
function genericStatementSpan(
  source: CompatibilitySource,
  start: number,
  until: number,
):
  | {
      name: string;
      afterName: string;
      params: string;
      end: number;
      block: boolean;
    }
  | undefined {
  const text = source.css.slice(start, until);
  const keyword = /^@([-\w]+)\s*/.exec(text);
  const name = keyword?.[1];
  if (
    !keyword ||
    !name ||
    (knownAtRuleRegex.test(name) && !headerFails(name, text, 0)) ||
    name === 'layer' ||
    name === 'custom-media' ||
    keyframesRegex.test(name) ||
    /^([-\w]+)?document$/.test(name) ||
    PAGE_MARGIN_BOX_NAMES.has(name)
  )
    return;
  let end = start + keyword[0].length;
  // V4 reads the prelude up to a `;`, then skips `;` and whitespace.
  const stop = source.preludeStop(end, until);
  let params = '';
  if (stop !== -1 && source.css[stop] === ';') {
    params = source.css.slice(end, stop);
    end = stop;
    while (end < until && /[;\s]/.test(source.css[end])) end++;
  }
  return {
    name,
    afterName: keyword[0].slice(name.length + 1),
    params,
    end,
    block: stop !== -1 && source.css[stop] === '{',
  };
}

function genericStatementAt(
  root: postcss.Root,
  source: CompatibilitySource,
  start: number,
  until: number,
): postcss.AtRule | undefined {
  const span = genericStatementSpan(source, start, until);
  if (!span) return;
  const { name, params, end } = span;
  const point = source.pointAt(end);
  const statement = postcss.atRule({ name, params });
  statement.raws.afterName = span.afterName;
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

// The first `{` before `until` outside quotes and parentheses, as V4's
// selector search finds it, or -1.
function selectorOpeningOffset(
  css: string,
  from: number,
  until: number,
): number {
  let depth = 0;
  for (let offset = from; offset < until; offset++) {
    const char = css[offset];
    if (char === '\\') {
      offset++;
    } else if (char === '"' || char === "'") {
      offset++;
      while (offset < until && css[offset] !== char) {
        offset += css[offset] === '\\' ? 2 : 1;
      }
      if (offset >= until) return -1;
    } else if (char === '(') {
      depth++;
    } else if (char === ')' && depth) {
      depth--;
    } else if (char === '{' && !depth) {
      return offset;
    }
  }
  return -1;
}

// Where V4's root reading from `from` opens a rule before `until`: after
// whitespace, comments and stray `}`, the first `{` its selector search
// finds. -1 when the reading starts at an at-rule or a `{`, or finds none.
function rootRuleOpening(css: string, from: number, until: number): number {
  let offset = from;
  while (offset < until) {
    if (/\s/.test(css[offset]) || css[offset] === '}') {
      offset++;
    } else if (css.startsWith('/*', offset)) {
      const close = css.slice(offset + 2, until).indexOf('*/');
      if (close === -1) return -1;
      offset += close + 4;
    } else {
      break;
    }
  }
  if (
    offset >= until ||
    css[offset] === '{' ||
    (css[offset] === '@' && /[-\w]/.test(css[offset + 1] ?? ''))
  )
    return -1;
  return selectorOpeningOffset(css, offset, until);
}

function recoveryRule(
  node: postcss.Rule | postcss.AtRule,
  source: CompatibilitySource,
  start: number,
  open: number,
): postcss.Rule {
  // Move the children rather than clone them, so per-node recovery state
  // still applies to them.
  const nodes = node.nodes ?? [];
  node.removeAll();
  const rule = postcss.rule({
    selector: source.css.slice(start, open),
    source: node.source,
  });
  rule.append(nodes);
  rule.raws.between = '';
  rule.raws.semicolon = node.raws.semicolon;
  if (node.source) {
    rule.source = {
      ...node.source,
      start: { ...source.pointAt(start), offset: start },
    };
  }
  if (source.abandoned.has(node)) source.abandoned.add(rule);
  return rule;
}

// Recovered comments are appended after root's source-ordered nodes.
const recoveredRootComments = new WeakSet<postcss.Node>();

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
        const comment = commentAt(root, source, offset, close + 2);
        recoveredRootComments.add(comment);
        root.append(comment);
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
        insertInSourceOrder(parent, declaration);
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
}

// Siblings are in source order, so this matches append + stable sort.
function insertInSourceOrder(
  parent: postcss.Container,
  node: postcss.ChildNode,
): void {
  parent.append(node);
  const nodes = parent.nodes ?? [];
  const offset = node.source?.start?.offset ?? 0;
  let low = 0;
  let high = nodes.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((nodes[middle].source?.start?.offset ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  if (low < nodes.length - 1) {
    nodes.pop();
    nodes.splice(low, 0, node);
  }
}

function startsBlockAtRule(root: postcss.Root, offset: number): boolean {
  let found = false;
  walkNodes(root, (node) => {
    if (
      node.type === 'atrule' &&
      node.nodes &&
      node.source?.start?.offset === offset
    )
      found = true;
  });
  return found;
}

function collectCompatibilityErrors(
  source: CompatibilitySource,
  root: postcss.Root,
  silent: boolean,
  boundaryCSS: string,
  syntaxError?: postcss.CssSyntaxError,
  resumable = false,
): CssParseError[] {
  const { css } = source;
  const errors: CssParseError[] = [];
  const segments = splitTopLevelSegments(boundaryCSS).map((segment) => ({
    ...segment,
    text: css.slice(segment.offset, segment.offset + segment.text.length),
  }));
  for (const segment of segments) {
    if (segment.text === '}' && !source.inPrelude(segment.offset))
      source.strayBraces.push(segment.offset);
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
    if (
      (!segment || !/^\s*@(?:import|charset|namespace)\b/.test(segment.text)) &&
      // V4 reads `@` without a name as text, unless PostCSS keeps a block
      // at-rule for it where V4 rejects the text.
      (syntaxError.reason !== 'At-rule without name' ||
        startsBlockAtRule(root, offset))
    ) {
      const error = source.error(syntaxError.reason, offset);
      if (syntaxError.reason === 'Unclosed bracket')
        source.bracketError = error;
      else errors.push(error);
    }
  }

  // PostCSS reads the input after an unclosed bracket as one token, so V4
  // reads its braces in blocks that PostCSS does not have.
  const bracketOffset =
    syntaxError?.reason === 'Unclosed bracket'
      ? source.offsetAt(syntaxError.line ?? 1, syntaxError.column ?? 1)
      : css.length;

  // `strays` where V4 skips every character, so reads each `}` as extra.
  function recordRootGap(from: number, until: number, strays = false): void {
    for (let offset = from; offset < until; offset++) {
      const open = source.namelessKeyframes.get(offset);
      if (open !== undefined) {
        errors.push(source.error('@keyframes missing name', open));
        offset = open - 1;
        continue;
      }
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
      if (css[offset] === '}') {
        // V4 skips one character at a time here, even inside a string.
        if (!source.inPrelude(offset) && (strays || offset < bracketOffset))
          source.strayBraces.push(offset);
        continue;
      }
      if (!/\s/.test(css[offset])) {
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
  let skippedIndex = 0;
  for (let node of root.nodes) {
    if (node.type === 'decl') continue;
    const start = node.source?.start?.offset;
    if (start === undefined) {
      retainedRoots.push(node);
      continue;
    }
    // No V4 at-rule matches this name, so V4 reads it as rule text.
    if (
      node.type === 'atrule' &&
      !node.nodes &&
      !/[-\w]/.test(css[start + 1] ?? '')
    )
      continue;
    const open =
      node.type === 'rule' || node.type === 'atrule'
        ? blockOpeningOffset(node)
        : undefined;
    if (open !== undefined) remainingBlocks--;
    while (cursor < start) {
      while (source.skippedBraces[skippedIndex] < cursor) skippedIndex++;
      const keyframesOpen = source.namelessKeyframes.get(cursor);
      if (keyframesOpen !== undefined) {
        errors.push(source.error('@keyframes missing name', keyframesOpen));
        cursor = keyframesOpen;
        continue;
      }
      if (source.skippedBraces[skippedIndex] === cursor) {
        errors.push(source.error('selector missing', cursor));
      } else if (!/\s/.test(css[cursor]) && css[cursor] !== '}') break;
      cursor++;
    }
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
    if (skipsSemicolons(node, css))
      cursor = source.semicolonsEnd(cursor, css.length);
  }
  // V4 skips the text after the last root node one character at a time up
  // to where it reads a rule or an at-rule. PostCSS reads that text as one
  // statement after an unclosed bracket or string, so the input is then
  // parsed again from there. Statements of unknown at-rules on the way stay
  // as read here, as PostCSS reads their at-words on past V4's names.
  let resume = css.length;
  let skips = false;
  for (let at = cursor; silent && at < css.length; at++) {
    if (css.startsWith('/*', at)) {
      const close = css.indexOf('*/', at + 2);
      if (close === -1) break;
      at = close + 1;
    } else if (css[at] === '@' && /[-\w]/.test(css[at + 1] ?? '')) {
      const statement = genericStatementSpan(source, at, css.length);
      if (!statement || statement.block) {
        resume = at;
        break;
      }
      at = statement.end - 1;
    } else if (!/\s/.test(css[at])) {
      if (css[at] !== '}' && source.selectorStop(at) > at) {
        resume = at;
        break;
      }
      skips = true;
    }
  }
  if (!skips) recordRootGap(cursor, css.length);
  else {
    recordRootGap(cursor, resume, true);
    if (resume < css.length && resumable) source.rootResume = resume;
    else recordRootGap(resume, css.length);
  }
  if (
    retainedRoots.length !== root.nodes.length ||
    retainedRoots.some((node, index) => node !== root.nodes[index])
  ) {
    root.removeAll();
    root.append(retainedRoots);
  }

  // Root comments V4 reads inside a selector; removed once the walk ends.
  const droppedRoots = new Set<postcss.ChildNode>();
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
      if (container.type === 'atrule') {
        const error = source.error(
          `@${atRuleErrorName(container.name)} missing '}'`,
          offset,
        );
        source.closingErrors.set(container, error);
        errors.push(error);
      } else {
        errors.push(source.error("missing '}'", offset));
      }
      if (container.type === 'rule' || container.type === 'atrule')
        source.abandoned.add(container);
      if (container.source) {
        const point = source.pointAt(offset);
        container.source.end = {
          line: point.line,
          column: point.column - 1,
          offset,
        };
      }
      if (silent) {
        const siblings =
          (container.parent?.type === 'root' && container.parent.nodes) || [];
        let from = offset;
        if (siblings.length) {
          from = hoistAbandonedChildren(offset);
          if (from >= limit) {
            // V4 reports the block's own `}` as extra.
            if (css[limit] === '}') source.strayBraces.push(limit);
            return;
          }
        }
        // V4 reads the text up to the next `{` as a selector, comments
        // included.
        let nextIndex = index + 1;
        while (
          siblings[nextIndex]?.type === 'comment' &&
          !recoveredRootComments.has(siblings[nextIndex])
        )
          nextIndex++;
        const next = siblings[nextIndex];
        if (siblings.length) {
          // V4 reads up to a `{` that was skipped as a root rule without a
          // selector. That rule would be `next` when kept.
          const brace = source.nextSkippedBrace(from);
          if (
            brace !== -1 &&
            (next?.source?.start?.offset ?? css.length) > brace &&
            rootRuleOpening(css, from, brace + 1) === brace
          )
            source.braceConflicts.push(brace);
        }
        const nextOpen =
          next?.type === 'rule' ? blockOpeningOffset(next) : undefined;
        // An unclosed quote or parenthesis hides every later `{` from V4.
        // An earlier `{` that PostCSS reads inside a value or comment is
        // approximated by the next rule's, but not a skipped block's.
        const selectorOpen =
          nextOpen === undefined
            ? -1
            : selectorOpeningOffset(css, from, nextOpen + 1);
        if (
          nextOpen !== undefined &&
          next?.type === 'rule' &&
          next.source &&
          selectorOpen !== -1 &&
          (selectorOpen === nextOpen || !source.skippedBrace(selectorOpen))
        ) {
          for (const comment of siblings.slice(index + 1, nextIndex))
            droppedRoots.add(comment);
          next.selector = css.slice(from, nextOpen);
          next.raws.between = '';
          delete next.raws.selector;
          next.source.start = { ...source.pointAt(from), offset: from };
          return;
        }
        recoverRootText(root, source, errors, from, end);
      }
    }

    // Moves the block children that V4 reads as root rules after `offset`
    // and returns where V4's root reading continues.
    function hoistAbandonedChildren(offset: number): number {
      let from = offset;
      let childIndex = 0;
      while (from < limit && css[from] !== '@') {
        while (
          childIndex < children.length &&
          (children[childIndex].source?.start?.offset ?? -1) < from
        )
          childIndex++;
        let block: postcss.Rule | postcss.AtRule | undefined;
        let blockIndex = childIndex;
        for (; blockIndex < children.length; blockIndex++) {
          const child = children[blockIndex];
          if (
            (child.type === 'rule' || child.type === 'atrule') &&
            child.nodes
          ) {
            block = child;
            break;
          }
        }
        const blockOpen = block && blockOpeningOffset(block);
        if (
          !block ||
          blockOpen === undefined ||
          blockOpen === from ||
          css[blockOpen] !== '{' ||
          selectorOpeningOffset(css, from, blockOpen + 1) !== blockOpen
        )
          break;
        let rule: postcss.Rule;
        if (block.type === 'rule') {
          rule = block;
          rule.selector = css.slice(from, blockOpen);
          rule.raws.between = '';
          delete rule.raws.selector;
          if (rule.source)
            rule.source.start = { ...source.pointAt(from), offset: from };
        } else {
          rule = recoveryRule(block, source, from, blockOpen);
        }
        retained.push(rule);
        source.hoisted.add(rule);
        from = Math.min(block.source?.end?.offset ?? limit, limit);
        childIndex = blockIndex + 1;
        // V4 keeps the comments that follow a rule.
        for (;;) {
          while (from < limit && /\s/.test(css[from])) from++;
          const comment = children[childIndex];
          if (
            comment?.type !== 'comment' ||
            comment.source?.start?.offset !== from
          )
            break;
          retained.push(comment);
          source.hoisted.add(comment);
          from = comment.source?.end?.offset ?? limit;
          childIndex++;
        }
      }
      return from;
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
    const atRules = readsAtRules(container, css);
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
      if (atRules && skipsSemicolons(child, css))
        cursor = source.semicolonsEnd(cursor, limit);
      while (
        cursor < limit &&
        (/\s/.test(css[cursor]) ||
          (child.type === 'decl' && css[cursor] === ';'))
      )
        cursor++;
    }
    if (container.type === 'atrule' && keyframesRegex.test(container.name)) {
      // V4 accepts whitespace in empty keyframes, e.g. `@keyframes x { }`.
      while (cursor < limit && /\s/.test(css[cursor])) cursor++;
      if (cursor < limit) {
        stopAt(cursor);
        cursor = limit;
      }
    }
    scanGap(cursor, limit);
    if (
      retained.length !== children.length ||
      retained.some((child, childIndex) => child !== children[childIndex])
    ) {
      container.removeAll();
      container.append(retained);
    }
  });
  if (droppedRoots.size) {
    const live = root.nodes.filter((node) => !droppedRoots.has(node));
    root.removeAll();
    root.append(live);
  }
  return errors;
}

// How V4 reads the body of a block: as rules and declarations, skipping to
// the next `;` in silent mode, or as declarations only.
type ChainReader = 'rules' | 'declarations';

// Where V4 fails to read a nested rule: one without a selector (`empty`) or
// text that is neither a rule nor a declaration (`text`). V4 closes every
// enclosing block there with an error, unless it skips to a `;`, and reads
// on at the root. Where a root rule opens a quote that never closes before
// its `{` (`quote`), V4 skips one character at a time up to the quote.
// Where V4 stops reading a block one declaration at a time before its `}`
// (`declarations`), it drops the block and reads on in the enclosing body.
// Where V4 fails to open an at-rule without a block at the end of a body
// read as rules (`miss`), it reads the rest as declarations, fails to close
// the body and reads on after it.
// Where V4 finds no end for a declaration value in a body read as rules
// (`value`), it reads the value as empty and fails to read the value text
// as a declaration: it skips to a `;`, closes the body at a `}`, or closes
// every enclosing block there and reads on at the root.
interface ChainBreak {
  kind:
    | 'empty'
    | 'text'
    | 'quote'
    | 'declarations'
    | 'miss'
    | 'value'
    | 'header';
  offset: number;
  // The unclosed quote of a `quote` break.
  quote: number;
  // Whether a `declarations` break follows a property without `:`.
  colon: boolean;
  // Enclosing blocks, innermost first; for a `declarations` break, the
  // dropped block first.
  levels: Array<{ node: postcss.Rule | postcss.AtRule; reader: ChainReader }>;
  // For a `miss` break, the at-rule's start and the errors V4 reports from
  // there up to the break.
  miss?: { start: number; errors: CssParseError[] };
  // For a `value` break, the declaration's and the value's start, and the
  // end of the text V4 skips where it reads on in the same body, or -1.
  value?: { start: number; valueStart: number; end: number };
  // For a `header` break, the at-rule's start and the error V4 reports
  // where its header ends.
  header?: { start: number; reason: string };
}

const blockReaderNames =
  /^(?:media|supports|container|font-feature-values|scope|layer|host|starting-style)$/;
const declarationReaderNames =
  /^(?:font-face|view-transition|page|property|position-try|counter-style)$/;
// Names V4 matches as a prefix, reading the rest as the prelude.
const prefixedAtRuleRegex =
  /^(?:media|supports|import|charset|namespace|page|host|font-face|container|starting-style|layer|scope|view-transition)|keyframes|document/;

// V4's reader for the body of `node`, or undefined where V4 matches its
// header otherwise.
function chainReader(
  node: postcss.Rule | postcss.AtRule,
  css: string,
): ChainReader | undefined {
  if (node.type === 'rule') return 'rules';
  const start = node.source?.start?.offset;
  const open = blockOpeningOffset(node);
  if (start === undefined || open === undefined || css[open] !== '{')
    return undefined;
  const { name } = node;
  const preludeStart = start + 1 + name.length;
  if (preludeStart > open) return undefined;
  const prelude = css.slice(preludeStart, open);
  if (prelude.includes('{')) return undefined;
  const empty = !prelude.trim();
  if (genericAtRule(name, css, start))
    return bracketedIndex(css, preludeStart, open + 1, '{;') === open
      ? 'rules'
      : undefined;
  if (PAGE_MARGIN_BOX_NAMES.has(name))
    return empty ? 'declarations' : undefined;
  if (declarationReaderNames.test(name)) {
    const matches =
      (name === 'page' &&
        bracketedIndex(css, preludeStart, open + 1, '{') === open) ||
      ((name === 'font-face' || name === 'view-transition') && empty) ||
      ((name === 'property' || name === 'position-try') &&
        /^\s+--[-\w]+\s*$/.test(prelude)) ||
      (name === 'counter-style' && /^\s+[-\w]+\s*$/.test(prelude));
    return matches ? 'declarations' : undefined;
  }
  if (blockReaderNames.test(name)) {
    if ((name === 'host' || name === 'starting-style') && !empty)
      return undefined;
    if (name === 'layer' && /[;@]/.test(prelude)) return undefined;
    return 'rules';
  }
  if (/^([-\w]+)?document$/.test(name)) return prelude ? 'rules' : undefined;
  return undefined;
}

// Whether V4 reads at-rules in the body of `container`.
function readsAtRules(container: postcss.Container, css: string): boolean {
  if (container.type === 'rule') {
    const { parent } = container;
    return !(
      parent?.type === 'atrule' &&
      keyframesRegex.test((parent as postcss.AtRule).name)
    );
  }
  if (container.type !== 'atrule') return false;
  const reader = chainReader(container as postcss.AtRule, css);
  return (
    reader === 'rules' ||
    (reader === 'declarations' && (container as postcss.AtRule).name === 'page')
  );
}

// Whether V4 reads an at-rule named `name` only as a generic one.
function genericAtRuleName(name: string): boolean {
  return (
    /^[-\w]+$/.test(name) &&
    !prefixedAtRuleRegex.test(name) &&
    !blockReaderNames.test(name) &&
    !declarationReaderNames.test(name) &&
    !PAGE_MARGIN_BOX_NAMES.has(name) &&
    name !== 'custom-media'
  );
}

// Whether V4 reads the at-rule named `name` at `start` as a generic one.
function genericAtRule(name: string, css: string, start: number): boolean {
  return genericAtRuleName(name) || headerFails(name, css, start);
}

const atNameRegex = /@([-\w]+)/y;

// Whether V4 reads `node` as a generic or `@layer` statement, after which it
// skips every `;` and whitespace.
function skipsSemicolons(node: postcss.ChildNode, css: string): boolean {
  if (node.type !== 'atrule' || node.nodes) return false;
  const start = node.source?.start?.offset;
  const end = node.source?.end?.offset;
  if (start === undefined || end === undefined || css[end - 1] !== ';')
    return false;
  atNameRegex.lastIndex = start;
  const name = atNameRegex.exec(css)?.[1];
  return (
    name !== undefined &&
    (genericAtRule(name, css, start) ||
      (name === 'custom-media' &&
        !customMediaRegex.test(atRuleHeader(node).params)) ||
      (/^layer/.test(name) && !/keyframes|document/.test(name)))
  );
}

// Whether V4, trying the remaining at-rules at `offset` once `node` fails
// there, reads what it reads when it starts there: no at-rule it tries
// before `node`'s matches the name at `offset`.
function rereadsAtRule(
  css: string,
  offset: number,
  node: postcss.AtRule,
): boolean {
  atNameRegex.lastIndex = offset;
  const name = atNameRegex.exec(css)?.[1];
  return (
    name === undefined ||
    genericAtRule(name, css, offset) ||
    (PAGE_MARGIN_BOX_NAMES.has(name) && !PAGE_MARGIN_BOX_NAMES.has(node.name))
  );
}

interface DeclarationBreak {
  node: postcss.AtRule;
  offset: number;
  // Whether V4 finds no `:` after a property there.
  colon: boolean;
}

// Where V4 stops reading the body of `node`, a block read one declaration
// at a time (`@page` reads at-rules too), before PostCSS's `}`: V4 drops
// the block there and reads on in the enclosing body. Returns the innermost
// such block, undefined where V4 reads the body as PostCSS does, and null
// where V4 reads it in a way this does not follow. Blocks found to be read
// as PostCSS does are added to `read`.
function declarationBreak(
  node: postcss.AtRule,
  source: CompatibilitySource,
  read: Set<postcss.AtRule>,
): DeclarationBreak | null | undefined {
  if (read.has(node)) return undefined;
  const { css } = source;
  const open = blockOpeningOffset(node);
  if (open === undefined || css[open] !== '{') return null;
  const end = node.source?.end?.offset;
  // Recovery abandons a block where V4 stops reading a rule body, which is
  // where V4 stops reading a declaration block or after.
  const abandoned = source.abandoned.has(node) ? end : undefined;
  // PostCSS's `}`, or the end of the input where it is unknown or missing.
  const close =
    end === undefined || abandoned !== undefined ? css.length : end - 1;
  if (close < css.length && css[close] !== '}') return null;
  const found = (offset: number, colon: boolean) =>
    abandoned === undefined || offset <= abandoned
      ? { node, offset, colon }
      : null;
  const closed = (offset: number) => {
    if (offset !== close || abandoned !== undefined) return null;
    read.add(node);
    return undefined;
  };
  const children = node.nodes ?? [];
  let childIndex = 0;
  let cursor = open + 1;
  for (;;) {
    // V4 skips whitespace and comments between declarations.
    for (;;) {
      while (cursor < css.length && /\s/.test(css[cursor])) cursor++;
      if (!css.startsWith('/*', cursor)) break;
      const comment = css.indexOf('*/', cursor + 2);
      if (comment === -1) return null;
      cursor = comment + 2;
    }
    if (cursor >= close) return closed(cursor);
    if (css[cursor] === '}') return null;
    if (css[cursor] === '@') {
      // Elsewhere, V4 tries the remaining at-rules there.
      if (node.name !== 'page')
        return rereadsAtRule(css, cursor, node) ? found(cursor, false) : null;
      while (
        childIndex < children.length &&
        (children[childIndex].source?.start?.offset ?? -1) < cursor
      )
        childIndex++;
      const child = children[childIndex];
      const childEnd = child?.source?.end?.offset;
      if (
        child?.type !== 'atrule' ||
        child.source?.start?.offset !== cursor ||
        childEnd === undefined
      )
        return null;
      if (child.nodes) {
        if (chainReader(child, css) !== 'declarations') return null;
        const inner = declarationBreak(child, source, read);
        if (inner !== undefined) return inner;
        cursor = childEnd;
        continue;
      }
      if (
        !genericAtRule(child.name, css, cursor) ||
        bracketedIndex(css, cursor + 1 + child.name.length, childEnd, '{;') !==
          childEnd - 1
      )
        return null;
      // V4 skips every `;` and whitespace after a generic statement.
      cursor = source.semicolonsEnd(childEnd, css.length);
      continue;
    }
    propertyRegex.lastIndex = cursor;
    if (!propertyRegex.test(css)) return found(cursor, false);
    cursor = propertyRegex.lastIndex;
    if (css[cursor] !== ':') {
      // V4 closes the block at a `}` after the missing `:`.
      if (cursor >= close) return closed(cursor);
      // V4 tries the remaining at-rules at a `@`, and reads a comment as
      // part of a selector.
      if (
        css[cursor] === '}' ||
        (css[cursor] === '@' && !rereadsAtRule(css, cursor, node)) ||
        css.startsWith('/*', cursor)
      )
        return null;
      return found(cursor, true);
    }
    separatorRegex.lastIndex = cursor;
    separatorRegex.test(css);
    const valueStart = separatorRegex.lastIndex;
    const valueEnd = source.valueStop(valueStart);
    // Without an end, V4 reads the value as the next declaration.
    cursor = valueEnd === -1 ? valueStart : valueEnd;
    while (cursor < css.length && /[;\s]/.test(css[cursor])) cursor++;
  }
}

// Where V4 fails to open `node`, an at-rule without a block that ends a body
// read as rules, it reads the rest of the body up to `until`, its `}` or the
// input end, as declarations, skipping to each `;` before a `}`. Returns the
// offset where V4 then fails to close the body, with the errors it reports
// from the at-rule on, or undefined where V4 closes the body or reads it in a
// way the scan does not follow.
function missBreak(
  node: postcss.AtRule,
  source: CompatibilitySource,
  until: number,
): { offset: number; errors: CssParseError[] } | undefined {
  const { css } = source;
  const start = node.source?.start?.offset;
  // A prelude V4 reads up to the next `{` is no miss at the at-rule.
  if (
    start === undefined ||
    blockPreludeEnd(source, start) !== undefined ||
    pageSelectorEnd(source, start) !== undefined
  )
    return undefined;
  const miss = atRuleMiss(node, source);
  if (
    !miss ||
    miss.cursor >= until ||
    css.slice(miss.cursor, until).includes('/*')
  )
    return undefined;
  const errors = [source.error(miss.reason, miss.cursor)];
  let cursor = miss.cursor;
  for (;;) {
    if (cursor >= until || css[cursor] === '}' || css[cursor] === '@')
      return undefined;
    // V4 reads a nested rule where a `{` comes before any `;` or `}`.
    const stop = source.ruleStop(cursor);
    if (stop !== -1 && css[stop] === '{') return undefined;
    propertyRegex.lastIndex = cursor;
    if (propertyRegex.test(css)) {
      cursor = propertyRegex.lastIndex;
      if (css[cursor] === ':') {
        separatorRegex.lastIndex = cursor;
        separatorRegex.test(css);
        const valueStart = separatorRegex.lastIndex;
        const valueEnd = source.valueStop(valueStart);
        // Without an end, V4 reads the value as the next declaration.
        cursor = valueEnd === -1 ? valueStart : valueEnd;
        while (cursor < css.length && /[;\s]/.test(css[cursor])) cursor++;
        continue;
      }
      errors.push(source.error("property missing ':'", cursor));
    }
    let skip = cursor;
    while (skip < until && css[skip] !== ';' && css[skip] !== '}') skip++;
    if (skip >= until || css[skip] === '}') break;
    cursor = skip + 1;
    while (cursor < css.length && /\s/.test(css[cursor])) cursor++;
  }
  return cursor >= until || /[}@\s]/.test(css[cursor])
    ? undefined
    : { offset: cursor, errors };
}

// Offset of the quote closing the one at `offset`, or -1.
function quoteEnd(css: string, offset: number): number {
  for (let at = offset + 1; at < css.length; at++) {
    if (css[at] === '\\') at++;
    else if (css[at] === css[offset]) return at;
  }
  return -1;
}

// `css` with [from, until) as spaces. Line breaks stay, and with them every
// line and column.
function blankRange(css: string, from: number, until: number): string {
  return (
    css.slice(0, from) +
    css.slice(from, until).replace(/[^\n]/g, ' ') +
    css.slice(until)
  );
}

// An unclosed comment after a declaration value without a `;`, which V4
// reads as value text up to the first `;` or `}` in the comment (`end`),
// reading on from there. The comment runs to the input end in PostCSS.
interface ValueComment {
  declaration: number;
  value: number;
  start: number;
  end: number;
}

function valueComment(
  root: postcss.Root,
  css: string,
): ValueComment | undefined {
  // Only the last `/*` of the input can open an unclosed comment.
  const last = css.lastIndexOf('/*');
  if (last === -1 || css.includes('*/', last + 2)) return;
  let comment = undefined as postcss.Comment | undefined;
  walkNodes(root, (node) => {
    const at = node.source?.start?.offset;
    if (
      !comment &&
      node.type === 'comment' &&
      at !== undefined &&
      css.startsWith('/*', at) &&
      !css.includes('*/', at + 2)
    )
      comment = node;
  });
  const start = comment?.source?.start?.offset;
  if (!comment || start === undefined || comment.parent?.type === 'root')
    return;
  let previous = comment.prev();
  while (previous?.type === 'comment') previous = previous.prev();
  const declaration = previous?.source?.start?.offset;
  const parsedEnd = previous?.source?.end?.offset;
  if (
    previous?.type !== 'decl' ||
    declaration === undefined ||
    parsedEnd === undefined ||
    css[parsedEnd - 1] === ';' ||
    css[parsedEnd - 1] === '}'
  )
    return;
  const property = propertyPrefixRegex.exec(css.slice(declaration, start));
  const colon = declaration + (property?.[0].length ?? 0);
  if (!property || css[colon] !== ':') return;
  let value = colon + 1;
  while (value < start && /\s/.test(css[value])) value++;
  // V4's value scan reaches the comment outside quotes and parentheses.
  if (
    declarationValueEnd(`${css.slice(value, start)};`, false) !==
    start - value
  )
    return;
  const relativeEnd = declarationValueEnd(css.slice(start), false);
  const end = start + relativeEnd;
  // Without a `{`, V4 reads the declaration as one, not as a nested rule.
  if (relativeEnd === -1 || css.slice(declaration, end).includes('{')) return;
  return { declaration, value, start, end };
}

function recoverCompatibility(
  root: postcss.Root,
  source: CompatibilitySource,
  errors: CssParseError[],
  silent: boolean,
  preserveComments: boolean,
  detect: boolean,
): ChainBreak | undefined {
  const { css } = source;
  const recoveryEnds = new Map<postcss.Container, number>();
  // V4 reads the block from `start` as a rule, so the `}` it misses there
  // is a rule's.
  const readAsRule = (
    node: postcss.Rule | postcss.AtRule,
    start: number,
    open: number,
  ): postcss.Rule => {
    const closing =
      node.type === 'atrule' ? source.closingErrors.get(node) : undefined;
    const index = closing ? errors.indexOf(closing) : -1;
    if (closing && index !== -1) {
      errors[index] = source.error(
        "missing '}'",
        source.offsetAt(closing.line, closing.column),
      );
    }
    return recoveryRule(node, source, start, open);
  };
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
  // Removals are deferred so each one is O(1): detached nodes keep their
  // index (the walk skips them) and are dropped once the walk completes.
  const detached = new Set<postcss.ChildNode>();
  const dirty = new Set<postcss.Container>();
  const detach = (node: postcss.ChildNode): void => {
    detached.add(node);
    if (node.parent) dirty.add(node.parent);
  };
  // Root nodes before `tail` are in source order; recovered comments follow.
  let tail = root.nodes.length;
  while (tail > 0 && recoveredRootComments.has(root.nodes[tail - 1])) tail--;
  let rootIndex = 0;
  // No live block remains at or after this root index.
  let blocklessFrom = Number.POSITIVE_INFINITY;
  // Rules that run to the end of the input; V4 keeps them without content.
  const unclosed = new Set<postcss.Rule>();
  // Errors closing the blocks that run to the end of the input, outermost
  // first. Such blocks are nested in one another.
  const closings: CssParseError[][] = [];
  // Unclosed at-rules, detached as V4 drops them; their bodies are V4's.
  const unclosedAtRules = new Set<postcss.ChildNode>();
  let chainBreak: ChainBreak | undefined;
  // Blocks read one declaration at a time that V4 reads as PostCSS does,
  // and those it reads in a way the scan cannot follow.
  const read = new Set<postcss.AtRule>();
  const unread = new Set<postcss.Rule | postcss.AtRule>();
  // The enclosing blocks of `node`, from `from` out, while V4 reads them as
  // PostCSS did.
  const chainLevels = (
    node: postcss.ChildNode,
    from = node.parent as postcss.Container | undefined,
  ): ChainBreak['levels'] | undefined => {
    const levels: ChainBreak['levels'] = [];
    for (
      let parent = from;
      parent && parent !== root;
      parent = parent.parent as postcss.Container | undefined
    ) {
      if (parent.type !== 'rule' && parent.type !== 'atrule') return;
      const block = parent as postcss.Rule | postcss.AtRule;
      const reader = chainReader(block, css);
      if (
        !reader ||
        source.abandoned.has(block) ||
        source.hoisted.has(block) ||
        (detached.has(block) && !unclosedAtRules.has(block))
      )
        return;
      levels.push({ node: block, reader });
    }
    return levels;
  };
  // A `miss` break at `node`, an at-rule without a block that ends a body
  // read as rules. A rule V4 keeps is only moved back at the root.
  const missChainBreak = (node: postcss.AtRule): ChainBreak | undefined => {
    const parent = node.parent;
    if (!parent || parent.type === 'root' || parent.last !== node) return;
    const levels = chainLevels(node);
    if (
      !levels?.length ||
      levels[0].reader !== 'rules' ||
      levels.some((level) => unread.has(level.node))
    )
      return;
    const block = levels[0].node;
    if (
      (block.type === 'rule' && block.parent !== root) ||
      recoveryEnds.has(block)
    )
      return;
    const blockEnd = block.source?.end?.offset;
    const open =
      blockEnd === undefined ||
      unclosedAtRules.has(block) ||
      (block.type === 'rule' && unclosed.has(block));
    if (!open && css[blockEnd - 1] !== '}') return;
    const found = missBreak(node, source, open ? css.length : blockEnd - 1);
    if (!found) return;
    return {
      kind: 'miss',
      offset: found.offset,
      quote: -1,
      colon: false,
      levels,
      miss: { start: node.source?.start?.offset ?? 0, errors: found.errors },
    };
  };
  // Where V4 reads a value through text PostCSS reads as other nodes, as
  // from a quote in a comment, V4 reads no declaration until this offset.
  let swallowed = -1;
  // The first offset with an error, over the first `scannedErrors` errors.
  let firstError = Number.POSITIVE_INFINITY;
  let scannedErrors = 0;
  // From the first bodiless at-rule V4 may read past its end.
  let runOnFrom = Number.POSITIVE_INFINITY;
  // Whether V4 has an error before `offset`, after which it may no longer
  // read the input as PostCSS does.
  const errorBefore = (offset: number): boolean => {
    for (; scannedErrors < errors.length; scannedErrors++) {
      const { line, column } = errors[scannedErrors];
      firstError = Math.min(firstError, source.offsetAt(line, column));
    }
    return firstError < offset;
  };
  // A `header` break at `node`, a block at-rule V4 fails after its header,
  // reading the text from there as a rule.
  const headerChainBreak = (node: postcss.AtRule): ChainBreak | undefined => {
    const miss = headerMiss(node, css);
    const open = blockOpeningOffset(node);
    const start = node.source?.start?.offset;
    if (!miss || open === undefined || start === undefined) return;
    const { cursor } = miss;
    // V4 reads an at-rule from a `@`, and a comment there as a node only
    // between rules.
    if (
      css[cursor] === '@' ||
      css.startsWith('/*', cursor) ||
      // V4 reads the header as it is in the input, not blanked to parse
      // the input again.
      source.original.slice(start, open + 1) !== css.slice(start, open + 1) ||
      source.inPrelude(start) ||
      errorBefore(start) ||
      runOnFrom < start ||
      start < swallowed ||
      selectorOpeningOffset(css, cursor, open + 1) !== open
    )
      return;
    let levels: ChainBreak['levels'] = [];
    if (node.parent !== root) {
      const found = chainLevels(node);
      // A body read as rules reads a rule where a `{` comes before any `;`
      // or `}`.
      if (
        !found?.length ||
        found[0].reader !== 'rules' ||
        found.some((level) => unread.has(level.node)) ||
        bracketedIndex(css, cursor, open + 1, '{;}') !== open
      )
        return;
      levels = found;
    }
    return {
      kind: 'header',
      offset: cursor,
      quote: -1,
      colon: false,
      levels,
      header: { start, reason: miss.reason },
    };
  };
  // A `value` break at `decl`, in `parent`, where V4 finds no end for the
  // value: V4 reads the value as empty and the value text as a property
  // without `:`, or as nothing. `null` where V4 then reads on in a way
  // recovery cannot follow.
  const valueBreak = (
    decl: postcss.Declaration,
    parent: postcss.Container | undefined,
  ): ChainBreak | null | undefined => {
    const start = decl.source?.start?.offset;
    if (
      start === undefined ||
      start < swallowed ||
      (parent?.type !== 'rule' && parent?.type !== 'atrule')
    )
      return;
    propertyRegex.lastIndex = start;
    if (!propertyRegex.test(css) || css[propertyRegex.lastIndex] !== ':')
      return;
    separatorRegex.lastIndex = propertyRegex.lastIndex;
    separatorRegex.test(css);
    const valueStart = separatorRegex.lastIndex;
    if (valueStart >= css.length) return;
    // V4's search mostly ends where PostCSS ends the value, which is checked
    // first so that valid input builds no search table.
    let end = decl.source?.end?.offset ?? css.length;
    while (end < css.length && /\s/.test(css[end])) end++;
    if (
      bracketedIndex(css, valueStart, Math.min(end + 1, css.length), ';}') !==
      -1
    )
      return;
    const stop = source.valueStop(valueStart);
    if (stop !== -1) {
      // V4 reads a longer value, beyond comments when it takes other nodes.
      let at = end;
      for (;;) {
        while (at < stop && /\s/.test(css[at])) at++;
        if (at >= stop || !css.startsWith('/*', at)) break;
        const comment = css.indexOf('*/', at + 2);
        at = comment === -1 ? css.length : comment + 2;
      }
      if (at < stop) swallowed = stop;
      return;
    }
    const levels = chainLevels(decl, parent);
    if (
      !levels?.length ||
      levels[0].reader !== 'rules' ||
      levels.some((level) => unread.has(level.node)) ||
      recoveryEnds.has(levels[0].node) ||
      source.inPrelude(start)
    )
      return;
    // V4 reads a nested rule from a `{`, and an at-rule or a comment there.
    if (
      source.ruleStop(start) !== -1 ||
      css[valueStart] === '@' ||
      css.startsWith('/*', valueStart)
    )
      return null;
    propertyRegex.lastIndex = valueStart;
    const colon = propertyRegex.test(css);
    const cursor = colon ? propertyRegex.lastIndex : valueStart;
    // Recovery reads a property up to the input end as V4 does.
    if (cursor >= css.length) return;
    // V4 reads another declaration there.
    if (css[cursor] === ':') return null;
    let skipped = -1;
    if (silent) {
      const semicolon = css.indexOf(';', cursor);
      const brace = css.indexOf('}', cursor);
      if (css[cursor] === '}') skipped = cursor;
      else if (semicolon !== -1 && (brace === -1 || semicolon < brace))
        skipped = semicolon + 1;
      // Each enclosing body then fails to read anything there, but V4 calls
      // a block at-rule's reader for a rule right after it fails at the root.
      else if (
        source.ruleStop(cursor) !== -1 ||
        levels.some((level) => level.reader !== 'rules') ||
        ((levels.length > 1 ||
          levels[levels.length - 1].node.type === 'atrule') &&
          (css[cursor] === '@' || css.startsWith('/*', cursor)))
      )
        return null;
    }
    return {
      kind: 'value',
      offset: cursor,
      quote: -1,
      colon,
      levels,
      value: { start, valueStart, end: skipped },
    };
  };
  // A chain break at `node`, `null` where V4 reads it in a way recovery
  // cannot follow, so that later nodes are no longer checked.
  const findChainBreak = (
    node: postcss.ChildNode,
  ): ChainBreak | null | undefined => {
    if (node.type === 'decl') return valueBreak(node, node.parent);
    if (node.type === 'atrule') {
      if (!node.nodes) {
        if (!statementLikeV4(node, css))
          runOnFrom = Math.min(runOnFrom, node.source?.start?.offset ?? 0);
        return silent ? missChainBreak(node) : undefined;
      }
      const header = headerChainBreak(node);
      if (header) return header;
      // V4 may read on past a block at-rule it fails to read.
      if (headerMiss(node, css) || keyframesMiss(node, css))
        runOnFrom = Math.min(runOnFrom, node.source?.start?.offset ?? 0);
      if (chainReader(node, css) !== 'declarations') return;
      // Where the scan cannot follow a block, it leaves the blocks inside
      // to recovery as before.
      const enclosing = chainLevels(node);
      if (!enclosing || enclosing.some((level) => unread.has(level.node)))
        return;
      const found = declarationBreak(node, source, read);
      if (found === null) unread.add(node);
      const levels = found && chainLevels(found.node);
      if (!found || !levels) return;
      return {
        kind: 'declarations',
        offset: found.offset,
        quote: -1,
        colon: found.colon,
        levels: [{ node: found.node, reader: 'declarations' }, ...levels],
      };
    }
    if (node.type !== 'rule' || node.source?.start?.offset === undefined)
      return;
    const start = node.source.start.offset;
    const open = blockOpeningOffset(node);
    if (open === undefined || css[open] !== '{') return;
    if (node.parent === root) {
      if (bracketedIndex(css, start, open + 1, '{') === open) return;
      let quote = start;
      while (
        quote < open &&
        !'"\'{}()\\@'.includes(css[quote]) &&
        !css.startsWith('/*', quote)
      )
        quote++;
      return (css[quote] === '"' || css[quote] === "'") &&
        quoteEnd(css, quote) === -1
        ? { kind: 'quote', offset: start, quote, colon: false, levels: [] }
        : null;
    }
    let kind: ChainBreak['kind'];
    if (css[start] === '@') return null;
    if (!node.selector.trim()) {
      if (open !== start) return null;
      kind = 'empty';
    } else {
      // V4's check for a nested rule: a `{` before any `;` or `}`.
      const stop =
        bracketedIndex(css, start, open + 1, '{;}') === open
          ? open
          : bracketedIndex(css, start, css.length, '{;}');
      if (stop === open) return;
      propertyRegex.lastIndex = start;
      if (css[stop] === '{' || propertyRegex.test(css)) return null;
      kind = 'text';
    }
    const levels = chainLevels(node);
    if (!levels) return null;
    if (silent) {
      const semicolon = css.indexOf(';', start);
      const brace = css.indexOf('}', start);
      // Only a body read as rules skips to the `;`; one read as
      // declarations is closed, and the next enclosing body would skip.
      if (
        semicolon !== -1 &&
        (brace === -1 || semicolon < brace) &&
        levels[0].reader === 'declarations' &&
        levels.some((level) => level.reader === 'rules')
      )
        return null;
    }
    return { kind, offset: start, quote: -1, colon: false, levels };
  };
  let detecting = detect;
  // The last declaration of an unclosed block, removed by recovery.
  let valueCandidate:
    | { decl: postcss.Declaration; parent: postcss.Container }
    | undefined;
  const recoverNode = (node: postcss.ChildNode, index: number): void => {
    if (chainBreak) return;
    if (detecting) {
      const found = findChainBreak(node);
      if (found !== undefined) detecting = false;
      if (found) {
        chainBreak = found;
        return;
      }
    }
    if (node.parent === root) rootIndex = index;
    const start = node.source?.start?.offset ?? 0;
    if (node.type === 'rule' && !node.selector.trim()) {
      detach(node);
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
      // V4 reads a nested import-like at-rule as a statement, which takes
      // the rest of the input when no `;` ends it.
      if (
        node.type === 'atrule' &&
        node.parent &&
        node.parent !== root &&
        /^(?:import|charset|namespace)/.test(node.name) &&
        !/^[-\w]*keyframes/.test(node.name) &&
        readsAtRules(node.parent, css) &&
        statementEnd(css, start) === css.length
      ) {
        detach(node);
        for (const child of node.nodes) detach(child);
        return;
      }
      const last = node.last;
      const cursor = recoveryEnds.get(node) ?? css.length;
      // V4 reads the whole body, reporting its errors, before the missing
      // `}`, so these errors are added once the walk has visited the body.
      const closing: CssParseError[] = [];
      const lastStart = last?.source?.start?.offset ?? 0;
      if (
        last?.type === 'decl' &&
        !recoveryEnds.has(node) &&
        !css.slice(lastStart).trimEnd().endsWith(';')
      ) {
        // The declaration runs to the input end, after every other node, so
        // it is checked for a break once the walk is done.
        valueCandidate = { decl: last, parent: node };
        last.remove();
        // V4 finds no end for the value, so it reads the value as empty and
        // the value text as a property without `:`.
        propertyRegex.lastIndex = lastStart;
        const property = propertyRegex.exec(css);
        separatorRegex.lastIndex = lastStart + (property?.[0].length ?? 0);
        const separator = property && separatorRegex.exec(css);
        if (!separator || separator.index + separator[0].length < css.length)
          closing.push(source.error("property missing ':'", css.length));
      }
      closing.push(
        source.error(
          node.type === 'atrule'
            ? `@${atRuleErrorName(node.name)} missing '}'`
            : "missing '}'",
          cursor,
        ),
      );
      closings.push(closing);
      if (node.type === 'atrule') {
        detach(node);
        unclosedAtRules.add(node);
        // V4 then fails to read a rule at the root.
        if (node.parent === root)
          errors.push(source.error('selector missing', cursor));
        return;
      }
      // V4 keeps the rule without its content, cleared after the walk.
      unclosed.add(node);
      const end = source.pointAt(cursor);
      node.source.end = {
        line: end.line,
        column: end.column - 1,
        offset: cursor,
      };
    } else if (node.type === 'atrule') {
      const miss = atRuleMiss(node, source);
      if (!miss) return;
      const { cursor, reason } = miss;
      errors.push(source.error(reason, cursor));
      // V4 reads a rule from where the keyframes name is missing.
      const keyframesOpen =
        reason === '@keyframes missing name' &&
        node.parent === root &&
        node.nodes &&
        css[cursor] !== '{'
          ? blockOpeningOffset(node)
          : undefined;
      if (
        keyframesOpen !== undefined &&
        selectorOpeningOffset(css, cursor, keyframesOpen + 1) === keyframesOpen
      ) {
        const rule = readAsRule(node, cursor, keyframesOpen);
        root.nodes[index] = rule;
        rule.parent = root;
        node.parent = undefined;
        return;
      }
      const parent = node.parent;
      const page =
        parent?.type === 'atrule' &&
        parent.name === 'page' &&
        parent.parent?.type === 'root' &&
        !detached.has(parent)
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
        .filter((child) => child.type !== 'decl' && !detached.has(child));
      detach(node);
      if (parent?.type === 'atrule' && parent.name === 'page') {
        errors.push(source.error("@page missing '}'", cursor));
        if (page && remaining) {
          page.removeAll();
          if (remaining.length) {
            // `insertBefore` moves nodes one at a time; the root is rebuilt.
            const at = root.nodes.indexOf(page);
            root.nodes = root.nodes
              .slice(0, at)
              .concat(remaining, root.nodes.slice(at));
            for (const child of remaining) child.parent = root;
            tail += remaining.length;
            blocklessFrom = Number.POSITIVE_INFINITY;
          }
        }
        detach(parent);
      }
      if (silent) {
        if (parent?.type === 'root' || page) {
          // In the page case, `remaining` now starts at the page's index.
          const from = page ? rootIndex : rootIndex + 1;
          let nextIndex = -1;
          let lastBlock = -1;
          const scanEnd = Math.min(blocklessFrom, root.nodes.length);
          for (let i = from; i < scanEnd; i++) {
            const child = root.nodes[i];
            if (
              detached.has(child) ||
              (child.type !== 'rule' && child.type !== 'atrule') ||
              !child.nodes
            )
              continue;
            if ((child.source?.start?.offset ?? -1) >= cursor) {
              nextIndex = i;
              break;
            }
            lastBlock = i;
          }
          if (nextIndex === -1) {
            blocklessFrom = Math.min(
              blocklessFrom,
              Math.max(from, lastBlock + 1),
            );
          }
          const nextBlock = root.nodes[nextIndex];
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
            const skipped = (child: postcss.ChildNode): boolean => {
              const offset = child.source?.start?.offset ?? -1;
              return offset >= cursor && offset < start;
            };
            // Source order bounds the skipped nodes before the next block;
            // recovered comments can be anywhere in the tail.
            for (let i = from; i < nextIndex; i++) {
              const child = root.nodes[i];
              if (!detached.has(child) && skipped(child)) detach(child);
            }
            for (
              let i = Math.max(tail, nextIndex + 1);
              i < root.nodes.length;
              i++
            ) {
              const child = root.nodes[i];
              if (!detached.has(child) && skipped(child)) detach(child);
            }
            const rule = readAsRule(nextBlock, cursor, open);
            root.nodes[nextIndex] = rule;
            rule.parent = root;
            nextBlock.parent = undefined;
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
          let next: postcss.ChildNode | undefined;
          for (let i = from; i < root.nodes.length; i++) {
            const child = root.nodes[i];
            if (
              !detached.has(child) &&
              (child.source?.start?.offset ?? -1) >= cursor
            ) {
              next = child;
              break;
            }
          }
          // Collect reported the root text after the at-rule's own span.
          const until = Math.min(
            next?.source?.start?.offset ?? css.length,
            page ? css.length : (node.source?.end?.offset ?? css.length),
          );
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
  };
  walkNodes(root, recoverNode, detached);
  if (detecting && !chainBreak && valueCandidate) {
    const found = valueBreak(valueCandidate.decl, valueCandidate.parent);
    if (found) chainBreak = found;
  }
  // V4 closes the innermost block first.
  for (let index = closings.length - 1; index >= 0; index--)
    errors.push(...closings[index]);
  // V4 keeps an abandoned rule without its content and drops an abandoned
  // at-rule. The children it reads as root nodes move to the root.
  const hoisted: postcss.ChildNode[] = [];
  for (const container of source.abandoned) {
    if (container.type === 'atrule' && (!silent || !container.parent)) continue;
    for (const child of container.nodes ?? []) {
      if (source.hoisted.has(child) && !detached.has(child))
        hoisted.push(child);
    }
    if (container.type === 'atrule') detach(container);
    container.removeAll();
  }
  if (hoisted.length) root.append(hoisted);
  for (const rule of unclosed) rule.removeAll();
  for (const container of dirty) {
    const nodes = container.nodes ?? [];
    const live = nodes.filter((child) => !detached.has(child));
    if (live.length !== nodes.length) {
      container.removeAll();
      container.append(live);
    }
  }
  root.nodes.sort(
    (a, b) => (a.source?.start?.offset ?? 0) - (b.source?.start?.offset ?? 0),
  );
  // V4 reads a stray `}` inside a statement as statement text, e.g. the
  // selector `x} y` of `x} y{}`, so only braces outside root nodes are extra.
  const extras: CssParseError[] = [];
  let nodeIndex = 0;
  let coveredUntil = 0;
  source.strayBraces.sort((a, b) => a - b);
  for (const [braceIndex, brace] of source.strayBraces.entries()) {
    if (brace === source.strayBraces[braceIndex - 1]) continue;
    while (
      nodeIndex < root.nodes.length &&
      (root.nodes[nodeIndex].source?.start?.offset ?? 0) <= brace
    ) {
      coveredUntil = Math.max(
        coveredUntil,
        root.nodes[nodeIndex].source?.end?.offset ?? 0,
      );
      nodeIndex++;
    }
    if (brace < coveredUntil) continue;
    source.orphanBrace ??= brace;
    if (silent) extras.push(source.error("extra '}'", brace));
  }
  if (extras.length) {
    // Extra braces lead errors at the same position, as V4 reports them first.
    const rest = errors.splice(0);
    for (const error of extras) errors.push(error);
    for (const error of rest) errors.push(error);
  }
  errors.sort(
    (a, b) =>
      a.line - b.line ||
      a.column - b.column ||
      Number(a.reason === 'selector missing') -
        Number(b.reason === 'selector missing'),
  );
  return chainBreak;
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

// V4 reads keyframe values as a run of offsets and lowercase words, each
// optionally followed by a `,`, so `from to` and `0%50%` hold two values. A
// selector V4 does not read whole keeps the comma split.
function keyframeValues(selector: string): string[] {
  const values: string[] = [];
  let offset = 0;
  for (;;) {
    keyframeValueRegex.lastIndex = offset;
    const match = keyframeValueRegex.exec(selector);
    if (!match) break;
    values.push(match[1]);
    offset = keyframeValueRegex.lastIndex;
    keyframeCommaRegex.lastIndex = offset;
    if (keyframeCommaRegex.test(selector)) {
      offset = keyframeCommaRegex.lastIndex;
    }
  }
  return values.length && offset === selector.length
    ? values
    : selector.split(',').map((v) => trim(v));
}

function convertKeyframe(
  node: postcss.Rule,
  sourceName: string,
  convertedNodes: ConvertedNodes,
): CssKeyframeAST {
  const values = keyframeValues(node.selector);
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

// The name and prelude V4 reads for `node`. The safe parser keeps a `:` after
// the at-keyword in the name, as in `@import:x`, which V4 reads as prelude
// text, keeping the whitespace after it.
function atRuleHeader(node: postcss.AtRule): { name: string; params: string } {
  const params = `${node.raws.afterName ?? ''}${
    node.raws.params?.raw ?? node.params
  }${node.raws.between ?? ''}`;
  return node.name.endsWith(':')
    ? { name: node.name.slice(0, -1), params: trim(`:${params}`) }
    : { name: node.name, params: trim(params) };
}

function convertAtRule(
  node: postcss.AtRule,
  sourceName: string,
  convertedNodes: ConvertedNodes,
): CssAtRuleAST {
  const { name: nameLower, params } = atRuleHeader(node);

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
  const start = node.source?.start?.offset;
  // V4 reads an at-rule whose header it fails to match as a generic one.
  const generic =
    start !== undefined &&
    headerFails(nameLower, node.source?.input.css ?? '', start);

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
        !customMediaRegex.test(params) ||
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
      if (generic) break;
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
      if (generic) break;
      return {
        type: CssTypes.property,
        name: params,
        declarations: convertDeclNodes(node.nodes ?? [], convertedNodes),
        position: convertPos(node.source, sourceName),
      } as CssPropertyAST;

    case 'counter-style':
      if (generic) break;
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
      if (generic) break;
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

// For layer and generic statements, V4 advanced past trailing `;` and
// whitespace to the start of the next token before recording end position.
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
  while (offset < css.length && /[;\s]/.test(css[offset])) {
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

function parsePostcss(
  css: string,
  input: string,
): { root: postcss.Root; syntaxError?: postcss.CssSyntaxError } {
  let root: postcss.Root;
  let syntaxError: postcss.CssSyntaxError | undefined;
  try {
    root = postcss.parse(input, postcssOptions);
  } catch (e) {
    if (!(e instanceof postcss.CssSyntaxError)) throw e;
    root = safeParser(input, postcssOptions);
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
  if (syntaxError) joinStrayBraces(root, input);
  if (root.source && (input !== css || css.startsWith('\uFEFF'))) {
    root.source.input.css = css;
  }
  return { root, syntaxError };
}

// PostCSS ends a rule after a `;` read after it (`ownSemicolon`), but the
// safe parser leaves the stray `}` before that `;` out of `ownSemicolon`.
// Only a root rule has one, as a `}` in a block closes the block. Adds the
// text after the rule's own `}`, found after its body, to `ownSemicolon`.
function joinStrayBraces(root: postcss.Root, input: string): void {
  for (const node of root.nodes) {
    if (node.type !== 'rule' || !node.raws.ownSemicolon) continue;
    const end = node.source?.end?.offset;
    const open = blockOpeningOffset(node);
    const from = node.last
      ? node.last.source?.end?.offset
      : open === undefined
        ? undefined
        : open + 1;
    const after = node.raws.after ?? '';
    if (
      end === undefined ||
      from === undefined ||
      !input.startsWith(after, from)
    )
      continue;
    const close = from + after.length;
    if (input[close] === '}' && close + 1 < end - node.raws.ownSemicolon.length)
      node.raws.ownSemicolon = input.slice(close + 1, end);
  }
}

interface CompatibilityParse {
  root: postcss.Root;
  source: CompatibilitySource;
  errors: CssParseError[];
}

// `errors` with `inserted` before the first error at or after `offset`.
function insertErrors(
  errors: CssParseError[],
  inserted: CssParseError[],
  source: CompatibilitySource,
  offset: number,
): CssParseError[] {
  let index = 0;
  while (
    index < errors.length &&
    source.offsetAt(errors[index].line, errors[index].column) < offset
  )
    index++;
  return errors.slice(0, index).concat(inserted, errors.slice(index));
}

// Parses `css` as V4 does. From a chain break, V4 reads text PostCSS reads
// as nested, so the input is parsed again as V4 reads on, at most
// `budget.left` more times; past that, recovery approximates the rest.
function parseCompatibility(
  css: string,
  sourceName: string,
  silent: boolean,
  preserveComments: boolean,
  budget: { left: number },
  original = css,
): CompatibilityParse {
  const input = prepareCompatibilityInput(css);
  let { root, syntaxError } = parsePostcss(css, input);
  let source = new CompatibilitySource(css, sourceName, undefined, original);
  restoreCompatibilitySpans(root, source, preserveComments);
  let errors = collectCompatibilityErrors(
    source,
    root,
    silent,
    input,
    syntaxError,
    budget.left > 0,
  );
  if (source.braceConflicts.length) {
    // V4 opens rules at some skipped braces, so read them again as rules.
    ({ root, syntaxError } = parsePostcss(css, input));
    source = new CompatibilitySource(
      css,
      sourceName,
      new Set(source.braceConflicts),
      original,
    );
    restoreCompatibilitySpans(root, source, preserveComments);
    errors = collectCompatibilityErrors(
      source,
      root,
      silent,
      input,
      syntaxError,
      budget.left > 0,
    );
  }
  const parseAgain = (text: string): CompatibilityParse => {
    budget.left--;
    const parsed = parseCompatibility(
      text,
      sourceName,
      silent,
      preserveComments,
      budget,
      original,
    );
    if (parsed.root.source) parsed.root.source.input.css = css;
    source.orphanBrace = parsed.source.orphanBrace;
    const bracket = parsed.source.bracketError;
    source.bracketError = bracket
      ? source.error(
          bracket.reason,
          source.offsetAt(bracket.line, bracket.column),
        )
      : undefined;
    return {
      root: parsed.root,
      source,
      // Texts parsed again keep the input's line breaks, so their errors'
      // lines and columns are already this parse's.
      errors: parsed.errors,
    };
  };
  const comment =
    !preserveComments && budget.left > 0 ? valueComment(root, css) : undefined;
  if (comment) {
    // V4 reads the input as it reads it without the comment text it takes
    // as value text, except for that value.
    const parsed = parseAgain(blankRange(css, comment.start, comment.end));
    walkNodes(parsed.root, (node) => {
      if (
        node.type === 'decl' &&
        node.source?.start?.offset === comment.declaration &&
        node.source.end?.offset === comment.end + 1
      ) {
        node.value = trim(css.slice(comment.value, comment.end));
        node.important = false;
        delete node.raws.value;
        delete node.raws.important;
      }
    });
    return parsed;
  }
  const found = recoverCompatibility(
    root,
    source,
    errors,
    silent,
    preserveComments,
    !silent || budget.left > 0,
  );
  if (!found) {
    const resume = source.rootResume;
    if (resume === undefined) return { root, source, errors };
    // V4 reads on from where it reads a rule or an at-rule. Everything
    // before that stays as read here: V4 reads no selector across the text
    // that stops it, so the text before it must not be parsed again.
    const before = (offset: number | undefined) =>
      offset === undefined || offset < resume;
    const read = root.nodes.filter((node) =>
      before(node.source?.start?.offset),
    );
    const parsed = parseAgain(blankRange(css, 0, resume));
    parsed.errors = [
      ...errors.filter((error) =>
        before(source.offsetAt(error.line, error.column)),
      ),
      ...parsed.errors,
    ];
    // Outer re-parses update the input text of the parsed root only.
    const input = parsed.root.source?.input;
    if (input) {
      for (const node of read) {
        if (node.source) node.source.input = input;
        if (node.type === 'rule' || node.type === 'atrule')
          node.walk((child) => {
            if (child.source) child.source.input = input;
          });
      }
    }
    // `prepend` moves nodes one at a time, so the roots are rebuilt instead.
    const nodes = read.concat(parsed.root.nodes);
    root.removeAll();
    parsed.root.removeAll();
    parsed.root.append(nodes);
    return parsed;
  }

  const { kind, offset, levels } = found;
  const before = errors.filter(
    (error) =>
      source.offsetAt(error.line, error.column) <
      (found.value?.start ?? offset),
  );
  const missing = (error: string) => source.error(error, offset);
  const closing = (node: postcss.Rule | postcss.AtRule) =>
    missing(
      node.type === 'atrule'
        ? `@${atRuleErrorName(node.name)} missing '}'`
        : "missing '}'",
    );
  if (kind === 'header' && found.header) {
    // V4 reads on from where the header ends, as a rule.
    const error = missing(found.header.reason);
    if (!silent) return { root, source, errors: before.concat(error) };
    const parsed = parseAgain(blankRange(css, found.header.start, offset));
    parsed.errors = insertErrors(parsed.errors, [error], source, offset);
    return parsed;
  }
  if (!silent) {
    // Strict parsing stops at the first error.
    before.push(
      kind === 'quote' || (kind === 'empty' && levels[0].reader === 'rules')
        ? missing('selector missing')
        : found.colon
          ? missing("property missing ':'")
          : closing(levels[0].node),
    );
    return { root, source, errors: before };
  }

  if (kind === 'quote') {
    // V4 fails to read a selector at each character up to the quote.
    const skipped: CssParseError[] = [];
    for (let at = offset; at <= found.quote; at++) {
      if (!/\s/.test(css[at]))
        skipped.push(source.error('selector missing', at));
    }
    const parsed = parseAgain(blankRange(css, offset, found.quote + 1));
    parsed.errors = insertErrors(parsed.errors, skipped, source, offset);
    return parsed;
  }

  if (kind === 'declarations') {
    // V4 reads on in the enclosing body from where it drops the block.
    const block = levels[0].node;
    const start = block.source?.start?.offset ?? 0;
    const dropped = errors.filter((error) => {
      const at = source.offsetAt(error.line, error.column);
      return at >= start && at < offset;
    });
    if (found.colon) dropped.push(missing("property missing ':'"));
    dropped.push(closing(block));
    const parsed = parseAgain(blankRange(css, start, offset));
    parsed.errors = insertErrors(parsed.errors, dropped, source, start);
    return parsed;
  }

  if (kind === 'miss' && found.miss) {
    // V4 drops an at-rule body it fails to close, keeps a rule without its
    // content, and reads on in the enclosing body.
    const block = levels[0].node;
    const start = block.source?.start?.offset ?? 0;
    const { miss } = found;
    const dropped = errors.filter((error) => {
      const at = source.offsetAt(error.line, error.column);
      return at >= start && at < miss.start;
    });
    dropped.push(...miss.errors, closing(block));
    const parsed = parseAgain(blankRange(css, start, offset));
    parsed.errors = insertErrors(parsed.errors, dropped, source, start);
    if (block.type === 'rule' && block.source) {
      block.removeAll();
      const end = source.pointAt(offset);
      block.source.end = { line: end.line, column: end.column - 1, offset };
      const next = parsed.root.nodes.find(
        (node) => (node.source?.start?.offset ?? 0) >= offset,
      );
      if (next) parsed.root.insertBefore(next, block);
      else parsed.root.append(block);
    }
    return parsed;
  }

  if (kind === 'value' && found.value) {
    const { valueStart, end } = found.value;
    const property = found.colon ? [missing("property missing ':'")] : [];
    if (end !== -1) {
      // V4 reads the value as empty, then reads on in the same body from
      // where it skips to, as it reads an empty value ended by `;`.
      const blank = blankRange(css, valueStart, end);
      const parsed = parseAgain(
        `${blank.slice(0, valueStart)};${blank.slice(valueStart + 1)}`,
      );
      parsed.errors = insertErrors(parsed.errors, property, source, offset);
      return parsed;
    }
    before.push(...property);
  }

  const semicolon = css.indexOf(';', offset);
  const brace = css.indexOf('}', offset);
  if (
    semicolon !== -1 &&
    (brace === -1 || semicolon < brace) &&
    levels[0].reader === 'rules'
  ) {
    // V4 skips to the `;` and reads on in the same block.
    const parsed = parseAgain(blankRange(css, offset, semicolon + 1));
    if (kind === 'empty') {
      parsed.errors = insertErrors(
        parsed.errors,
        [missing('selector missing')],
        source,
        offset,
      );
    }
    return parsed;
  }

  // V4 closes every enclosing block there, each failing to read a rule
  // without a selector first, and reads the rest from the root.
  for (const { node, reader } of levels) {
    if (kind === 'empty' && reader === 'rules')
      before.push(missing('selector missing'));
    before.push(closing(node));
  }
  const outer = levels[levels.length - 1].node;
  const outerStart = outer.source?.start?.offset ?? 0;
  const kept = root.nodes.filter(
    (node) => (node.source?.start?.offset ?? 0) < outerStart,
  );
  if (outer.type === 'rule' && outer.source) {
    // V4 keeps the rule without its content.
    outer.removeAll();
    const end = source.pointAt(offset);
    outer.source.end = { line: end.line, column: end.column - 1, offset };
    kept.push(outer);
  }
  const rest = parseAgain(blankRange(css, 0, offset));
  const nodes = rest.root.nodes.slice();
  rest.root.removeAll();
  root.removeAll();
  root.append(kept.concat(nodes));
  return { root, source, errors: before.concat(rest.errors) };
}

export const parse = (
  css: string,
  options?: ParseOptions,
): CssStylesheetAST => {
  const sourceName = options?.source ?? '';
  const silent = options?.silent ?? false;
  const preserveComments = options?.stripCommentsInValues === false;
  const { root, source, errors } = parseCompatibility(
    css,
    sourceName,
    silent,
    preserveComments,
    { left: 8 },
  );
  let parsingErrors = errors;
  const orphan = silent ? undefined : source.orphanBrace;
  const before = (error: CssParseError) =>
    orphan === undefined || source.offsetAt(error.line, error.column) < orphan;
  if (orphan !== undefined) {
    const retained = root.nodes.filter(
      (node) => (node.source?.start?.offset ?? 0) < orphan,
    );
    if (retained.length !== root.nodes.length) {
      root.removeAll();
      root.append(retained);
    }
    parsingErrors = parsingErrors.filter(before);
  }
  if (
    !parsingErrors.length &&
    source.bracketError &&
    before(source.bracketError)
  )
    parsingErrors = [source.bracketError];
  if (!silent && parsingErrors.length) throw parsingErrors[0];

  return buildStylesheet(
    root,
    sourceName,
    options?.source,
    parsingErrors,
    options?.stripCommentsInValues !== false,
  );
};

export default parse;
