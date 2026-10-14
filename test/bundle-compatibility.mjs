import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as v4 from 'css-tools-v4';

const require = createRequire(import.meta.url);
const umd = readFileSync(
  new URL('../dist/umd/adobe-css-tools.js', import.meta.url),
  'utf8',
);
const notices = readFileSync(
  new URL('../dist/umd/adobe-css-tools.LICENSES.txt', import.meta.url),
  'utf8',
);
for (const name of ['postcss', 'postcss-safe-parser', 'nanoid', 'picocolors']) {
  const license = readFileSync(
    new URL(`../node_modules/${name}/LICENSE`, import.meta.url),
    'utf8',
  );
  assert.ok(notices.includes(`${name}\n\n${license}`));
}
assert.ok(umd.includes('adobe-css-tools.LICENSES.txt'));
const browser = {};
runInNewContext(umd, browser);
const commonjsExports = {};
runInNewContext(umd, {
  exports: commonjsExports,
  module: { exports: commonjsExports },
});
let amdExports;
const define = (dependencies, factory) => {
  assert.deepEqual(Array.from(dependencies), ['exports']);
  amdExports = {};
  factory(amdExports);
};
define.amd = true;
runInNewContext(umd, { define });

const bundles = [
  ['CJS', require('../dist/cjs/adobe-css-tools.cjs')],
  ['ESM', await import('../dist/esm/adobe-css-tools.mjs')],
  ['UMD/browser', browser.cssTools],
  ['UMD/CommonJS', commonjsExports],
  ['UMD/AMD', amdExports],
];
const inputs = [
  '',
  'a { color: red; }',
  '@media screen { a { content: "/* text */"; color: red/**/blue; } }',
  'a { _color: blue; *zoom: 1; }',
  '@keyframes example { from { opacity: 0 } to { opacity: 1 } }',
  'a { color red; }',
  'a {} /*',
  '{ color: red; }',
  'a {} } b {}',
  'a { color: red; }\n/*# sourceMappingURL=data:application/json;base64,bm90LWpzb24= */',
  'a { color: /* keep */ red; }',
  'a {\n color: red\n background: blue;\n}',
  'a { color:: red }',
  'a { color: red: blue }',
  'a { : red }',
  'a { color: red; : blue; margin: 0; }',
  '@media /* keep */ screen { a {} }',
  '@import url(x.css) /* keep */ screen;',
  '@unknown /* keep */ value;',
  '@custom-media --x /* keep  spacing */ (width > 1px);',
  'a { color: red /* brand */ }',
  'a { color: red /* a */ /* b */ }',
  '@tailwind base;\n',
  '@unknown value;\r\n \t a {}',
  '@media screen { @unknown value;\n a {} }',
  '\uFEFFa {\r\n color red;\r\n margin: 0;\r\n}',
  'a { color red }\na { color red }',
  'garbage',
  'a{} garbage',
  'garbage; a{}',
  'a{--foo\\:bar:red;}',
  'a{*foo\\:bar:red; _foo\\:bar:blue;}',
  'a{--x:{color:red; padding:0}}',
  'a{--x:{--y:{color:red}}}',
  '@media x{--x:{color:red; padding:0}}',
  'a{--x:{color:red}; margin:0;}',
  '@foo',
  '@foo\r\n \t',
  'a{}\r\n@foo\n',
  '\uFEFF@foo\n',
];

function visible(value) {
  if (Array.isArray(value)) return Array.from(value, visible);
  if (value && typeof value === 'object') {
    return Object.fromEntries([
      ...(typeof value.message === 'string'
        ? [
            ['name', value.name],
            ['message', value.message],
          ]
        : []),
      ...Object.entries(value).map(([key, child]) => [key, visible(child)]),
    ]);
  }
  return value;
}

function outcome(parser, css, options) {
  try {
    return { ast: parser(css, options) };
  } catch (error) {
    return { error: visible(error) };
  }
}

for (const [name, api] of bundles) {
  assert.deepEqual(Object.keys(api).sort(), Object.keys(v4).sort(), name);
  assert.equal(api.default.parse, api.parse, name);
  assert.equal(api.default.stringify, api.stringify, name);
  assert.deepEqual(visible(api.CssTypes), visible(v4.CssTypes), name);
  for (const css of inputs) {
    for (const options of [
      {},
      { source: 'bundle.css' },
      { silent: true, source: 'bundle.css' },
    ]) {
      const expected = outcome(v4.parse, css, options);
      const actual = outcome(api.parse, css, options);
      assert.deepEqual(visible(actual), visible(expected), name);
      if (actual.ast && expected.ast) {
        for (const formatting of [{}, { compress: true }, { indent: '\t' }]) {
          assert.equal(
            api.stringify(actual.ast, formatting),
            v4.stringify(expected.ast, formatting),
            name,
          );
          assert.equal(
            api.stringify(expected.ast, formatting),
            v4.stringify(expected.ast, formatting),
            name,
          );
        }
      }
    }
  }
  for (const [css, expected] of [
    ['a { content: "/* text */"; }', 'a{content:"/* text */";}'],
    ['a{color:/*keep*/red;}', 'a{color:/*keep*/red;}'],
    ['a{color:/*keep*/red !important;}', 'a{color:/*keep*/red !important;}'],
    ['a { color: red /* brand */ }', 'a{color:red /* brand */;}'],
    ['a{color:/* ; } ( " */red;}', 'a{color:/* ; } ( " */red;}'],
    ['a{color:red/* ; } ( " */}', 'a{color:red/* ; } ( " */;}'],
    [
      'a{color:var(--x, /* ) ; } */ red);}',
      'a{color:var(--x, /* ) ; } */ red);}',
    ],
    ['a{--foo\\:bar:/*keep*/red;}', 'a{--foo\\:bar:/*keep*/red;}'],
    [
      'a{--x:{color:/*keep*/red; padding:0}}',
      'a{--x:{color:/*keep*/red;padding:0;}}',
    ],
  ]) {
    for (const silent of [false, true]) {
      assert.equal(
        api.stringify(
          api.parse(css, { silent, stripCommentsInValues: false }),
          { compress: true },
        ),
        expected,
        name,
      );
    }
  }
  console.log(`${name}: exports, ASTs, errors, formatting and option passed`);
}
