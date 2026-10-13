import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseV4, stringify as stringifyV4 } from 'css-tools-v4';
import { parse, stringify } from '../src/index';

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
];

cases.push(...edgeCases.map((css, index) => ({ name: `edge/${index}`, css })));

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
