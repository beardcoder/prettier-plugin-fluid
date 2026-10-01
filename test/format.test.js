import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import * as prettier from 'prettier';

import fluid from '../dist/index.js';
import { preprocess } from '../dist/preprocess.js';
import { restore } from '../dist/restore.js';

const ALL_PLUGINS = [fluid, 'prettier-plugin-organize-attributes', 'prettier-plugin-tailwindcss'];

/** @param {string} version */
const parseVersion = (version) => version.split(/[.-]/, 3).map(Number);

/**
 * @param {string} version
 * @param {string} minimum
 */
function isAtLeast(version, minimum) {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] > b[i];
    }
  }

  return true;
}

/**
 * prettier-plugin-tailwindcss 0.8 declares `prettier: ^3.0`, but fails with a
 * TypeError on Prettier 3.0.0 to 3.6.2 even for plain HTML (checked with
 * 0.8.1). CI also runs the suite against the oldest supported Prettier. Any
 * other failure is a real error and must fail the tests.
 *
 * @param {string} prettierVersion
 * @param {string} tailwindVersion
 * @returns {string | false} Why the Tailwind tests are skipped.
 */
function tailwindIncompatibility(prettierVersion, tailwindVersion) {
  const known = tailwindVersion.startsWith('0.8.') && !isAtLeast(prettierVersion, '3.7.0');

  return known && `prettier-plugin-tailwindcss ${tailwindVersion} needs Prettier 3.7, not ${prettierVersion}`;
}

const tailwindPackage = new URL('../package.json', import.meta.resolve('prettier-plugin-tailwindcss'));
const skipTailwind = tailwindIncompatibility(
  prettier.version,
  JSON.parse(await readFile(tailwindPackage, 'utf8')).version,
);

const format = (source, options = {}) => prettier.format(source, { parser: 'fluid', plugins: [fluid], ...options });

async function assertFormat(source, expected, options) {
  const output = await format(source, options);
  assert.equal(output, expected);
  assert.equal(await format(output, options), output, 'formatting must be idempotent');
}

describe('layout', () => {
  test('structural ViewHelpers are blocks', async () => {
    await assertFormat(
      `<f:if condition="{a}"><f:then><p>yes</p></f:then><f:else><p>no</p></f:else></f:if>`,
      `<f:if condition="{a}">\n  <f:then><p>yes</p></f:then>\n  <f:else><p>no</p></f:else>\n</f:if>\n`,
    );
  });

  test('EXT:form ViewHelpers that render children are blocks', async () => {
    await assertFormat(
      `<f:section name="Main">\n<formvh:renderAllFormValues renderable="{form.formDefinition}" as="formValue">{f:render(section: 'FieldValue', arguments: '{_all}')}</formvh:renderAllFormValues>\n</f:section>`,
      `<f:section name="Main">\n  <formvh:renderAllFormValues renderable="{form.formDefinition}" as="formValue">\n    {f:render(section: 'FieldValue', arguments: '{_all}')}\n  </formvh:renderAllFormValues>\n</f:section>\n`,
    );
  });

  test('prettier-ignore still applies to ViewHelpers', async () => {
    await assertFormat(
      `<div>\n<!-- prettier-ignore -->\n<f:if condition="{a}"><b>keep   this</b></f:if>\n</div>`,
      `<div>\n  <!-- prettier-ignore -->\n  <f:if condition="{a}"><b>keep   this</b></f:if>\n</div>\n`,
    );
  });

  test('prettier-ignore inside f:comment applies to the next node', async () => {
    await assertFormat(
      `<div>\n<f:comment><!-- prettier-ignore --></f:comment>\n<div   class="a"  >keep   this</div>\n<p>  x  </p>\n</div>`,
      `<div>\n  <f:comment><!-- prettier-ignore --></f:comment>\n  <div   class="a"  >keep   this</div>\n  <p>x</p>\n</div>\n`,
    );
    await assertFormat(
      `<div>\n<f:comment> <!-- prettier-ignore --> </f:comment>\n<f:if condition="{a}"><b>keep   this</b></f:if>\n</div>`,
      `<div>\n  <f:comment> <!-- prettier-ignore --> </f:comment>\n  <f:if condition="{a}"><b>keep   this</b></f:if>\n</div>\n`,
    );
  });

  test('directives inside f:comment apply to the next node', async () => {
    await assertFormat(
      `<div>\n<f:comment><!-- prettier-ignore-attribute --></f:comment>\n<div   class="a   b"  id="x"></div>\n<f:comment><!-- display: block --></f:comment>\n<my:thing>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</my:thing>\n<f:comment><!-- display: inline --></f:comment>\n<f:if condition="{a}">x</f:if>\n</div>`,
      `<div>\n  <f:comment><!-- prettier-ignore-attribute --></f:comment>\n  <div class="a   b" id="x"></div>\n  <f:comment><!-- display: block --></f:comment>\n  <my:thing>\n    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n  </my:thing>\n  <f:comment><!-- display: inline --></f:comment>\n  <f:if condition="{a}">x</f:if>\n</div>\n`,
    );
  });

  test('f:variable content is kept as written', async () => {
    await assertFormat(
      `<div>\n<f:variable name="classes">btn btn-primary btn-large some-other-class another-class yet-another-class</f:variable>\n<f:variable   name="x" value="{y}"/>\n</div>`,
      `<div>\n  <f:variable name="classes">btn btn-primary btn-large some-other-class another-class yet-another-class</f:variable>\n  <f:variable name="x" value="{y}" />\n</div>\n`,
    );
  });

  test('prettier-ignore-start/end keeps the range as written', async () => {
    await assertFormat(
      `<div>\n<!-- prettier-ignore-start -->\n<div   class="a"  >keep   this</div>\n<f:if condition="{a}"><p>  y  </p></f:if>\n<!-- prettier-ignore-end -->\n<p>  x  </p>\n</div>`,
      `<div>\n  <!-- prettier-ignore-start -->\n<div   class="a"  >keep   this</div>\n<f:if condition="{a}"><p>  y  </p></f:if>\n<!-- prettier-ignore-end -->\n  <p>x</p>\n</div>\n`,
    );
  });

  test('prettier-ignore-start/end also works inside f:comment', async () => {
    await assertFormat(
      `<div>\n<f:comment><!-- prettier-ignore-start --></f:comment>\n<b   class="{a -> f:format.raw()}">keep   this</b>\n<f:comment><!-- prettier-ignore-end --></f:comment>\n<f:if condition="{a}"><p>  x  </p></f:if>\n</div>`,
      `<div>\n  <f:comment><!-- prettier-ignore-start --></f:comment>\n<b   class="{a -> f:format.raw()}">keep   this</b>\n<f:comment><!-- prettier-ignore-end --></f:comment>\n  <f:if condition="{a}"><p>x</p></f:if>\n</div>\n`,
    );
  });

  test('prettier-ignore-start without end ignores the rest', async () => {
    await assertFormat(
      `<p>  a  </p>\n<!-- prettier-ignore-start -->\n<p>  b  </p>\n`,
      `<p>a</p>\n<!-- prettier-ignore-start -->\n<p>  b  </p>\n`,
    );
  });

  test('user display comments win over the default', async () => {
    await assertFormat(
      `<span><!-- display: inline --><f:if condition="{a}">x</f:if></span>`,
      `<span><!-- display: inline --><f:if condition="{a}">x</f:if></span>\n`,
    );
  });

  test('ViewHelper tags keep their width next to custom elements', async () => {
    // Templates that already use such tag names still restore correctly.
    await assertFormat(
      `<div><f-if>a</f-if><f:if condition="{b}"><p>b</p></f:if></div>`,
      `<div>\n  <f-if>a</f-if><f:if condition="{b}"><p>b</p></f:if>\n</div>\n`,
    );
    await assertFormat(
      `<f:link.page pageUid="{uid}" class="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" />`,
      `<f:link.page pageUid="{uid}" class="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" />\n`,
    );
  });
});

describe('custom ViewHelpers', () => {
  const source = `<div><my:card.teaser item="{item}">{item.title -> my:format.crop(length: 3)}</my:card.teaser></div>`;

  test('are recognized and inline by default', async () => {
    await assertFormat(
      source,
      `<div>\n  <my:card.teaser item="{item}"\n    >{item.title -> my:format.crop(length: 3)}</my:card.teaser\n  >\n</div>\n`,
    );
  });

  test('fluidBlockViewHelpers extends the defaults, with wildcards', async () => {
    await assertFormat(
      source,
      `<div>\n  <my:card.teaser item="{item}">\n    {item.title -> my:format.crop(length: 3)}\n  </my:card.teaser>\n</div>\n`,
      { fluidBlockViewHelpers: ['my:card.*'] },
    );
    // defaults still apply
    await assertFormat(
      `<div><f:if condition="{a}">x</f:if></div>`,
      `<div>\n  <f:if condition="{a}">x</f:if>\n</div>\n`,
      {
        fluidBlockViewHelpers: ['my:*'],
      },
    );
  });

  test('fluidInlineViewHelpers overrides the defaults', async () => {
    await assertFormat(`<p>a <f:render partial="X" /> b</p>`, `<p>a <f:render partial="X" /> b</p>\n`, {
      fluidInlineViewHelpers: ['f:render'],
    });
  });

  test('camelCase names are preserved', async () => {
    await assertFormat(`<my:fooBar someArg="{x}" />`, `<my:fooBar someArg="{x}" />\n`);
  });
});

describe('shorthand syntax', () => {
  test('is never re-wrapped', async () => {
    const expression = `{f:translate(key: 'x', default: 'A rather long default text that would normally wrap')}`;
    await assertFormat(`<p>Hello ${expression}</p>`, `<p>\n  Hello\n  ${expression}\n</p>\n`);
  });

  test('escaped quotes in ViewHelper arguments', async () => {
    const source = `<f:form.textfield additionalAttributes="{placeholder: \\"Name\\"}" />\n`;
    await assertFormat(source, source);
  });

  test('escaped quotes in ViewHelper arguments outside of expressions', async () => {
    const source = `<f:link.typolink parameter="{link}" textWrap="<span class=\\"icon\\">|</span>" />\n`;
    await assertFormat(source, source);
  });

  test('expression syntax: ternary, casts, arithmetic, negation', async () => {
    const source = `<p>\n  {foo ? x : y} {foo ?: y} {!foo ?: y} {foo as boolean} {foo % 5} {foo ^ 5}\n  {true ? false: true}\n</p>\n`;
    await assertFormat(source, source);
  });

  test('ternary conditions with operators shorthand syntax does not allow', async () => {
    const source = `<p>\n  {(a && b) ? 'yes   indeed' : 'no'} {(foo.bar < 10) ? 'x' : 'y'}\n  {!(false && 1) ? 'yes' : 'no'} {(1 <= 0) ? 'yes' : 'no'}\n</p>\n`;
    await assertFormat(source, source);
  });

  test('in attribute-name position', async () => {
    const source = `<div {attributes -> f:format.raw()} class="a"></div>\n`;
    await assertFormat(source, source);
  });

  test('multi-line expressions break the tag and move with its indent', async () => {
    await assertFormat(
      `<f:render partial="Card" arguments="{\n  title: item.title,\n  link: item.link\n}" />\n`,
      `<f:render
  partial="Card"
  arguments="{
    title: item.title,
    link: item.link
  }"
/>
`,
    );
    // nested one level deeper: continuation lines move along
    await assertFormat(
      `<div><f:render partial="Card" arguments="{\n  title: item.title\n}" /></div>\n`,
      `<div>
  <f:render
    partial="Card"
    arguments="{
      title: item.title
    }"
  />
</div>
`,
    );
  });

  test('non-Fluid braces and CDATA are left alone', async () => {
    const source = `<p>{ not fluid; }</p>\n<![CDATA[ {raw} ]]>\n`;
    await assertFormat(source, source);
  });
});

describe('fluidArraySpacing', () => {
  const always = { fluidArraySpacing: 'always' };
  const never = { fluidArraySpacing: 'never' };

  test('preserve (default) keeps arrays as written', async () => {
    const source = `<f:render partial="Card" arguments="{1:tree,2:house}" />\n`;
    await assertFormat(source, source);
  });

  test('always adds spaces inside the braces and after commas', async () => {
    await assertFormat(
      `<f:render partial="Card" arguments="{1:tree,2:house}" />`,
      `<f:render partial="Card" arguments="{ 1:tree, 2:house }" />\n`,
      always,
    );
    await assertFormat(
      `<f:render partial="Card" arguments="{item: item ,title:'A, B'}" />`,
      `<f:render partial="Card" arguments="{ item: item, title:'A, B' }" />\n`,
      always,
    );
  });

  test('never removes spaces inside the braces', async () => {
    await assertFormat(
      `<f:render partial="Card" arguments="{ 1:tree, 2:house }" />`,
      `<f:render partial="Card" arguments="{1:tree, 2:house}" />\n`,
      never,
    );
  });

  test('nested arrays, also in inline ViewHelper arguments', async () => {
    await assertFormat(
      `<p>{f:translate(key: 'x', arguments: {0: a,1: {b: c}})}</p>`,
      `<p>{f:translate(key: 'x', arguments: { 0: a, 1: { b: c } })}</p>\n`,
      always,
    );
    await assertFormat(
      `<div data-count="{items -> f:count()} {f:count(subject: {a: 1,b: 2})}"></div>`,
      `<div data-count="{items -> f:count()} {f:count(subject: { a: 1, b: 2 })}"></div>\n`,
      always,
    );
  });

  test('every array in ViewHelper arguments, also with a single entry', async () => {
    await assertFormat(
      `<f:render partial="Card" arguments="{fh:tree}" />\n<f:variable.set name="x" value='{"w":"1"}' />`,
      `<f:render partial="Card" arguments="{ fh:tree }" />\n<f:variable.set name="x" value='{ "w":"1" }' />\n`,
      always,
    );
  });

  test('never touches arrays outside of ViewHelper arguments: Fluid outputs them as text', async () => {
    const source = `<p x-data="{open: false,count: 0}" data-json='{"w":"1"}'>
  {fh:tree} {1:tree,2:house} {f:format.raw()} {a -> f:format.raw()}
  {foo ? x : y} {item.title} {a == 'b'} {f:if(condition: a, then: 'x')}
</p>
`;
    await assertFormat(source, source, always);
    await assertFormat(source, source, never);
  });

  test('fluidArraySpacingInStrings: arrays in strings of ViewHelper arguments', async () => {
    const source = `<p>{f:if(condition: x, then: '{a:1,b:2}')} {x ? '{a:1}' : 'b'}</p>\n`;
    await assertFormat(source, source, always);
    await assertFormat(source, `<p>{f:if(condition: x, then: '{ a:1, b:2 }')} {x ? '{a:1}' : 'b'}</p>\n`, {
      ...always,
      fluidArraySpacingInStrings: true,
    });
    await assertFormat(
      `<f:alias map="{x: '{f:if(condition: \\'{a:1}\\', then: 1)}', y: 'z {b:2}'}">{x}</f:alias>`,
      `<f:alias map="{ x: '{f:if(condition: \\'{ a:1 }\\', then: 1)}', y: 'z { b:2 }' }">\n  {x}\n</f:alias>\n`,
      { ...always, fluidArraySpacingInStrings: true },
    );
  });

  test('strings and multi-line arrays stay as written', async () => {
    const source = `<f:render
  partial="Card"
  arguments="{
    title: item.title,link: '{a,b}'
  }"
/>
`;
    await assertFormat(source, source, always);
  });
});

describe('f:comment', () => {
  test('content is kept verbatim, even if it is broken HTML', async () => {
    await assertFormat(
      `<div><f:comment>\n  <p>unclosed <b>{old -> f:x()\n</f:comment><p>a</p></div>`,
      `<div>\n  <f:comment>\n  <p>unclosed <b>{old -> f:x()\n</f:comment>\n  <p>a</p>\n</div>\n`,
    );
  });

  test('nested and self-closing comments', async () => {
    const source = `<f:comment>a <f:comment>b</f:comment> c</f:comment>\n<f:comment />\n`;
    await assertFormat(source, source);
  });
});

describe('attribute quotes', () => {
  test('single-quoted values with JSON keep their quotes', async () => {
    await assertFormat(`<div a='{"w":"1"}'></div>`, `<div a='{"w":"1"}'></div>\n`);
    await assertFormat(
      `<my-player style-config='{"width":"100%"}' class="x"></my-player>`,
      `<my-player style-config='{"width":"100%"}' class="x"></my-player>\n`,
    );
  });

  test('refuses to write a value that fits no quotes', () => {
    const { html, state } = preprocess(`<div a='{"w":"1"}'></div>`);
    // Simulate Prettier printing the value with double quotes next to a
    // single quote it cannot move.
    const broken = html.replace(/a='([^']*)'/, `a="$1 it's"`);
    assert.throws(() => restore(broken, state), /cannot quote the attribute value/);
  });
});

describe('verbatim ViewHelpers', () => {
  test('f:spaceless content is kept as written', async () => {
    const source = `<div>\n  <f:spaceless><f:if condition="{a}">text-bg-{b}</f:if> <f:if condition="{c}">x</f:if></f:spaceless>\n</div>\n`;
    await assertFormat(source, source);
  });

  test('fluidVerbatimViewHelpers adds more, with wildcards', async () => {
    const source = `<div>\n  <my:classes><f:if condition="{a}">a</f:if> b</my:classes>\n</div>\n`;
    await assertFormat(source, source, { fluidVerbatimViewHelpers: ['my:*'] });
  });
});

describe('fluidIndentRoot: false', () => {
  const options = { fluidIndentRoot: false };

  test('does not indent the content of <fluid>', async () => {
    await assertFormat(
      `<fluid data-namespace-typo3-fluid="true" xmlns:f="http://typo3.org/ns/TYPO3/CMS/Fluid/ViewHelpers">\n<f:if condition="{a}"><p>x</p></f:if>\n</fluid>`,
      `<fluid
  data-namespace-typo3-fluid="true"
  xmlns:f="http://typo3.org/ns/TYPO3/CMS/Fluid/ViewHelpers"
>

<f:if condition="{a}"><p>x</p></f:if>

</fluid>
`,
      options,
    );
  });

  test('works for <html data-namespace-typo3-fluid> and keeps leading comments', async () => {
    await assertFormat(
      `<!-- @format -->\n<html data-namespace-typo3-fluid="true"><f:section name="Main"><p>x</p></f:section></html>`,
      `<!-- @format -->\n<html data-namespace-typo3-fluid="true">\n\n<f:section name="Main"><p>x</p></f:section>\n\n</html>\n`,
      options,
    );
  });

  test('fluidRootAttributePerLine', async () => {
    await assertFormat(
      `<fluid data-namespace-typo3-fluid="true">\n<p>x</p>\n</fluid>`,
      `<fluid\n  data-namespace-typo3-fluid="true"\n>\n\n<p>x</p>\n\n</fluid>\n`,
      { ...options, fluidRootAttributePerLine: true },
    );
  });

  test('other roots are formatted as usual', async () => {
    await assertFormat(`<div><p>x</p></div>`, `<div><p>x</p></div>\n`, options);
  });

  test('errors point at the right line', async () => {
    const source = `<fluid data-namespace-typo3-fluid="true">\n\n<div>\n  <section></div>\n</fluid>`;
    await assert.rejects(format(source, options), (error) => {
      assert.equal(error.loc.start.line, 4);

      return true;
    });
  });

  test('keeps a DOCTYPE and comments before the root', async () => {
    for (const doctype of ['<!DOCTYPE html>', '<!doctype html>']) {
      await assertFormat(
        `${doctype}\n<!-- c -->\n<html data-namespace-typo3-fluid="true"><f:section name="Main"><p>x</p></f:section></html>`,
        `${doctype}\n<!-- c -->\n<html data-namespace-typo3-fluid="true">\n\n<f:section name="Main"><p>x</p></f:section>\n\n</html>\n`,
        options,
      );
    }
  });

  test('the namespace attribute must be exactly true', async () => {
    for (const value of [`'true'`, 'true']) {
      await assertFormat(
        `<div data-namespace-typo3-fluid=${value}>\n<p>x</p>\n</div>`,
        `<div data-namespace-typo3-fluid="true">\n\n<p>x</p>\n\n</div>\n`,
        options,
      );
    }
    for (const tag of [
      `<div data-namespace-typo3-fluid="trueish">`,
      `<div data-namespace-typo3-fluid="false">`,
      `<div title=' data-namespace-typo3-fluid="true"'>`,
      `<div data-x="a data-namespace-typo3-fluid=true">`,
    ]) {
      const source = `${tag}\n<p>x</p>\n</div>`;
      const output = await format(source, options);
      assert.equal(output, await format(source));
      assert.match(output, /\n {2}<p>x<\/p>\n/);
    }
  });

  describe('errors point at the original position', () => {
    const positionOf = (source, needle) => {
      const before = source.slice(0, source.indexOf(needle));
      const lines = before.split('\n');

      return { line: lines.length, column: lines.at(-1).length + 1 };
    };
    const assertErrorAt = async (source, expected, extra = {}) => {
      await assert.rejects(format(source, { ...options, ...extra }), (error) => {
        assert.deepEqual(error.loc.start, expected);
        assert.match(stripVTControlCharacters(error.message), new RegExp(`\\(${expected.line}:${expected.column}\\)`));

        return true;
      });
    };

    test('in the content', async () => {
      await assertErrorAt(`<fluid><div></span></fluid>`, {
        line: 1,
        column: 13,
      });
    });

    test('in the content after comments and a multi-line opening tag', async () => {
      const source = `<!-- a -->\n<!-- b --><fluid\n  data-namespace-typo3-fluid="true">  <div>\n{x}</span></fluid>`;
      await assertErrorAt(source, positionOf(source, '</span>'));
      const first = `<!-- a -->\n<fluid\n  data-namespace-typo3-fluid="true">  <div></span></fluid>`;
      await assertErrorAt(first, positionOf(first, '</span>'));
    });

    test('in the content, with CRLF', async () => {
      const source = `<!-- a -->\n<fluid\n  data-namespace-typo3-fluid="true">  <div></span>\n</fluid>`;
      await assertErrorAt(source.replaceAll('\n', '\r\n'), positionOf(source, '</span>'), { endOfLine: 'crlf' });
    });

    test('in the opening tag', async () => {
      const source = `<!-- a -->\n  <!-- b --> <fluid data-namespace-typo3-fluid="true" <b>\n<p>x</p>\n</fluid>`;
      await assertErrorAt(source, positionOf(source, '<fluid'));
      await assertErrorAt(source.replaceAll('\n', '\r\n'), positionOf(source, '<fluid'), { endOfLine: 'crlf' });
    });

    test('in a multi-line opening tag', async () => {
      const tag = `<fluid\n  data-namespace-typo3-fluid="true"\n  a="&#xzz;">`;
      // Where the html parser puts the error in the tag on its own.
      const inTag = await prettier.format(`${tag}</fluid>`, { parser: 'html' }).then(assert.fail, (error) => error.loc);
      assert.ok(inTag.end.line > 1);
      const source = `<!-- a -->\n  <!-- b --> ${tag}\n<p>x</p>\n</fluid>`;
      const start = positionOf(source, '<fluid');
      for (const [text, extra] of [
        [source, {}],
        [source.replaceAll('\n', '\r\n'), { endOfLine: 'crlf' }],
      ]) {
        await assert.rejects(format(text, { ...options, ...extra }), (error) => {
          assert.deepEqual(error.loc, {
            start,
            end: {
              line: start.line + inTag.end.line - 1,
              column: inTag.end.column,
            },
          });

          return true;
        });
      }
    });
  });
});

describe('f:asset.css / f:asset.script', () => {
  test('inline content is formatted as CSS and JavaScript', async () => {
    await assertFormat(
      `<div><f:asset.css identifier="a">.a  >  .b { margin: 0 ; }</f:asset.css><f:asset.script identifier="b">foo( 1 )</f:asset.script></div>`,
      `<div>
  <f:asset.css identifier="a">
    .a > .b {
      margin: 0;
    }
  </f:asset.css>
  <f:asset.script identifier="b">
    foo(1);
  </f:asset.script>
</div>
`,
    );
  });

  test('real <style>/<script> tags around them stay what they are', async () => {
    const output = await format(
      `<style>.x { margin: 0; }</style><f:asset.css identifier="a">.a { margin: 0; }</f:asset.css><script>foo( 1 )</script>`,
    );
    assert.match(output, /^<style>\n {2}\.x \{/);
    assert.match(output, /<f:asset\.css identifier="a">\n {2}\.a \{\n {4}margin: 0;\n {2}\}\n<\/f:asset\.css>/);
    assert.match(output, /<script>\n {2}foo\(1\);\n<\/script>\n$/);
  });

  test('content with Fluid syntax or CDATA is kept as written', async () => {
    const source = `<div>
  <f:asset.css identifier="a">.a { color: {settings.color}; }</f:asset.css>
  <f:asset.script identifier="b"><![CDATA[ foo( 1 ) ]]></f:asset.script>
  <f:asset.css identifier="c" href="EXT:site/Resources/Public/c.css" />
</div>
`;
    await assertFormat(source, source);
  });

  test('escaped quotes in arguments', async () => {
    await assertFormat(
      `<f:asset.script identifier="a\\"b">let x=1</f:asset.script>\n<f:asset.css identifier="a\\"b" media="x">.a { margin: 0; }</f:asset.css>`,
      `<f:asset.script identifier="a\\"b">
  let x = 1;
</f:asset.script>
<f:asset.css identifier="a\\"b" media="x">
  .a {
    margin: 0;
  }
</f:asset.css>
`,
    );
  });

  test('arguments follow fluidArraySpacing like other ViewHelpers', async () => {
    const value = `{async: 1,defer:'{a: 1}'}`;
    const cases = [
      ['preserve', false],
      ['always', false],
      ['never', false],
      ['always', true],
      ['never', true],
    ];
    for (const [fluidArraySpacing, fluidArraySpacingInStrings] of cases) {
      const options = {
        fluidArraySpacing,
        fluidArraySpacingInStrings,
        printWidth: 120,
      };
      const reference = await format(`<f:render additionalAttributes="${value}" />`, options);
      const expected = /additionalAttributes="([^"]*)"/.exec(reference)[1];
      if (fluidArraySpacing === 'preserve') {
        assert.equal(expected, value);
      } else {
        assert.notEqual(expected, value);
      }
      await assertFormat(
        `<f:asset.script identifier="a" additionalAttributes="${value}">let x=1</f:asset.script>`,
        `<f:asset.script identifier="a" additionalAttributes="${expected}">\n  let x = 1;\n</f:asset.script>\n`,
        options,
      );
      await assertFormat(
        `<f:asset.css identifier="a" additionalAttributes="${value}">.a { margin: 0; }</f:asset.css>`,
        `<f:asset.css identifier="a" additionalAttributes="${expected}">\n  .a {\n    margin: 0;\n  }\n</f:asset.css>\n`,
        options,
      );
      await assertFormat(
        `<f:asset.css identifier="a" href="a.css" additionalAttributes="${value}" />`,
        `<f:asset.css identifier="a" href="a.css" additionalAttributes="${expected}" />\n`,
        options,
      );
      // Elements kept as written keep their arguments, too.
      for (const verbatim of [
        `<f:asset.script identifier="a" additionalAttributes="${value}">let x = '{b}';</f:asset.script>\n`,
        `<f:asset.script identifier="a\\"b" additionalAttributes="${value}"><![CDATA[ foo( 1 ) ]]></f:asset.script>\n`,
      ]) {
        await assertFormat(verbatim, verbatim, options);
      }
      // Attributes of plain HTML tags are no ViewHelper arguments.
      const html = `<f:asset.script identifier="a">let x = 1;</f:asset.script>\n<script data-x="${value}">\n  let y = 1;\n</script>\n<style data-x="${value}"></style>\n`;
      assert.equal(
        await format(html, options),
        html.replace(
          `<f:asset.script identifier="a">let x = 1;</f:asset.script>`,
          `<f:asset.script identifier="a">\n  let x = 1;\n</f:asset.script>`,
        ),
      );
    }
  });
});

describe('fluidFinalNewline', () => {
  test('true (default) ends the file with a line break', async () => {
    await assertFormat(`<p>{a}</p>`, `<p>{a}</p>\n`);
  });

  test('false removes the final line break', async () => {
    const options = { fluidFinalNewline: false };
    await assertFormat(`<p>{a}</p>\n\n`, `<p>{a}</p>`, options);
    await assertFormat(
      `<fluid data-namespace-typo3-fluid="true">\n<p>x</p>\n</fluid>\n`,
      `<fluid data-namespace-typo3-fluid="true">\n\n<p>x</p>\n\n</fluid>`,
      { ...options, fluidIndentRoot: false },
    );
  });
});

describe('pragma', () => {
  test('requirePragma', async () => {
    const source = `<div><f:if condition="{a}">x</f:if></div>`;
    assert.equal(await format(source, { requirePragma: true }), source);
    assert.match(await format(`<!-- @format -->\n${source}`, { requirePragma: true }), /\n  <f:if/);
  });

  test('insertPragma', async () => {
    assert.equal(await format(`<p>a</p>`, { insertPragma: true }), `<!-- @format -->\n\n<p>a</p>\n`);
  });
});

describe('robustness', () => {
  test('CRLF line endings', async () => {
    assert.equal(
      await format(`<f:if condition="{a}">\r\n<p>x</p></f:if>`, {
        endOfLine: 'crlf',
      }),
      `<f:if condition="{a}">\r\n  <p>x</p>\r\n</f:if>\r\n`,
    );
  });

  test('empty file', async () => {
    assert.equal(await format(''), '');
  });

  test('placeholders never collide with template content', async () => {
    const source = `<p>qz qza {a}</p>\n`;
    await assertFormat(source, source);
  });

  test('dynamic tag names', async () => {
    await assertFormat(
      `<div><h{level} class="x">Title</h{level}></div>`,
      `<div><h{level} class="x">Title</h{level}></div>\n`,
    );
  });

  test('script/style bodies with Fluid code are kept verbatim', async () => {
    const source = `<div>
  <style nonce="{nonce}"><f:format.raw>
    body { color: red }
  </f:format.raw></style>
  <script>var url = '{f:uri.action(action: "show")}';</script>
</div>
`;
    await assertFormat(source, source);
  });

  describe('script/style bodies with Fluid code stay protected after directives', () => {
    const bodies = {
      script: `const x = '{f:if(condition: a, then: \\'yes\\', else: \\'no\\')}';`,
      style: `.a { content: "{f:if(condition: a, then: \\'yes\\')}" }`,
    };
    const directives = ['display: block', 'display: inline', 'prettier-ignore-attribute'];
    const pluginSets = [
      [fluid],
      [fluid, 'prettier-plugin-organize-attributes'],
      ...(skipTailwind ? [] : [ALL_PLUGINS]),
    ];

    for (const directive of directives) {
      for (const comment of [`<!-- ${directive} -->`, `<f:comment><!-- ${directive} --></f:comment>`]) {
        test(comment, async () => {
          for (const plugins of pluginSets) {
            for (const [tag, body] of Object.entries(bodies)) {
              const element = `<${tag} class="b a">${body}</${tag}>`;
              const source = `<div>\n${comment}\n${element}\n</div>\n`;
              const output = await format(source, { plugins });
              assert.ok(output.includes(`${comment}\n  ${element}\n`), `body must be kept as written:\n${output}`);
              assert.equal(await format(output, { plugins }), output);
            }
          }
        });
      }
    }

    test('the example from the analysis is kept exactly', async () => {
      const source = `<!-- display: block -->\n<script>${bodies.script}</script>\n`;
      await assertFormat(source, source);
    });

    test('multi-line bodies keep their lines, also with CRLF', async () => {
      const body = `\n  var a = '{f:if(condition: a, then: \\'b\\')}';\n      var  c = 1;\n`;
      const source = `<div>\n<!-- display: block -->\n<script>${body}</script>\n</div>\n`;
      const expected = `<div>\n  <!-- display: block -->\n  <script>${body}</script>\n</div>\n`;
      await assertFormat(source, expected);
      const crlf = (text) => text.replaceAll('\n', '\r\n');
      await assertFormat(crlf(source), crlf(expected), { endOfLine: 'crlf' });
    });

    test('prettier-ignore keeps the whole element', async () => {
      for (const comment of ['<!-- prettier-ignore -->', '<f:comment><!-- prettier-ignore --></f:comment>']) {
        const source = `<div>\n  ${comment}\n  <script   type="module">${bodies.script}</script>\n</div>\n`;
        await assertFormat(source, source);
      }
    });

    test('bodies without Fluid code are still formatted', async () => {
      await assertFormat(
        `<!-- display: block -->\n<script>let a=1</script>\n<f:comment><!-- prettier-ignore-attribute --></f:comment>\n<style>p{margin:0 ;}</style>`,
        `<!-- display: block -->\n<script>\n  let a = 1;\n</script>\n<f:comment><!-- prettier-ignore-attribute --></f:comment>\n<style>\n  p {\n    margin: 0;\n  }\n</style>\n`,
      );
    });
  });

  test('script/style bodies without Fluid code are formatted', async () => {
    await assertFormat(
      `<script>let a=1</script>\n<style>p{margin:0 ;}</style>`,
      `<script>\n  let a = 1;\n</script>\n<style>\n  p {\n    margin: 0;\n  }\n</style>\n`,
    );
  });

  test('embeddedLanguageFormatting: off still formats the template', async () => {
    await assertFormat(
      `<div><f:if condition="{a}">x</f:if></div>`,
      `<div>\n  <f:if condition="{a}">x</f:if>\n</div>\n`,
      { embeddedLanguageFormatting: 'off' },
    );
  });

  test('parse errors point at the Fluid source', async () => {
    const source = `<div>\n  {some.long -> f:format.raw()}\n  <f:if condition="{a}"><p>{b}</p></f:if>\n  <section class="{c}"></div>`;
    await assert.rejects(format(source), (error) => {
      // The code frame is syntax-highlighted when running in a color terminal.
      const message = stripVTControlCharacters(error.message);
      assert.deepEqual(error.loc.start, { line: 4, column: 24 });
      assert.match(message, /^Unexpected closing tag "div"/);
      assert.match(message, /Fluid templates must be well-nested HTML/);
      // code frame shows the original template, not placeholders
      assert.match(message, /> 4 \|   <section class="\{c\}"><\/div>/);

      return true;
    });
  });

  test('conditional wrappers are kept as written', async () => {
    const source = `<div class="outer"><f:if condition="{wrap}"><div class="wrapper">
    </f:if>
<p>content   here</p>
<f:if condition="{wrap}"></div></f:if></div>`;
    await assertFormat(
      source,
      `<div class="outer">
  <f:if condition="{wrap}"><div class="wrapper">
    </f:if>
  <p>content here</p>
  <f:if condition="{wrap}"></div></f:if>
</div>
`,
    );
  });

  test('conditional opening tags in f:then/f:else are kept as written', async () => {
    const source = `<table><tr><f:if condition="{header}"><f:then><th></f:then><f:else><td></f:else></f:if>{cell}</tr></table>\n`;
    const output = await format(source);
    assert.match(output, /<f:if condition="\{header\}"><f:then><th><\/f:then><f:else><td><\/f:else><\/f:if>/);
    assert.equal(await format(output), output);
  });

  test('refuses to drop Fluid code', () => {
    const { html, state } = preprocess(`<p>{a} {b}</p>`);
    const [first] = html.match(new RegExp(`${state.nonce}\\d+_*${state.nonce}`));
    assert.throws(() => restore(first, state), /dropped Fluid code.*\{b\}/);
  });
});

// Void elements decide which ViewHelper bodies are well-nested HTML and get
// formatted; the others are kept as written.
describe('HTML elements', () => {
  // Loaded like the plugin loads it, see src/elements.ts.
  const { htmlVoidTags } = createRequire(import.meta.url)('@prettier/html-tags');
  // Historical void tags of @prettier/html-tags the plugin keeps treating as
  // ordinary elements, as before it used the package.
  const legacy = ['basefont', 'bgsound', 'command', 'frame', 'image', 'keygen', 'param'];
  const wrapped = (tag) => `<f:if condition="{a}"><div>  <${tag} title="{t}">  </div></f:if>`;

  test('void elements are those of @prettier/html-tags', async () => {
    const voids = htmlVoidTags.filter((tag) => !legacy.includes(tag));
    assert.ok(voids.length >= 13, voids.join());
    // Tag names are case-insensitive; Prettier prints them in lowercase.
    for (const tag of [...voids, ...voids.map((tag) => tag.toUpperCase())]) {
      await assertFormat(
        wrapped(tag),
        `<f:if condition="{a}">\n  <div><${tag.toLowerCase()} title="{t}" /></div>\n</f:if>\n`,
      );
    }
  });

  test('historical void tags keep their previous handling', async () => {
    assert.deepEqual(
      legacy.filter((tag) => !htmlVoidTags.includes(tag)),
      [],
    );
    for (const tag of legacy) {
      // Not well-nested without a closing tag: kept as written.
      await assertFormat(wrapped(tag), `${wrapped(tag)}\n`);
    }
    // SVG's <image> has content.
    await assertFormat(
      `<f:if condition="{a}"><svg><image href="{x}"></image></svg></f:if>`,
      `<f:if condition="{a}">\n  <svg><image href="{x}"></image></svg>\n</f:if>\n`,
    );
  });

  test('custom elements, MathML, ViewHelpers and dynamic tags are no void elements', async () => {
    await assertFormat(
      `<f:if condition="{a}"><my-el>  <x-y a="{b}"></x-y></my-el><h{n}>  t</h{n}><math><mi>x</mi></math><f:format.raw>{x}</f:format.raw></f:if>`,
      `<f:if condition="{a}">\n  <my-el> <x-y a="{b}"></x-y></my-el><h{n}> t</h{n}><math><mi>x</mi></math\n  ><f:format.raw>{x}</f:format.raw>\n</f:if>\n`,
    );
    // Without a closing tag, none of them is well-nested.
    for (const tag of ['my-el', 'h{n}', 'mi', 'f:format.raw']) {
      await assertFormat(wrapped(tag), `${wrapped(tag)}\n`);
    }
  });
});

describe('every occurrence of Fluid code is restored', () => {
  const placeholderOf = (html, state) => html.match(new RegExp(`${state.nonce}\\d+_*${state.nonce}`))[0];

  test('refuses to drop one of several equal expressions', () => {
    const { html, state } = preprocess(`<p>{x} {x}</p>`);
    const placeholder = placeholderOf(html, state);
    assert.throws(
      () => restore(html.replace(placeholder, ''), state),
      /prettier-plugin-fluid: formatting dropped Fluid code.*\{x\}/,
    );
  });

  test('refuses to duplicate Fluid code', () => {
    const { html, state } = preprocess(`<p>{x} {x}</p>`);
    const placeholder = placeholderOf(html, state);
    assert.throws(
      () => restore(html.replace(placeholder, placeholder.repeat(2)), state),
      /prettier-plugin-fluid: formatting duplicated Fluid code.*\{x\}/,
    );
    const comment = preprocess(`<f:comment>{x}</f:comment>`);
    assert.throws(
      () => restore(comment.html.repeat(2), comment.state),
      /prettier-plugin-fluid: formatting duplicated Fluid code.*<f:comment>/,
    );
  });

  test('refuses unknown placeholders', () => {
    const { html, state } = preprocess(`<p class="{a}">{a}</p>`);
    const unknown = `${state.nonce}99${state.nonce}`;
    for (const changed of [
      `${html}${unknown}`,
      `${html}<!--${unknown}-->`,
      html.replace('class="', `class="${unknown} `),
    ]) {
      assert.throws(
        () => restore(changed, state),
        /prettier-plugin-fluid: formatting produced unknown placeholders.*qz99qz/,
      );
    }
  });

  test('refuses comment placeholders taken out of their comment', () => {
    const { html, state } = preprocess(`<div><f:comment>x</f:comment></div>`);
    assert.throws(
      () => restore(html.replace(/<!--|-->/g, ''), state),
      /prettier-plugin-fluid: formatting dropped Fluid code.*<f:comment>x.*took Fluid code out of its HTML comment/,
    );
  });

  test('an HTML plugin that drops a placeholder makes formatting fail', async () => {
    const { parsers } = await import('prettier/plugins/html');
    const dropping = {
      parsers: {
        html: {
          ...parsers.html,
          preprocess: (text) => text.replace(/qz\d+_*qz/, ''),
        },
      },
    };
    await assert.rejects(
      format(`<p>{x} {x}</p>`, { plugins: [fluid, dropping] }),
      /prettier-plugin-fluid: formatting dropped Fluid code.*\{x\}/,
    );
  });

  test('repetitions, dynamic tags, comments and attributes stay intact', async () => {
    const source = `<div class="{x}" title="{x}" data-x="{x}">
  <h{level} class="{x}">{x} {x}</h{level}>
  <f:comment>{x}</f:comment>
  <f:comment>{x}</f:comment>
  <!-- {x} -->
  <p>{x}{x}</p>
</div>
`;
    await assertFormat(source, source);
    await assertFormat(source, source, {
      plugins: [fluid, 'prettier-plugin-organize-attributes'],
    });
  });
});

describe('other plugins', () => {
  test('Tailwind is only skipped for known incompatible versions', () => {
    for (const prettierVersion of ['3.0.0', '3.6.2']) {
      assert.match(tailwindIncompatibility(prettierVersion, '0.8.1'), /needs Prettier 3\.7/);
    }
    for (const [prettierVersion, tailwindVersion] of [
      ['3.7.0', '0.8.1'],
      ['3.9.9', '0.8.1'],
      ['4.0.0', '0.8.1'],
      ['3.0.0', '0.7.0'],
      ['3.0.0', '0.9.0'],
    ]) {
      assert.equal(tailwindIncompatibility(prettierVersion, tailwindVersion), false);
    }
  });

  test('prettier-plugin-organize-attributes', async () => {
    await assertFormat(
      `<f:link.page pageUid="{uid}" class="btn" additionalAttributes="{rel: 'x'}">x</f:link.page>`,
      `<f:link.page class="btn" additionalAttributes="{rel: 'x'}" pageUid="{uid}"\n  >x</f:link.page\n>\n`,
      {
        plugins: [fluid, 'prettier-plugin-organize-attributes'],
        attributeSort: 'ASC',
      },
    );
  });

  test('prettier-plugin-tailwindcss', { skip: skipTailwind }, async () => {
    await assertFormat(
      `<div class="p-4 flex {f:if(condition: a, then: 'x')}"></div>`,
      `<div class="{f:if(condition: a, then: 'x')} flex p-4"></div>\n`,
      { plugins: ALL_PLUGINS },
    );
    // Duplicate classes are removed, but not repeated Fluid code.
    await assertFormat(`<div class="{x} p-4 {x} flex p-4"></div>`, `<div class="{x} {x} flex p-4"></div>\n`, {
      plugins: ALL_PLUGINS,
    });
    await assertFormat(
      `<div class="p-4 flex {(a && b) ? 'active   big' : 'hidden'}"></div>`,
      `<div class="{(a && b) ? 'active   big' : 'hidden'} flex p-4"></div>\n`,
      { plugins: ALL_PLUGINS },
    );
  });
});

// Fixtures: test/fixtures/<name>.input.html → <name>.output.html, formatted
// with this plugin and the optional <name>.options.json. Its "plugins" lists
// further plugins the fixture is an integration test for; fixtures without
// them check this plugin alone. Regenerate outputs with `UPDATE=1 npm test`.
describe('fixtures', async () => {
  const dir = new URL('fixtures/', import.meta.url);
  const inputs = (await readdir(dir)).filter((file) => file.endsWith('.input.html'));

  for (const input of inputs) {
    const optionsUrl = new URL(input.replace('.input.html', '.options.json'), dir);
    const { plugins = [], ...options } = JSON.parse(await readFile(optionsUrl, 'utf8').catch(() => '{}'));
    const skip = plugins.includes('prettier-plugin-tailwindcss') && skipTailwind;
    test(input.replace('.input.html', ''), { skip }, async () => {
      const source = await readFile(new URL(input, dir), 'utf8');
      const outputUrl = new URL(input.replace('.input.', '.output.'), dir);
      const fixtureOptions = { ...options, plugins: [fluid, ...plugins] };
      if (process.env.UPDATE) {
        await writeFile(outputUrl, await format(source, fixtureOptions));
      }
      await assertFormat(source, await readFile(outputUrl, 'utf8'), fixtureOptions);
    });
  }
});
