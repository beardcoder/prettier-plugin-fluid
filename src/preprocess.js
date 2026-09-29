// @ts-check

/**
 * Turns a Fluid template into plain HTML that Prettier's own `html` parser
 * (and every plugin wrapping it) can format safely, and back again:
 *
 * - Fluid shorthand syntax (`{item.title -> f:format.crop(maxCharacters: 20)}`),
 *   including arbitrarily nested inline syntax, is swapped for opaque
 *   placeholders of the same width, so it is never re-wrapped or re-quoted.
 * - `<f:comment>` elements become HTML comments, so their (possibly broken)
 *   content is kept verbatim.
 * - Structural ViewHelpers (`<f:if>`, `<f:for>`, ...) get a
 *   `<!-- display: block -->` hint; Prettier would treat unknown namespaced
 *   tags as inline elements otherwise.
 */

/**
 * @typedef {object} PreprocessOptions
 * @property {readonly string[]} [blockViewHelpers] Additional (e.g. custom)
 *   ViewHelpers formatted as blocks. `*` matches any part of a name, e.g.
 *   `my:*` or `v:variable.*`.
 * @property {readonly string[]} [inlineViewHelpers] ViewHelpers formatted
 *   inline even though they are block by default. Wins over `blockViewHelpers`.
 * @property {readonly string[]} [verbatimViewHelpers] Additional ViewHelpers
 *   whose element is kept exactly as written, like `<f:comment>`.
 * @property {number} [printWidth] Multi-line expressions get placeholders wider
 *   than this, so a tag containing one always breaks its attributes.
 * @property {ArraySpacing} [arraySpacing] Spaces inside the braces of
 *   single-line Fluid arrays (`{ a: 1, b: 2 }` or `{a: 1, b: 2}`).
 *
 * @typedef {"preserve" | "always" | "never"} ArraySpacing
 *
 * @typedef {object} Fragment
 * @property {string} source Original template code.
 * @property {boolean} comment Whether the placeholder is wrapped in `<!-- -->`.
 * @property {number} indent Leading whitespace of the source line the code
 *   starts on; continuation lines of expressions move with the new indent.
 *
 * @typedef {object} Segment Code the preprocessor replaced or inserted.
 * @property {number} htmlStart
 * @property {number} htmlEnd
 * @property {number} sourceStart
 * @property {number} sourceEnd
 *
 * @typedef {object} RestoreState
 * @property {string} source The original template.
 * @property {string} nonce
 * @property {string[]} hints Comments inserted to steer Prettier.
 * @property {Fragment[]} fragments
 * @property {Segment[]} segments Sorted by position.
 * @property {RawTextTags} rawTextTags `<f:asset.css>`/`<f:asset.script>`
 *   tags temporarily turned into `<style>`/`<script>`.
 *
 * @typedef {object} RawTextTags
 * @property {number} count All `<style>`/`<script>` tags (opening and
 *   closing) in the preprocessed HTML.
 * @property {Map<number, string>} assets Original tag name by the ordinal of
 *   the renamed tags among them.
 *
 * @typedef {{ line: number, column: number }} Position 1-based line and column.
 */

/**
 * ViewHelpers whose content is kept as written. `f:spaceless` often builds
 * strings (e.g. class lists) where added line breaks would change the output.
 */
export const DEFAULT_VERBATIM_VIEWHELPERS = Object.freeze(["f:spaceless"]);

/** Tags from typo3/fluid and TYPO3 core that structure a template. */
export const DEFAULT_BLOCK_VIEWHELPERS = Object.freeze([
  "f:alias",
  "f:argument",
  "f:asset.css",
  "f:asset.script",
  "f:cache.*",
  "f:case",
  "f:comment",
  "f:defaultCase",
  "f:else",
  "f:for",
  "f:form",
  "f:fragment",
  "f:groupedFor",
  "f:if",
  "f:layout",
  "f:render",
  "f:section",
  "f:slot",
  "f:spaceless",
  "f:switch",
  "f:then",
  "f:variable",
]);

// Characters Fluid accepts in shorthand syntax, see
// Patterns::$SPLIT_PATTERN_SHORTHANDSYNTAX in typo3/fluid, plus `!` and `?`
// for negation and the ternary operator.
const SHORTHAND_CHAR = /[a-zA-Z0-9|\->_:=,.()*+^/%!?\s]/;
const VIEWHELPER_NAME = "[a-zA-Z0-9.]*:[a-zA-Z0-9.]+";

/**
 * `<!-- prettier-ignore-start -->`, also wrapped in `<f:comment>` so it does
 * not end up in the rendered HTML.
 *
 * @param {"start" | "end"} kind
 * @param {string} flags
 */
function ignoreRangeMarker(kind, flags) {
  const comment = `<!--\\s*prettier-ignore-${kind}\\s*-->`;
  return new RegExp(
    `${comment}|<f:comment\\s*>\\s*${comment}\\s*</f:comment\\s*>`,
    flags,
  );
}

const TOKEN = {
  htmlComment: /<!--[\s\S]*?(?:-->|$)/y,
  cdata: /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/y,
  fluidComment: /<f:comment\s*(\/?)>/y,
  fluidCommentTags: /<(\/?)f:comment\s*(\/?)>/g,
  viewHelperTag: /<(\/?)([a-zA-Z0-9.]+):([a-zA-Z0-9.]+)/y,
  rawTextOpen: /<(script|style)\b/iy,
  ignoreStart: ignoreRangeMarker("start", "y"),
  ignoreEnd: ignoreRangeMarker("end", "g"),
};

const DIRECTIVE_COMMENT =
  /(?:<!--\s*(?:prettier-ignore(?!-(?:start|end)\b)|display:)[\s\S]*?-->|<f:comment\s*>\s*<!--\s*prettier-ignore\s*-->\s*<\/f:comment\s*>)\s*$/;

/** `<!-- prettier-ignore -->` that does not end up in the rendered HTML. */
const FLUID_IGNORE_COMMENT =
  /^<f:comment\s*>\s*<!--\s*prettier-ignore\s*-->\s*<\/f:comment\s*>$/;

/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param {readonly string[]} patterns
 * @returns {(name: string) => boolean}
 */
function createNameMatcher(patterns) {
  if (patterns.length === 0) {
    return () => false;
  }
  const alternatives = patterns.map((pattern) =>
    pattern.split("*").map(escapeRegExp).join("[a-zA-Z0-9.]*"),
  );
  const regex = new RegExp(`^(?:${alternatives.join("|")})$`, "i");
  return (name) => regex.test(name);
}

/**
 * Picks a letters-only marker that does not occur in the template, so
 * placeholders can never collide with template content.
 *
 * @param {string} source
 */
function createNonce(source) {
  for (let n = 0; ; n++) {
    let suffix = "";
    for (let rest = n; rest > 0; rest = Math.floor(rest / 26)) {
      suffix += String.fromCharCode(97 + (rest % 26));
    }
    const nonce = `qz${suffix}`;
    if (!source.includes(nonce)) {
      return nonce;
    }
  }
}

/**
 * Creates a Prettier directive comment such as `display: block`. Tabs make it
 * distinguishable from user-written comments, while Prettier still recognizes
 * it (directives are matched after trimming whitespace).
 *
 * @param {string} source
 * @param {string} directive
 */
function createHint(source, directive) {
  let tabs = "\t";
  while (source.includes(`<!--${tabs}${directive}${tabs}-->`)) {
    tabs += "\t";
  }
  return `<!--${tabs}${directive}${tabs}-->`;
}

const VIEWHELPER_TAG_ANYWHERE = new RegExp(`</?${VIEWHELPER_NAME}`);

/**
 * Whether a script/style body contains Fluid code. Such bodies are not valid
 * JS/CSS, and formatting them could alter Fluid syntax (e.g. swap quotes).
 *
 * @param {string} text
 */
function containsFluid(text) {
  if (VIEWHELPER_TAG_ANYWHERE.test(text)) {
    return true;
  }
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    if (matchShorthand(text, i) !== -1) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} text
 * @param {number} index Position of the opening quote.
 * @returns {number} Index after the closing quote, or -1.
 */
function skipQuoted(text, index) {
  const quote = text[index];
  for (let i = index + 1; i < text.length; i++) {
    if (text[i] === "\\") {
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
 * contain further shorthand syntax) at any depth.
 *
 * @param {string} text
 * @param {number} index Position of the opening `{`.
 * @returns {number} Index after the closing `}`, or -1 if this is no Fluid syntax.
 */
export function matchShorthand(text, index) {
  let i = index + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === "}") {
      return i > index + 1 ? i + 1 : -1;
    }
    if (char === "{") {
      i = matchShorthand(text, i);
    } else if (char === '"' || char === "'") {
      i = skipQuoted(text, i);
    } else if (char === "\\") {
      // Escaped quotes inside ViewHelper arguments: condition="{a == \"b\"}"
      i += 2;
    } else if (SHORTHAND_CHAR.test(char)) {
      i++;
    } else {
      return -1;
    }
    if (i === -1) {
      return -1;
    }
  }
  return -1;
}

// Array syntax as in Patterns::$SCAN_PATTERN_SHORTHANDSYNTAX_ARRAYS of
// typo3/fluid: `key: value` or `key = value`, separated by optional commas.
const ARRAY_KEY =
  /([a-zA-Z0-9\-_]+|"(?:\\.|[^"\\])+"|'(?:\\.|[^'\\])+')(\s*[:=]\s*)/y;
const ARRAY_IDENTIFIER = /[a-zA-Z0-9\-_.]+/y;
const WHITESPACE = /\s*/y;

/**
 * @param {RegExp} regex A sticky regex.
 * @param {string} text
 * @param {number} index
 */
function matchSticky(regex, text, index) {
  regex.lastIndex = index;
  return regex.exec(text);
}

/**
 * Rewrites a single-line Fluid array (`{a: 1,b: 2}`) with one space after each
 * comma and the given spacing inside the braces. Keys, delimiters and values
 * stay as written.
 *
 * `{fh:baum}` also matches Fluid's array syntax, but reads like a namespaced
 * name (and `{"w":"1"}` like JSON); a single entry without whitespace around
 * its delimiter is therefore never treated as an array at the top level.
 *
 * @param {string} code An expression from `{` to `}`.
 * @param {"always" | "never"} spacing
 * @param {boolean} nested Whether `code` is the value of an array entry.
 * @returns {string | undefined} Undefined if `code` is no single-line array.
 */
function formatArray(code, spacing, nested) {
  const end = code.length - 1;
  /** @type {string[]} */
  const entries = [];
  let ambiguous = false;
  let i = 1;
  while (true) {
    const space = /** @type {RegExpExecArray} */ (
      matchSticky(WHITESPACE, code, i)
    )[0];
    if (space.includes("\n")) {
      return undefined;
    }
    i += space.length;
    if (i === end) {
      break;
    }
    const key = matchSticky(ARRAY_KEY, code, i);
    if (!key || key[2].includes("\n")) {
      return undefined;
    }
    const valueStart = i + key[0].length;
    /** @type {string | undefined} */
    let value;
    let valueEnd;
    const char = code[valueStart];
    if (char === '"' || char === "'") {
      valueEnd = skipQuoted(code, valueStart);
      value = code.slice(valueStart, valueEnd);
    } else if (char === "{") {
      valueEnd = matchShorthand(code, valueStart);
      value =
        valueEnd === -1
          ? undefined
          : formatArray(code.slice(valueStart, valueEnd), spacing, true);
    } else {
      value = matchSticky(ARRAY_IDENTIFIER, code, valueStart)?.[0];
      valueEnd = valueStart + (value?.length ?? 0);
    }
    ambiguous = /^[:=]$/.test(key[2]);
    if (value === undefined || valueEnd === -1 || valueEnd > end) {
      return undefined;
    }
    entries.push(`${key[0]}${value}`);
    i = valueEnd;
    const separator = /** @type {RegExpExecArray} */ (
      matchSticky(/\s*,?/y, code, i)
    )[0];
    if (separator.includes("\n")) {
      return undefined;
    }
    i += separator.length;
  }
  if (entries.length === 0 || (entries.length === 1 && ambiguous && !nested)) {
    return undefined;
  }
  const pad = spacing === "always" ? " " : "";
  return `{${pad}${entries.join(", ")}${pad}}`;
}

/**
 * Applies `formatArray()` to every array in an expression, including arrays
 * nested in ViewHelper arguments. Quoted strings are left alone.
 *
 * @param {string} code
 * @param {"always" | "never"} spacing
 */
export function formatArrays(code, spacing) {
  let result = "";
  let copied = 0;
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (char === "\\") {
      i++;
    } else if (char === '"' || char === "'") {
      const end = skipQuoted(code, i);
      if (end === -1) {
        break;
      }
      i = end - 1;
    } else if (char === "{") {
      const end = matchShorthand(code, i);
      if (end === -1) {
        continue;
      }
      const inner = code.slice(i, end);
      const formatted =
        formatArray(inner, spacing, false) ??
        `{${formatArrays(inner.slice(1, -1), spacing)}}`;
      result += code.slice(copied, i) + formatted;
      copied = end;
      i = end - 1;
    }
  }
  return result + code.slice(copied);
}

/**
 * @param {string} text
 * @param {number} index Position of the `<`.
 * @returns {number} Index after the tag's `>`, or -1.
 */
function findTagEnd(text, index) {
  for (let i = index; i < text.length; i++) {
    if (text[i] === '"' || text[i] === "'") {
      i = skipQuoted(text, i);
      if (i === -1) {
        return -1;
      }
      i--;
    } else if (text[i] === ">") {
      return i + 1;
    }
  }
  return -1;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea"]);
/** Asset ViewHelpers whose inline content is CSS or JavaScript. */
const ASSET_ELEMENTS = new Map([
  ["f:asset.css", "style"],
  ["f:asset.script", "script"],
]);
const RAW_TEXT_TAG = /<(\/?)(?:style|script)(?=[\s/>])/gi;
// Tag names may contain Fluid expressions: <h{level}>.
const ANY_TAG = /<(\/?)([a-zA-Z][^\s/>]*)/y;

/**
 * Finds the end of the ViewHelper element whose opening tag starts at `start`.
 *
 * @param {string} text
 * @param {number} start
 * @param {string} name e.g. `f:if`
 * @returns {{ bodyStart: number, bodyEnd: number, end: number } | undefined}
 *   Undefined for self-closing or unclosed elements.
 */
function findViewHelperElement(text, start, name) {
  const tags = new RegExp(`<(/?)${escapeRegExp(name)}(?=[\\s/>])`, "g");
  tags.lastIndex = start;
  let depth = 0;
  let bodyStart = -1;
  for (let match; (match = tags.exec(text));) {
    const tagEnd = findTagEnd(text, match.index);
    if (tagEnd === -1) {
      return undefined;
    }
    if (match[1]) {
      depth--;
      if (depth === 0) {
        return { bodyStart, bodyEnd: match.index, end: tagEnd };
      }
    } else if (text[tagEnd - 2] !== "/") {
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
 * Whether `text` is a well-nested sequence of HTML/ViewHelper elements, e.g.
 * not just the opening `<div>` of a conditional wrapper. Deliberately strict:
 * implied end tags (`<li>a<li>b`) also count as unbalanced.
 *
 * @param {string} text
 */
function isBalancedHtml(text) {
  /** @type {string[]} */
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "{") {
      const end = matchShorthand(text, i);
      i = end === -1 ? i + 1 : end;
      continue;
    }
    if (char !== "<") {
      i++;
      continue;
    }
    const terminator = text.startsWith("<!--", i)
      ? "-->"
      : text.startsWith("<![CDATA[", i)
        ? "]]>"
        : undefined;
    if (terminator) {
      const end = text.indexOf(terminator, i);
      if (end === -1) {
        return false;
      }
      i = end + terminator.length;
      continue;
    }
    ANY_TAG.lastIndex = i;
    const match = ANY_TAG.exec(text);
    if (!match) {
      i++;
      continue;
    }
    const tagEnd = findTagEnd(text, i);
    if (tagEnd === -1) {
      return false;
    }
    const [, slash, rawName] = match;
    const name = rawName.includes(":") ? rawName : rawName.toLowerCase();
    i = tagEnd;
    if (slash) {
      if (stack.pop() !== name) {
        return false;
      }
    } else if (text[tagEnd - 2] !== "/" && !VOID_ELEMENTS.has(name)) {
      if (
        RAW_TEXT_ELEMENTS.has(name) ||
        ASSET_ELEMENTS.has(name) ||
        name === "f:comment"
      ) {
        // Skip content that is no markup.
        const close = text.indexOf(`</${rawName}`, i);
        if (close === -1) {
          return false;
        }
        i = close;
      }
      stack.push(name);
    }
  }
  return stack.length === 0;
}

class Preprocessor {
  /** @type {string} */ #source;
  /** @type {(name: string) => boolean} */ #isBlockViewHelper;
  /** @type {(name: string) => boolean} */ #isVerbatimViewHelper;
  /** @type {number} */ #printWidth;
  /** @type {ArraySpacing} */ #arraySpacing;
  #nonce;
  #displayHint;
  #ignoreHint;
  /** Placeholders by source, so equal code (e.g. `<h{n}>…</h{n}>`) stays equal. */
  /** @type {Map<string, string>} */ #placeholders = new Map();
  /** @type {Fragment[]} */ #fragments = [];
  /** @type {string[]} */ #output = [];
  #outputLength = 0;
  /** @type {Segment[]} */ #segments = [];
  #pos = 0;
  /** Start of the source range not yet copied to #output. */
  #pending = 0;
  /** @type {{ start: number, end: number } | undefined} */ #rawTextBody;
  /** End of a ViewHelper element whose content is known to be well-nested. */
  #checkedUntil = 0;
  /** Closing asset tags to rename, by source position. */
  /** @type {Map<number, string>} */ #assetCloses = new Map();
  /** HTML offsets of renamed asset tags and their original names. */
  /** @type {Map<number, string>} */ #assetTags = new Map();
  /** ViewHelper argument values with escaped quotes: start → end. */
  /** @type {Map<number, number>} */ #escapedValues = new Map();

  /**
   * @param {string} source
   * @param {PreprocessOptions} options
   */
  constructor(
    source,
    {
      blockViewHelpers = [],
      inlineViewHelpers = [],
      verbatimViewHelpers = [],
      printWidth = 80,
      arraySpacing = "preserve",
    } = {},
  ) {
    this.#source = source;
    this.#printWidth = printWidth;
    this.#arraySpacing = arraySpacing;
    this.#isVerbatimViewHelper = createNameMatcher([
      ...DEFAULT_VERBATIM_VIEWHELPERS,
      ...verbatimViewHelpers,
    ]);
    const isBlock = createNameMatcher([
      ...DEFAULT_BLOCK_VIEWHELPERS,
      ...blockViewHelpers,
    ]);
    const isInline = createNameMatcher(inlineViewHelpers);
    this.#isBlockViewHelper = (name) => isBlock(name) && !isInline(name);
    this.#nonce = createNonce(source);
    this.#displayHint = createHint(source, "display: block");
    this.#ignoreHint = createHint(source, "prettier-ignore");
  }

  run() {
    const source = this.#source;
    while (this.#pos < source.length) {
      const escapedValueEnd = this.#escapedValues.get(this.#pos);
      if (escapedValueEnd !== undefined) {
        this.#escapedValues.delete(this.#pos);
        this.#replace(escapedValueEnd, false);
        continue;
      }
      if (this.#pos === this.#rawTextBody?.start) {
        // Script/style bodies go untouched to Prettier's embedded formatters.
        this.#pos = this.#rawTextBody.end;
        this.#rawTextBody = undefined;
        continue;
      }
      const char = source[this.#pos];
      const handled =
        (char === "{" && this.#shorthand()) ||
        (char === "<" &&
          (this.#ignoreRange() ||
            this.#skip(TOKEN.htmlComment) ||
            this.#skip(TOKEN.cdata) ||
            this.#fluidComment() ||
            this.#tag()));
      if (!handled) {
        this.#pos++;
      }
    }
    this.#flush(source.length);

    /** @type {RestoreState} */
    const state = {
      source: this.#source,
      nonce: this.#nonce,
      hints: [this.#displayHint, this.#ignoreHint],
      fragments: this.#fragments,
      segments: this.#segments,
      rawTextTags: { count: 0, assets: new Map() },
    };
    const html = this.#output.join("");
    for (const match of html.matchAll(RAW_TEXT_TAG)) {
      const name = this.#assetTags.get(match.index);
      if (name) {
        state.rawTextTags.assets.set(state.rawTextTags.count, name);
      }
      state.rawTextTags.count++;
    }
    return { html, state };
  }

  /** @param {number} until */
  #flush(until) {
    const text = this.#source.slice(this.#pending, until);
    this.#output.push(text);
    this.#outputLength += text.length;
    this.#pending = until;
  }

  /**
   * Emits `text` in place of the source range from the current position to `end`.
   *
   * @param {string} text
   * @param {number} end
   */
  #emit(text, end) {
    this.#flush(this.#pos);
    this.#segments.push({
      htmlStart: this.#outputLength,
      htmlEnd: this.#outputLength + text.length,
      sourceStart: this.#pos,
      sourceEnd: end,
    });
    this.#output.push(text);
    this.#outputLength += text.length;
    this.#pos = this.#pending = end;
  }

  /**
   * @param {number} end
   * @param {boolean} comment
   * @param {(code: string) => string} [transform] Formats the code; the
   *   placeholder gets the width of the result.
   */
  #replace(end, comment, transform) {
    const original = this.#source.slice(this.#pos, end);
    const existing = comment ? undefined : this.#placeholders.get(original);
    if (existing) {
      this.#emit(existing, end);
      return true;
    }
    const code = transform ? transform(original) : original;
    const lineStart = this.#source.lastIndexOf("\n", this.#pos - 1) + 1;
    const indent = /^[ \t]*/.exec(this.#source.slice(lineStart, this.#pos))?.[0]
      .length;
    const id =
      this.#fragments.push({ source: code, comment, indent: indent ?? 0 }) - 1;
    const core = `${this.#nonce}${id}`;
    // Pad to the code's width so Prettier's line fitting stays realistic.
    // Multi-line code must not share a line with other attributes, so it is
    // made wider than the print width.
    const width = comment
      ? 0
      : code.includes("\n")
        ? this.#printWidth + 1
        : code.length;
    const padding = "_".repeat(
      Math.max(0, width - core.length - this.#nonce.length),
    );
    const placeholder = `${core}${padding}${this.#nonce}`;
    if (!comment) {
      this.#placeholders.set(original, placeholder);
    }

    this.#emit(comment ? `<!--${placeholder}-->` : placeholder, end);
    return true;
  }

  /** @param {RegExp} regex */
  #matchAt(regex) {
    regex.lastIndex = this.#pos;
    return regex.exec(this.#source);
  }

  /**
   * Copies a construct Fluid and Prettier both keep as-is.
   *
   * @param {RegExp} regex
   */
  #skip(regex) {
    const match = this.#matchAt(regex);
    if (match) {
      this.#pos += match[0].length;
    }
    return Boolean(match);
  }

  #shorthand() {
    const end = matchShorthand(this.#source, this.#pos);
    const spacing = this.#arraySpacing;
    return (
      end !== -1 &&
      this.#replace(
        end,
        false,
        spacing === "preserve"
          ? undefined
          : (code) => formatArrays(code, spacing),
      )
    );
  }

  /**
   * Prettier's `html` parser has no range ignore, so everything from
   * `prettier-ignore-start` to `prettier-ignore-end` (or the end of the
   * template) is kept as written.
   */
  #ignoreRange() {
    const start = this.#matchAt(TOKEN.ignoreStart);
    if (!start) {
      return false;
    }
    const regex = TOKEN.ignoreEnd;
    regex.lastIndex = this.#pos + start[0].length;
    const end = regex.exec(this.#source)
      ? regex.lastIndex
      : this.#source.length;
    return this.#replace(end, true);
  }

  #fluidComment() {
    const open = this.#matchAt(TOKEN.fluidComment);
    if (!open) {
      return false;
    }
    if (open[1]) {
      return this.#replace(this.#pos + open[0].length, true);
    }
    // Fluid comments nest; find the matching closing tag.
    const regex = TOKEN.fluidCommentTags;
    regex.lastIndex = this.#pos + open[0].length;
    let depth = 1;
    for (let match; depth > 0 && (match = regex.exec(this.#source));) {
      if (!match[2]) {
        depth += match[1] ? -1 : 1;
      }
    }
    const end = depth === 0 ? regex.lastIndex : this.#source.length;
    const ignore = FLUID_IGNORE_COMMENT.test(
      this.#source.slice(this.#pos, end),
    );
    this.#replace(end, true);
    if (ignore) {
      // Prettier only sees the placeholder, so the directive is repeated
      // as a hint that applies to the next node. The line break keeps the
      // hint (removed when restoring) from gluing the next node to the comment.
      this.#emit(`\n${this.#ignoreHint}`, this.#pos);
    }
    return true;
  }

  #tag() {
    const viewHelper = this.#matchAt(TOKEN.viewHelperTag);
    if (viewHelper) {
      const [tag, slash, namespace, name] = viewHelper;
      if (this.#asset(tag, slash, `${namespace}:${name}`)) {
        return true;
      }
      if (!slash && this.#isVerbatimViewHelper(`${namespace}:${name}`)) {
        const element = findViewHelperElement(
          this.#source,
          this.#pos,
          `${namespace}:${name}`,
        );
        if (element) {
          return this.#replace(element.end, true);
        }
      }
      if (!slash && this.#pos >= this.#checkedUntil) {
        const element = findViewHelperElement(
          this.#source,
          this.#pos,
          `${namespace}:${name}`,
        );
        if (element) {
          const body = this.#source.slice(element.bodyStart, element.bodyEnd);
          if (!isBalancedHtml(body)) {
            // A conditional wrapper like `<f:if …><div></f:if>` cannot be
            // formatted as HTML; keep the whole element as written.
            return this.#replace(element.end, true);
          }
          this.#checkedUntil = element.end;
        }
      }
      if (
        !slash &&
        this.#isBlockViewHelper(`${namespace}:${name}`) &&
        !this.#followsDirective()
      ) {
        this.#emit(this.#displayHint, this.#pos);
      }
      // `<f:if` becomes the custom element `<f-qz-if`. With a namespaced name,
      // the HTML parser would put every child into the `f` namespace, where
      // e.g. `<input>` is no void element and `<p>` has no implied end tag.
      if (!slash) {
        this.#findEscapedValues();
      }
      const renamed = `<${slash}${namespace}-${this.#nonce}-${name}`;
      this.#emit(renamed, this.#pos + tag.length);
      return true;
    }

    // Attributes are scanned by the main loop, so return false after this.
    const rawText = this.#matchAt(TOKEN.rawTextOpen);
    const tagEnd = rawText ? findTagEnd(this.#source, this.#pos) : -1;
    if (rawText && tagEnd !== -1) {
      const close = new RegExp(`</${rawText[1]}`, "ig");
      close.lastIndex = tagEnd;
      const end = close.exec(this.#source)?.index ?? this.#source.length;
      this.#rawTextBody = { start: tagEnd, end };
      // Keep script/style bodies with Fluid code exactly as written.
      if (
        containsFluid(this.#source.slice(tagEnd, end)) &&
        !this.#followsDirective()
      ) {
        this.#emit(this.#ignoreHint, this.#pos);
      }
    }
    return false;
  }

  /**
   * Turns `<f:asset.css>`/`<f:asset.script>` with inline content into
   * `<style>`/`<script>`, so Prettier formats the content as CSS/JavaScript.
   *
   * @param {string} tag The matched `<ns:name` or `</ns:name`.
   * @param {string} slash
   * @param {string} name
   */
  #asset(tag, slash, name) {
    const end = this.#pos + tag.length;
    if (slash) {
      const htmlName = this.#assetCloses.get(this.#pos);
      if (!htmlName) {
        return false;
      }
      this.#emit(`</${htmlName}`, end);
      this.#assetTags.set(
        /** @type {Segment} */ (this.#segments.at(-1)).htmlStart,
        `/${name}`,
      );
      return true;
    }
    const htmlName = ASSET_ELEMENTS.get(name);
    const element =
      htmlName && findViewHelperElement(this.#source, this.#pos, name);
    if (!htmlName || !element) {
      return false;
    }
    const body = this.#source.slice(element.bodyStart, element.bodyEnd);
    if (containsFluid(body) || body.includes("<![CDATA[")) {
      // Not valid CSS/JavaScript; keep it exactly as written.
      return this.#replace(element.end, true);
    }
    this.#emit(`<${htmlName}`, end);
    this.#assetTags.set(
      /** @type {Segment} */ (this.#segments.at(-1)).htmlStart,
      name,
    );
    this.#assetCloses.set(element.bodyEnd, htmlName);
    this.#rawTextBody = { start: element.bodyStart, end: element.bodyEnd };
    return true;
  }

  /**
   * Fluid allows backslash-escaped quotes in ViewHelper arguments, also
   * outside of `{…}`: `textWrap="<span class=\"icon\">|</span>"`. An HTML
   * parser would end the value at `\"`, so such values are protected as a
   * whole.
   */
  #findEscapedValues() {
    const tagEnd = findTagEnd(this.#source, this.#pos);
    for (let i = this.#pos; i < tagEnd; i++) {
      const char = this.#source[i];
      if (char !== '"' && char !== "'") {
        continue;
      }
      const end = skipQuoted(this.#source, i);
      if (end === -1) {
        return;
      }
      if (this.#source.slice(i + 1, end - 1).includes(`\\${char}`)) {
        this.#escapedValues.set(i + 1, end - 1);
      }
      i = end - 1;
    }
  }

  /** `<!-- prettier-ignore -->` / `<!-- display: x -->` must stay adjacent to their tag. */
  #followsDirective() {
    const before = this.#source.slice(Math.max(0, this.#pos - 500), this.#pos);
    return DIRECTIVE_COMMENT.test(before);
  }
}

/**
 * @param {string} source Fluid template.
 * @param {PreprocessOptions} [options]
 */
export const preprocess = (source, options = {}) =>
  new Preprocessor(source, options).run();

/**
 * Reverses `preprocess()` on the formatted HTML.
 *
 * @param {string} formatted
 * @param {RestoreState} state
 */
export function restore(formatted, state) {
  const { nonce, hints, fragments } = state;
  const hint = new RegExp(
    `(?:${hints.map(escapeRegExp).join("|")})(?:\\n[ \\t]*)?`,
    "g",
  );
  const placeholder = new RegExp(`(<!--)?${nonce}(\\d+)_*${nonce}(-->)?`, "g");
  const restored = new Set();

  const text = fixAttributeQuotes(
    restoreAssetTags(
      restoreTagNames(formatted.replace(hint, ""), nonce),
      state.rawTextTags,
    ),
    state,
  );
  const result = text.replace(placeholder, (match, open, id, close, offset) => {
    const fragment = fragments[Number(id)];
    if (!fragment.comment) {
      restored.add(Number(id));
      const source = reindent(fragment, lineIndent(text, offset));
      return `${open ?? ""}${source}${close ?? ""}`;
    }
    if (open && close) {
      restored.add(Number(id));
      return fragment.source;
    }
    return match;
  });

  if (restored.size !== fragments.length) {
    const lost = fragments
      .filter((_, id) => !restored.has(id))
      .map(({ source }) => source);
    throw new Error(
      `prettier-plugin-fluid: formatting dropped Fluid code, refusing to continue: ${lost.join(", ")}`,
    );
  }
  return result;
}

/**
 * Leading whitespace of the line containing `offset`.
 *
 * @param {string} text
 * @param {number} offset
 */
function lineIndent(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

/**
 * For each line of a Fluid expression: whether it starts inside a quoted
 * string.
 *
 * @param {string} source
 */
function linesStartingInString(source) {
  const result = [false];
  /** @type {string | undefined} */
  let quote;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      i++;
    } else if (char === "\n") {
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
 * Moves the continuation lines of a multi-line expression by the change in
 * indentation of its first line, keeping their relative layout.
 *
 * @param {Fragment} fragment
 * @param {string} newIndent
 */
function reindent({ source, indent }, newIndent) {
  const delta = newIndent.length - indent;
  if (delta === 0 || !source.includes("\n")) {
    return source;
  }
  const [first, ...rest] = source.split("\n");
  const unit = newIndent.includes("\t") ? "\t" : " ";
  const inString = linesStartingInString(source);
  const moved = rest.map((line, index) => {
    // Whitespace inside a string literal is output; leave those lines alone.
    if (line.trim() === "" || inString[index + 1]) {
      return line;
    }
    if (delta > 0) {
      return unit.repeat(delta) + line;
    }
    const removable = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    return line.slice(Math.min(-delta, removable));
  });
  return [first, ...moved].join("\n");
}

/**
 * Prettier picks the quotes of an attribute value by the quotes it contains,
 * but cannot see quotes inside placeholders. A value like '{"w":"1"}' would be
 * printed as "…" and turn into invalid HTML once restored, so switch such
 * values to the other quote character. Fails if neither quote works.
 *
 * @param {string} text Formatted HTML with placeholders.
 * @param {RestoreState} state
 */
function fixAttributeQuotes(text, { source, nonce, fragments }) {
  const placeholder = new RegExp(`${nonce}(\\d+)_*${nonce}`, "g");
  const quoted = new RegExp(
    `=(["'])([^"'\\n]*?${nonce}\\d+_*${nonce}[^\\n]*?)\\1`,
    "g",
  );
  return text.replace(quoted, (match, quote, value) => {
    const other = quote === '"' ? "'" : '"';
    const full = value.replace(
      placeholder,
      (/** @type {string} */ _, /** @type {string} */ id) =>
        fragments[Number(id)].source,
    );
    // Backslash-escaped quotes are Fluid syntax (`"{a: \\"b\\"}"`) and fine.
    const hasRaw = (/** @type {string} */ text, /** @type {string} */ char) =>
      new RegExp(`(?<!\\\\)${char}`).test(text);
    if (!hasRaw(full, quote)) {
      return match;
    }
    const entity = quote === '"' ? "&quot;" : "&apos;";
    const unescaped = value.replaceAll(entity, quote);
    const unescapedFull = full.replaceAll(entity, quote);
    if (hasRaw(unescapedFull, other)) {
      // No quote character works. Fine if the template already had it so
      // (Fluid accepts it); otherwise refuse to write invalid HTML.
      if (source.includes(`${quote}${unescapedFull}${quote}`)) {
        return match;
      }
      throw new Error(
        `prettier-plugin-fluid: cannot quote the attribute value ${full}: it contains both quote characters. Refusing to write invalid HTML.`,
      );
    }
    return `=${other}${unescaped}${other}`;
  });
}

/**
 * @param {string} text
 * @param {Position} position
 */
function toOffset(text, { line, column }) {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf("\n", offset);
    if (next === -1) {
      break;
    }
    offset = next + 1;
  }
  return offset + column - 1;
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {Position}
 */
function toPosition(text, offset) {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: offset - lineStart + 1 };
}

/**
 * Maps a position in the preprocessed HTML back to the Fluid template, e.g.
 * for parse errors. Positions inside a placeholder map to its start.
 *
 * @param {Position} position
 * @param {{ html: string, source: string, state: RestoreState }} context
 * @returns {Position}
 */
export function toSourcePosition(position, { html, source, state }) {
  const offset = toOffset(html, position);
  let delta = 0;
  for (const segment of state.segments) {
    if (offset < segment.htmlStart) {
      break;
    }
    if (offset < segment.htmlEnd) {
      return toPosition(source, segment.sourceStart);
    }
    delta = segment.sourceEnd - segment.htmlEnd;
  }
  return toPosition(source, offset + delta);
}

/**
 * Turns renamed ViewHelper tags (`f-qz-if`) back into `f:if`.
 *
 * @param {string} text
 * @param {string} nonce
 */
function restoreTagNames(text, nonce) {
  return text.replace(new RegExp(`([a-zA-Z0-9.]+)-${nonce}-`, "g"), "$1:");
}

/**
 * Replaces placeholders and renamed tags in arbitrary text (e.g. error
 * messages) without the completeness check of `restore()`.
 *
 * @param {string} text
 * @param {RestoreState} state
 */
export const revealPlaceholders = (text, { nonce, fragments }) =>
  restoreTagNames(text, nonce).replace(
    new RegExp(`${nonce}(\\d+)_*${nonce}`, "g"),
    (match, id) => fragments[Number(id)]?.source ?? match,
  );

/**
 * Finds a root tag that only declares the Fluid namespaces, i.e. `<fluid …>`
 * or any tag with `data-namespace-typo3-fluid="true"`, wrapping the template.
 * Comments before it (e.g. `<!-- @format -->`) are allowed.
 *
 * @param {string} text
 * @returns {{ prefix: string, name: string, openStart: number, openEnd: number, closeStart: number } | undefined}
 */
export function findRootElement(text) {
  const open = /^((?:\s*<!--[\s\S]*?-->)*)\s*<([a-zA-Z][\w-]*)(?=[\s/>])/.exec(
    text,
  );
  if (!open) {
    return undefined;
  }
  const [match, prefix, name] = open;
  const openStart = match.length - name.length - 1;
  const openEnd = findTagEnd(text, openStart);
  if (openEnd === -1 || text[openEnd - 2] === "/") {
    return undefined;
  }
  const tag = text.slice(openStart, openEnd);
  if (
    name.toLowerCase() !== "fluid" &&
    !/\sdata-namespace-typo3-fluid\s*=\s*["']?true/i.test(tag)
  ) {
    return undefined;
  }
  const close = new RegExp(`</${name}\\s*>\\s*$`, "i").exec(text);
  if (!close || close.index < openEnd) {
    return undefined;
  }
  return {
    prefix: prefix.trim(),
    name,
    openStart,
    openEnd,
    closeStart: close.index,
  };
}

/**
 * Turns the `<style>`/`<script>` tags that were `<f:asset.css>`/
 * `<f:asset.script>` back. Prettier keeps the order of elements, so the tags
 * are identified by their position among all `<style>`/`<script>` tags.
 *
 * @param {string} text
 * @param {RawTextTags} rawTextTags
 */
function restoreAssetTags(text, { count, assets }) {
  if (assets.size === 0) {
    return text;
  }
  let ordinal = 0;
  const result = text.replace(RAW_TEXT_TAG, (match) => {
    const name = assets.get(ordinal++);
    return name ? `<${name}` : match;
  });
  if (ordinal !== count) {
    throw new Error(
      "prettier-plugin-fluid: formatting changed the number of <style>/<script> tags, refusing to continue.",
    );
  }
  return result;
}
