// The scanner of the compiled plugin (dist/lexer.js): recognized ranges are
// zero-based UTF-16 offsets with an exclusive end, into the unchanged text.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  findEscapedValues,
  findRootElement,
  matchShorthand,
  scanDeclaration,
  scanTag,
  scanToken,
  skipQuoted,
} from '../dist/lexer.js';

/** Every token `scanToken()` finds, scanning like the preprocessor. */
function tokens(text) {
  const found = [];
  for (let i = 0; i < text.length;) {
    const token = scanToken(text, i);
    if (token && token.kind !== 'viewHelperTag' && token.kind !== 'rawTextElement') {
      found.push(token);
      i = token.end;
    } else {
      i++;
    }
  }

  return found;
}

describe('shorthand syntax', () => {
  test('nested braces, strings and inline ViewHelpers', () => {
    const expression = `{f:if(condition: '{a: {b: 1}}', then: "{c -> f:format.raw()}", else: {d: '}'})}`;
    const text = `<p>${expression}</p>`;
    assert.equal(matchShorthand(text, 3), 3 + expression.length);
    assert.deepEqual(scanToken(text, 3), {
      kind: 'shorthand',
      start: 3,
      end: 3 + expression.length,
    });
    // Inner braces are shorthand syntax of their own.
    const inner = text.indexOf('{b');
    assert.equal(text.slice(inner, matchShorthand(text, inner)), '{b: 1}');
  });

  test('escaped quotes do not end strings', () => {
    const text = String.raw`x="{f:x(a: 'it\'s }', b: \"y\")}" y`;
    const start = text.indexOf('{');
    const end = matchShorthand(text, start);
    assert.equal(text.slice(start, end), String.raw`{f:x(a: 'it\'s }', b: \"y\")}`);
    const quote = text.indexOf("'");
    assert.equal(text.slice(quote, skipQuoted(text, quote)), String.raw`'it\'s }'`);
    assert.equal(skipQuoted(`'open\\'`, 0), -1);
  });

  test('ternary expressions and text that is no Fluid', () => {
    const ternary = "{(a && b) ? 'x' : 'y'}";
    assert.equal(matchShorthand(ternary, 0), ternary.length);
    for (const text of ['{}', '{ not fluid; }', '{a', '{a {b}']) {
      assert.equal(matchShorthand(text, 0), -1, text);
      assert.equal(scanToken(text, 0), undefined, text);
    }
  });

  test('scans do not affect each other', () => {
    const a = "{x ? 'a' : 'b'} {y}";
    const b = '<!-- c --><f:comment>d</f:comment>{z ? 1 : 2}';
    const first = [scanToken(a, 0), scanToken(a, 16)];
    // Interleaved with scans of other text at other positions.
    assert.deepEqual(tokens(b).length, 3);
    assert.deepEqual([scanToken(a, 0), scanToken(a, 16)], first);
    assert.deepEqual(first, [
      { kind: 'shorthand', start: 0, end: 15 },
      { kind: 'shorthand', start: 16, end: 19 },
    ]);
  });
});

describe('source ranges', () => {
  test('comments and protected ranges are kept as written', () => {
    const text = [
      '<!--  a  -->',
      '<![CDATA[ {b} ]]>',
      '<f:comment> <f:comment>x</f:comment>\n  {y} </f:comment>',
      '<!-- prettier-ignore-start --> <p>  z </p>\n<!-- prettier-ignore-end -->',
      '<f:comment>\n<!-- prettier-ignore -->\n</f:comment>',
      '<!-- open',
    ].join('\t');
    const found = tokens(text);
    assert.deepEqual(
      found.map(({ kind }) => kind),
      ['comment', 'cdata', 'fluidComment', 'ignoreRange', 'fluidComment', 'comment'],
    );
    assert.deepEqual(
      found.map(({ start, end }) => text.slice(start, end)),
      text.split('\t'),
    );
    assert.deepEqual(
      found.map((token) => token.directive),
      [undefined, undefined, undefined, undefined, 'prettier-ignore', undefined],
    );
  });

  test('ViewHelper tags and script/style elements', () => {
    const text = `<f:if condition="{a}"></f:if><script type="x">{b}</SCRIPT>`;
    assert.deepEqual(scanToken(text, 0), {
      kind: 'viewHelperTag',
      start: 0,
      end: 5,
      closing: false,
      namespace: 'f',
      name: 'if',
    });
    assert.equal(scanToken(text, 22).closing, true);
    const script = text.indexOf('<script');
    const element = scanToken(text, script);
    assert.equal(element.kind, 'rawTextElement');
    assert.equal(text.slice(element.start, element.end), `<script type="x">`);
    assert.equal(text.slice(element.body.start, element.body.end), '{b}');
  });

  test('tags, declarations and escaped attribute values', () => {
    const text = `<!DOCTYPE html><h{level} a="x>y"><br/><img`;
    assert.deepEqual(scanDeclaration(text, 0), {
      kind: 'declaration',
      start: 0,
      end: 15,
      terminated: true,
    });
    const tag = scanTag(text, 15);
    assert.equal(tag.name, 'h{level}');
    assert.equal(text.slice(tag.start, tag.end), `<h{level} a="x>y">`);
    assert.equal(scanTag(text, tag.end).selfClosing, true);
    assert.deepEqual(scanTag(text, text.length - 4), {
      kind: 'unterminatedTag',
      start: text.length - 4,
      closing: false,
      name: 'img',
    });
    assert.equal(scanTag(text, 0), undefined);

    const viewHelper = String.raw`<f:x a="<b class=\"i\">" b="c" d='\'' >`;
    assert.deepEqual(
      findEscapedValues(viewHelper, 0, viewHelper.length).map(({ start, end }) => viewHelper.slice(start, end)),
      [String.raw`<b class=\"i\">`, String.raw`\'`],
    );
  });
});

describe('offsets with CRLF and Unicode', () => {
  test('are UTF-16 offsets into the unchanged text', () => {
    const text = '😀\r\n<f:comment>ä\r\n</f:comment>{x}\r\n<!-- 😀 -->';
    const found = tokens(text);
    assert.deepEqual(
      found.map(({ kind, start, end }) => [kind, start, end]),
      [
        ['fluidComment', 4, 30],
        ['shorthand', 30, 33],
        ['comment', 35, 46],
      ],
    );
    assert.deepEqual(
      found.map(({ start, end }) => text.slice(start, end)),
      ['<f:comment>ä\r\n</f:comment>', '{x}', '<!-- 😀 -->'],
    );
  });

  test('the root element', () => {
    const text = `<!-- 😀 -->\r\n<html data-namespace-typo3-fluid="true">\r\n<p>ä</p>\r\n</html>\r\n`;
    const root = findRootElement(text);
    assert.deepEqual(root, {
      prefix: '<!-- 😀 -->',
      name: 'html',
      openStart: 13,
      openEnd: 53,
      closeStart: 65,
    });
    assert.equal(text.slice(root.openStart, root.openEnd), `<html data-namespace-typo3-fluid="true">`);
    assert.equal(text.slice(root.closeStart), '</html>\r\n');
  });
});
