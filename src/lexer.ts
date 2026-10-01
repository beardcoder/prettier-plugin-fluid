/**
 * Recognizes Fluid and HTML syntax in template text: quoted strings with
 * backslash escapes, shorthand syntax (`{…}`), tags, comments and the other
 * source ranges the formatter keeps as written.
 *
 * Unlike a compiler's lexer, nothing is skipped or normalized: results are
 * offsets into the scanned text, which callers slice to get the original code,
 * whitespace and comments included. Offsets are zero-based UTF-16 indices and
 * ranges end exclusively, like `String#slice`.
 *
 * Nothing here depends on Prettier, placeholders or formatting options. Sticky
 * regexes are only used through `matchSticky()`, which sets `lastIndex` right
 * before matching; global regexes are created per call. So no scan can affect
 * another one, also not a nested one.
 */
import type { SourceRange } from './types.js';

/** A construct `scanToken()` recognized, starting at `start`. */
export type Token =
  /** Fluid shorthand syntax or a ternary expression: `{item.title}`. */
  | { kind: 'shorthand'; start: number; end: number }
  /**
   * From `<!-- prettier-ignore-start -->` to `<!-- prettier-ignore-end -->`
   * (or the end of the text), also in `<f:comment>`.
   */
  | { kind: 'ignoreRange'; start: number; end: number }
  /** `<!-- … -->` or `<![CDATA[ … ]]>`, up to the end of the text if unterminated. */
  | { kind: 'comment' | 'cdata'; start: number; end: number }
  /**
   * A (nested) `<f:comment>` element, up to the end of the text if unclosed.
   * `directive` is the Prettier directive it only consists of, e.g.
   * `prettier-ignore` or `display: block`.
   */
  | {
      kind: 'fluidComment';
      start: number;
      end: number;
      directive: string | undefined;
    }
  /** The start of a ViewHelper tag: `<f:if` or `</f:if`, without attributes. */
  | {
      kind: 'viewHelperTag';
      start: number;
      end: number;
      closing: boolean;
      namespace: string;
      name: string;
    }
  /**
   * The opening tag of a `<script>`/`<style>` element (`start` to `end`) and
   * its body, up to the closing tag or the end of the text.
   */
  | {
      kind: 'rawTextElement';
      start: number;
      end: number;
      body: SourceRange;
    };

/** An HTML or ViewHelper tag `scanTag()` recognized. */
export type TagScan =
  | {
      kind: 'tag';
      start: number;
      /** After the tag's `>`. */
      end: number;
      closing: boolean;
      /** As written; may contain Fluid expressions: `h{level}`. */
      name: string;
      selfClosing: boolean;
    }
  /** A tag without `>`, e.g. at the end of the text. */
  | { kind: 'unterminatedTag'; start: number; closing: boolean; name: string };

/** Markup `scanDeclaration()` recognized; `end` is the text's length if unterminated. */
export interface Declaration {
  kind: 'comment' | 'cdata' | 'declaration';
  start: number;
  end: number;
  terminated: boolean;
}

// Characters Fluid accepts in shorthand syntax, see
// Patterns::$SPLIT_PATTERN_SHORTHANDSYNTAX in typo3/fluid, plus `!` and `?`
// for negation and the ternary operator.
const SHORTHAND_CHAR = /[a-zA-Z0-9|\->_:=,.()*+^/%!?\s]/;
const VIEWHELPER_NAME = '[a-zA-Z0-9.]*:[a-zA-Z0-9.]+';

// TernaryExpressionNode::$detectionExpression of typo3/fluid: the condition
// may contain characters shorthand syntax does not, e.g. `{(a && b) ? 1 : 2}`.
const TERNARY = /\{[!\w.()|&'"=<>%\s{}:,]+\s?\?\s?[\w.\s'"]*\s?:\s?[\w.\s'"]+\}/y;

/**
 * `<!-- prettier-ignore-start -->`, also wrapped in `<f:comment>` so it does
 * not end up in the rendered HTML.
 */
function ignoreRangeMarker(kind: 'start' | 'end', flags: string): RegExp {
  const comment = `<!--\\s*prettier-ignore-${kind}\\s*-->`;

  return new RegExp(`${comment}|<f:comment\\s*>\\s*${comment}\\s*</f:comment\\s*>`, flags);
}

const TOKEN = {
  htmlComment: /<!--[\s\S]*?(?:-->|$)/y,
  cdata: /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/y,
  fluidComment: /<f:comment\s*(\/?)>/y,
  viewHelperTag: /<(\/?)([a-zA-Z0-9.]+):([a-zA-Z0-9.]+)/y,
  rawTextOpen: /<(script|style)\b/iy,
  ignoreStart: ignoreRangeMarker('start', 'y'),
};
// Tag names may contain Fluid expressions: <h{level}>.
const ANY_TAG = /<(\/?)([a-zA-Z][^\s/>]*)/y;

const DIRECTIVE = String.raw`<!--\s*(?:prettier-ignore(?!-(?:start|end)\b)|display:)[\s\S]*?-->`;
function directiveBefore(directive: string): RegExp {
  return new RegExp(String.raw`(?:${directive}|<f:comment\s*>\s*${directive}\s*</f:comment\s*>)\s*$`);
}

const DIRECTIVE_COMMENT = directiveBefore(DIRECTIVE);
// Prettier matches `prettier-ignore` exactly; `-attribute` keeps the content.
const IGNORE_COMMENT = directiveBefore(String.raw`<!--\s*prettier-ignore\s*-->`);

/**
 * A directive such as `<!-- display: block -->` in `<f:comment>`, so it does
 * not end up in the rendered HTML.
 */
const FLUID_DIRECTIVE_COMMENT =
  /^<f:comment\s*>\s*<!--\s*(prettier-ignore(?:-attribute(?:\s[\s\S]*?)?)?|display:\s*[\w-]+)\s*-->\s*<\/f:comment\s*>$/;

const VIEWHELPER_TAG_ANYWHERE = new RegExp(`</?${VIEWHELPER_NAME}`);

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param regex A sticky regex. */
export function matchSticky(regex: RegExp, text: string, index: number): RegExpExecArray | null {
  regex.lastIndex = index;

  return regex.exec(text);
}

/**
 * @param index Position of the opening quote.
 * @returns Index after the closing quote, or -1.
 */
export function skipQuoted(text: string, index: number): number {
  const quote = text[index];
  for (let i = index + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text[i] === quote) {
      return i + 1;
    }
  }

  return -1;
}

/**
 * Matches Fluid shorthand syntax the way Fluid's recursive `(?R)` pattern
 * does: nested braces and quoted strings (with backslash escapes, which may
 * contain further shorthand syntax) at any depth. Also matches ternary
 * expressions, which Fluid detects separately.
 *
 * @param index Position of the opening `{`.
 * @returns Index after the closing `}`, or -1 if this is no Fluid syntax.
 */
export function matchShorthand(text: string, index: number): number {
  const end = matchBraces(text, index);
  if (end !== -1) return end;

  return matchSticky(TERNARY, text, index) ? TERNARY.lastIndex : -1;
}

/**
 * @param index Position of the opening `{`.
 * @returns Index after the closing `}`, or -1.
 */
function matchBraces(text: string, index: number): number {
  let i = index + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === '}') return i > index + 1 ? i + 1 : -1;
    if (char === '{') {
      i = matchShorthand(text, i);
    } else if (char === '"' || char === "'") {
      i = skipQuoted(text, i);
    } else if (char === '\\') {
      // Escaped quotes inside ViewHelper arguments: condition="{a == \"b\"}"
      i += 2;
    } else if (SHORTHAND_CHAR.test(char)) {
      i++;
    } else {
      return -1;
    }
    if (i === -1) return -1;
  }

  return -1;
}

/**
 * Whether a script/style body contains Fluid code. Such bodies are not valid
 * JS/CSS, and formatting them could alter Fluid syntax (e.g. swap quotes).
 */
export function containsFluid(text: string): boolean {
  if (VIEWHELPER_TAG_ANYWHERE.test(text)) return true;
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    if (matchShorthand(text, i) !== -1) return true;
  }

  return false;
}

/**
 * The Fluid or HTML construct starting at `index` that the preprocessor
 * handles, or undefined. Checked in this order, as the first match wins.
 */
export function scanToken(text: string, index: number): Token | undefined {
  if (text[index] === '{') {
    const end = matchShorthand(text, index);

    return end === -1 ? undefined : { kind: 'shorthand', start: index, end };
  }
  if (text[index] !== '<') return undefined;

  return (
    scanIgnoreRange(text, index) ??
    scanMatch('comment', TOKEN.htmlComment, text, index) ??
    scanMatch('cdata', TOKEN.cdata, text, index) ??
    scanFluidComment(text, index) ??
    scanViewHelperTag(text, index) ??
    scanRawTextElement(text, index)
  );
}

function scanMatch(kind: 'comment' | 'cdata', regex: RegExp, text: string, index: number): Token | undefined {
  const match = matchSticky(regex, text, index);

  return match ? { kind, start: index, end: index + match[0].length } : undefined;
}

/**
 * Prettier's `html` parser has no range ignore, so everything from
 * `prettier-ignore-start` to `prettier-ignore-end` (or the end of the
 * template) is kept as written.
 */
function scanIgnoreRange(text: string, index: number): Token | undefined {
  const start = matchSticky(TOKEN.ignoreStart, text, index);
  if (!start) return undefined;
  const endMarker = ignoreRangeMarker('end', 'g');
  endMarker.lastIndex = index + start[0].length;
  const end = endMarker.exec(text) ? endMarker.lastIndex : text.length;

  return { kind: 'ignoreRange', start: index, end };
}

function scanFluidComment(text: string, index: number): Token | undefined {
  const open = matchSticky(TOKEN.fluidComment, text, index);
  if (!open) return undefined;
  if (open[1]) {
    return {
      kind: 'fluidComment',
      start: index,
      end: index + open[0].length,
      directive: undefined,
    };
  }
  // Fluid comments nest; find the matching closing tag.
  const tags = /<(\/?)f:comment\s*(\/?)>/g;
  tags.lastIndex = index + open[0].length;
  let depth = 1;
  for (let match; depth > 0 && (match = tags.exec(text));) {
    if (!match[2]) {
      depth += match[1] ? -1 : 1;
    }
  }
  const end = depth === 0 ? tags.lastIndex : text.length;
  const directive = FLUID_DIRECTIVE_COMMENT.exec(text.slice(index, end))?.[1];

  return { kind: 'fluidComment', start: index, end, directive };
}

function scanViewHelperTag(text: string, index: number): Token | undefined {
  const match = matchSticky(TOKEN.viewHelperTag, text, index);
  if (!match) return undefined;
  const [tag, slash, namespace, name] = match;

  return {
    kind: 'viewHelperTag',
    start: index,
    end: index + tag.length,
    closing: slash === '/',
    namespace,
    name,
  };
}

function scanRawTextElement(text: string, index: number): Token | undefined {
  const open = matchSticky(TOKEN.rawTextOpen, text, index);
  const tagEnd = open ? findTagEnd(text, index) : -1;
  if (!open || tagEnd === -1) return undefined;
  const close = new RegExp(`</${open[1]}`, 'ig');
  close.lastIndex = tagEnd;
  const bodyEnd = close.exec(text)?.index ?? text.length;

  return {
    kind: 'rawTextElement',
    start: index,
    end: tagEnd,
    body: { start: tagEnd, end: bodyEnd },
  };
}

/**
 * The HTML or ViewHelper tag starting at `index`, or undefined if there is
 * none. Comments and declarations (`<!…>`) are no tags, see `scanDeclaration()`.
 */
export function scanTag(text: string, index: number): TagScan | undefined {
  const match = matchSticky(ANY_TAG, text, index);
  if (!match) return undefined;
  const [, slash, name] = match;
  const closing = slash === '/';
  const end = findTagEnd(text, index);

  return end === -1
    ? { kind: 'unterminatedTag', start: index, closing, name }
    : {
        kind: 'tag',
        start: index,
        end,
        closing,
        name,
        selfClosing: text[end - 2] === '/',
      };
}

/** The comment, CDATA section or other `<!…>` declaration (e.g. a DOCTYPE) at `index`. */
export function scanDeclaration(text: string, index: number): Declaration | undefined {
  const [kind, terminator] = text.startsWith('<!--', index)
    ? (['comment', '-->'] as const)
    : text.startsWith('<![CDATA[', index)
      ? (['cdata', ']]>'] as const)
      : text.startsWith('<!', index)
        ? (['declaration', '>'] as const)
        : [];
  if (!kind) return undefined;
  const close = text.indexOf(terminator, index);

  return close === -1
    ? { kind, start: index, end: text.length, terminated: false }
    : { kind, start: index, end: close + terminator.length, terminated: true };
}

/**
 * @param index Position of the `<`.
 * @returns Index after the tag's `>`, or -1.
 */
export function findTagEnd(text: string, index: number): number {
  for (let i = index; i < text.length; i++) {
    if (text[i] === '"' || text[i] === "'") {
      i = skipQuoted(text, i);
      if (i === -1) return -1;
      i--;
    } else if (text[i] === '>') {
      return i + 1;
    }
  }

  return -1;
}

/**
 * Finds the end of the ViewHelper element whose opening tag starts at `start`.
 *
 * @param name e.g. `f:if`
 * @returns Undefined for self-closing or unclosed elements.
 */
export function findViewHelperElement(
  text: string,
  start: number,
  name: string,
): { body: SourceRange; end: number } | undefined {
  const tags = new RegExp(`<(/?)${escapeRegExp(name)}(?=[\\s/>])`, 'g');
  tags.lastIndex = start;
  let depth = 0;
  let bodyStart = -1;
  for (let match; (match = tags.exec(text));) {
    const tagEnd = findTagEnd(text, match.index);
    if (tagEnd === -1) return undefined;
    if (match[1]) {
      depth--;
      if (depth === 0) return { body: { start: bodyStart, end: match.index }, end: tagEnd };
    } else if (text[tagEnd - 2] !== '/') {
      depth++;
      if (bodyStart === -1) {
        bodyStart = tagEnd;
      }
    } else if (depth === 0) {
      return undefined;
    }
    tags.lastIndex = tagEnd;
  }

  return undefined;
}

/**
 * Fluid allows backslash-escaped quotes in ViewHelper arguments, also
 * outside of `{…}`: `textWrap="<span class=\"icon\">|</span>"`. An HTML
 * parser would end the value at `\"`. Finds such values between `start` and
 * `end` (a tag's attributes); ranges are without the quotes.
 */
export function findEscapedValues(text: string, start: number, end: number): SourceRange[] {
  const values: SourceRange[] = [];
  for (let i = start; i < end; i++) {
    const char = text[i];
    if (char !== '"' && char !== "'") continue;
    const valueEnd = skipQuoted(text, i);
    if (valueEnd === -1) break;
    if (text.slice(i + 1, valueEnd - 1).includes(`\\${char}`)) {
      values.push({ start: i + 1, end: valueEnd - 1 });
    }
    i = valueEnd - 1;
  }

  return values;
}

/**
 * Whether `<!-- prettier-ignore -->`, `<!-- display: x -->` or the like (also
 * in `<f:comment>`) directly precedes `index`; such directives must stay
 * adjacent to their tag.
 */
export function followsDirective(text: string, index: number): boolean {
  return DIRECTIVE_COMMENT.test(text.slice(Math.max(0, index - 500), index));
}

/** Whether exactly `<!-- prettier-ignore -->` (also in `<f:comment>`) precedes `index`. */
export function followsIgnoreDirective(text: string, index: number): boolean {
  return IGNORE_COMMENT.test(text.slice(Math.max(0, index - 500), index));
}

/** Leading whitespace of the line containing `offset`. */
export function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;

  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? '';
}

/**
 * For each line of a Fluid expression: whether it starts inside a quoted
 * string.
 */
export function linesStartingInString(source: string): boolean[] {
  const result = [false];
  let quote: string | undefined;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') {
      i++;
    } else if (char === '\n') {
      result.push(quote !== undefined);
    } else if (quote === undefined && (char === '"' || char === "'")) {
      quote = char;
    } else if (char === quote) {
      quote = undefined;
    }
  }

  return result;
}

/**
 * The value of an attribute of an opening tag, or undefined.
 *
 * @param tag From `<` to `>`.
 * @param name Lowercase.
 */
function getAttribute(tag: string, name: string): string | undefined {
  const attribute = /\s*([^\s"'>/=]+)\s*(=\s*)?/y;
  let i = /^<[^\s/>]*/.exec(tag)?.[0].length ?? 0;
  while (i < tag.length) {
    const match = matchSticky(attribute, tag, i);
    if (!match) {
      i++;
      continue;
    }
    i += match[0].length;
    let value = '';
    if (match[2]) {
      if (tag[i] === '"' || tag[i] === "'") {
        const end = skipQuoted(tag, i);
        if (end === -1) return undefined;
        value = tag.slice(i + 1, end - 1);
        i = end;
      } else {
        // `[^\s>]*` always matches.
        value = matchSticky(/[^\s>]*/y, tag, i)![0];
        i += value.length;
      }
    }
    if (match[1].toLowerCase() === name) return value;
  }

  return undefined;
}

/** A root tag wrapping the whole template, see `findRootElement()`. */
export interface RootElement {
  /** DOCTYPE and comments before the tag, trimmed. */
  prefix: string;
  name: string;
  openStart: number;
  openEnd: number;
  closeStart: number;
}

/**
 * Finds a root tag that only declares the Fluid namespaces, i.e. `<fluid …>`
 * or any tag with `data-namespace-typo3-fluid="true"`, wrapping the template.
 * A DOCTYPE and comments before it (e.g. `<!-- @format -->`) are allowed.
 */
export function findRootElement(text: string): RootElement | undefined {
  const open = /^((?:\s*(?:<!--[\s\S]*?-->|<!doctype\b[^>]*>))*)\s*<([a-zA-Z][\w-]*)(?=[\s/>])/i.exec(text);
  if (!open) return undefined;
  const [match, prefix, name] = open;
  const openStart = match.length - name.length - 1;
  const openEnd = findTagEnd(text, openStart);
  if (openEnd === -1 || text[openEnd - 2] === '/') return undefined;
  const tag = text.slice(openStart, openEnd);
  if (name.toLowerCase() !== 'fluid' && getAttribute(tag, 'data-namespace-typo3-fluid')?.toLowerCase() !== 'true')
    return undefined;
  const close = new RegExp(`</${name}\\s*>\\s*$`, 'i').exec(text);
  if (!close || close.index < openEnd) return undefined;

  return {
    prefix: prefix.trim(),
    name,
    openStart,
    openEnd,
    closeStart: close.index,
  };
}
