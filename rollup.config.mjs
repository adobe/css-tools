import { readFileSync } from 'node:fs';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import dts from 'rollup-plugin-dts';

// Module builds use installed dependencies; UMD remains a standalone browser bundle.
const external = ['postcss', 'postcss-safe-parser'];

// Fix source map paths: tsconfig rootDir:"." causes extra "../" level
// ../../../src/ → ../../src/ so paths resolve correctly within the package
const fixSourceMapPath = (relativeSourcePath) =>
  relativeSourcePath.replace(/^(\.\.\/)*src\//, '../../src/');

const config = [
  {
    input: 'src/index.ts',
    output: {
      name: 'cssTools',
      file: 'dist/umd/adobe-css-tools.js',
      format: 'umd',
      sourcemap: true,
      exports: 'named',
      sourcemapPathTransform: fixSourceMapPath,
      banner:
        '/*! @adobe/css-tools | Third-party licenses: adobe-css-tools.LICENSES.txt */',
    },
    plugins: [
      resolve({ browser: true, preferBuiltins: false }),
      commonjs(),
      replace({
        preventAssignment: true,
        'process.env.NODE_ENV': JSON.stringify('production'),
        'process.env.LANG': 'undefined',
      }),
      typescript({
        outputToFilesystem: false,
        compilerOptions: {
          sourceMap: true,
        },
      }),
      terser(),
      {
        name: 'bundled-license-notices',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'adobe-css-tools.LICENSES.txt',
            source: ['postcss', 'postcss-safe-parser', 'nanoid', 'picocolors']
              .map(
                (name) =>
                  `${name}\n\n${readFileSync(
                    new URL(`./node_modules/${name}/LICENSE`, import.meta.url),
                    'utf8',
                  )}`,
              )
              .join('\n\n'),
          });
        },
      },
    ],
  },
  {
    input: 'src/index.ts',
    external,
    output: [
      {
        name: 'cssTools',
        format: 'cjs',
        file: 'dist/cjs/adobe-css-tools.cjs',
        dynamicImportInCjs: false,
        sourcemap: true,
        exports: 'named',
        sourcemapPathTransform: fixSourceMapPath,
      },
    ],
    plugins: [
      commonjs({
        transformMixedEsModules: true,
      }),
      typescript({
        outputToFilesystem: false,
      }),
      terser(),
    ],
  },
  {
    input: 'src/index.ts',
    external,
    output: [
      {
        name: 'cssTools',
        format: 'esm',
        file: 'dist/esm/adobe-css-tools.mjs',
        sourcemap: true,
        exports: 'named',
        sourcemapPathTransform: fixSourceMapPath,
      },
    ],
    plugins: [
      typescript({
        outputToFilesystem: false,
        compilerOptions: {
          sourceMap: true,
        },
      }),
      terser(),
    ],
  },
  {
    input: 'src/index.ts',
    output: [
      { file: 'dist/esm/adobe-css-tools.d.mts', format: 'es' },
      { file: 'dist/cjs/adobe-css-tools.d.cts', format: 'es' },
      { file: 'dist/umd/adobe-css-tools.d.ts', format: 'es' },
    ],
    plugins: [dts()],
  },
];

export default config;
