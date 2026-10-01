#!/usr/bin/env node
// Formats every Fluid HTML template (*.html, *.fluid.html, *.fluid) below the
// given directories and verifies that formatting keeps all Fluid code and is
// idempotent. Usage:
//
//   node scripts/check-corpus.js [--strict] [--verbose] path/to/extension [...more paths]
//
// Always fails on lost/changed Fluid code, non-idempotent output (including a
// failing second pass) and unexpected errors. Also reports:
// - parse errors: templates that are not well-nested HTML (left unformatted)
// - normalized: other content Prettier changed on purpose, e.g. CSS in
//   style="" attributes or implied end tags (`<li>a<li>b` → `…</li>`)
//
// --strict additionally fails on parse errors and if no template was found,
// for use as a CI check on a known-good corpus.
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import * as prettier from 'prettier';

import fluid from '../dist/index.js';
import { containsFluid } from '../dist/lexer.js';
import { preprocess } from '../dist/preprocess.js';

export const DEFAULT_OPTIONS = {
  parser: 'fluid',
  plugins: [fluid, 'prettier-plugin-organize-attributes'],
};

/**
 * HTML templates, like the plugin's language registration (`.fluid`,
 * `.fluid.html`) plus plain `.html`. Plain-text templates (`.fluid.txt`) are
 * no HTML.
 *
 * @param {string} name
 */
export const isTemplate = (name) => name.endsWith('.html') || name.endsWith('.fluid');

/** @param {string} dir */
async function* templates(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name)) {
      yield* templates(path);
    } else if (entry.isFile() && isTemplate(entry.name)) {
      yield path;
    }
  }
}

/** @param {string[]} list */
const sorted = (list) => JSON.stringify(list.toSorted());

/**
 * Collapses whitespace outside of quoted strings: the plugin re-indents the
 * lines of multi-line expressions, which does not change their meaning.
 * Whitespace inside strings is output and must stay exactly as written.
 *
 * @param {string} source
 */
function normalizeExpression(source) {
  let result = '';
  let quote;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') {
      result += char + (source[i + 1] ?? '');
      i++;
    } else if (quote === undefined && /\s/.test(char)) {
      if (!result.endsWith(' ')) result += ' ';
    } else {
      if (quote === undefined && (char === '"' || char === "'")) quote = char;
      else if (char === quote) quote = undefined;
      result += char;
    }
  }

  return result;
}

/**
 * Bodies of `<script>`/`<style>` elements that contain Fluid code. The plugin
 * keeps them exactly as written.
 *
 * @param {string} text
 */
function fluidRawTextBodies(text) {
  /** @type {string[]} */
  const bodies = [];
  const open = /<(script|style)\b/gi;
  for (let match; (match = open.exec(text));) {
    let end = match.index;
    for (let quote; end < text.length; end++) {
      const char = text[end];
      if (quote) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
    }
    const close = text.toLowerCase().indexOf(`</${match[1].toLowerCase()}`, end + 1);
    const body = text.slice(end + 1, close === -1 ? text.length : close);
    if (containsFluid(body)) {
      bodies.push(body);
    }
    open.lastIndex = close === -1 ? text.length : close;
  }

  return bodies;
}

/**
 * Everything formatting must keep, as order-independent lists: every
 * occurrence of each Fluid expression (whitespace outside strings may
 * change), verbatim areas (`<f:comment>`, ignore ranges, verbatim ViewHelpers,
 * conditional wrappers, …), ViewHelper tags and script/style bodies with Fluid.
 *
 * @param {string} text
 */
export function protectedContent(text) {
  const lf = text.replace(/\r\n?/g, '\n');
  const { fragments } = preprocess(lf).state;
  /** @param {boolean} comment @param {(source: string) => string} map */
  const occurrences = (comment, map) =>
    sorted(
      fragments.flatMap((fragment) =>
        fragment.comment === comment ? Array(fragment.count).fill(map(fragment.source)) : [],
      ),
    );

  return {
    expressions: occurrences(false, normalizeExpression),
    'verbatim content': occurrences(true, (source) => source),
    'ViewHelper tags': sorted(lf.match(/<\/?[a-zA-Z0-9.]*:[a-zA-Z0-9.]+/g) ?? []),
    'script/style bodies with Fluid': sorted(fluidRawTextBodies(lf)),
  };
}

/**
 * What formatting changed that it must keep.
 *
 * @param {string} source
 * @param {string} output
 * @returns {string[]} Names of the changed kinds of content.
 */
export function protectionViolations(source, output) {
  const before = protectedContent(source);
  const after = protectedContent(output);

  return Object.entries(before)
    .filter(([kind, value]) => after[/** @type {keyof typeof after} */ (kind)] !== value)
    .map(([kind]) => kind);
}

// Content characters, ignoring whitespace, quotes, self-closing slashes
// (`<br>` → `<br />`) and DOCTYPE casing. Sorting ignores attribute order.
const characters = (/** @type {string} */ text) =>
  sorted([...text.replace(/<!doctype/gi, '').replace(/[\s"'/]+/g, '')]);

/** @param {unknown} error */
const firstLine = (error) => String(error instanceof Error ? error.message : error).split('\n', 1)[0];

/**
 * Parse errors of invalid HTML are expected in real templates. The plugin's
 * own refusals (lost Fluid code) and other errors are not.
 *
 * @param {unknown} error
 */
const isParseError = (error) =>
  error instanceof SyntaxError && 'loc' in error && !firstLine(error).startsWith('prettier-plugin-fluid:');

export const LABELS = {
  parseErrors: 'parse errors (left unformatted)',
  normalized: 'normalized by Prettier (review)',
  lossy: 'LOSSY: Fluid code changed',
  unstable: 'NOT IDEMPOTENT',
  failed: 'FAILED: unexpected errors',
};

/**
 * @param {string[]} roots
 * @param {{ strict?: boolean, options?: import("prettier").Options, cwd?: string }} [settings]
 */
export async function checkCorpus(roots, { strict = false, options = DEFAULT_OPTIONS, cwd = process.cwd() } = {}) {
  /** @type {Record<keyof typeof LABELS, string[]>} */
  const findings = {
    parseErrors: [],
    normalized: [],
    lossy: [],
    unstable: [],
    failed: [],
  };
  let ok = 0;
  let total = 0;

  for (const root of roots) {
    for await (const file of templates(root)) {
      total++;
      const name = relative(cwd, file);
      const source = await readFile(file, 'utf8');
      let output;
      try {
        output = await prettier.format(source, options);
      } catch (error) {
        const list = isParseError(error)
          ? findings.parseErrors
          : firstLine(error).startsWith('prettier-plugin-fluid:')
            ? findings.lossy
            : findings.failed;
        list.push(`${name}: ${firstLine(error)}`);
        continue;
      }

      const changed = protectionViolations(source, output);
      if (changed.length > 0) {
        findings.lossy.push(`${name}: ${changed.join(', ')}`);
        continue;
      }
      let second;
      try {
        second = await prettier.format(output, options);
      } catch (error) {
        findings.unstable.push(`${name}: second pass failed: ${firstLine(error)}`);
        continue;
      }
      if (second !== output) {
        findings.unstable.push(name);
      } else if (characters(source) !== characters(output)) {
        findings.normalized.push(name);
      } else {
        ok++;
      }
    }
  }

  const failures =
    findings.lossy.length +
    findings.unstable.length +
    findings.failed.length +
    (strict ? findings.parseErrors.length : 0);
  /** @type {string[]} */
  const problems = [];
  if (strict && total === 0) {
    problems.push('no templates found');
  }
  const exitCode = failures > 0 || problems.length > 0 ? 1 : 0;

  return { total, ok, findings, problems, exitCode };
}

async function main() {
  const { positionals: roots, values } = parseArgs({
    allowPositionals: true,
    options: {
      verbose: { type: 'boolean', short: 'v' },
      strict: { type: 'boolean' },
    },
  });
  if (roots.length === 0) {
    console.error('Usage: node scripts/check-corpus.js [--strict] [-v] <dir> [...dirs]');

    return 2;
  }
  const started = performance.now();
  const { total, ok, findings, problems, exitCode } = await checkCorpus(roots, {
    strict: values.strict,
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`${total} files in ${seconds}s: ${ok} unchanged content`);
  for (const [key, list] of Object.entries(findings)) {
    if (list.length > 0) {
      const label = LABELS[/** @type {keyof typeof LABELS} */ (key)];
      console.log(`\n${list.length} ${label}:`);
      for (const line of values.verbose ? list : list.slice(0, 15)) {
        console.log(`  ${line}`);
      }
      if (!values.verbose && list.length > 15) {
        console.log(`  … ${list.length - 15} more (--verbose)`);
      }
    }
  }
  for (const problem of problems) {
    console.log(`\nFAILED: ${problem}`);
  }

  return exitCode;
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
