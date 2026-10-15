import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseV4, stringify as stringifyV4 } from 'css-tools-v4';
import postcss from 'postcss';
import { parse, stringify } from '../src/index';
import type { CssAtRuleAST, CssDeclarationAST } from '../src/type';

const cases = fs.readdirSync(path.join(__dirname, 'cases')).map((name) => ({
  name: `fixture/${name}`,
  css: fs.readFileSync(
    path.join(__dirname, 'cases', name, 'input.css'),
    'utf8',
  ),
}));

const edgeCases = [
  '',
  ' \r\n\t',
  'a { color: red }',
  'a { color: red   ; }',
  'a {\n color: red\n}',
  'a { color: red /* comment */; }',
  'a { *color: red; _color: blue; }',
  'a { color: red!important; }',
  'a { color: red ! important; }',
  'a { content: "/* not a comment */"; }',
  'a { content: "}"; }',
  '@MEDIA screen { a { color: red; } }',
  '@layer reset;\n\n a {}',
  '@unknown x { color: red; }',
  'a { color red; }',
  'a { color: red',
  'a {} /*',
  '{ color: red; }',
  'a {} } b {}',
  'foo { color= red; } bar { color: blue; } baz {}} boo { display: none}',
  'a { content: "/*"; }',
  'a { color: /* before */red/* after */; }',
  'a { color: red !/**/important; }',
  'a { co/**/lor: red; }',
  '.a\\{b { color: red; } .x {}',
  '.a\\}b { color: red; } .x {}',
  'a { background: url(data:image/svg+xml,{x}); } .x {}',
  'a { COLOR: RED; }',
  '\uFEFFa { color: red; }',
  'a { color: red; /* trailing */ }',
  '@media screen { a { color: red } }',
  '@keyframes test { 0%, 100% { opacity: 0; } }',
  '@media screen { a { color red; } }',
  'a { color red; background blue; }',
  'a {\n color red;\n background blue;\n}',
  'a { color: red;',
  'a {',
  '@media screen { a {}',
  '@font-face { font-family: test;',
  '@media screen;',
  '@supports (display: grid);',
  '@keyframes {}',
  '@import "x";\n a { color red; }',
  'a { color: red }\n/* unterminated',
  'a { color: red; /* unterminated',
  'a { content: "unterminated; }',
  'a { color:red;;background:blue; }',
  'a { & b { color: blue; } }',
  '@unknown a { color:red; a { margin:0; } }',
  '@charset "UTF-8";\r\n/* comment */\r\na{color: red}',
  'a{color: red}\n\nb {margin: 0}',
  'a { color: red; }\n/*# sourceMappingURL=data:application/json;base64,bm90LWpzb24= */',
  'a { color red; }\n/*# sourceMappingURL=data:application/json;base64,bm90LWpzb24= */',
];

cases.push(...edgeCases.map((css, index) => ({ name: `edge/${index}`, css })));

const regressions = [
  ['leading-value-comment', 'a { color: /* keep */ red; }'],
  ['missing-semicolon', 'a {\n color: red\n background: blue;\n}'],
  ['double-colon', 'a { color:: red }'],
  ['extra-value-colon', 'a { color: red: blue }'],
  ['empty-property', 'a { : red }'],
  ['empty-property-after-declaration', 'a { color: red; : blue; margin: 0; }'],
  ['media-prelude-comment', '@media /* c */ screen { a {} }'],
  ['import-prelude-comment', '@import url(x.css) /* c */ screen;'],
  ['generic-prelude-comment', '@unknown /* c */ value;'],
  ['trailing-value-comment', 'a { color: red /* brand */ }'],
  ['multiple-trailing-value-comments', 'a { color: red /* a */ /* b */ }'],
  ['trailing-value-comment-newline', 'a {\n color: red /* brand */\n}'],
  ['generic-statement-newline', '@tailwind base;\n'],
  ['generic-statement-whitespace', '@unknown value;\r\n \t a {}'],
  ['nested-generic-statement', '@media screen { @unknown value;\n a {} }'],
  ['commented-property', 'a { co/**/lor: /* keep */ red; }'],
  [
    'commented-hack-values',
    'a { *zoom: /* keep */ 1; _color: blue /* end */ }',
  ],
  [
    'standalone-comments-after-semicolons',
    'a { color: red; /* keep */ margin: 0; /* end */ }',
  ],
  ['nested-trailing-value-comment', 'a { & b { color: red /* end */ } }'],
  [
    'important-trailing-comment',
    'a { color: /* keep */ red !/**/important /* end */ }',
  ],
  [
    'quoted-value-delimiters',
    'a { content: "a;}"; background: url("data:x,{};"); }',
  ],
  ['bom-trailing-value-comment', '\uFEFFa { color: red /* end */ }'],
  [
    'bom-malformed-declarations',
    '\uFEFFa {\r\n color red;\r\n margin: 0;\r\n}',
  ],
  [
    'bom-malformed-empty-property',
    '\uFEFFa { color: red; : blue; margin: 0; }',
  ],
  ['crlf-missing-semicolon', 'a {\r\n color: red\r\n margin: 0;\r\n}'],
  ['layer-block-position', '@layer /* keep */ base { a {} }\r\n b {}'],
  [
    'document-block-position',
    '@-moz-document /* keep */ url(x) { a {} }\n b {}',
  ],
  [
    'supports-prelude-comments',
    '@supports /* keep */ (display: grid) /* end */ { a {} }',
  ],
  ['import-leading-prelude-comment', '@import /* keep */ url(x.css) screen;'],
  ['namespace-prelude-comment', '@namespace /* keep */ url("x");'],
  [
    'custom-media-prelude-comments',
    '@custom-media --x /* keep  spacing */ (width > 1px);',
  ],
  [
    'custom-media-multiline-prelude',
    '@custom-media --x\n /* keep */ (width:\n  1px);\n',
  ],
  ['generic-block-prelude-comment', '@unknown /* keep */ x /* end */ { a {} }'],
  [
    'malformed-declarations-with-valid-siblings',
    'a { color red; margin: 0; background blue; padding: 1px; }',
  ],
  [
    'nested-malformed-declarations',
    '@media screen { a { color red; margin: 0; } b {} }',
  ],
  [
    'valid-rule-after-malformed-declarations',
    'a { color red; margin: 0; } b { color: blue; }',
  ],
  ['malformed-unclosed-declaration', 'a { color red; margin: 0;'],
  ['unknown-top-level-word', 'garbage'],
  ['unknown-top-level-tail', 'a{} garbage'],
  ['unknown-before-statement', 'garbage; @import "x";'],
  ['unknown-prefix-in-selector', 'garbage; a{}'],
  ['unknown-tail-after-malformed-rule', 'a { color red; } garbage'],
  ['bom-unknown-top-level-tail', '\uFEFFa{} \r\ngarbage'],
  ['top-level-declaration', 'color:red;'],
  ['declaration-prefix-in-selector', 'color:red; a{}'],
  ['escaped-custom-property-colon', 'a{--foo\\:bar:red;}'],
  ['escaped-property-colon', 'a{foo\\:bar:red;}'],
  ['escaped-hack-property-colon', 'a{*foo\\:bar:red; _foo\\:bar:blue;}'],
  ['escaped-commented-property-colon', 'a{co/**/lor\\:name:/* keep */red;}'],
  ['multiple-escaped-property-colons', 'a{--foo\\:bar\\:baz:red;}'],
  ['escaped-property-empty-value', 'a{--foo\\:bar:;}'],
  ['escaped-property-important', 'a{--foo\\:bar:red !important;}'],
  ['escaped-property-separator-whitespace', 'a { --foo\\:bar : "red"; }'],
  ['custom-property-block', 'a{--x : {a:b}}'],
  ['custom-property-block-semicolons', 'a{--x:{color:red; padding:0}}'],
  ['custom-property-block-prefix', 'a{--x:prefix {a:b}}'],
  ['custom-property-block-comments', 'a{--x:/* name */{color:/* keep */red}}'],
  ['nested-custom-property-blocks', 'a{--x:{--y:{color:red}}}'],
  ['custom-property-block-quoted-header', 'a{--x:"{};--z:" {color:red}}'],
  [
    'custom-property-literal-delimiters',
    'a{--x:"{color:red;}"; --y:var(--z,{padding:0});}',
  ],
  [
    'custom-property-block-siblings',
    'a{color:blue; --x:{color:red; padding:0} margin:0;} b{padding:1px;}',
  ],
  ['custom-property-block-trailing-semicolon', 'a{--x:{color:red}; margin:0;}'],
  ['custom-property-block-media', '@media x{--x:{color:red; padding:0}}'],
  ['custom-property-block-layer', '@layer x{a{--x:{color:red}}}'],
  ['custom-property-block-generic', '@unknown x{--x:{color:red}}'],
  ['custom-property-block-root', '--x:{color:red}'],
  [
    'custom-property-block-bom-crlf',
    '\uFEFFa{\r\n --x : {\r\n color:red;\r\n padding:0\r\n }\r\n}',
  ],
  ['generic-eof', '@foo'],
  ['generic-eof-space', '@foo '],
  ['generic-eof-newline', '@foo\n'],
  ['generic-eof-crlf', '@foo\r\n \t'],
  ['generic-eof-after-rule', 'a{}\r\n@foo\n'],
  ['generic-eof-bom', '\uFEFF@foo\n'],
  ['anonymous-layer-minified', '@layer{a{color:red}}'],
  ['anonymous-layer-spaced', '@layer {a{color:red}}'],
  ['anonymous-layer-empty', '@layer{}b{margin:0}'],
  ['parameterized-generic-eof', '@unknown x'],
  ['parameterized-generic-eof-comment', '@unknown x /*c*/'],
  ['generic-eof-comment', '@foo /*c*/'],
  ['generic-eof-comment-crlf', '@foo \r\n/* c */\r\n'],
  ['generic-eof-following-generic', '@foo /*c*/ @bar'],
  ['parameterized-generic-eof-following-generic', '@unknown x /*c*/ @bar'],
  ['parameterized-generic-eof-trivia', '@unknown x \n'],
  ['bare-known-media-eof', '@media'],
  ['bare-known-supports-eof', '@supports'],
  ['bare-known-import-eof', '@import'],
  ['layer-statement-eof-comment', '@layer a,b /*c*/'],
  ['layer-statement-eof-comment-control', '@layer a,b /*c*/;'],
  ['statement-eof-trivia-charset', '@charset "UTF-8" \n'],
  ['statement-eof-trivia-import', '@import "x" \n'],
  ['statement-eof-trivia-namespace', '@namespace url(x) \n'],
  ['escaped-hex-property', 'a{\\63 olor:red}'],
  ['missing-block-keyframes', '@keyframes x;'],
  ['missing-block-keyframes-trivia', '@keyframes x \r\n;'],
  ['missing-block-keyframes-following-rule', '@keyframes x; a{}'],
  ['missing-block-vendor-keyframes', '@-webkit-keyframes x;'],
  ['missing-block-vendor-document', '@-moz-document url(x);'],
  [
    'missing-block-vendor-document-prelude-semicolon',
    '@-moz-document url(x); a{}',
  ],
  ['missing-block-page-margin', '@page{@top-left;}'],
  ['missing-block-page-margin-root', '@top-left;'],
  ['missing-block-page-margin-comment', '@page{@top-left;/*c*/}'],
  ['missing-block-page-margin-following-rule', '@page{@top-left;} a{}'],
  [
    'missing-block-page-margin-remaining-child',
    '@page{@top-left; @bottom-left{x:y}}',
  ],
  ['declaration-only-font-face', '@font-face{--x:{a:b}}'],
  [
    'declaration-only-font-face-following-rule',
    '@font-face{--x:{a:b}}/*end*/b{color:red}',
  ],
  ['declaration-only-nested-custom-block', '@font-face{x:{{a:b}}}'],
  [
    'declaration-only-font-face-comment-closer',
    '@font-face{color: /* } */red}b{}',
  ],
  ['declaration-only-font-face-bracketed-value', '@font-face{x:[{a:b}]}b{}'],
  ['declaration-only-page', '@page{--x:{a:b}}'],
  ['declaration-only-property', '@property --test{--x:{a:b}}'],
  ['declaration-only-counter-style', '@counter-style test{--x:{a:b}}'],
  ['declaration-only-view-transition', '@view-transition{--x:{a:b}}'],
  ['declaration-only-position-try', '@position-try --test{--x:{a:b}}'],
  ['declaration-only-keyframes', '@keyframes x{0%{--x:{a:b}}}'],
  [
    'declaration-only-keyframes-following-rule',
    '@keyframes x{0%{--x:{a:b}}}b{color:red}',
  ],
  [
    'declaration-only-keyframe-comment-closer',
    '@keyframes x{0%{color: /* } */red}}b{}',
  ],
  ['declaration-only-vendor-keyframes', '@-webkit-keyframes x{0%{--x:{a:b}}}'],
  ['declaration-only-page-margin', '@page{@top-left{--x:{a:b}}}'],
  [
    'declaration-only-page-margin-following-rule',
    '@page{@top-left{--x:{a:b}}}b{color:red}',
  ],
];
for (const [name, opening] of [
  ['media', '@media a{'],
  ['supports', '@supports (display:grid){'],
  ['rule', 'a{'],
  ['layer', '@layer a{'],
  ['generic', '@unknown a{'],
  ['page', '@page{'],
]) {
  for (const [variant, body] of [
    ['comment', '@foo /*c*/'],
    ['comment-crlf', '@foo /* c */\r\n'],
    ['multiple-comments', '@foo /*c*/ /*d*/'],
    ['statement', '@foo @bar'],
    ['comment-and-statement', '@foo /*c*/ @bar'],
  ]) {
    regressions.push([`nested-eof-${name}-${variant}`, `${opening}${body}}`]);
  }
  if (name === 'page') continue;
  for (const [variant, body] of [
    ['keyframes', '@keyframes x;'],
    ['vendor-keyframes', '@-webkit-keyframes x;'],
    ['valid-sibling', '@keyframes x; c:d;'],
    ['commented-sibling', '@keyframes x; /*c*/ c:d;'],
    ['commented-header', '@keyframes x /**/ c:d;'],
    ['comment-only-header', '@keyframes x /*c*/;'],
    ['malformed-header', '@keyframes x junk; c:d;'],
    ['header-declaration', '@keyframes x c:d;'],
    ['header-value-comment', '@keyframes x c:/*keep*/d;'],
  ]) {
    regressions.push([
      `nested-recovery-${name}-${variant}`,
      `${opening}${body}}b{c:d}`,
    ]);
  }
}
cases.push(
  ...regressions.map(([name, css]) => ({ name: `regression/${name}`, css })),
);

// A fixed seed makes generated failures reproducible.
let seed = 0x405000;
function pick<T>(values: readonly T[]): T {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return values[Math.floor((seed / 0x100000000) * values.length)];
}

for (let index = 0; index < 1000; index++) {
  const selector = pick(['a', '.x:hover', '#id', '[data-x="a,b"]', 'a, b']);
  const whitespace = pick([' ', '\n', '\r\n', '\t', '  ']);
  const property = pick(['color', '--x', 'margin', 'content', '*zoom']);
  const value = pick([
    'red',
    '0',
    'calc(100% - 1px)',
    '"a,b"',
    'url("x.svg")',
    'red !important',
    'red/**/blue',
    '',
  ]);
  const body = `${selector}${whitespace}{${whitespace}${property}:${whitespace}${value}${pick([';', '', ' ;'])}${whitespace}}`;
  const css = pick([
    body,
    `/* generated */${whitespace}${body}`,
    `@media screen {${whitespace}${body}${whitespace}}`,
    `@supports (display: grid) {${body}}`,
    `@layer test {${body}}`,
  ]);
  cases.push({ name: `generated/${index}`, css });
}

const publicDirectory = path.join(__dirname, '..', '.compatibility-css');
if (process.env.CSS_TOOLS_PUBLIC_CSS === '1') {
  if (!fs.existsSync(publicDirectory)) {
    throw new Error(
      'Run node test/fetch-public-css.mjs before public CSS tests.',
    );
  }
  const manifest: unknown = JSON.parse(
    fs.readFileSync(path.join(publicDirectory, 'manifest.json'), 'utf8'),
  );
  if (!Array.isArray(manifest) || manifest.length !== 8) {
    throw new Error('Expected eight pinned public CSS samples.');
  }
  for (const entry of manifest) {
    const sample: unknown = entry;
    if (
      !sample ||
      typeof sample !== 'object' ||
      !('name' in sample) ||
      typeof sample.name !== 'string' ||
      path.basename(sample.name) !== sample.name ||
      !sample.name.endsWith('.css') ||
      !('sha256' in sample) ||
      typeof sample.sha256 !== 'string'
    ) {
      throw new Error('Invalid public CSS manifest entry.');
    }
    const css = fs.readFileSync(
      path.join(publicDirectory, sample.name),
      'utf8',
    );
    if (createHash('sha256').update(css).digest('hex') !== sample.sha256) {
      throw new Error(`Public CSS checksum mismatch: ${sample.name}`);
    }
    cases.push({ name: `public/${sample.name}`, css });
  }
}

function outcome(
  parser: typeof parse,
  css: string,
  options: { source?: string; silent?: boolean },
) {
  try {
    return { ast: parser(css, options) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return {
      error: {
        ...error,
        name: error.name,
        message: error.message,
      },
    };
  }
}

function observable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(observable);
  if (value && typeof value === 'object') {
    return {
      ...(value instanceof Error
        ? { name: value.name, message: value.message }
        : {}),
      ...Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, observable(child)]),
      ),
    };
  }
  return value;
}

function firstDifference(
  actual: unknown,
  expected: unknown,
  location = '$',
): unknown {
  if (Object.is(actual, expected)) return undefined;
  if (
    actual === null ||
    expected === null ||
    typeof actual !== 'object' ||
    typeof expected !== 'object'
  ) {
    return { location, actual, expected };
  }
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(actual, key))
  ) {
    return { location, actualKeys, expectedKeys };
  }
  for (const key of expectedKeys) {
    const difference = firstDifference(
      Reflect.get(actual, key),
      Reflect.get(expected, key),
      `${location}.${key}`,
    );
    if (difference) return difference;
  }
  return undefined;
}

function parentDifference(
  value: unknown,
  parent: object | null = null,
  location = '$',
): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if ('type' in value && typeof value.type === 'string') {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'parent');
    if (
      !descriptor ||
      descriptor.value !== parent ||
      descriptor.enumerable ||
      !descriptor.writable ||
      !descriptor.configurable
    ) {
      return `${location}: invalid parent link or descriptor`;
    }
    parent = value;
  }
  for (const [key, child] of Object.entries(value)) {
    const difference = parentDifference(child, parent, `${location}.${key}`);
    if (difference) return difference;
  }
  return undefined;
}

describe.each(cases)('V4 compatibility: $name', ({ name, css }) => {
  const options = name.startsWith('public/')
    ? [{}]
    : [
        {},
        { source: 'compatibility.css' },
        { silent: true },
        { silent: true, source: 'compatibility.css' },
      ];
  it.each(options)('matches AST and errors for %j', (options) => {
    const expected = outcome(parseV4, css, options);
    const actual = outcome(parse, css, options);
    // Separate package copies have different class identities, but the same
    // observable fields (including undefined properties) must be preserved.
    expect(
      firstDifference(observable(actual), observable(expected)),
    ).toBeUndefined();
    if (!expected.ast || !actual.ast) return;
    expect(parentDifference(actual.ast)).toBeUndefined();
    expect(parentDifference(expected.ast)).toBeUndefined();

    for (const formatting of [{}, { compress: true }, { indent: '\t' }]) {
      expect(stringify(actual.ast, formatting)).toBe(
        stringifyV4(expected.ast, formatting),
      );
      expect(stringify(expected.ast, formatting)).toBe(
        stringifyV4(expected.ast, formatting),
      );
    }
  });
});

describe.each([
  { name: 'separate rules', css: 'a { color red; }\n'.repeat(128) },
  { name: 'one rule', css: `a {${' color red;'.repeat(128)} }` },
  { name: 'rules without semicolons', css: 'a { color red }\n'.repeat(128) },
  {
    name: 'empty recovered properties',
    css: `a {${' : red;'.repeat(128)} margin: 0; }`,
  },
])('V5 error recovery complexity: $name', ({ css }) => {
  it.each([false, true])(
    'does not reparse or traverse all declarations per error, silent=%j',
    (silent) => {
      const expected = outcome(parseV4, css, { silent });
      const parsing = jest.spyOn(postcss, 'parse');
      const walking = jest.spyOn(postcss.Container.prototype, 'walkDecls');
      try {
        const actual = outcome(parse, css, { silent });
        expect(
          firstDifference(observable(actual), observable(expected)),
        ).toBeUndefined();
        expect(parsing.mock.calls.length).toBeLessThanOrEqual(2);
        expect(walking.mock.calls.length).toBeLessThanOrEqual(1);
      } finally {
        parsing.mockRestore();
        walking.mockRestore();
      }
    },
  );
});

describe.each([
  {
    name: 'separate custom-property blocks',
    css: 'a{--x:{color:red; padding:0}}\n'.repeat(128),
  },
  {
    name: 'nested custom-property blocks',
    css: `a{${'--x:{'.repeat(128)}color:red${'}'.repeat(128)}}`,
  },
])('V4 block classification complexity: $name', ({ css }) => {
  it('does not reparse each custom-property block', () => {
    const expected = parseV4(css);
    const parsing = jest.spyOn(postcss, 'parse');
    try {
      const actual = parse(css);
      expect(
        firstDifference(observable(actual), observable(expected)),
      ).toBeUndefined();
      expect(parentDifference(actual)).toBeUndefined();
      expect(parsing).toHaveBeenCalledTimes(1);
    } finally {
      parsing.mockRestore();
    }
  });
});

describe('deep V4-compatible media blocks', () => {
  it.each([false, true])(
    'preserves values, positions and parents without wrapper recursion, silent=%j',
    (silent) => {
      const depth = 512;
      const css = `${'@media all{'.repeat(depth)}a{x:y;}${'} '.repeat(depth)}`;
      const expected = parseV4(css, { silent });
      const actual = parse(css, { silent });
      let expectedNode: CssAtRuleAST | CssDeclarationAST =
        expected.stylesheet.rules[0];
      let actualNode: CssAtRuleAST | CssDeclarationAST =
        actual.stylesheet.rules[0];
      let parent: object = actual;
      for (let index = 0; index < depth; index++) {
        if (expectedNode.type !== 'media' || actualNode.type !== 'media') {
          throw new Error(`Expected a media node at depth ${index}`);
        }
        expect(actualNode.media).toBe(expectedNode.media);
        expect(actualNode.position).toEqual(expectedNode.position);
        const descriptor = Object.getOwnPropertyDescriptor(
          actualNode,
          'parent',
        );
        expect(descriptor).toEqual({
          value: parent,
          enumerable: false,
          writable: true,
          configurable: true,
        });
        parent = actualNode;
        actualNode = actualNode.rules[0];
        expectedNode = expectedNode.rules[0];
      }
      expect(observable(actualNode)).toEqual(observable(expectedNode));
      expect(actual.stylesheet.parsingErrors).toEqual(
        expected.stylesheet.parsingErrors,
      );
    },
  );
});
