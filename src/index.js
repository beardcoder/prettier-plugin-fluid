// @ts-check
/** @import { Options, Plugin, SupportOption } from "prettier" */
/** @import { Position, RestoreState } from "./preprocess.js" */
import * as prettier from "prettier";
import {
  preprocess,
  restore,
  revealPlaceholders,
  toSourcePosition,
} from "./preprocess.js";

const { hardline, join } = prettier.doc.builders;

/**
 * @typedef {{ type: "root", text: string, formatted: string }} FluidRoot
 * @typedef {Options & {
 *   fluidBlockViewHelpers?: string[],
 *   fluidInlineViewHelpers?: string[],
 * }} FluidOptions
 */

const PRAGMA = /^\s*<!--\s*@(?:format|prettier)\s*-->/;

// Options that must not leak into the nested `html` format call.
const NESTED_EXCLUDED_OPTIONS = new Set([
  "parser",
  "plugins",
  "endOfLine",
  "cursorOffset",
  "rangeStart",
  "rangeEnd",
  "requirePragma",
  "insertPragma",
  "checkIgnorePragma",
]);

/** @type {WeakMap<object, Promise<string[]>>} */
const optionNamesCache = new WeakMap();

/**
 * Names of all options Prettier and the loaded plugins support. Only these are
 * forwarded, so the nested call never warns about internal properties.
 *
 * @param {NonNullable<Options["plugins"]>} plugins
 */
function getForwardedOptionNames(plugins) {
  const cached = optionNamesCache.get(plugins);
  if (cached) {
    return cached;
  }
  const names = prettier
    .getSupportInfo({ plugins })
    .then(({ options }) =>
      options.flatMap(({ name }) =>
        name && !NESTED_EXCLUDED_OPTIONS.has(name) ? [name] : [],
      ),
    );
  optionNamesCache.set(plugins, names);
  return names;
}

/**
 * Re-targets an `html` parse error at the original Fluid template, so the
 * message and code frame point at the right line.
 *
 * @param {unknown} error
 * @param {{ html: string, source: string, state: RestoreState }} context
 */
function toFluidError(error, context) {
  const loc = /** @type {{ loc?: { start: Position, end?: Position } }} */ (
    error
  )?.loc;
  if (!(error instanceof Error) || !loc?.start) {
    return error;
  }
  const start = toSourcePosition(loc.start, context);
  const end = loc.end && toSourcePosition(loc.end, context);
  let message = revealPlaceholders(
    error.message.split("\n", 1)[0].replace(/ \(\d+:\d+\)$/, ""),
    context.state,
  );
  message += ` (${start.line}:${start.column})`;
  // Typical for Fluid: a condition around only an opening or closing tag.
  if (/closing tag|not terminated/i.test(message)) {
    message +=
      "\nFluid templates must be well-nested HTML: wrap conditional markup completely, or exclude it with <!-- prettier-ignore -->.";
  }
  const fluidError = new SyntaxError(message, { cause: error });
  return Object.assign(fluidError, { loc: { start, end } });
}

/** @type {Plugin["languages"]} */
export const languages = [
  {
    name: "Fluid",
    parsers: ["fluid"],
    extensions: [".fluid", ".fluid.html"],
    vscodeLanguageIds: ["fluid", "typo3-fluid"],
  },
];

/** @type {Record<string, SupportOption>} */
export const options = {
  fluidBlockViewHelpers: {
    category: "Fluid",
    type: "string",
    array: true,
    default: [{ value: [] }],
    description:
      "Additional ViewHelpers (e.g. custom ones) formatted as block elements. Supports * wildcards: my:*, v:variable.*",
  },
  fluidInlineViewHelpers: {
    category: "Fluid",
    type: "string",
    array: true,
    default: [{ value: [] }],
    description:
      "ViewHelpers formatted inline even if they are block elements by default.",
  },
};

/** @type {Plugin<FluidRoot>["parsers"]} */
export const parsers = {
  fluid: {
    astFormat: "fluid",
    /**
     * Formatting happens here rather than in `embed`: Prettier swallows embed
     * errors (and skips embeds with `embeddedLanguageFormatting: "off"`),
     * while parse errors are reported with a code frame.
     *
     * @param {string} text
     * @param {FluidOptions} options
     */
    async parse(text, options) {
      const { html, state } = preprocess(text, {
        blockViewHelpers: options.fluidBlockViewHelpers,
        inlineViewHelpers: options.fluidInlineViewHelpers,
      });
      const plugins = options.plugins ?? [];
      const forwarded = Object.fromEntries(
        (await getForwardedOptionNames(plugins))
          .filter((name) => name in options)
          .map((name) => [
            name,
            /** @type {Record<string, unknown>} */ (options)[name],
          ]),
      );

      let formatted;
      try {
        // Uses the `html` parser as resolved by Prettier, so plugins wrapping
        // it (organize-attributes, tailwindcss, ...) take part as usual.
        formatted = await prettier.format(html, {
          ...forwarded,
          plugins,
          parser: "html",
          endOfLine: "lf",
        });
      } catch (error) {
        throw toFluidError(error, { html, source: text, state });
      }
      return { type: "root", text, formatted: restore(formatted, state) };
    },
    hasPragma: (text) => PRAGMA.test(text),
    locStart: () => 0,
    locEnd: (node) => node.text.length,
  },
};

/** @type {Plugin<FluidRoot>["printers"]} */
export const printers = {
  fluid: {
    print({ node }) {
      const lines = node.formatted.trimEnd().split("\n");
      return lines.length === 1 && lines[0] === ""
        ? ""
        : [join(hardline, lines), hardline];
    },
    insertPragma: (text) => `<!-- @format -->\n\n${text}`,
  },
};

/** @type {Plugin<FluidRoot>} */
export default { languages, options, parsers, printers };
