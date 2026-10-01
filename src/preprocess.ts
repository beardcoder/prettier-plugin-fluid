/**
 * Turns a Fluid template into plain HTML that Prettier's own `html` parser
 * (and every plugin wrapping it) can format safely; `restore()` turns it back:
 *
 * - Fluid shorthand syntax (`{item.title -> f:format.crop(maxCharacters: 20)}`),
 *   including arbitrarily nested inline syntax, is swapped for opaque
 *   placeholders of the same width, so it is never re-wrapped or re-quoted.
 * - `<f:comment>` elements become HTML comments, so their (possibly broken)
 *   content is kept verbatim.
 * - Structural ViewHelpers (`<f:if>`, `<f:for>`, ...) get a
 *   `<!-- display: block -->` hint; Prettier would treat unknown namespaced
 *   tags as inline elements otherwise.
 *
 * The syntax is recognized by `lexer.ts`; this module decides what to protect
 * and produces the placeholders and the intermediate HTML.
 */
import { type ArrayFormat, type ArraySpacing, formatArrays, toArrayFormat } from './arrays.js';
import { assetElementFor, assetElementTags, createViewHelperRules, hasTextContent, isVoidElement } from './elements.js';
import {
  containsFluid,
  escapeRegExp,
  findEscapedValues,
  findTagEnd,
  findViewHelperElement,
  followsDirective,
  followsIgnoreDirective,
  lineIndent,
  matchShorthand,
  scanDeclaration,
  scanTag,
  scanToken,
  type Token,
} from './lexer.js';
import type { Fragment, RestoreState, Segment, SourceRange } from './types.js';

export interface PreprocessOptions {
  /**
   * Additional (e.g. custom) ViewHelpers formatted as blocks. `*` matches any
   * part of a name, e.g. `my:*` or `v:variable.*`.
   */
  blockViewHelpers?: readonly string[] | undefined;
  /**
   * ViewHelpers formatted inline even though they are block by default. Wins
   * over `blockViewHelpers`.
   */
  inlineViewHelpers?: readonly string[] | undefined;
  /** Additional ViewHelpers whose element is kept exactly as written, like `<f:comment>`. */
  verbatimViewHelpers?: readonly string[] | undefined;
  /**
   * Multi-line expressions get placeholders wider than this, so a tag
   * containing one always breaks its attributes.
   */
  printWidth?: number | undefined;
  /** Spaces inside the braces of single-line Fluid arrays (`{ a: 1, b: 2 }` or `{a: 1, b: 2}`). */
  arraySpacing?: ArraySpacing | undefined;
  /** Also format arrays in quoted strings of ViewHelper arguments (`'{a: 1}'`). */
  arraySpacingInStrings?: boolean | undefined;
}

type ViewHelperTag = Extract<Token, { kind: 'viewHelperTag' }>;

/**
 * Picks a letters-only marker that does not occur in the template, so
 * placeholders can never collide with template content.
 */
function createNonce(source: string): string {
  for (let n = 0; ; n++) {
    let suffix = '';
    for (let rest = n; rest > 0; rest = Math.floor(rest / 26)) {
      suffix += String.fromCharCode(97 + (rest % 26));
    }
    const nonce = `qz${suffix}`;
    if (!source.includes(nonce)) return nonce;
  }
}

/**
 * Creates a Prettier directive comment such as `display: block`. Tabs make it
 * distinguishable from user-written comments, while Prettier still recognizes
 * it (directives are matched after trimming whitespace).
 */
function createHint(source: string, directive: string): string {
  let tabs = '\t';
  while (source.includes(`<!--${tabs}${directive}${tabs}-->`)) {
    tabs += '\t';
  }

  return `<!--${tabs}${directive}${tabs}-->`;
}

/**
 * Whether `text` is a well-nested sequence of HTML/ViewHelper elements, e.g.
 * not just the opening `<div>` of a conditional wrapper. Deliberately strict:
 * implied end tags (`<li>a<li>b`) also count as unbalanced.
 */
function isBalancedHtml(text: string): boolean {
  const stack: string[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '{') {
      const end = matchShorthand(text, i);
      i = end === -1 ? i + 1 : end;
      continue;
    }
    if (char !== '<') {
      i++;
      continue;
    }
    // Comments and CDATA sections are skipped; other declarations are text.
    const declaration = scanDeclaration(text, i);
    if (declaration && declaration.kind !== 'declaration') {
      if (!declaration.terminated) return false;
      i = declaration.end;
      continue;
    }
    const tag = scanTag(text, i);
    if (!tag) {
      i++;
      continue;
    }
    if (tag.kind === 'unterminatedTag') return false;
    const name = tag.name.includes(':') ? tag.name : tag.name.toLowerCase();
    i = tag.end;
    if (tag.closing) {
      if (stack.pop() !== name) return false;
    } else if (!tag.selfClosing && !isVoidElement(name)) {
      if (hasTextContent(name)) {
        // Skip content that is no markup.
        const close = text.indexOf(`</${tag.name}`, i);
        if (close === -1) return false;
        i = close;
      }
      stack.push(name);
    }
  }

  return stack.length === 0;
}

/** The state of one `preprocess()` call. */
interface Context {
  source: string;
  isBlockViewHelper: (name: string) => boolean;
  isVerbatimViewHelper: (name: string) => boolean;
  printWidth: number;
  arrayFormat: ArrayFormat | undefined;
  nonce: string;
  displayHint: string;
  ignoreHint: string;
  /** Hints for directives written in `<f:comment>`, by directive. */
  directiveHints: Map<string, string>;
  /** Placeholders by code, so equal code (e.g. `<h{n}>…</h{n}>`) stays equal. */
  placeholders: Map<string, { placeholder: string; fragment: Fragment }>;
  /** Replacement for `ns:` in tag names, by namespace. */
  tagPrefixes: Map<string, string>;
  fragments: Fragment[];
  output: string[];
  outputLength: number;
  segments: Segment[];
  pos: number;
  /** Start of the source range not yet copied to `output`. */
  pending: number;
  rawTextBody: SourceRange | undefined;
  /** End of a ViewHelper element whose content is known to be well-nested. */
  checkedUntil: number;
  /** Closing asset tags to rename, by source position. */
  assetCloses: Map<number, string>;
  /** HTML offsets of renamed asset tags and their original names. */
  assetTags: Map<number, string>;
  /** ViewHelper argument values with escaped quotes: start → end. */
  escapedValues: Map<number, number>;
  /** End of the current ViewHelper tag, whose attributes are arguments. */
  argumentsEnd: number;
}

/** @param source Fluid template. */
export function preprocess(source: string, options: PreprocessOptions = {}): { html: string; state: RestoreState } {
  const context = createContext(source, options);
  while (context.pos < source.length) {
    const escapedValueEnd = context.escapedValues.get(context.pos);
    if (escapedValueEnd !== undefined) {
      context.escapedValues.delete(context.pos);
      replace(context, escapedValueEnd, false);
      continue;
    }
    if (context.pos === context.rawTextBody?.start) {
      // Script/style bodies go untouched to Prettier's embedded formatters.
      context.pos = context.rawTextBody.end;
      context.rawTextBody = undefined;
      continue;
    }
    const token = scanToken(source, context.pos);
    if (!token || !handle(context, token)) context.pos++;
  }
  flush(context, source.length);

  const state: RestoreState = {
    source,
    nonce: context.nonce,
    namespaces: [...context.tagPrefixes]
      .filter(([namespace, prefix]) => prefix === `${namespace}-`)
      .map(([namespace]) => namespace),
    hints: [context.displayHint, context.ignoreHint, ...context.directiveHints.values()],
    fragments: context.fragments,
    segments: context.segments,
    rawTextTags: { count: 0, assets: new Map() },
  };
  const html = context.output.join('');
  for (const match of html.matchAll(assetElementTags())) {
    const name = context.assetTags.get(match.index);
    if (name) state.rawTextTags.assets.set(state.rawTextTags.count, name);
    state.rawTextTags.count++;
  }

  return { html, state };
}

function createContext(
  source: string,
  {
    blockViewHelpers,
    inlineViewHelpers,
    verbatimViewHelpers,
    printWidth = 80,
    arraySpacing = 'preserve',
    arraySpacingInStrings = false,
  }: PreprocessOptions,
): Context {
  const viewHelpers = createViewHelperRules({
    block: blockViewHelpers,
    inline: inlineViewHelpers,
    verbatim: verbatimViewHelpers,
  });

  return {
    source,
    isBlockViewHelper: viewHelpers.isBlock,
    isVerbatimViewHelper: viewHelpers.isVerbatim,
    printWidth,
    arrayFormat: toArrayFormat(arraySpacing, arraySpacingInStrings),
    nonce: createNonce(source),
    displayHint: createHint(source, 'display: block'),
    ignoreHint: createHint(source, 'prettier-ignore'),
    directiveHints: new Map(),
    placeholders: new Map(),
    tagPrefixes: new Map(),
    fragments: [],
    output: [],
    outputLength: 0,
    segments: [],
    pos: 0,
    pending: 0,
    rawTextBody: undefined,
    checkedUntil: 0,
    assetCloses: new Map(),
    assetTags: new Map(),
    escapedValues: new Map(),
    argumentsEnd: -1,
  };
}

/**
 * Protects or rewrites the construct at the current position.
 *
 * @returns Whether the position moved past it; otherwise the scan goes on
 *   with the next character, e.g. with the attributes of a tag.
 */
function handle(context: Context, token: Token): boolean {
  switch (token.kind) {
    case 'shorthand': {
      const format = context.arrayFormat;
      const inArguments = context.pos < context.argumentsEnd;

      return replace(context, token.end, false, format && ((code) => formatArrays(code, format, inArguments)));
    }
    case 'ignoreRange':
      return replace(context, token.end, true);
    case 'comment':
    case 'cdata':
      // Fluid and Prettier both keep it as-is.
      context.pos = token.end;

      return true;
    case 'fluidComment':
      replace(context, token.end, true);
      if (token.directive) {
        // Prettier only sees the placeholder, so the directive is repeated
        // as a hint that applies to the next node. The line break keeps the
        // hint (removed when restoring) from gluing the next node to the comment.
        emit(context, `\n${directiveHint(context, token.directive)}`, context.pos);
      }

      return true;
    case 'viewHelperTag':
      return viewHelperTag(context, token);
    case 'rawTextElement':
      rawTextElement(context, token.body);

      // Attributes are scanned by the main loop.
      return false;
  }
}

function flush(context: Context, until: number): void {
  const text = context.source.slice(context.pending, until);
  context.output.push(text);
  context.outputLength += text.length;
  context.pending = until;
}

/**
 * Emits `text` in place of the source range from the current position to `end`.
 *
 * @returns Where `text` starts in the HTML.
 */
function emit(context: Context, text: string, end: number): number {
  flush(context, context.pos);
  const htmlStart = context.outputLength;
  context.segments.push({
    htmlStart,
    htmlEnd: context.outputLength + text.length,
    sourceStart: context.pos,
    sourceEnd: end,
  });
  context.output.push(text);
  context.outputLength += text.length;
  context.pos = context.pending = end;

  return htmlStart;
}

/**
 * @param transform Formats the code; the placeholder gets the width of the
 *   result.
 */
function replace(context: Context, end: number, comment: boolean, transform?: (code: string) => string): true {
  const original = context.source.slice(context.pos, end);
  const code = transform ? transform(original) : original;
  const existing = comment ? undefined : context.placeholders.get(code);
  if (existing) {
    existing.fragment.count++;
    emit(context, existing.placeholder, end);

    return true;
  }
  const fragment: Fragment = {
    source: code,
    comment,
    indent: lineIndent(context.source, context.pos).length,
    count: 1,
  };
  const id = context.fragments.push(fragment) - 1;
  const core = `${context.nonce}${id}`;
  // Pad to the code's width so Prettier's line fitting stays realistic.
  // Multi-line code must not share a line with other attributes, so it is
  // made wider than the print width.
  const width = comment ? 0 : code.includes('\n') ? context.printWidth + 1 : code.length;
  const padding = '_'.repeat(Math.max(0, width - core.length - context.nonce.length));
  const placeholder = `${core}${padding}${context.nonce}`;
  if (!comment) context.placeholders.set(code, { placeholder, fragment });

  emit(context, comment ? `<!--${placeholder}-->` : placeholder, end);

  return true;
}

function directiveHint(context: Context, directive: string): string {
  let hint = context.directiveHints.get(directive);
  if (!hint) {
    hint = createHint(context.source, directive);
    context.directiveHints.set(directive, hint);
  }

  return hint;
}

function viewHelperTag(context: Context, tag: ViewHelperTag): boolean {
  const name = `${tag.namespace}:${tag.name}`;
  if (asset(context, tag, name)) return true;
  if (!tag.closing && context.isVerbatimViewHelper(name)) {
    const element = findViewHelperElement(context.source, context.pos, name);
    if (element) return replace(context, element.end, true);
  }
  if (!tag.closing && context.pos >= context.checkedUntil) {
    const element = findViewHelperElement(context.source, context.pos, name);
    if (element) {
      const body = context.source.slice(element.body.start, element.body.end);
      // A conditional wrapper like `<f:if …><div></f:if>` cannot be
      // formatted as HTML; keep the whole element as written.
      if (!isBalancedHtml(body)) return replace(context, element.end, true);
      context.checkedUntil = element.end;
    }
  }
  if (!tag.closing && context.isBlockViewHelper(name) && !followsDirective(context.source, context.pos)) {
    emit(context, context.displayHint, context.pos);
  }
  // `<f:if` becomes the custom element `<f-if`. With a namespaced name,
  // the HTML parser would put every child into the `f` namespace, where
  // e.g. `<input>` is no void element and `<p>` has no implied end tag.
  if (!tag.closing) startArguments(context);
  const slash = tag.closing ? '/' : '';
  const renamed = `<${slash}${tagPrefix(context, tag.namespace)}${tag.name}`;
  emit(context, renamed, context.pos + tag.end - tag.start);

  return true;
}

function rawTextElement(context: Context, body: SourceRange): void {
  context.rawTextBody = body;
  // Keep script/style bodies with Fluid code exactly as written. Prettier
  // only looks at the previous comment, so this hint takes the place of
  // `display: …` and `prettier-ignore-attribute`, which keep applying to
  // the hint and change nothing a full ignore does not keep anyway.
  if (
    containsFluid(context.source.slice(body.start, body.end)) &&
    !followsIgnoreDirective(context.source, context.pos)
  ) {
    emit(context, context.ignoreHint, context.pos);
  }
}

/**
 * Turns `<f:asset.css>`/`<f:asset.script>` with inline content into
 * `<style>`/`<script>`, so Prettier formats the content as CSS/JavaScript.
 */
function asset(context: Context, tag: ViewHelperTag, name: string): boolean {
  const end = context.pos + tag.end - tag.start;
  if (tag.closing) {
    const htmlName = context.assetCloses.get(context.pos);
    if (!htmlName) return false;
    context.assetTags.set(emit(context, `</${htmlName}`, end), `/${name}`);

    return true;
  }
  const htmlName = assetElementFor(name);
  const element = htmlName && findViewHelperElement(context.source, context.pos, name);
  if (!htmlName || !element) return false;
  const body = context.source.slice(element.body.start, element.body.end);
  // Not valid CSS/JavaScript; keep it exactly as written.
  if (containsFluid(body) || body.includes('<![CDATA[')) return replace(context, element.end, true);
  startArguments(context);
  context.assetTags.set(emit(context, `<${htmlName}`, end), name);
  context.assetCloses.set(element.body.end, htmlName);
  context.rawTextBody = element.body;

  return true;
}

/**
 * The attributes of the ViewHelper tag at the current position are
 * arguments. Values with backslash-escaped quotes are protected as a whole.
 */
function startArguments(context: Context): void {
  context.argumentsEnd = findTagEnd(context.source, context.pos);
  const values = findEscapedValues(context.source, context.pos, context.argumentsEnd);
  for (const { start, end } of values) {
    context.escapedValues.set(start, end);
  }
}

/**
 * `f-` keeps the width of `f:`, so Prettier breaks lines where it would with
 * the original tag. Templates that already contain `<f-…>` tags get
 * `f-<nonce>-` instead, so the renamed tags stay distinguishable.
 */
function tagPrefix(context: Context, namespace: string): string {
  let prefix = context.tagPrefixes.get(namespace);
  if (!prefix) {
    const taken = new RegExp(`</?${escapeRegExp(namespace)}-`, 'i');
    prefix = taken.test(context.source) ? `${namespace}-${context.nonce}-` : `${namespace}-`;
    context.tagPrefixes.set(namespace, prefix);
  }

  return prefix;
}
