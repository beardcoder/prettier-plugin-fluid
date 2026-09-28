#!/usr/bin/env node
// Formats every *.html file below the given directories and verifies that
// formatting keeps all Fluid code and is idempotent. Usage:
//
//   node scripts/check-corpus.js [--verbose] path/to/extension [...more paths]
//
// Fails on lost/changed Fluid code or non-idempotent output. Also reports:
// - parse errors: templates that are not well-nested HTML (left unformatted)
// - normalized: other content Prettier changed on purpose, e.g. CSS in
//   style="" attributes or implied end tags (`<li>a<li>b` → `…</li>`)
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import * as prettier from "prettier";
import fluid from "../src/index.js";
import { preprocess } from "../src/preprocess.js";

const { positionals: roots, values } = parseArgs({
  allowPositionals: true,
  options: { verbose: { type: "boolean", short: "v" } },
});
if (roots.length === 0) {
  console.error("Usage: node scripts/check-corpus.js [-v] <dir> [...dirs]");
  process.exit(2);
}

const options = {
  parser: "fluid",
  plugins: [fluid, "prettier-plugin-organize-attributes"],
};

/** @param {string} dir */
async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && ![".git", "node_modules"].includes(entry.name)) {
      yield* htmlFiles(path);
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      yield path;
    }
  }
}

/** @param {string[]} list */
const sorted = (list) => JSON.stringify(list.toSorted());

/** Fluid expressions and comments, order-independent. */
const fluidFragments = (/** @type {string} */ text) =>
  sorted(preprocess(text).state.fragments.map(({ source }) => source));

const viewHelperTags = (/** @type {string} */ text) =>
  sorted(text.match(/<\/?[a-zA-Z0-9.]*:[a-zA-Z0-9.]+/g) ?? []);

// Content characters, ignoring whitespace, quotes, self-closing slashes
// (`<br>` → `<br />`) and DOCTYPE casing. Sorting ignores attribute order.
const characters = (/** @type {string} */ text) =>
  sorted([...text.replace(/<!doctype/gi, "").replace(/[\s"'/]+/g, "")]);

/** @type {Record<string, string[]>} */
const findings = {
  "parse errors (left unformatted)": [],
  "normalized by Prettier (review)": [],
  "LOSSY: Fluid code changed": [],
  "NOT IDEMPOTENT": [],
};
const [parseErrors, normalized, lossy, unstable] = Object.values(findings);
let ok = 0;
let total = 0;
const started = performance.now();

for (const root of roots) {
  for await (const file of htmlFiles(root)) {
    total++;
    const name = relative(process.cwd(), file);
    const source = await readFile(file, "utf8");
    let output;
    try {
      output = await prettier.format(source, options);
    } catch (error) {
      parseErrors.push(`${name}: ${String(error.message).split("\n", 1)[0]}`);
      continue;
    }

    const changed = [
      fluidFragments(source) !== fluidFragments(output) && "expressions",
      viewHelperTags(source) !== viewHelperTags(output) && "ViewHelper tags",
    ].filter(Boolean);
    if (changed.length > 0) {
      lossy.push(`${name}: ${changed.join(", ")}`);
    } else if ((await prettier.format(output, options)) !== output) {
      unstable.push(name);
    } else if (characters(source) !== characters(output)) {
      normalized.push(name);
    } else {
      ok++;
    }
  }
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(`${total} files in ${seconds}s: ${ok} unchanged content`);
for (const [label, list] of Object.entries(findings)) {
  if (list.length > 0) {
    console.log(`\n${list.length} ${label}:`);
    for (const line of values.verbose ? list : list.slice(0, 15)) {
      console.log(`  ${line}`);
    }
    if (!values.verbose && list.length > 15) {
      console.log(`  … ${list.length - 15} more (--verbose)`);
    }
  }
}
process.exitCode = lossy.length + unstable.length > 0 ? 1 : 0;
