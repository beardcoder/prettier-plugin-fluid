/**
 * Formats Fluid arrays (`{a: 1, b: {c: 2}}`) in ViewHelper arguments with the
 * `fluidArraySpacing` option. Everything else in an expression stays as
 * written.
 */
import { matchShorthand, matchSticky, skipQuoted } from './lexer.js';

export type ArraySpacing = 'preserve' | 'always' | 'never';

export interface ArrayFormat {
  spacing: 'always' | 'never';
  /**
   * Whether to format arrays in quoted strings of ViewHelper arguments, which
   * Fluid parses as arguments, too.
   */
  inStrings: boolean;
}

/** @returns Undefined if arrays are kept as written. */
export function toArrayFormat(spacing: ArraySpacing, inStrings: boolean): ArrayFormat | undefined {
  return spacing === 'preserve' ? undefined : { spacing, inStrings };
}

// Array syntax as in Patterns::$SCAN_PATTERN_SHORTHANDSYNTAX_ARRAYS of
// typo3/fluid: `key: value` or `key = value`, separated by optional commas.
const ARRAY_KEY = /([a-zA-Z0-9\-_]+|"(?:\\.|[^"\\])+"|'(?:\\.|[^'\\])+')(\s*[:=]\s*)/y;
const ARRAY_IDENTIFIER = /[a-zA-Z0-9\-_.]+/y;
const WHITESPACE = /\s*/y;
const SEPARATOR = /\s*,?/y;

// An inline ViewHelper call: `f:translate(`.
const VIEWHELPER_CALL = /[a-zA-Z0-9.]+:[a-zA-Z0-9.]+$/;

/**
 * Rewrites a single-line Fluid array (`{a: 1,b: 2}`) with one space after each
 * comma and the given spacing inside the braces. Keys, delimiters and values
 * stay as written.
 *
 * @param code An expression from `{` to `}`.
 * @returns Undefined if `code` is no single-line array.
 */
function formatArray(code: string, format: ArrayFormat): string | undefined {
  const end = code.length - 1;
  const entries: string[] = [];
  let i = 1;
  while (true) {
    // `\s*` always matches.
    const space = matchSticky(WHITESPACE, code, i)![0];
    if (space.includes('\n')) return undefined;
    i += space.length;
    if (i === end) break;
    const key = matchSticky(ARRAY_KEY, code, i);
    if (!key || key[2].includes('\n')) return undefined;
    const valueStart = i + key[0].length;
    let value: string | undefined;
    let valueEnd;
    const char = code[valueStart];
    if (char === '"' || char === "'") {
      valueEnd = skipQuoted(code, valueStart);
      value = code.slice(valueStart, valueEnd);
      if (format.inStrings && valueEnd !== -1) {
        value = formatString(value, format);
      }
    } else if (char === '{') {
      valueEnd = matchShorthand(code, valueStart);
      value = valueEnd === -1 ? undefined : formatArray(code.slice(valueStart, valueEnd), format);
    } else {
      value = matchSticky(ARRAY_IDENTIFIER, code, valueStart)?.[0];
      valueEnd = valueStart + (value?.length ?? 0);
    }
    if (value === undefined || valueEnd === -1 || valueEnd > end) return undefined;
    entries.push(`${key[0]}${value}`);
    i = valueEnd;
    // `\s*,?` always matches.
    const separator = matchSticky(SEPARATOR, code, i)![0];
    if (separator.includes('\n')) return undefined;
    i += separator.length;
  }
  if (entries.length === 0) return undefined;
  const pad = format.spacing === 'always' ? ' ' : '';

  return `{${pad}${entries.join(', ')}${pad}}`;
}

/**
 * Formats the arrays in a quoted string of a ViewHelper argument.
 *
 * @param code The string including its quotes.
 */
function formatString(code: string, format: ArrayFormat): string {
  const quote = code[0];

  return `${quote}${formatArrays(code.slice(1, -1), format, true)}${quote}`;
}

/**
 * Applies `formatArray()` to every array in an expression. Like Fluid, only
 * ViewHelper arguments contain arrays: attribute values of ViewHelper tags and
 * the arguments of inline ViewHelpers (`f:translate(arguments: {0: a})`).
 * Elsewhere, `{a: 1}` is output as text. Quoted strings are left alone unless
 * `format.inStrings` is set.
 *
 * @param inArguments Whether `code` is a ViewHelper argument.
 */
export function formatArrays(code: string, format: ArrayFormat, inArguments: boolean): string {
  let result = '';
  let copied = 0;
  // Per open parenthesis: whether it encloses ViewHelper arguments.
  const parens: boolean[] = [];
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    const isArgument = inArguments || parens.at(-1) === true;
    if (char === '\\') {
      i++;
    } else if (char === '"' || char === "'") {
      const end = skipQuoted(code, i);
      if (end === -1) break;
      if (isArgument && format.inStrings) {
        result += code.slice(copied, i) + formatString(code.slice(i, end), format);
        copied = end;
      }
      i = end - 1;
    } else if (char === '(') {
      parens.push(isArgument || VIEWHELPER_CALL.test(code.slice(0, i)));
    } else if (char === ')') {
      parens.pop();
    } else if (char === '{') {
      const end = matchShorthand(code, i);
      if (end === -1) continue;
      const inner = code.slice(i, end);
      const formatted =
        (isArgument ? formatArray(inner, format) : undefined) ??
        `{${formatArrays(inner.slice(1, -1), format, isArgument)}}`;
      result += code.slice(copied, i) + formatted;
      copied = end;
      i = end - 1;
    }
  }

  return result + code.slice(copied);
}
