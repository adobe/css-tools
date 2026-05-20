import { createDefaultEsmPreset } from 'ts-jest';

const ignores = ['/node_modules/', '__mocks__', '/dist/'];
const tsJestTransformCfg = createDefaultEsmPreset({
  tsconfig: { moduleResolution: 'bundler', ignoreDeprecations: '6.0' },
});

/** @type {import("jest").Config} **/
export default {
  ...tsJestTransformCfg,
  collectCoverageFrom: [
    'src/**/*.+(js|jsx|ts|tsx)',
    '!**/node_modules/**',
    '!**/*.d.ts',
  ],
  testPathIgnorePatterns: [...ignores],
  coveragePathIgnorePatterns: [...ignores],
};
