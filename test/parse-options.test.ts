import { type ParseOptions, parse, stringify } from '../src/index';

const css =
  '@media screen { a { content: "/* text */"; color: red/**/blue; } }';

describe('stripCommentsInValues', () => {
  it.each([undefined, {}, { stripCommentsInValues: true }])(
    'preserves V4 normalization by default with %j',
    (options: ParseOptions | undefined) => {
      expect(stringify(parse(css, options), { compress: true })).toBe(
        '@media screen{a{content:"";color:redblue;}}',
      );
    },
  );

  it.each([false, true])(
    'preserves quoted and embedded comment text when disabled, silent=%j',
    (silent) => {
      expect(
        stringify(parse(css, { silent, stripCommentsInValues: false }), {
          compress: true,
        }),
      ).toBe('@media screen{a{content:"/* text */";color:red/**/blue;}}');
    },
  );

  it('preserves raw value comments that PostCSS separates from the value', () => {
    expect(
      stringify(
        parse('a { color: red /* trailing */; }', {
          stripCommentsInValues: false,
        }),
        { compress: true },
      ),
    ).toBe('a{color:red /* trailing */;}');
  });

  it('does not remove standalone comment nodes when enabled', () => {
    expect(stringify(parse('/* standalone */a { color: red; }'))).toContain(
      '/* standalone */',
    );
  });

  it('does not share options between successive parses', () => {
    const plain = 'a { content: "/* text */"; }';
    expect(stringify(parse(plain, { stripCommentsInValues: false }))).toContain(
      '"/* text */"',
    );
    expect(stringify(parse(plain))).toContain('""');
  });
});
