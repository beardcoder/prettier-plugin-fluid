/**
 * Formats a Fluid template: preprocesses it, formats the HTML with Prettier's
 * `html` parser and the other loaded plugins, and restores the Fluid code.
 * Parse errors are mapped back to positions in the template.
 */
import { format, getSupportInfo, type Options } from 'prettier';

import { findRootElement, type RootElement } from './lexer.js';
import type { FluidOptions } from './options.js';
import { type PositionContext, toSourcePosition } from './positions.js';
import { preprocess } from './preprocess.js';
import { restore, revealPlaceholders } from './restore.js';
import type { Origin, Position, RestoreState } from './types.js';

type FormatOptions = Options & FluidOptions;

// Options that must not leak into the nested `html` format call.
const NESTED_EXCLUDED_OPTIONS = new Set([
  'parser',
  'plugins',
  'endOfLine',
  'cursorOffset',
  'rangeStart',
  'rangeEnd',
  'requirePragma',
  'insertPragma',
  'checkIgnorePragma',
]);

const optionNamesCache = new WeakMap<object, Promise<string[]>>();

/**
 * Names of all options Prettier and the loaded plugins support. Only these are
 * forwarded, so the nested call never warns about internal properties.
 */
function getForwardedOptionNames(plugins: NonNullable<Options['plugins']>): Promise<string[]> {
  const cached = optionNamesCache.get(plugins);
  if (cached) return cached;
  const names = getSupportInfo({ plugins }).then(({ options }) =>
    options.flatMap(({ name }) => (name && !NESTED_EXCLUDED_OPTIONS.has(name) ? [name] : [])),
  );
  optionNamesCache.set(plugins, names);

  return names;
}

function isPosition(value: unknown): value is Position {
  return (
    typeof value === 'object' &&
    value !== null &&
    'line' in value &&
    typeof value.line === 'number' &&
    'column' in value &&
    typeof value.column === 'number'
  );
}

/** The location Prettier's parsers attach to syntax errors, if any. */
function getLocation(error: Error): { start: Position; end: Position | undefined } | undefined {
  const loc: unknown = 'loc' in error ? error.loc : undefined;
  if (typeof loc !== 'object' || loc === null || !('start' in loc) || !isPosition(loc.start)) return undefined;
  const end = 'end' in loc && isPosition(loc.end) ? loc.end : undefined;

  return { start: loc.start, end };
}

/**
 * Re-targets an `html` parse error at the original Fluid template, so the
 * message and code frame point at the right line.
 */
function toFluidError(error: unknown, context: PositionContext & { state: RestoreState }): unknown {
  const loc = error instanceof Error ? getLocation(error) : undefined;
  if (!(error instanceof Error) || !loc) return error;
  const start = toSourcePosition(loc.start, context);
  const end = loc.end && toSourcePosition(loc.end, context);
  let message = revealPlaceholders(error.message.split('\n', 1)[0].replace(/ \(\d+:\d+\)$/, ''), context.state);
  message += ` (${start.line}:${start.column})`;
  // Typical for Fluid: a condition around only an opening or closing tag.
  if (/closing tag|not terminated/i.test(message)) {
    message +=
      '\nFluid templates must be well-nested HTML: wrap conditional markup completely, or exclude it with <!-- prettier-ignore -->.';
  }
  const fluidError = new SyntaxError(message, { cause: error });

  return Object.assign(fluidError, { loc: { start, end } });
}

/**
 * Formats a template and returns the result with Fluid code restored.
 *
 * @param origin Where `text` is taken from, for error positions.
 */
async function formatTemplate(text: string, options: FormatOptions, origin?: Origin): Promise<string> {
  const { html, state } = preprocess(text, {
    blockViewHelpers: options.fluidBlockViewHelpers,
    inlineViewHelpers: options.fluidInlineViewHelpers,
    verbatimViewHelpers: options.fluidVerbatimViewHelpers,
    printWidth: options.printWidth,
    arraySpacing: options.fluidArraySpacing,
    arraySpacingInStrings: options.fluidArraySpacingInStrings,
  });
  const plugins = options.plugins ?? [];
  const forwarded = Object.fromEntries(
    (await getForwardedOptionNames(plugins)).filter((name) => name in options).map((name) => [name, options[name]]),
  );

  let formatted;
  try {
    // Uses the `html` parser as resolved by Prettier, so plugins wrapping it
    // (organize-attributes, tailwindcss, ...) take part as usual.
    formatted = await format(html, {
      ...forwarded,
      plugins,
      parser: 'html',
      endOfLine: 'lf',
    });
  } catch (error) {
    throw toFluidError(error, {
      html,
      source: text,
      segments: state.segments,
      state,
      origin,
    });
  }

  return restore(formatted, state, {
    tabWidth: options.tabWidth ?? 2,
    useTabs: options.useTabs ?? false,
    bracketSameLine: options.bracketSameLine ?? false,
  });
}

/**
 * With `fluidIndentRoot: false`: formats the root tag and its content
 * separately, so the content is not indented, with an empty line after the
 * opening and before the closing tag.
 */
async function formatWithFlatRoot(text: string, root: RootElement, options: FormatOptions): Promise<string> {
  const closeTag = `</${root.name}>`;
  const openTag = text.slice(root.openStart, root.openEnd);
  const tagOptions = options.fluidRootAttributePerLine ? { ...options, printWidth: 1 } : options;
  const opening = (
    await formatTemplate(`${openTag}${closeTag}`, tagOptions, {
      text,
      offset: root.openStart,
    })
  )
    .trim()
    .slice(0, -closeTag.length)
    .trimEnd();

  const content = text.slice(root.openEnd, root.closeStart);
  const children = (await formatTemplate(content, options, { text, offset: root.openEnd })).trim();

  const body = children ? `${opening}\n\n${children}\n\n${closeTag}\n` : `${opening}\n${closeTag}\n`;

  return root.prefix ? `${root.prefix}\n${body}` : body;
}

/** Formats a whole Fluid template with the options of the Prettier call. */
export async function formatFluid(text: string, options: FormatOptions): Promise<string> {
  const root = options.fluidIndentRoot === false ? findRootElement(text) : undefined;

  return root ? formatWithFlatRoot(text, root, options) : formatTemplate(text, options);
}
