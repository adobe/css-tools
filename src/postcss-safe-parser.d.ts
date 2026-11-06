declare module 'postcss-safe-parser' {
  import type { ProcessOptions, Root } from 'postcss';

  function safeParse(
    css: string | { toString(): string },
    opts?: ProcessOptions,
  ): Root;
  export = safeParse;
}
