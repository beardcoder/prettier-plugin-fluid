/**
 * The Prettier plugin: the `fluid` parser formats the whole template, the
 * printer outputs the result.
 */
import { doc, type Parser, type ParserOptions, type Plugin, type Printer } from 'prettier';

import { formatFluid } from './format.js';
import { type FluidOptions, languages, options } from './options.js';

export type { ArraySpacing } from './arrays.js';
export type { FluidOptions } from './options.js';
export { languages, options };

const { hardline, join } = doc.builders;

interface FluidRoot {
  type: 'root';
  text: string;
  formatted: string;
}

const PRAGMA = /^\s*<!--\s*@(?:format|prettier)\s*-->/;

export const parsers: Record<string, Parser<FluidRoot>> = {
  fluid: {
    astFormat: 'fluid',
    /**
     * Formatting happens here rather than in `embed`: Prettier swallows embed
     * errors (and skips embeds with `embeddedLanguageFormatting: "off"`),
     * while parse errors are reported with a code frame.
     */
    async parse(text, options: ParserOptions<FluidRoot> & FluidOptions) {
      const formatted = await formatFluid(text, options);

      return { type: 'root', text, formatted };
    },
    hasPragma: (text) => PRAGMA.test(text),
    locStart: () => 0,
    locEnd: (node) => node.text.length,
  },
};

export const printers: Record<string, Printer<FluidRoot>> = {
  fluid: {
    print({ node }, options: ParserOptions<FluidRoot> & FluidOptions) {
      const lines = node.formatted.trimEnd().split('\n');
      if (lines.length === 1 && lines[0] === '') return '';
      const content = join(hardline, lines);

      return options.fluidFinalNewline === false ? content : [content, hardline];
    },
    insertPragma: (text) => `<!-- @format -->\n\n${text}`,
  },
};

const plugin: Plugin<FluidRoot> = { languages, options, parsers, printers };
export default plugin;
