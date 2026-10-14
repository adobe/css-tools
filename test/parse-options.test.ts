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

  describe.each([false, true])('comment preservation, silent=%j', (silent) => {
    it.each([
      ['a{color:/*keep*/red;}', 'a{color:/*keep*/red;}'],
      ['a{--x:/*keep*/red;}', 'a{--x:/*keep*/red;}'],
      ['a{color:/*keep*/red !important;}', 'a{color:/*keep*/red !important;}'],
      ['a{color:/*a*/red/*b*/;}', 'a{color:/*a*/red/*b*/;}'],
      ['a { color: red /* brand */ }', 'a{color:red /* brand */;}'],
      ['a{--x:/*keep*/;}', 'a{--x:/*keep*/;}'],
      ['a{color:/*keep*/!important;}', 'a{color:/*keep*/!important;}'],
      ['a{color:/* ; } ( " */red;}', 'a{color:/* ; } ( " */red;}'],
      ['a{color:red/* ; } ( " */;}', 'a{color:red/* ; } ( " */;}'],
      ['a{color:red/* ; } ( " */}', 'a{color:red/* ; } ( " */;}'],
      ['a{content:"/* ; } () */";}', 'a{content:"/* ; } () */";}'],
      ['a{content:"x;}" /*keep*/}', 'a{content:"x;}" /*keep*/;}'],
      [
        'a{color:var(--x, /* ) ; } */ red);}',
        'a{color:var(--x, /* ) ; } */ red);}',
      ],
    ])('preserves the full value of %s', (input, expected) => {
      expect(
        stringify(parse(input, { silent, stripCommentsInValues: false }), {
          compress: true,
        }),
      ).toBe(expected);
    });
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

  describe.each([false, true])(
    'large declaration values, stripCommentsInValues=%j',
    (stripCommentsInValues) => {
      it.each([
        {
          name: 'deep parentheses',
          value: `${'('.repeat(4096)}0${')'.repeat(4096)}`,
        },
        { name: 'many strings', value: '"x" '.repeat(4096).trim() },
        { name: 'many functions', value: 'f(0) '.repeat(4096).trim() },
        { name: 'many escapes', value: '\\x '.repeat(12000).trim() },
      ])(
        'handles $name without recursive or repeated suffix scans',
        ({ value }) => {
          const input = `a{x:${value};}`;
          expect(
            stringify(parse(input, { stripCommentsInValues }), {
              compress: true,
            }),
          ).toBe(input);
        },
      );
    },
  );
});
