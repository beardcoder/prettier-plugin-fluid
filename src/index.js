// @ts-check
/** @import { Options, Plugin, SupportOption } from "prettier" */
/** @import { Origin, Position } from "./preprocess.js" */
import * as prettier from "prettier";
import {
  findRootElement,
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
 *   fluidVerbatimViewHelpers?: string[],
 *   fluidIndentRoot?: boolean,
 *   fluidRootAttributePerLine?: boolean,
 *   fluidFinalNewline?: boolean,
 *   fluidArraySpacing?: import("./preprocess.js").ArraySpacing,
 *   fluidArraySpacingInStrings?: boolean,
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
 * @param {Parameters<typeof toSourcePosition>[1]} context
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
    // "html-fluid" is the language of HTML templates in the Fluid extension
    // for VS Code; its "fluid" language is plain-text Fluid (e.g. emails).
    vscodeLanguageIds: ["html-fluid"],
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
  fluidVerbatimViewHelpers: {
    category: "Fluid",
    type: "string",
    array: true,
    default: [{ value: [] }],
    description:
      "Additional ViewHelpers whose element is kept exactly as written, like f:comment. f:spaceless and f:variable always are. Supports * wildcards.",
  },
  fluidIndentRoot: {
    category: "Fluid",
    type: "boolean",
    default: true,
    description:
      'Indent the content of the root tag that declares the Fluid namespaces (<fluid> or a tag with data-namespace-typo3-fluid="true").',
  },
  fluidRootAttributePerLine: {
    category: "Fluid",
    type: "boolean",
    default: false,
    description:
      "Put every attribute of the root tag on its own line. Only with fluidIndentRoot: false.",
  },
  fluidFinalNewline: {
    category: "Fluid",
    type: "boolean",
    default: true,
    description:
      "End the file with a line break. With false, the last line has none.",
  },
  fluidArraySpacing: {
    category: "Fluid",
    type: "choice",
    default: "preserve",
    description:
      "Spaces inside the braces of single-line Fluid arrays: { a: 1, b: 2 } or {a: 1, b: 2}.",
    choices: [
      {
        value: "preserve",
        description: "Keep Fluid arrays exactly as written.",
      },
      {
        value: "always",
        description: "{ a: 1, b: 2 }, with one space after each comma.",
      },
      {
        value: "never",
        description: "{a: 1, b: 2}, with one space after each comma.",
      },
    ],
  },
  fluidArraySpacingInStrings: {
    category: "Fluid",
    type: "boolean",
    default: false,
    description:
      "With fluidArraySpacing: also format arrays in quoted strings of ViewHelper arguments, e.g. then: '{a: 1}'. Fluid parses them as arrays, too.",
  },
};

/**
 * Formats a template and returns the result with Fluid code restored.
 *
 * @param {string} text
 * @param {FluidOptions} options
 * @param {Origin} [origin] Where `text` is taken from, for error positions.
 */
async function formatTemplate(text, options, origin) {
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
    (await getForwardedOptionNames(plugins))
      .filter((name) => name in options)
      .map((name) => [
        name,
        /** @type {Record<string, unknown>} */ (options)[name],
      ]),
  );

  let formatted;
  try {
    // Uses the `html` parser as resolved by Prettier, so plugins wrapping it
    // (organize-attributes, tailwindcss, ...) take part as usual.
    formatted = await prettier.format(html, {
      ...forwarded,
      plugins,
      parser: "html",
      endOfLine: "lf",
    });
  } catch (error) {
    throw toFluidError(error, { html, source: text, state, origin });
  }
  return restore(formatted, state);
}

/**
 * With `fluidIndentRoot: false`: formats the root tag and its content
 * separately, so the content is not indented, with an empty line after the
 * opening and before the closing tag.
 *
 * @param {string} text
 * @param {NonNullable<ReturnType<typeof findRootElement>>} root
 * @param {FluidOptions} options
 */
async function formatWithFlatRoot(text, root, options) {
  const closeTag = `</${root.name}>`;
  const openTag = text.slice(root.openStart, root.openEnd);
  const tagOptions = options.fluidRootAttributePerLine
    ? { ...options, printWidth: 1 }
    : options;
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
  const children = (
    await formatTemplate(content, options, { text, offset: root.openEnd })
  ).trim();

  const body = children
    ? `${opening}\n\n${children}\n\n${closeTag}\n`
    : `${opening}\n${closeTag}\n`;
  return root.prefix ? `${root.prefix}\n${body}` : body;
}

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
      const root =
        options.fluidIndentRoot === false ? findRootElement(text) : undefined;
      const formatted = root
        ? await formatWithFlatRoot(text, root, options)
        : await formatTemplate(text, options);
      return { type: "root", text, formatted };
    },
    hasPragma: (text) => PRAGMA.test(text),
    locStart: () => 0,
    locEnd: (node) => node.text.length,
  },
};

/** @type {Plugin<FluidRoot>["printers"]} */
export const printers = {
  fluid: {
    print({ node }, /** @type {FluidOptions} */ options) {
      const lines = node.formatted.trimEnd().split("\n");
      if (lines.length === 1 && lines[0] === "") {
        return "";
      }
      const content = join(hardline, lines);
      return options.fluidFinalNewline === false
        ? content
        : [content, hardline];
    },
    insertPragma: (text) => `<!-- @format -->\n\n${text}`,
  },
};

/** @type {Plugin<FluidRoot>} */
export default { languages, options, parsers, printers };
