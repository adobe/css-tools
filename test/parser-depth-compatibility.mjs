import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as v4 from 'css-tools-v4';

const require = createRequire(import.meta.url);
const bundles = ['CJS', 'ESM', 'UMD/browser', 'UMD/CommonJS', 'UMD/AMD'];
const depth = 2048;
const opening = '@media all{';
const leaf = 'a{x:y;}';
const nestedCSS = (depth) => opening.repeat(depth) + leaf + '} '.repeat(depth);
const css = nestedCSS(depth);

function expectedAST(depth, source) {
  const leafStart = opening.length * depth;
  const position = (start, end) => ({
    start: { line: 1, column: start + 1 },
    end: { line: 1, column: end + 1 },
    source,
  });
  let node = {
    type: 'rule',
    selectors: ['a'],
    declarations: [
      {
        type: 'declaration',
        property: 'x',
        value: 'y',
        position: position(leafStart + 2, leafStart + 5),
      },
    ],
    position: position(leafStart, leafStart + leaf.length),
  };
  for (let level = depth - 1; level >= 0; level--) {
    node = {
      type: 'media',
      media: 'all',
      rules: [node],
      position: position(
        opening.length * level,
        leafStart + leaf.length + (depth - level) * 2 - 1,
      ),
    };
  }
  return {
    type: 'stylesheet',
    stylesheet: { source, rules: [node], parsingErrors: [] },
  };
}

function assertSameAST(actual, expected) {
  const pending = [{ actual, expected, parent: null }];
  while (pending.length) {
    const entry = pending.pop();
    const { actual, expected } = entry;
    if (!expected || typeof expected !== 'object') {
      assert.equal(actual, expected);
      continue;
    }
    assert.ok(actual && typeof actual === 'object');
    assert.equal(Array.isArray(actual), Array.isArray(expected));
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
    const parent = typeof actual.type === 'string' ? actual : entry.parent;
    if (typeof actual.type === 'string') {
      assert.deepEqual(Object.getOwnPropertyDescriptor(actual, 'parent'), {
        value: entry.parent,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    for (const key of Object.keys(expected)) {
      pending.push({ actual: actual[key], expected: expected[key], parent });
    }
  }
}

async function loadBundle(name) {
  if (name === 'CJS') return require('../dist/cjs/adobe-css-tools.cjs');
  if (name === 'ESM') return import('../dist/esm/adobe-css-tools.mjs');
  const umd = readFileSync(
    new URL('../dist/umd/adobe-css-tools.js', import.meta.url),
    'utf8',
  );
  if (name === 'UMD/browser') {
    const browser = {};
    runInNewContext(umd, browser);
    return browser.cssTools;
  }
  if (name === 'UMD/CommonJS') {
    const exports = {};
    runInNewContext(umd, { exports, module: { exports } });
    return exports;
  }
  if (name === 'UMD/AMD') {
    let exports;
    const define = (dependencies, factory) => {
      assert.deepEqual(Array.from(dependencies), ['exports']);
      exports = {};
      factory(exports);
    };
    define.amd = true;
    runInNewContext(umd, { define });
    return exports;
  }
  assert.fail(`Unknown bundle: ${name}`);
}

if (process.argv[2] === '--worker') {
  const name = process.argv[3];
  const api = await loadBundle(name);
  for (const silent of [false, true]) {
    const options = { silent, source: 'resource.css' };
    // V4 itself overflows at depth 2048 on some supported Node versions.
    assertSameAST(
      v4.parse(nestedCSS(16), options),
      expectedAST(16, options.source),
    );
    const expected = expectedAST(depth, options.source);
    for (const stripCommentsInValues of [false, true]) {
      const actual = api.parse(css, {
        ...options,
        stripCommentsInValues,
      });
      assertSameAST(actual, expected);
    }
  }
  console.log(`${name}: depth-2048 ASTs, positions and parents passed`);
} else {
  for (const name of bundles) {
    const child = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=128',
        fileURLToPath(import.meta.url),
        '--worker',
        name,
      ],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(
      child.status,
      0,
      `${name}: ${child.error?.message ?? child.signal ?? ''}\n${child.stderr}`,
    );
    process.stdout.write(child.stdout);
  }
}
