// The scanner of the plugin (src/lexer.ts): recognized ranges are
// zero-based UTF-16 offsets with an exclusive end, into the unchanged text.
import { describe, expect, test } from 'bun:test';

import {
  findEscapedValues,
  findRootElement,
  matchShorthand,
  scanDeclaration,
  scanTag,
  scanToken,
  skipQuoted,
} from '../src/lexer.ts';

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
    expect(matchShorthand(text, 3)).toBe(3 + expression.length);
    expect(scanToken(text, 3)).toEqual({
      kind: 'shorthand',
      start: 3,
      end: 3 + expression.length,
    });
    // Inner braces are shorthand syntax of their own.
    const inner = text.indexOf('{b');
    expect(text.slice(inner, matchShorthand(text, inner))).toBe('{b: 1}');
  });

  test('escaped quotes do not end strings', () => {
    const text = String.raw`x="{f:x(a: 'it\'s }', b: \"y\")}" y`;
    const start = text.indexOf('{');
    const end = matchShorthand(text, start);
    expect(text.slice(start, end)).toBe(String.raw`{f:x(a: 'it\'s }', b: \"y\")}`);
    const quote = text.indexOf("'");
    expect(text.slice(quote, skipQuoted(text, quote))).toBe(String.raw`'it\'s }'`);
    expect(skipQuoted(`'open\\'`, 0)).toBe(-1);
  });

  test('ternary expressions and text that is no Fluid', () => {
    const ternary = "{(a && b) ? 'x' : 'y'}";
    expect(matchShorthand(ternary, 0)).toBe(ternary.length);
    for (const text of ['{}', '{ not fluid; }', '{a', '{a {b}']) {
      expect(matchShorthand(text, 0), text).toBe(-1);
      expect(scanToken(text, 0), text).toBe(undefined);
    }
  });

  test('scans do not affect each other', () => {
    const a = "{x ? 'a' : 'b'} {y}";
    const b = '<!-- c --><f:comment>d</f:comment>{z ? 1 : 2}';
    const first = [scanToken(a, 0), scanToken(a, 16)];
    // Interleaved with scans of other text at other positions.
    expect(tokens(b).length).toEqual(3);
    expect([scanToken(a, 0), scanToken(a, 16)]).toEqual(first);
    expect(first).toEqual([
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
    expect(found.map(({ kind }) => kind)).toEqual([
      'comment',
      'cdata',
      'fluidComment',
      'ignoreRange',
      'fluidComment',
      'comment',
    ]);
    expect(found.map(({ start, end }) => text.slice(start, end))).toEqual(text.split('\t'));
    expect(found.map((token) => token.directive)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      'prettier-ignore',
      undefined,
    ]);
  });

  test('ViewHelper tags and script/style elements', () => {
    const text = `<f:if condition="{a}"></f:if><script type="x">{b}</SCRIPT>`;
    expect(scanToken(text, 0)).toEqual({
      kind: 'viewHelperTag',
      start: 0,
      end: 5,
      closing: false,
      namespace: 'f',
      name: 'if',
    });
    expect(scanToken(text, 22).closing).toBe(true);
    const script = text.indexOf('<script');
    const element = scanToken(text, script);
    expect(element.kind).toBe('rawTextElement');
    expect(text.slice(element.start, element.end)).toBe(`<script type="x">`);
    expect(text.slice(element.body.start, element.body.end)).toBe('{b}');
  });

  test('tags, declarations and escaped attribute values', () => {
    const text = `<!DOCTYPE html><h{level} a="x>y"><br/><img`;
    expect(scanDeclaration(text, 0)).toEqual({
      kind: 'declaration',
      start: 0,
      end: 15,
      terminated: true,
    });
    const tag = scanTag(text, 15);
    expect(tag.name).toBe('h{level}');
    expect(text.slice(tag.start, tag.end)).toBe(`<h{level} a="x>y">`);
    expect(scanTag(text, tag.end).selfClosing).toBe(true);
    expect(scanTag(text, text.length - 4)).toEqual({
      kind: 'unterminatedTag',
      start: text.length - 4,
      closing: false,
      name: 'img',
    });
    expect(scanTag(text, 0)).toBe(undefined);

    const viewHelper = String.raw`<f:x a="<b class=\"i\">" b="c" d='\'' >`;
    expect(
      findEscapedValues(viewHelper, 0, viewHelper.length).map(({ start, end }) => viewHelper.slice(start, end)),
    ).toEqual([String.raw`<b class=\"i\">`, String.raw`\'`]);
  });
});

describe('offsets with CRLF and Unicode', () => {
  test('are UTF-16 offsets into the unchanged text', () => {
    const text = '😀\r\n<f:comment>ä\r\n</f:comment>{x}\r\n<!-- 😀 -->';
    const found = tokens(text);
    expect(found.map(({ kind, start, end }) => [kind, start, end])).toEqual([
      ['fluidComment', 4, 30],
      ['shorthand', 30, 33],
      ['comment', 35, 46],
    ]);
    expect(found.map(({ start, end }) => text.slice(start, end))).toEqual([
      '<f:comment>ä\r\n</f:comment>',
      '{x}',
      '<!-- 😀 -->',
    ]);
  });

  test('the root element', () => {
    const text = `<!-- 😀 -->\r\n<html data-namespace-typo3-fluid="true">\r\n<p>ä</p>\r\n</html>\r\n`;
    const root = findRootElement(text);
    expect(root).toEqual({
      prefix: '<!-- 😀 -->',
      name: 'html',
      openStart: 13,
      openEnd: 53,
      closeStart: 65,
    });
    expect(text.slice(root.openStart, root.openEnd)).toBe(`<html data-namespace-typo3-fluid="true">`);
    expect(text.slice(root.closeStart)).toBe('</html>\r\n');
  });
});
