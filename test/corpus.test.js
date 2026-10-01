import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsers } from 'prettier/plugins/html';

import { checkCorpus, DEFAULT_OPTIONS, protectionViolations } from '../scripts/check-corpus.js';

const script = fileURLToPath(new URL('../scripts/check-corpus.js', import.meta.url));
const corpus = fileURLToPath(new URL('corpus/', import.meta.url));

/** @type {string[]} */
const directories = [];
after(() => Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true }))));

/** @param {Record<string, string>} files */
async function directory(files) {
  const dir = await mkdtemp(join(tmpdir(), 'fluid-corpus-'));
  directories.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }

  return dir;
}

/** @param {string[]} args */
function run(...args) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  return { status, output: stdout + stderr };
}

describe('protection comparison', () => {
  const assertViolations = (source, output, expected) =>
    assert.deepEqual(protectionViolations(source, output), expected);

  test('allows reformatting, attribute sorting and line endings', () => {
    assertViolations(
      `<div><f:link.page pageUid="{uid}" class="{c}">x</f:link.page></div>`,
      `<div>\n  <f:link.page class="{c}" pageUid="{uid}">x</f:link.page>\n</div>\n`,
      [],
    );
    assertViolations(`<p>{x}</p>\n<p>y</p>\n`, `<p>{x}</p>\r\n<p>y</p>\r\n`, []);
  });

  test('allows re-indenting expressions outside of strings', () => {
    assertViolations(
      `<p>{f:x(\n  a: 1,\n  b: 'x')}</p>`,
      `<div>\n  <p>{f:x(\n      a: 1,\n      b: 'x')}</p>\n</div>`,
      [],
    );
    assertViolations(`<p>{f:x(a: 'a  b')}</p>`, `<p>{f:x(a: 'a b')}</p>`, ['expressions']);
  });

  test('counts every occurrence of an expression', () => {
    assertViolations(`<p>{x} {x}</p>`, `<p>{x}</p>`, ['expressions']);
    assertViolations(`<p>{x} {x}</p>`, `<p>{x} {x} {x}</p>`, ['expressions']);
    assertViolations(`<p>{x} {y}</p>`, `<p>{y} {x}</p>`, []);
  });

  test('verbatim content must stay exactly as written', () => {
    const comment = `<f:comment>a  <b></f:comment>`;
    assertViolations(comment, `<f:comment>a <b></f:comment>`, ['verbatim content']);
    assertViolations(comment, `${comment}${comment}`, ['verbatim content', 'ViewHelper tags']);
    assertViolations(`<p>x</p>${comment}`, comment, []);
    assertViolations(
      `<!-- prettier-ignore-start --><p>a  b</p><!-- prettier-ignore-end -->`,
      `<!-- prettier-ignore-start --><p>a b</p><!-- prettier-ignore-end -->`,
      ['verbatim content'],
    );
  });

  test('script/style bodies with Fluid must stay exactly as written', () => {
    const source = `<script>var a = '{f:if(condition: b, then: \\'c\\')}';</script><style>.a { color: {c}; }</style>`;
    assertViolations(
      source,
      `<script>var a = "{f:if(condition: b, then: 'c')}";</script><style>.a { color: {c}; }</style>`,
      ['script/style bodies with Fluid'],
    );
    assertViolations(source, `<style>.a { color: {c}; }</style>`, ['script/style bodies with Fluid']);
    assertViolations(source, `<div>\n  ${source}\n</div>\n`, []);
    // Bodies without Fluid are formatted as JavaScript/CSS.
    assertViolations(`<script>let a=1</script>`, `<script>\n  let a = 1;\n</script>`, []);
  });

  test('ViewHelper tags must be kept', () => {
    assertViolations(`<f:if condition="{a}"><f:then>x</f:then></f:if>`, `<f:if condition="{a}">x</f:if>`, [
      'ViewHelper tags',
    ]);
  });
});

describe('checkCorpus', () => {
  /** An html parser that changes the preprocessed HTML. */
  const htmlPlugin = (preprocess) => ({
    parsers: { html: { ...parsers.html, preprocess } },
  });
  const optionsWith = (plugin) => ({
    ...DEFAULT_OPTIONS,
    plugins: [...DEFAULT_OPTIONS.plugins, plugin],
  });

  test("the plugin's refusals are lossy, not parse errors", async () => {
    const dir = await directory({ 'a.html': `<p>{x} {x}</p>\n` });
    const dropping = htmlPlugin((text) => text.replace(/qz\d+_*qz/, ''));
    const result = await checkCorpus([dir], {
      options: optionsWith(dropping),
      cwd: dir,
    });
    assert.deepEqual(result.findings.parseErrors, []);
    assert.equal(result.findings.lossy.length, 1);
    assert.match(result.findings.lossy[0], /^a\.html: prettier-plugin-fluid: formatting dropped/);
    assert.equal(result.exitCode, 1);
  });

  test('errors of the second pass are reported with the file name', async () => {
    const dir = await directory({ 'a.html': `<p>{x}</p>\n` });
    let calls = 0;
    const failing = htmlPlugin((text) => {
      if (++calls === 2) {
        throw new Error('second pass broke');
      }

      return text;
    });
    const result = await checkCorpus([dir], {
      options: optionsWith(failing),
      cwd: dir,
    });
    assert.deepEqual(result.findings.unstable, ['a.html: second pass failed: second pass broke']);
    assert.equal(result.exitCode, 1);
  });

  test('non-idempotent output fails', async () => {
    const dir = await directory({ 'a.html': `<p>{x}</p>\n` });
    const growing = htmlPlugin((text) => `${text}<!-- more -->`);
    const result = await checkCorpus([dir], {
      options: optionsWith(growing),
      cwd: dir,
    });
    assert.deepEqual(result.findings.unstable, ['a.html']);
    assert.equal(result.exitCode, 1);
  });

  test('the versioned corpus passes in strict mode', async () => {
    const result = await checkCorpus([corpus], { strict: true });
    assert.ok(result.total >= 3, `${result.total} templates`);
    assert.deepEqual(
      [
        ...result.findings.parseErrors,
        ...result.findings.lossy,
        ...result.findings.unstable,
        ...result.findings.failed,
      ],
      [],
    );
    assert.equal(result.exitCode, 0);
  });
});

describe('check-corpus CLI', () => {
  test('valid templates, of every HTML template extension', async () => {
    const dir = await directory({
      'a.html': `<div><f:if condition="{a}"><p>x</p></f:if></div>\n`,
      'b.fluid.html': `<p>{b}</p>\n`,
      'c.fluid': `<f:render partial="C" arguments="{c: c}" />\n`,
      // Plain-text template, no HTML.
      'mail.fluid.txt': `Hello {name}, <not html\n`,
    });
    for (const args of [[dir], ['--strict', dir]]) {
      const { status, output } = run(...args);
      assert.equal(status, 0, output);
      assert.match(output, /^3 files in /);
    }
  });

  test('only .fluid templates', async () => {
    const dir = await directory({ 'template.fluid': `<p>{a}</p>\n` });
    const { status, output } = run('--strict', dir);
    assert.equal(status, 0, output);
    assert.match(output, /^1 files in /);
  });

  test('invalid HTML fails only in strict mode', async () => {
    const dir = await directory({ 'broken.html': `<div><span></div>\n` });
    const tolerant = run(dir);
    assert.equal(tolerant.status, 0, tolerant.output);
    assert.match(
      tolerant.output,
      /1 parse errors \(left unformatted\):\n {2}.*broken\.html: Unexpected closing tag "div"/,
    );
    const strict = run('--strict', dir);
    assert.equal(strict.status, 1, strict.output);
    assert.match(strict.output, /broken\.html: Unexpected closing tag "div"/);
  });

  test('no templates fails only in strict mode', async () => {
    const dir = await directory({ 'notes.txt': 'x' });
    assert.equal(run(dir).status, 0);
    const strict = run('--strict', dir);
    assert.equal(strict.status, 1, strict.output);
    assert.match(strict.output, /^0 files in [\s\S]*FAILED: no templates found/);
  });

  test('without a path it is a usage error', () => {
    for (const args of [[], ['--strict']]) {
      const { status, output } = run(...args);
      assert.equal(status, 2);
      assert.match(output, /^Usage: node scripts\/check-corpus\.js \[--strict\]/);
    }
  });
});
