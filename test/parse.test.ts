import type CssParseError from '../src/CssParseError';
import { parse, stringify } from '../src/index';
import {
  type CssDeclarationAST,
  type CssMediaAST,
  type CssPageAST,
  type CssPageMarginBoxAST,
  type CssRuleAST,
  CssTypes,
} from '../src/type';

describe('parse(str)', () => {
  it('should save the filename and source', () => {
    const css = 'booty {\n  size: large;\n}\n';
    const ast = parse(css, {
      source: 'booty.css',
    });

    expect(ast.stylesheet.source).toBe('booty.css');

    const position = ast.stylesheet.rules[0].position;
    expect(position?.start).toBeDefined();
    expect(position?.end).toBeDefined();
    expect(position?.source).toBe('booty.css');
    // expect(position.content).toBe(css);
  });

  it('should throw when a selector is missing', () => {
    expect(() => {
      parse('{size: large}');
    }).toThrow();

    expect(() => {
      parse('b { color: red; }\n{ color: green; }\na { color: blue; }');
    }).toThrow();
  });

  it('should throw when a broken comment is found', () => {
    expect(() => {
      parse('thing { color: red; } /* b { color: blue; }');
    }).toThrow();

    expect(() => {
      parse('/*');
    }).toThrow();

    /* Nested comments should be fine */
    expect(() => {
      parse('/* /* */');
    }).not.toThrow();
  });

  it('should allow empty property value', () => {
    expect(() => {
      parse('p { color:; }');
    }).not.toThrow();
  });

  it('should not throw with silent option', () => {
    expect(() => {
      parse('thing { color: red; } /* b { color: blue; }', { silent: true });
    }).not.toThrow();
  });

  it('should list the parsing errors and continue parsing', () => {
    const result = parse(
      'foo { color= red; } bar { color: blue; } baz {}} boo { display: none}',
      {
        silent: true,
        source: 'foo.css',
      },
    );

    const rules = result.stylesheet.rules;
    expect(rules.length).toBeGreaterThan(2);

    const errors = result.stylesheet.parsingErrors;
    expect(errors).toBeDefined();
    expect(errors?.length).toBe(2);

    const firstError = (errors as unknown as Array<CssParseError>)[0];

    expect(firstError).toHaveProperty('message');
    expect(firstError).toHaveProperty('reason');
    expect(firstError).toHaveProperty('filename');
    expect(firstError.filename).toBe('foo.css');
    expect(firstError).toHaveProperty('line');
    expect(firstError).toHaveProperty('column');
    expect(firstError).toHaveProperty('source');
  });

  it('should set parent property', () => {
    const result = parse(
      'thing { test: value; }\n' +
        '@media (min-width: 100px) { thing { test: value; } }',
    );

    // expect(result).not.toHaveProperty('parent');

    const rules = result.stylesheet.rules;
    expect(rules.length).toBe(2);

    let rule = rules[0] as CssRuleAST;
    expect(rule.parent).toBe(result);
    expect(rule.declarations.length).toBe(1);

    let decl = rule.declarations[0];
    expect(decl.parent).toBe(rule);

    const media = rules[1] as CssMediaAST;
    expect(media.parent).toBe(result);
    expect(media.rules.length).toBe(1);

    rule = media.rules[0] as CssRuleAST;
    expect(rule.parent).toBe(media);

    expect(rule.declarations.length).toBe(1);
    decl = rule.declarations[0];
    expect(decl.parent).toBe(rule);
  });

  // GitHub Issue #210: @page with @left-middle crashes parser
  // https://github.com/adobe/css-tools/issues/210
  describe('issue #210: @page with margin box at-rules', () => {
    it('should parse @page with @left-middle without crashing', () => {
      const css = '@page { margin: 2cm; @left-middle { content: "Hello"; } }';
      const ast = parse(css);
      const page = ast.stylesheet.rules[0] as CssPageAST;

      expect(page.type).toBe(CssTypes.page);
      expect(page.declarations.length).toBe(2);

      const marginDecl = page.declarations[0] as CssDeclarationAST;
      expect(marginDecl.type).toBe(CssTypes.declaration);
      expect(marginDecl.property).toBe('margin');
      expect(marginDecl.value).toBe('2cm');

      const marginBox = page.declarations[1] as CssPageMarginBoxAST;
      expect(marginBox.type).toBe(CssTypes.pageMarginBox);
      expect(marginBox.name).toBe('left-middle');
      expect(marginBox.declarations.length).toBe(1);
      expect((marginBox.declarations[0] as CssDeclarationAST).property).toBe(
        'content',
      );
    });

    it('should parse all 16 page margin box at-rules', () => {
      const marginBoxNames = [
        'top-left-corner',
        'top-left',
        'top-center',
        'top-right',
        'top-right-corner',
        'bottom-left-corner',
        'bottom-left',
        'bottom-center',
        'bottom-right',
        'bottom-right-corner',
        'left-top',
        'left-middle',
        'left-bottom',
        'right-top',
        'right-middle',
        'right-bottom',
      ];

      for (const name of marginBoxNames) {
        const css = `@page { @${name} { content: "x"; } }`;
        const ast = parse(css);
        const page = ast.stylesheet.rules[0] as CssPageAST;
        const box = page.declarations[0] as CssPageMarginBoxAST;
        expect(box.type).toBe(CssTypes.pageMarginBox);
        expect(box.name).toBe(name);
      }
    });

    it('should roundtrip @page with margin boxes', () => {
      const css =
        '@page :first {\n  margin: 2cm;\n  @top-center {\n    content: "Title";\n  }\n  @bottom-center {\n    content: counter(page);\n  }\n}';
      expect(stringify(parse(css))).toBe(css);
    });
  });

  // GitHub Issue #122: CSS nesting support
  // https://github.com/adobe/css-tools/issues/122
  describe('issue #122: CSS nesting', () => {
    it('should parse nested rules', () => {
      const css = '.parent { color: red; .child { color: blue; } }';
      const ast = parse(css);
      const rule = ast.stylesheet.rules[0] as CssRuleAST;

      expect(rule.selectors).toEqual(['.parent']);
      expect(rule.declarations.length).toBe(2);

      const decl = rule.declarations[0] as CssDeclarationAST;
      expect(decl.property).toBe('color');
      expect(decl.value).toBe('red');

      const nested = rule.declarations[1] as CssRuleAST;
      expect(nested.type).toBe(CssTypes.rule);
      expect(nested.selectors).toEqual(['.child']);
      expect((nested.declarations[0] as CssDeclarationAST).value).toBe('blue');
    });

    it('should parse deeply nested rules', () => {
      const css = '.a { .b { .c { color: red; } } }';
      const ast = parse(css);
      const a = ast.stylesheet.rules[0] as CssRuleAST;
      const b = a.declarations[0] as CssRuleAST;
      const c = b.declarations[0] as CssRuleAST;

      expect(a.selectors).toEqual(['.a']);
      expect(b.selectors).toEqual(['.b']);
      expect(c.selectors).toEqual(['.c']);
      expect((c.declarations[0] as CssDeclarationAST).value).toBe('red');
    });

    it('should parse & selector nesting', () => {
      const css = 'a { &:hover { color: red; } &::before { content: "x"; } }';
      const ast = parse(css);
      const rule = ast.stylesheet.rules[0] as CssRuleAST;

      expect(rule.declarations.length).toBe(2);
      expect((rule.declarations[0] as CssRuleAST).selectors).toEqual([
        '&:hover',
      ]);
      expect((rule.declarations[1] as CssRuleAST).selectors).toEqual([
        '&::before',
      ]);
    });

    it('should parse nested @media inside a rule', () => {
      const css =
        '.card { padding: 1rem; @media (min-width: 768px) { padding: 2rem; } }';
      const ast = parse(css);
      const rule = ast.stylesheet.rules[0] as CssRuleAST;

      expect(rule.declarations.length).toBe(2);
      const media = rule.declarations[1] as CssMediaAST;
      expect(media.type).toBe(CssTypes.media);
      expect(media.media).toBe('(min-width: 768px)');
    });

    it('should roundtrip nested CSS', () => {
      const css =
        '.parent {\n  color: red;\n  .child {\n    color: blue;\n  }\n}';
      expect(stringify(parse(css))).toBe(css);
    });

    it('should handle declarations after nested rules', () => {
      const css = '.a { .b { color: red; } margin: 0; }';
      const ast = parse(css);
      const rule = ast.stylesheet.rules[0] as CssRuleAST;
      expect(rule.declarations.length).toBe(2);
      expect((rule.declarations[0] as CssRuleAST).selectors).toEqual(['.b']);
      expect((rule.declarations[1] as CssDeclarationAST).property).toBe(
        'margin',
      );
    });
  });

  // GitHub Issue #175: Comment with { in selector causes parse failure
  // https://github.com/adobe/css-tools/issues/175
  describe('issue #175: comments with braces in selectors', () => {
    it('should parse selector with commented-out parts containing braces', () => {
      const css = 'head, /* footer, */body/*, nav */ { foo: bar; }';
      const ast = parse(css);
      const rule = ast.stylesheet.rules[0] as CssRuleAST;

      expect(rule.selectors).toEqual(['head', 'body']);
      expect(rule.declarations.length).toBe(1);
      expect((rule.declarations[0] as CssDeclarationAST).property).toBe('foo');
      expect((rule.declarations[0] as CssDeclarationAST).value).toBe('bar');
    });

    it('should parse selector with comment before opening brace', () => {
      const css = '.a /* comment */ { color: red; }';
      const ast = parse(css);
      const rule = ast.stylesheet.rules[0] as CssRuleAST;

      expect(rule.selectors).toEqual(['.a']);
      expect((rule.declarations[0] as CssDeclarationAST).value).toBe('red');
    });

    it('should roundtrip selector with comments stripped', () => {
      const css = 'head, /* footer, */body { color: red; }';
      const output = stringify(parse(css));
      expect(output).toContain('head,');
      expect(output).toContain('body');
      expect(output).toContain('color: red');
      expect(output).not.toContain('footer');
    });
  });

  // GitHub Issue #188: Stylesheets with errors / silent mode recovery
  // https://github.com/adobe/css-tools/issues/188
  describe('issue #188: error recovery in silent mode', () => {
    it('should recover valid declarations after invalid ones', () => {
      const css = '* { aa; display: block; }';
      const ast = parse(css, { silent: true });
      const rule = ast.stylesheet.rules[0] as CssRuleAST;

      expect(rule.selectors).toEqual(['*']);
      expect(rule.declarations.length).toBe(1);
      expect((rule.declarations[0] as CssDeclarationAST).property).toBe(
        'display',
      );
      expect((rule.declarations[0] as CssDeclarationAST).value).toBe('block');
    });

    it('should continue parsing rules after error recovery', () => {
      const css = '.broken { badprop; } .ok { color: red; }';
      const ast = parse(css, { silent: true });
      const rules = ast.stylesheet.rules;

      expect(rules.length).toBe(2);
      const okRule = rules[1] as CssRuleAST;
      expect(okRule.selectors).toEqual(['.ok']);
      expect((okRule.declarations[0] as CssDeclarationAST).value).toBe('red');
    });

    it('should recover from extra closing braces', () => {
      const css = '.a {} } .b { color: blue; }';
      const ast = parse(css, { silent: true });
      const rules = ast.stylesheet.rules;

      expect(rules.length).toBe(2);
      expect((rules[0] as CssRuleAST).selectors).toEqual(['.a']);
      expect((rules[1] as CssRuleAST).selectors).toEqual(['.b']);
      expect(
        ((rules[1] as CssRuleAST).declarations[0] as CssDeclarationAST).value,
      ).toBe('blue');
    });

    it('should recover from multiple errors in one rule', () => {
      const css = '.x { bad1; bad2; color: green; font-size: 1rem; }';
      const ast = parse(css, { silent: true });
      const rule = ast.stylesheet.rules[0] as CssRuleAST;

      expect(rule.selectors).toEqual(['.x']);
      const decls = rule.declarations.filter(
        (d) => d.type === CssTypes.declaration,
      ) as CssDeclarationAST[];
      expect(decls.length).toBe(2);
      expect(decls[0].property).toBe('color');
      expect(decls[1].property).toBe('font-size');
    });

    it('should record parsing errors', () => {
      const css = '* { aa; display: block; }';
      const ast = parse(css, { silent: true });

      expect(ast.stylesheet.parsingErrors).toBeDefined();
      expect(ast.stylesheet.parsingErrors?.length).toBeGreaterThan(0);
    });

    it('should not recover when silent is false', () => {
      expect(() => {
        parse('* { aa; display: block; }');
      }).toThrow();
    });
  });
});
