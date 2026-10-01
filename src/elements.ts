/**
 * Element categories the preprocessor and restoring decide by: void and raw
 * text HTML elements, asset ViewHelpers with CSS/JavaScript content, and the
 * ViewHelpers formatted as blocks or kept verbatim by default.
 *
 * Only the void elements come from `@prettier/html-tags`, the tag data
 * Prettier itself uses. The other categories are rules of this plugin that no
 * HTML tag list provides; a known HTML tag is not a block element or void
 * because of that. Names not in a category (custom elements, SVG/MathML,
 * dynamic names like `h{level}`, other ViewHelpers) are ordinary elements.
 */
import { createRequire } from 'node:module';

import { escapeRegExp } from './lexer.js';

type HtmlTags = typeof import('@prettier/html-tags');
type HtmlTagName = HtmlTags['htmlTags'][number];
type HtmlVoidTagName = HtmlTags['htmlVoidTags'][number];

// The package's ESM entry imports its JSON data with import attributes, which
// Node.js 20 before 20.10 cannot parse and Node.js 22.0 reports as
// experimental. Its `require` export is the same data as plain JSON, typed by
// the package's own declarations.
const { htmlVoidTags } = createRequire(import.meta.url)('@prettier/html-tags') as HtmlTags;

/**
 * Historical void elements the package lists, but which this plugin never
 * treated as void: Prettier's HTML parser only knows `param` as void, and SVG
 * has an `<image>` element with content. Treating them as void would change
 * which ViewHelper bodies count as well-nested and are formatted at all.
 */
const LEGACY_NON_VOID_ELEMENTS: ReadonlySet<string> = new Set<HtmlVoidTagName>([
  'basefont',
  'bgsound',
  'command',
  'frame',
  'image',
  'keygen',
  'param',
]);

const VOID_ELEMENTS: ReadonlySet<string> = new Set(htmlVoidTags.filter((name) => !LEGACY_NON_VOID_ELEMENTS.has(name)));

/** Elements whose content is text for the HTML parser, not markup. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set<HtmlTagName>(['script', 'style', 'textarea']);

/** Asset ViewHelpers whose inline content is CSS or JavaScript. */
const ASSET_ELEMENTS: ReadonlyMap<string, HtmlTagName> = new Map([
  ['f:asset.css', 'style'],
  ['f:asset.script', 'script'],
]);

/**
 * ViewHelpers whose content is kept as written. `f:spaceless` often builds
 * strings (e.g. class lists) where added line breaks would change the output;
 * `f:variable` takes its content, whitespace included, as the value.
 */
const DEFAULT_VERBATIM_VIEWHELPERS: readonly string[] = Object.freeze(['f:spaceless', 'f:variable']);

/**
 * Tags from typo3/fluid and TYPO3 core that structure a template. `formvh` is
 * the namespace EXT:form's own templates use for its ViewHelpers.
 */
const DEFAULT_BLOCK_VIEWHELPERS: readonly string[] = Object.freeze([
  'f:alias',
  'f:argument',
  'f:asset.css',
  'f:asset.script',
  'f:cache.*',
  'f:case',
  'f:comment',
  'f:defaultCase',
  'f:else',
  'f:for',
  'f:form',
  'f:fragment',
  'f:groupedFor',
  'f:if',
  'f:layout',
  'f:render',
  'f:section',
  'f:slot',
  'f:spaceless',
  'f:switch',
  'f:then',
  'f:variable',
  'formvh:form',
  'formvh:renderAllFormValues',
  'formvh:renderFormValue',
  'formvh:renderRenderable',
]);

/** @param name Lowercase HTML tag name. */
export function isVoidElement(name: string): boolean {
  return VOID_ELEMENTS.has(name);
}

/**
 * The HTML element (`style`/`script`) an asset ViewHelper such as
 * `f:asset.css` is formatted as, or undefined.
 */
export function assetElementFor(viewHelper: string): string | undefined {
  return ASSET_ELEMENTS.get(viewHelper);
}

/**
 * Whether the content of the element is no markup: raw text elements, asset
 * ViewHelpers and `<f:comment>`.
 *
 * @param name Lowercase for HTML tags, as written for ViewHelpers.
 */
export function hasTextContent(name: string): boolean {
  return RAW_TEXT_ELEMENTS.has(name) || ASSET_ELEMENTS.has(name) || name === 'f:comment';
}

/**
 * Opening and closing `<style>`/`<script>` tags, which asset ViewHelpers are
 * temporarily turned into. A new regex per call, as it is global.
 */
export function assetElementTags(): RegExp {
  return /<(\/?)(?:style|script)(?=[\s/>])/gi;
}

/**
 * @param patterns ViewHelper names; `*` matches any part of a name.
 * @returns Case-insensitive matcher.
 */
function createNameMatcher(patterns: readonly string[]): (name: string) => boolean {
  if (patterns.length === 0) return () => false;
  const alternatives = patterns.map((pattern) => pattern.split('*').map(escapeRegExp).join('[a-zA-Z0-9.]*'));
  const regex = new RegExp(`^(?:${alternatives.join('|')})$`, 'i');

  return (name) => regex.test(name);
}

export interface ViewHelperOptions {
  /** Additional ViewHelpers formatted as blocks. */
  block?: readonly string[] | undefined;
  /** ViewHelpers formatted inline even though they are block by default. Wins over `block`. */
  inline?: readonly string[] | undefined;
  /** Additional ViewHelpers whose element is kept exactly as written. */
  verbatim?: readonly string[] | undefined;
}

export interface ViewHelperRules {
  isBlock: (name: string) => boolean;
  isVerbatim: (name: string) => boolean;
}

/**
 * The block and verbatim ViewHelpers of one formatting call: the defaults
 * plus the given names. The defaults themselves never change.
 */
export function createViewHelperRules({ block = [], inline = [], verbatim = [] }: ViewHelperOptions): ViewHelperRules {
  const isVerbatim = createNameMatcher([...DEFAULT_VERBATIM_VIEWHELPERS, ...verbatim]);
  const isBlock = createNameMatcher([...DEFAULT_BLOCK_VIEWHELPERS, ...block]);
  const isInline = createNameMatcher(inline);

  return {
    isBlock: (name: string) => isBlock(name) && !isInline(name),
    isVerbatim,
  };
}
