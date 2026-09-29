import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import * as prettier from "prettier";
import fluid from "../src/index.js";
import { preprocess, restore } from "../src/preprocess.js";

const ALL_PLUGINS = [
  fluid,
  "prettier-plugin-organize-attributes",
  "prettier-plugin-tailwindcss",
];

// Recent prettier-plugin-tailwindcss releases fail on old Prettier 3.x even
// for plain HTML; CI also runs the suite against the oldest supported Prettier.
const skipTailwind = await prettier
  .format("<div></div>", {
    parser: "html",
    plugins: ["prettier-plugin-tailwindcss"],
  })
  .then(
    () => false,
    () =>
      `prettier-plugin-tailwindcss does not support Prettier ${prettier.version}`,
  );

const format = (source, options = {}) =>
  prettier.format(source, { parser: "fluid", plugins: [fluid], ...options });

async function assertFormat(source, expected, options) {
  const output = await format(source, options);
  assert.equal(output, expected);
  assert.equal(
    await format(output, options),
    output,
    "formatting must be idempotent",
  );
}

describe("layout", () => {
  test("structural ViewHelpers are blocks", async () => {
    await assertFormat(
      `<f:if condition="{a}"><f:then><p>yes</p></f:then><f:else><p>no</p></f:else></f:if>`,
      `<f:if condition="{a}">\n  <f:then><p>yes</p></f:then>\n  <f:else><p>no</p></f:else>\n</f:if>\n`,
    );
  });

  test("EXT:form ViewHelpers that render children are blocks", async () => {
    await assertFormat(
      `<f:section name="Main">\n<formvh:renderAllFormValues renderable="{form.formDefinition}" as="formValue">{f:render(section: 'FieldValue', arguments: '{_all}')}</formvh:renderAllFormValues>\n</f:section>`,
      `<f:section name="Main">\n  <formvh:renderAllFormValues\n    renderable="{form.formDefinition}"\n    as="formValue"\n  >\n    {f:render(section: 'FieldValue', arguments: '{_all}')}\n  </formvh:renderAllFormValues>\n</f:section>\n`,
    );
  });

  test("prettier-ignore still applies to ViewHelpers", async () => {
    await assertFormat(
      `<div>\n<!-- prettier-ignore -->\n<f:if condition="{a}"><b>keep   this</b></f:if>\n</div>`,
      `<div>\n  <!-- prettier-ignore -->\n  <f:if condition="{a}"><b>keep   this</b></f:if>\n</div>\n`,
    );
  });

  test("prettier-ignore inside f:comment applies to the next node", async () => {
    await assertFormat(
      `<div>\n<f:comment><!-- prettier-ignore --></f:comment>\n<div   class="a"  >keep   this</div>\n<p>  x  </p>\n</div>`,
      `<div>\n  <f:comment><!-- prettier-ignore --></f:comment>\n  <div   class="a"  >keep   this</div>\n  <p>x</p>\n</div>\n`,
    );
    await assertFormat(
      `<div>\n<f:comment> <!-- prettier-ignore --> </f:comment>\n<f:if condition="{a}"><b>keep   this</b></f:if>\n</div>`,
      `<div>\n  <f:comment> <!-- prettier-ignore --> </f:comment>\n  <f:if condition="{a}"><b>keep   this</b></f:if>\n</div>\n`,
    );
  });

  test("directives inside f:comment apply to the next node", async () => {
    await assertFormat(
      `<div>\n<f:comment><!-- prettier-ignore-attribute --></f:comment>\n<div   class="a   b"  id="x"></div>\n<f:comment><!-- display: block --></f:comment>\n<my:thing>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</my:thing>\n<f:comment><!-- display: inline --></f:comment>\n<f:if condition="{a}">x</f:if>\n</div>`,
      `<div>\n  <f:comment><!-- prettier-ignore-attribute --></f:comment>\n  <div class="a   b" id="x"></div>\n  <f:comment><!-- display: block --></f:comment>\n  <my:thing>\n    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n  </my:thing>\n  <f:comment><!-- display: inline --></f:comment>\n  <f:if condition="{a}">x</f:if>\n</div>\n`,
    );
  });

  test("f:variable content is kept as written", async () => {
    await assertFormat(
      `<div>\n<f:variable name="classes">btn btn-primary btn-large some-other-class another-class yet-another-class</f:variable>\n<f:variable   name="x" value="{y}"/>\n</div>`,
      `<div>\n  <f:variable name="classes">btn btn-primary btn-large some-other-class another-class yet-another-class</f:variable>\n  <f:variable name="x" value="{y}" />\n</div>\n`,
    );
  });

  test("prettier-ignore-start/end keeps the range as written", async () => {
    await assertFormat(
      `<div>\n<!-- prettier-ignore-start -->\n<div   class="a"  >keep   this</div>\n<f:if condition="{a}"><p>  y  </p></f:if>\n<!-- prettier-ignore-end -->\n<p>  x  </p>\n</div>`,
      `<div>\n  <!-- prettier-ignore-start -->\n<div   class="a"  >keep   this</div>\n<f:if condition="{a}"><p>  y  </p></f:if>\n<!-- prettier-ignore-end -->\n  <p>x</p>\n</div>\n`,
    );
  });

  test("prettier-ignore-start/end also works inside f:comment", async () => {
    await assertFormat(
      `<div>\n<f:comment><!-- prettier-ignore-start --></f:comment>\n<b   class="{a -> f:format.raw()}">keep   this</b>\n<f:comment><!-- prettier-ignore-end --></f:comment>\n<f:if condition="{a}"><p>  x  </p></f:if>\n</div>`,
      `<div>\n  <f:comment><!-- prettier-ignore-start --></f:comment>\n<b   class="{a -> f:format.raw()}">keep   this</b>\n<f:comment><!-- prettier-ignore-end --></f:comment>\n  <f:if condition="{a}"><p>x</p></f:if>\n</div>\n`,
    );
  });

  test("prettier-ignore-start without end ignores the rest", async () => {
    await assertFormat(
      `<p>  a  </p>\n<!-- prettier-ignore-start -->\n<p>  b  </p>\n`,
      `<p>a</p>\n<!-- prettier-ignore-start -->\n<p>  b  </p>\n`,
    );
  });

  test("user display comments win over the default", async () => {
    await assertFormat(
      `<span><!-- display: inline --><f:if condition="{a}">x</f:if></span>`,
      `<span><!-- display: inline --><f:if condition="{a}">x</f:if></span>\n`,
    );
  });
});

describe("custom ViewHelpers", () => {
  const source = `<div><my:card.teaser item="{item}">{item.title -> my:format.crop(length: 3)}</my:card.teaser></div>`;

  test("are recognized and inline by default", async () => {
    await assertFormat(
      source,
      `<div>\n  <my:card.teaser item="{item}"\n    >{item.title -> my:format.crop(length: 3)}</my:card.teaser\n  >\n</div>\n`,
    );
  });

  test("fluidBlockViewHelpers extends the defaults, with wildcards", async () => {
    await assertFormat(
      source,
      `<div>\n  <my:card.teaser item="{item}">\n    {item.title -> my:format.crop(length: 3)}\n  </my:card.teaser>\n</div>\n`,
      { fluidBlockViewHelpers: ["my:card.*"] },
    );
    // defaults still apply
    await assertFormat(
      `<div><f:if condition="{a}">x</f:if></div>`,
      `<div>\n  <f:if condition="{a}">x</f:if>\n</div>\n`,
      {
        fluidBlockViewHelpers: ["my:*"],
      },
    );
  });

  test("fluidInlineViewHelpers overrides the defaults", async () => {
    await assertFormat(
      `<p>a <f:render partial="X" /> b</p>`,
      `<p>a <f:render partial="X" /> b</p>\n`,
      {
        fluidInlineViewHelpers: ["f:render"],
      },
    );
  });

  test("camelCase names are preserved", async () => {
    await assertFormat(
      `<my:fooBar someArg="{x}" />`,
      `<my:fooBar someArg="{x}" />\n`,
    );
  });
});

describe("shorthand syntax", () => {
  test("is never re-wrapped", async () => {
    const expression = `{f:translate(key: 'x', default: 'A rather long default text that would normally wrap')}`;
    await assertFormat(
      `<p>Hello ${expression}</p>`,
      `<p>\n  Hello\n  ${expression}\n</p>\n`,
    );
  });

  test("escaped quotes in ViewHelper arguments", async () => {
    const source = `<f:form.textfield additionalAttributes="{placeholder: \\"Name\\"}" />\n`;
    await assertFormat(source, source);
  });

  test("escaped quotes in ViewHelper arguments outside of expressions", async () => {
    const source = `<f:link.typolink\n  parameter="{link}"\n  textWrap="<span class=\\"icon\\">|</span>"\n/>\n`;
    await assertFormat(source, source);
  });

  test("expression syntax: ternary, casts, arithmetic, negation", async () => {
    const source = `<p>\n  {foo ? x : y} {foo ?: y} {!foo ?: y} {foo as boolean} {foo % 5} {foo ^ 5}\n  {true ? false: true}\n</p>\n`;
    await assertFormat(source, source);
  });

  test("in attribute-name position", async () => {
    const source = `<div {attributes -> f:format.raw()} class="a"></div>\n`;
    await assertFormat(source, source);
  });

  test("multi-line expressions break the tag and move with its indent", async () => {
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

  test("non-Fluid braces and CDATA are left alone", async () => {
    const source = `<p>{ not fluid; }</p>\n<![CDATA[ {raw} ]]>\n`;
    await assertFormat(source, source);
  });
});

describe("fluidArraySpacing", () => {
  const always = { fluidArraySpacing: "always" };
  const never = { fluidArraySpacing: "never" };

  test("preserve (default) keeps arrays as written", async () => {
    const source = `<p>{1:baum,2:haus} { a: 1 }</p>\n`;
    await assertFormat(source, source);
  });

  test("always adds spaces inside the braces and after commas", async () => {
    await assertFormat(
      `<p>{1:baum,2:haus}</p>`,
      `<p>{ 1:baum, 2:haus }</p>\n`,
      always,
    );
    await assertFormat(
      `<f:render partial="Card" arguments="{item: item ,title:'A, B'}" />`,
      `<f:render partial="Card" arguments="{ item: item, title:'A, B' }" />\n`,
      always,
    );
  });

  test("never removes spaces inside the braces", async () => {
    await assertFormat(
      `<p>{ 1:baum, 2:haus }</p>`,
      `<p>{1:baum, 2:haus}</p>\n`,
      never,
    );
  });

  test("nested arrays, also in ViewHelper arguments", async () => {
    await assertFormat(
      `<p>{f:translate(key: 'x', arguments: {0: a,1: {b: c}})}</p>`,
      `<p>{f:translate(key: 'x', arguments: { 0: a, 1: { b: c } })}</p>\n`,
      always,
    );
  });

  test("never touches code that only looks like an array", async () => {
    const source = `<p>
  {fh:baum} {f:format.raw()} {a -> f:format.raw()} {foo ? x : y} {item.title}
  {a == 'b'} {f:if(condition: a, then: 'x')} {"w":"1"}
</p>
`;
    await assertFormat(source, source, always);
    await assertFormat(source, source, never);
  });

  test("strings and multi-line arrays stay as written", async () => {
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

describe("f:comment", () => {
  test("content is kept verbatim, even if it is broken HTML", async () => {
    await assertFormat(
      `<div><f:comment>\n  <p>unclosed <b>{old -> f:x()\n</f:comment><p>a</p></div>`,
      `<div>\n  <f:comment>\n  <p>unclosed <b>{old -> f:x()\n</f:comment>\n  <p>a</p>\n</div>\n`,
    );
  });

  test("nested and self-closing comments", async () => {
    const source = `<f:comment>a <f:comment>b</f:comment> c</f:comment>\n<f:comment />\n`;
    await assertFormat(source, source);
  });
});

describe("attribute quotes", () => {
  test("single-quoted values with JSON keep their quotes", async () => {
    await assertFormat(
      `<div a='{"w":"1"}'></div>`,
      `<div a='{"w":"1"}'></div>\n`,
    );
    await assertFormat(
      `<my-player style-config='{"width":"100%"}' class="x"></my-player>`,
      `<my-player style-config='{"width":"100%"}' class="x"></my-player>\n`,
    );
  });

  test("refuses to write a value that fits no quotes", () => {
    const { html, state } = preprocess(`<div a='{"w":"1"}'></div>`);
    // Simulate Prettier printing the value with double quotes next to a
    // single quote it cannot move.
    const broken = html.replace(/a='([^']*)'/, `a="$1 it's"`);
    assert.throws(
      () => restore(broken, state),
      /cannot quote the attribute value/,
    );
  });
});

describe("verbatim ViewHelpers", () => {
  test("f:spaceless content is kept as written", async () => {
    const source = `<div>\n  <f:spaceless><f:if condition="{a}">text-bg-{b}</f:if> <f:if condition="{c}">x</f:if></f:spaceless>\n</div>\n`;
    await assertFormat(source, source);
  });

  test("fluidVerbatimViewHelpers adds more, with wildcards", async () => {
    const source = `<div>\n  <my:classes><f:if condition="{a}">a</f:if> b</my:classes>\n</div>\n`;
    await assertFormat(source, source, { fluidVerbatimViewHelpers: ["my:*"] });
  });
});

describe("fluidIndentRoot: false", () => {
  const options = { fluidIndentRoot: false };

  test("does not indent the content of <fluid>", async () => {
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

  test("works for <html data-namespace-typo3-fluid> and keeps leading comments", async () => {
    await assertFormat(
      `<!-- @format -->\n<html data-namespace-typo3-fluid="true"><f:section name="Main"><p>x</p></f:section></html>`,
      `<!-- @format -->\n<html data-namespace-typo3-fluid="true">\n\n<f:section name="Main"><p>x</p></f:section>\n\n</html>\n`,
      options,
    );
  });

  test("fluidRootAttributePerLine", async () => {
    await assertFormat(
      `<fluid data-namespace-typo3-fluid="true">\n<p>x</p>\n</fluid>`,
      `<fluid\n  data-namespace-typo3-fluid="true"\n>\n\n<p>x</p>\n\n</fluid>\n`,
      { ...options, fluidRootAttributePerLine: true },
    );
  });

  test("other roots are formatted as usual", async () => {
    await assertFormat(`<div><p>x</p></div>`, `<div><p>x</p></div>\n`, options);
  });

  test("errors point at the right line", async () => {
    const source = `<fluid data-namespace-typo3-fluid="true">\n\n<div>\n  <section></div>\n</fluid>`;
    await assert.rejects(format(source, options), (error) => {
      assert.equal(error.loc.start.line, 4);
      return true;
    });
  });
});

describe("f:asset.css / f:asset.script", () => {
  test("inline content is formatted as CSS and JavaScript", async () => {
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

  test("real <style>/<script> tags around them stay what they are", async () => {
    const output = await format(
      `<style>.x { margin: 0; }</style><f:asset.css identifier="a">.a { margin: 0; }</f:asset.css><script>foo( 1 )</script>`,
    );
    assert.match(output, /^<style>\n {2}\.x \{/);
    assert.match(
      output,
      /<f:asset\.css identifier="a">\n {2}\.a \{\n {4}margin: 0;\n {2}\}\n<\/f:asset\.css>/,
    );
    assert.match(output, /<script>\n {2}foo\(1\);\n<\/script>\n$/);
  });

  test("content with Fluid syntax or CDATA is kept as written", async () => {
    const source = `<div>
  <f:asset.css identifier="a">.a { color: {settings.color}; }</f:asset.css>
  <f:asset.script identifier="b"><![CDATA[ foo( 1 ) ]]></f:asset.script>
  <f:asset.css identifier="c" href="EXT:site/Resources/Public/c.css" />
</div>
`;
    await assertFormat(source, source);
  });
});

describe("fluidFinalNewline", () => {
  test("true (default) ends the file with a line break", async () => {
    await assertFormat(`<p>{a}</p>`, `<p>{a}</p>\n`);
  });

  test("false removes the final line break", async () => {
    const options = { fluidFinalNewline: false };
    await assertFormat(`<p>{a}</p>\n\n`, `<p>{a}</p>`, options);
    await assertFormat(
      `<fluid data-namespace-typo3-fluid="true">\n<p>x</p>\n</fluid>\n`,
      `<fluid data-namespace-typo3-fluid="true">\n\n<p>x</p>\n\n</fluid>`,
      { ...options, fluidIndentRoot: false },
    );
  });
});

describe("pragma", () => {
  test("requirePragma", async () => {
    const source = `<div><f:if condition="{a}">x</f:if></div>`;
    assert.equal(await format(source, { requirePragma: true }), source);
    assert.match(
      await format(`<!-- @format -->\n${source}`, { requirePragma: true }),
      /\n  <f:if/,
    );
  });

  test("insertPragma", async () => {
    assert.equal(
      await format(`<p>a</p>`, { insertPragma: true }),
      `<!-- @format -->\n\n<p>a</p>\n`,
    );
  });
});

describe("robustness", () => {
  test("CRLF line endings", async () => {
    assert.equal(
      await format(`<f:if condition="{a}">\r\n<p>x</p></f:if>`, {
        endOfLine: "crlf",
      }),
      `<f:if condition="{a}">\r\n  <p>x</p>\r\n</f:if>\r\n`,
    );
  });

  test("empty file", async () => {
    assert.equal(await format(""), "");
  });

  test("placeholders never collide with template content", async () => {
    const source = `<p>qz qza {a}</p>\n`;
    await assertFormat(source, source);
  });

  test("dynamic tag names", async () => {
    await assertFormat(
      `<div><h{level} class="x">Title</h{level}></div>`,
      `<div><h{level} class="x">Title</h{level}></div>\n`,
    );
  });

  test("script/style bodies with Fluid code are kept verbatim", async () => {
    const source = `<div>
  <style nonce="{nonce}"><f:format.raw>
    body { color: red }
  </f:format.raw></style>
  <script>var url = '{f:uri.action(action: "show")}';</script>
</div>
`;
    await assertFormat(source, source);
  });

  test("script/style bodies without Fluid code are formatted", async () => {
    await assertFormat(
      `<script>let a=1</script>\n<style>p{margin:0 ;}</style>`,
      `<script>\n  let a = 1;\n</script>\n<style>\n  p {\n    margin: 0;\n  }\n</style>\n`,
    );
  });

  test("embeddedLanguageFormatting: off still formats the template", async () => {
    await assertFormat(
      `<div><f:if condition="{a}">x</f:if></div>`,
      `<div>\n  <f:if condition="{a}">x</f:if>\n</div>\n`,
      { embeddedLanguageFormatting: "off" },
    );
  });

  test("parse errors point at the Fluid source", async () => {
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

  test("conditional wrappers are kept as written", async () => {
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

  test("conditional opening tags in f:then/f:else are kept as written", async () => {
    const source = `<table><tr><f:if condition="{header}"><f:then><th></f:then><f:else><td></f:else></f:if>{cell}</tr></table>\n`;
    const output = await format(source);
    assert.match(
      output,
      /<f:if condition="\{header\}"><f:then><th><\/f:then><f:else><td><\/f:else><\/f:if>/,
    );
    assert.equal(await format(output), output);
  });

  test("refuses to drop Fluid code", () => {
    const { html, state } = preprocess(`<p>{a} {b}</p>`);
    const [first] = html.match(
      new RegExp(`${state.nonce}\\d+_*${state.nonce}`),
    );
    assert.throws(() => restore(first, state), /dropped Fluid code.*\{b\}/);
  });
});

describe("other plugins", () => {
  test("prettier-plugin-organize-attributes", async () => {
    await assertFormat(
      `<f:link.page pageUid="{uid}" class="btn" additionalAttributes="{rel: 'x'}">x</f:link.page>`,
      `<f:link.page class="btn" additionalAttributes="{rel: 'x'}" pageUid="{uid}"\n  >x</f:link.page\n>\n`,
      {
        plugins: [fluid, "prettier-plugin-organize-attributes"],
        attributeSort: "ASC",
      },
    );
  });

  test("prettier-plugin-tailwindcss", { skip: skipTailwind }, async () => {
    await assertFormat(
      `<div class="p-4 flex {f:if(condition: a, then: 'x')}"></div>`,
      `<div class="{f:if(condition: a, then: 'x')} flex p-4"></div>\n`,
      { plugins: ALL_PLUGINS },
    );
  });
});

// Fixtures: test/fixtures/<name>.input.html → <name>.output.html, formatted
// with all plugins and the optional <name>.options.json.
// Regenerate outputs with `UPDATE=1 npm test`.
describe("fixtures", async () => {
  const dir = new URL("fixtures/", import.meta.url);
  const inputs = (await readdir(dir)).filter((file) =>
    file.endsWith(".input.html"),
  );

  for (const input of inputs) {
    test(input.replace(".input.html", ""), { skip: skipTailwind }, async () => {
      const source = await readFile(new URL(input, dir), "utf8");
      const outputUrl = new URL(input.replace(".input.", ".output."), dir);
      const optionsUrl = new URL(
        input.replace(".input.html", ".options.json"),
        dir,
      );
      const options = {
        plugins: ALL_PLUGINS,
        ...JSON.parse(await readFile(optionsUrl, "utf8").catch(() => "{}")),
      };
      if (process.env.UPDATE) {
        await writeFile(outputUrl, await format(source, options));
      }
      await assertFormat(source, await readFile(outputUrl, "utf8"), options);
    });
  }
});
