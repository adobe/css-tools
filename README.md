# @adobe/css-tools

> A modern CSS parser and stringifier with TypeScript support

[![npm version](https://badge.fury.io/js/%40adobe%2Fcss-tools.svg)](https://badge.fury.io/js/%40adobe%2Fcss-tools)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Parse CSS into an Abstract Syntax Tree (AST) and convert it back to CSS with configurable formatting. Built with TypeScript for type safety and modern JavaScript features.

## V5: Final Compatibility Release

V5 will be the **final release of `@adobe/css-tools`**. We recommend moving to
[PostCSS](https://postcss.org/) directly whenever possible, especially for new projects.

V5 retains **V4's public API and css-tools AST**. It replaces the parser
internals with PostCSS and adds compatibility shims for existing options and
default output. The returned AST remains a css-tools AST rather than a native
PostCSS AST. The V4 parser is not used at runtime.

Compatibility is verified for the tested corpus, not every CSS input. The
[upstream parser limitations](#known-issues-in-v5) are accepted for this final
release and **will not be fixed** in css-tools.

Using PostCSS directly is a separate migration: its API and AST differ from
css-tools. V5 lets existing applications upgrade without that migration while
keeping a path open to using PostCSS directly.

## Install

```bash
npm install @adobe/css-tools
```

## Usage

```js
import { parse, stringify } from '@adobe/css-tools'

// Parse CSS to AST
const ast = parse('body { font-size: 12px; }')

// Stringify AST back to CSS
const css = stringify(ast)
// => "body { font-size: 12px; }"

// Pretty print with custom indentation
const formatted = stringify(ast, { indent: '  ' })
// => "body {\n  font-size: 12px;\n}"

// Minify output
const minified = stringify(ast, { compress: true })
// => "body{font-size:12px}"
```

## API

### `parse(code, options?)`

Parses CSS code and returns an Abstract Syntax Tree (AST).

**Parameters:**
- `code` (string) - The CSS code to parse
- `options` (object, optional) - Parsing options
  - `silent` (boolean) - Collect recoverable parse errors instead of throwing. Recovery can still throw for some malformed inputs; see [known issues](#known-issues-in-v5).
  - `source` (string) - File path for better error reporting
  - `stripCommentsInValues` (boolean) - Remove comment-like text from declaration values, including inside quoted strings, for V4 compatibility (default: `true`). Set to `false` to preserve leading, embedded, and trailing value comments.

**Returns:** `CssStylesheetAST` - The parsed CSS as an AST

### `stringify(ast, options?)`

Converts a CSS AST back to CSS string with configurable formatting.

**Parameters:**
- `ast` (CssStylesheetAST) - The CSS AST to stringify
- `options` (object, optional) - Stringification options
  - `indent` (string) - Indentation string (default: `'  '`)
  - `compress` (boolean) - Whether to compress/minify the output (default: `false`)

**Returns:** `string` - The formatted CSS string

## Features

- **Complete CSS Support**: All standard CSS features including selectors, properties, values, at-rules, and comments
- **TypeScript Support**: Full type definitions for all AST nodes and functions
- **Error Handling**: Configurable error handling with detailed position information
- **Formatting Options**: Pretty print, minify, or custom formatting
- **Performance Optimized**: Efficient parsing and stringification for large CSS files
- **Source Positions**: Track original source positions for debugging and tooling

### Supported CSS Features

- **Selectors**: Element, class, ID, attribute, pseudo-class, pseudo-element selectors
- **Properties**: All standard CSS properties and custom properties
- **Values**: Colors, lengths, percentages, functions, calc(), etc.
- **At-rules**: @media, @keyframes, @import, @charset, @namespace, @font-face, @page, @document, @supports, @container, @layer, @starting-style, @host, @custom-media
- **Comments**: Both /* */ and // comments
- **Whitespace**: Preserves formatting information
- **Vendor prefixes**: Supports vendor-prefixed at-rules and properties
- **Nested rules**: Media queries, supports, containers, etc.
- **Complex selectors**: Combinators, pseudo-selectors, attribute selectors

## Examples

### Error Handling

```js
import { parse } from '@adobe/css-tools'

const malformedCss = `
  body { color: red; }
  { color: blue; } /* Missing selector */
  .valid { background: green; }
`

// Parse with silent error handling
const result = parse(malformedCss, { silent: true })

// Check for parsing errors
if (result.stylesheet.parsingErrors) {
  console.log('Parsing errors:', result.stylesheet.parsingErrors.length)
  result.stylesheet.parsingErrors.forEach(error => {
    console.log(`Error at line ${error.line}: ${error.message}`)
  })
}

// Valid rules are still parsed
console.log('Valid rules:', result.stylesheet.rules.length)
```

### Source Tracking

```js
import { parse } from '@adobe/css-tools'

const css = 'body { color: red; }'
const ast = parse(css, { source: 'styles.css' })

// Position information is available
const rule = ast.stylesheet.rules[0]
console.log(rule.position?.source) // "styles.css"
console.log(rule.position?.start) // { line: 1, column: 1 }
console.log(rule.position?.end) // { line: 1, column: 20 }
```

Positions and parse errors refer to the supplied CSS. As in V4, input source maps
are not loaded or resolved; `sourceMappingURL` comments remain ordinary CSS comments.

For more examples, see the [Examples documentation](docs/EXAMPLES.md).

## Performance

V5's PostCSS-based parser was faster than the published V4.5.0 parser on these
samples. Measurements used Benchmark.js with repeated warm, steady-state samples
on Node.js 24.18.0 and an Apple M3 Max (macOS/arm64). ASTs and stringified outputs
were checked for equality before timing. These measurements use PostCSS 8.5.30
and include the final compatibility repairs.

| CSS input | Size | V4.5.0 parse (ms) | V5 parse (ms) | V5 speedup |
|---|---:|---:|---:|---:|
| One rule | 20 bytes | 0.0058 | 0.0042 | 1.4x |
| `benchmark/small.css` | 7.8 KB | 0.499 | 0.314 | 1.6x |
| Pure.css 3.0.0 | 26.2 KB | 4.101 | 1.556 | 2.6x |
| Bootstrap 5.3.3 | 281 KB | 632.3 | 23.3 | 27.2x |

For Bootstrap, parsing plus default stringification improved from **637.9 ms to
26.3 ms**, about **24x faster**. Stringification alone was broadly unchanged:
Bootstrap took about 0.77 ms in V4 and 0.81 ms in V5.

Warm throughput is not cold-start latency. A separate alternating-order,
forced-GC batch run measured a 17-byte rule at 0.0060 ms in V4 and 0.0099 ms
in V5. Median module loading, excluding process startup, was 0.80 ms for V4's
CJS entry and 9.18 ms for V5's ESM entry across eleven fresh processes each.
Fresh-process Bootstrap peak RSS was about 72.1 MiB in V4 and 96.3 MiB in V5,
including module initialization, a live AST, and compressed stringification.
The standalone UMD bundle grew from 20,942 to 94,070 bytes, or from 4,701 to
27,525 bytes gzipped.

These are sample measurements, not guaranteed speedups. Results depend on the
CSS, warm-up, garbage collection, runtime, and hardware. See the `benchmark/`
directory for the existing parser benchmark and its inputs, and
[known issues](#known-issues-in-v5) for upstream adversarial-input costs.

## V4 Compatibility Tests

The V5 parser uses PostCSS with compatibility shims, not the V4 parser.
`css-tools-v4` is a development-only alias pinned to the published
`@adobe/css-tools@4.5.0` release as the test oracle.

```bash
npm ci
npm test -- --runInBand
npm run build
npm run test:bundles
npm run test:compatibility:public
```

The offline suite compares all existing CSS fixtures, lexical/error edge cases,
and 1,000 seeded generated inputs. It checks complete AST fields, source positions,
non-enumerable parent links, strict and silent errors, and byte-identical default,
compressed, and custom-indent output. It also checks that V5 can stringify V4 ASTs.
Bundle checks cover CJS, ESM, and standalone UMD browser, CommonJS, and AMD loading.
Each loader also parses depth-2048 nested media in an isolated process with a
128 MiB old-space limit and a five-second deadline, checking ASTs, positions, and
parent descriptors without recursively walking the result. This gate covers
parsing, not deep stringification.

The public-CSS command samples eight complete stylesheets from ten pinned npm
distribution URLs on jsDelivr, using seed `0x405000`. It verifies SHA-256 checksums
before testing and stores downloads and their provenance in the gitignored
`.compatibility-css/` directory. The sample includes Bootstrap (normal and minified),
Bulma, Animate.css, Pure.css, Milligram, Water.css, and Modern Normalize.
Public files use default parse options and all three formatting modes; the offline
inputs exercise `source` and `silent` combinations. The published V4 parser is slow
on the full Bulma file, so this opt-in command can take several minutes.

Passing these comparisons establishes exact parity for the tested inputs, not a
proof of identical behavior for every possible CSS string. Additional lexical
and malformed-input probes have confirmed differences outside that corpus.

## Known Issues in V5

The following upstream resource limitations are accepted and **will not be fixed**
in css-tools. They affect both strict and silent parsing.

**Core PostCSS at-rule token handling** takes superlinear time on headers with
many leading comments, such as `'@unknown ' + '/**/ '.repeat(n) + 'x;'`.
PostCSS repeatedly removes tokens from the front of an array before the
compatibility layer receives the AST. This is not regex backtracking.

**Safe-parser recovery resource exhaustion** occurs when `postcss-safe-parser`
recursively recovers long sequences without declaration semicolons, such as
`'a {' + '\n color: red'.repeat(3100) + '\n}'`. This can overflow the stack or
exhaust memory before the compatibility layer receives an AST. V4 accepts this
input; the failure threshold depends on the runtime and resource limits. This
recovery issue is separate from core PostCSS's token-handling cost.

For untrusted CSS, `silent` is not an exception-safety or execution-time
guarantee. Limit input size and isolate parsing in a worker or process with an
enforceable timeout; an in-process timer cannot interrupt synchronous parsing.
Applications relying on V4's behavior for these inputs should not treat V5 as a
behaviorally identical upgrade.

## Documentation

- [API Reference](docs/API.md) - Complete API documentation
- [AST Structure](docs/AST.md) - Detailed AST node types and structure
- [Examples](docs/EXAMPLES.md) - Comprehensive usage examples
- [Changelog](docs/CHANGELOG.md) - Version history and changes

## Background

This is a fork of the npm `css` package, maintained by Adobe with modern improvements including TypeScript support, enhanced performance, and security updates. It provides a robust foundation for CSS tooling, preprocessing, and analysis.

## License

[MIT](LICENSE)
