import typescript from '@rollup/plugin-typescript';
import dts from 'rollup-plugin-dts';
import terser from '@rollup/plugin-terser';

import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

const config = [
  {
    input: 'src/index.ts',
    output: {
      name: 'cssTools',
      file: 'dist/umd/adobe-css-tools.js',
      format: 'umd',
      sourcemap: true,
      exports: 'named',
    },
    plugins: [
      resolve(),
      commonjs(),
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
      {
        name: 'cssTools',
        format: 'cjs',
        file: 'dist/cjs/adobe-css-tools.cjs',
        dynamicImportInCjs: false,
        sourcemap: true,
        exports: 'named',
      },
    ],
    plugins: [
      commonjs({
        transformMixedEsModules: true,
      }),
      typescript(),
      terser(),
    ],
  },
  {
    input: 'src/index.ts',
    output: [
      {
        name: 'cssTools',
        format: 'esm',
        file: 'dist/esm/adobe-css-tools.mjs',
        sourcemap: true,
        exports: 'named',
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
      {file: 'dist/esm/adobe-css-tools.d.mts', format: 'es'},
      {file: 'dist/cjs/adobe-css-tools.d.cts', format: 'es'},
      {file: 'dist/umd/adobe-css-tools.d.ts', format: 'es'},
    ],
    plugins: [dts()],
  },
];

export default config;
