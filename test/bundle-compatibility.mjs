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
  assert.equal(
    api.stringify(
      api.parse('a { content: "/* text */"; }', {
        stripCommentsInValues: false,
      }),
      { compress: true },
    ),
    'a{content:"/* text */";}',
    name,
  );
  console.log(`${name}: exports, ASTs, errors, formatting and option passed`);
}
