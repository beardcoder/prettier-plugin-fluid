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
 *
 * @typedef {object} Fragment
 * @property {string} source Original template code.
 * @property {boolean} comment Whether the placeholder is wrapped in `<!-- -->`.
 *
 * @typedef {object} Segment Code the preprocessor replaced or inserted.
 * @property {number} htmlStart
 * @property {number} htmlEnd
 * @property {number} sourceStart
 * @property {number} sourceEnd
 *
 * @typedef {object} RestoreState
 * @property {string} nonce
 * @property {string[]} hints Comments inserted to steer Prettier.
 * @property {Fragment[]} fragments
 * @property {Segment[]} segments Sorted by position.
 *
 * @typedef {{ line: number, column: number }} Position 1-based line and column.
 */

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

const TOKEN = {
  htmlComment: /<!--[\s\S]*?(?:-->|$)/y,
  cdata: /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/y,
  fluidComment: /<f:comment\s*(\/?)>/y,
  fluidCommentTags: /<(\/?)f:comment\s*(\/?)>/g,
  viewHelperTag: /<(\/?)([a-zA-Z0-9.]+):([a-zA-Z0-9.]+)/y,
  rawTextOpen: /<(script|style)\b/iy,
};

const DIRECTIVE_COMMENT = /<!--\s*(?:prettier-ignore|display:)[\s\S]*?-->\s*$/;

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
      if (RAW_TEXT_ELEMENTS.has(name) || name === "f:comment") {
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

  /**
   * @param {string} source
   * @param {PreprocessOptions} options
   */
  constructor(source, { blockViewHelpers = [], inlineViewHelpers = [] } = {}) {
    this.#source = source;
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
          (this.#skip(TOKEN.htmlComment) ||
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
      nonce: this.#nonce,
      hints: [this.#displayHint, this.#ignoreHint],
      fragments: this.#fragments,
      segments: this.#segments,
    };
    return { html: this.#output.join(""), state };
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
   */
  #replace(end, comment) {
    const code = this.#source.slice(this.#pos, end);
    const existing = comment ? undefined : this.#placeholders.get(code);
    if (existing) {
      this.#emit(existing, end);
      return true;
    }
    const id = this.#fragments.push({ source: code, comment }) - 1;
    const core = `${this.#nonce}${id}`;
    // Pad to the code's width so Prettier's line fitting stays realistic.
    const width = comment
      ? 0
      : Math.max(...code.split("\n").map((line) => line.length));
    const padding = "_".repeat(
      Math.max(0, width - core.length - this.#nonce.length),
    );
    const placeholder = `${core}${padding}${this.#nonce}`;
    if (!comment) {
      this.#placeholders.set(code, placeholder);
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
    return end !== -1 && this.#replace(end, false);
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
    return this.#replace(
      depth === 0 ? regex.lastIndex : this.#source.length,
      true,
    );
  }

  #tag() {
    const viewHelper = this.#matchAt(TOKEN.viewHelperTag);
    if (viewHelper) {
      const [tag, slash, namespace, name] = viewHelper;
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
export function restore(formatted, { nonce, hints, fragments }) {
  const hint = new RegExp(
    `(?:${hints.map(escapeRegExp).join("|")})(?:\\n[ \\t]*)?`,
    "g",
  );
  const placeholder = new RegExp(`(<!--)?${nonce}(\\d+)_*${nonce}(-->)?`, "g");
  const restored = new Set();

  const result = restoreTagNames(formatted.replace(hint, ""), nonce).replace(
    placeholder,
    (match, open, id, close) => {
      const fragment = fragments[Number(id)];
      if (!fragment.comment) {
        restored.add(Number(id));
        return `${open ?? ""}${fragment.source}${close ?? ""}`;
      }
      if (open && close) {
        restored.add(Number(id));
        return fragment.source;
      }
      return match;
    },
  );

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
