/**
 * The Fluid language and the options this plugin adds to Prettier, with
 * their defaults.
 */
import type { SupportLanguage, SupportOption } from 'prettier';

import type { ArraySpacing } from './arrays.js';

/** The options of this plugin; Prettier fills in the defaults. */
export interface FluidOptions {
  fluidBlockViewHelpers?: string[] | undefined;
  fluidInlineViewHelpers?: string[] | undefined;
  fluidVerbatimViewHelpers?: string[] | undefined;
  fluidIndentRoot?: boolean | undefined;
  fluidRootAttributePerLine?: boolean | undefined;
  fluidFinalNewline?: boolean | undefined;
  fluidArraySpacing?: ArraySpacing | undefined;
  fluidArraySpacingInStrings?: boolean | undefined;
}

export const languages: SupportLanguage[] = [
  {
    name: 'Fluid',
    parsers: ['fluid'],
    extensions: ['.fluid', '.fluid.html'],
    // "html-fluid" is the language of HTML templates in the Fluid extension
    // for VS Code; its "fluid" language is plain-text Fluid (e.g. emails).
    vscodeLanguageIds: ['html-fluid'],
  },
];

export const options: Record<keyof FluidOptions, SupportOption> = {
  fluidBlockViewHelpers: {
    category: 'Fluid',
    type: 'string',
    array: true,
    default: [{ value: [] }],
    description:
      'Additional ViewHelpers (e.g. custom ones) formatted as block elements. Supports * wildcards: my:*, v:variable.*',
  },
  fluidInlineViewHelpers: {
    category: 'Fluid',
    type: 'string',
    array: true,
    default: [{ value: [] }],
    description: 'ViewHelpers formatted inline even if they are block elements by default.',
  },
  fluidVerbatimViewHelpers: {
    category: 'Fluid',
    type: 'string',
    array: true,
    default: [{ value: [] }],
    description:
      'Additional ViewHelpers whose element is kept exactly as written, like f:comment. f:spaceless and f:variable always are. Supports * wildcards.',
  },
  fluidIndentRoot: {
    category: 'Fluid',
    type: 'boolean',
    default: true,
    description:
      'Indent the content of the root tag that declares the Fluid namespaces (<fluid> or a tag with data-namespace-typo3-fluid="true").',
  },
  fluidRootAttributePerLine: {
    category: 'Fluid',
    type: 'boolean',
    default: false,
    description: 'Put every attribute of the root tag on its own line. Only with fluidIndentRoot: false.',
  },
  fluidFinalNewline: {
    category: 'Fluid',
    type: 'boolean',
    default: true,
    description: 'End the file with a line break. With false, the last line has none.',
  },
  fluidArraySpacing: {
    category: 'Fluid',
    type: 'choice',
    default: 'preserve',
    description: 'Spaces inside the braces of single-line Fluid arrays: { a: 1, b: 2 } or {a: 1, b: 2}.',
    choices: [
      {
        value: 'preserve',
        description: 'Keep Fluid arrays exactly as written.',
      },
      {
        value: 'always',
        description: '{ a: 1, b: 2 }, with one space after each comma.',
      },
      {
        value: 'never',
        description: '{a: 1, b: 2}, with one space after each comma.',
      },
    ],
  },
  fluidArraySpacingInStrings: {
    category: 'Fluid',
    type: 'boolean',
    default: false,
    description:
      "With fluidArraySpacing: also format arrays in quoted strings of ViewHelper arguments, e.g. then: '{a: 1}'. Fluid parses them as arrays, too.",
  },
};
