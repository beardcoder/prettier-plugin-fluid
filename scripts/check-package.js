#!/usr/bin/env node
// Smoke test of the npm package as users get it: builds and packs the
// package into a temporary directory, installs the tarball and Prettier into
// a temporary consumer project outside of the repository and formats
// templates there. Nothing is published. Usage:
//
//   node scripts/check-package.js [--package-dir <dir>] [--prettier <version>]
//
// - The package is built explicitly first (`npm run build` in the package
//   directory), as `npm pack --ignore-scripts` skips lifecycle scripts on
//   purpose: `prepare` would install the husky Git hooks, which must not be a
//   side effect of a test.
// - The consumer installs Prettier and TypeScript from the registry (default:
//   the version ranges the repository is developed with), never from the
//   repository's own node_modules; the package's dependencies are installed
//   regularly with it.
// - Fails if the build keeps stale output of removed modules, if the package
//   lacks a build artifact of a source module or contains other build output,
//   sources, tests, temporary files or loop progress files, if the repository
//   changed (tarballs, lock files, Git hooks), if formatting in the consumer
//   does not work, or if a TypeScript consumer of the package and its option
//   types does not type-check.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'package-dir': {
      type: 'string',
      default: fileURLToPath(new URL('..', import.meta.url)),
    },
    prettier: { type: 'string' },
  },
});
const packageDir = resolve(values['package-dir']);
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
const prettierVersion = values.prettier ?? manifest.devDependencies?.prettier ?? '3';
const typescriptVersion = manifest.devDependencies?.typescript ?? 'latest';

// npm/bun set npm_* variables for scripts; they must not configure the
// consumer's installation (e.g. its prefix or lockfile settings).
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 */
const exec = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** @param {string} dir */
async function listFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(dir, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (entry.isFile()) {
      const parent = entry.parentPath ?? /** @type {any} */ (entry).path;
      files.push(relative(dir, join(parent, entry.name)).split('\\').join('/'));
    }
  }

  return files.sort();
}

/** What the test must not change in the repository. */
async function repositoryState() {
  const hash = async (/** @type {string} */ file) =>
    existsSync(join(packageDir, file))
      ? createHash('sha256')
          .update(await readFile(join(packageDir, file)))
          .digest('hex')
      : null;
  const git = (/** @type {string[]} */ args) => {
    try {
      return exec('git', args, packageDir);
    } catch {
      return null;
    }
  };

  return {
    'bun.lock': await hash('bun.lock'),
    'package-lock.json': await hash('package-lock.json'),
    'package.json': await hash('package.json'),
    tarballs: (await readdir(packageDir)).filter((name) => name.endsWith('.tgz')),
    'git status': git(['status', '--porcelain', '--untracked-files=all']),
    'git hooks': git(['config', '--get', 'core.hooksPath']),
  };
}

const FORBIDDEN = [
  /^src\//,
  /^test\//,
  /^docs\//,
  /^scripts\//,
  /^\.claude\//,
  /^\.husky\//,
  /^\.github\//,
  /^node_modules\//,
  /ralph/i,
  /\.tgz$/,
  /\.tsbuildinfo$/,
  /(^|\/)(\.DS_Store|.*\.tmp|.*~)$/,
];

/** The string targets of a (conditional) `exports` entry, in order. */
const targets = (/** @type {unknown} */ entry) =>
  typeof entry === 'string' ? [entry] : Object.values(entry ?? {}).flatMap(targets);

// Runs inside the consumer project with Node.js.
const SMOKE_TEST = String.raw`
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import plugin, {
  languages,
  options,
  parsers,
  printers,
} from "@beardcoder/prettier-plugin-fluid";

// Resolved from the installed tarball, not from the repository.
const entry = realpathSync(
  fileURLToPath(import.meta.resolve("@beardcoder/prettier-plugin-fluid")),
);
assert.ok(
  entry.startsWith(realpathSync(process.cwd()) + "/node_modules/"),
  entry,
);
assert.deepEqual(plugin, { languages, options, parsers, printers });
assert.deepEqual(languages[0].extensions, [".fluid", ".fluid.html"]);
assert.equal(typeof parsers.fluid.parse, "function");
assert.equal(typeof printers.fluid.print, "function");
assert.equal(options.fluidIndentRoot.type, "boolean");
const require = createRequire(import.meta.url);
assert.equal(
  require("@beardcoder/prettier-plugin-fluid/package.json").name,
  "@beardcoder/prettier-plugin-fluid",
);
// The runtime dependency is installed with the package, not bundled.
const htmlTags = realpathSync(
  createRequire(entry).resolve("@prettier/html-tags"),
);
assert.ok(
  htmlTags.startsWith(realpathSync(process.cwd()) + "/node_modules/@prettier/html-tags/"),
  htmlTags,
);
// Internal modules are no public entry points.
await assert.rejects(
  import("@beardcoder/prettier-plugin-fluid/dist/lexer.js"),
  { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
);

const source = '<div><f:if condition="{a}">{b}</f:if></div>';
const expected = '<div>\n  <f:if condition="{a}">{b}</f:if>\n</div>\n';
for (const settings of [
  { parser: "fluid", plugins: [plugin] },
  { parser: "fluid", plugins: ["@beardcoder/prettier-plugin-fluid"] },
  { filepath: "Templates/Page.fluid", plugins: [plugin] },
  { filepath: "Templates/Page.html", parser: "fluid", plugins: [plugin] },
]) {
  const output = await prettier.format(source, settings);
  assert.equal(output, expected, JSON.stringify(settings));
  assert.equal(await prettier.format(output, settings), output);
}
// Prettier before 3.6 prefers the extension .html over .fluid.html.
const [major, minor] = prettier.version.split(".").map(Number);
const longExtensions = major > 3 || (major === 3 && minor >= 6);
const fluidHtml = { filepath: "Templates/Page.fluid.html", plugins: [plugin] };
assert.equal(
  (await prettier.getFileInfo(fluidHtml.filepath, fluidHtml)).inferredParser,
  longExtensions ? "fluid" : "html",
);
if (longExtensions) {
  const output = await prettier.format(source, fluidHtml);
  assert.equal(output, expected, ".fluid.html");
  assert.equal(await prettier.format(output, fluidHtml), output);
}
// Without the parser, .html files are plain HTML to Prettier.
assert.notEqual(
  await prettier.format(source, { filepath: "Page.html", plugins: [plugin] }),
  expected,
);
console.log(prettier.version, longExtensions);
`;

// Type-checked with tsc inside the consumer project; `@ts-expect-error` lines
// fail if the types resolve to `any`.
const TYPES_TEST = String.raw`
import * as prettier from "prettier";
import type { Config } from "prettier";
import plugin, {
  languages,
  options,
  parsers,
  printers,
  type ArraySpacing,
  type FluidOptions,
} from "@beardcoder/prettier-plugin-fluid";

const spacing: ArraySpacing = "always";
const fluid: FluidOptions = {
  fluidBlockViewHelpers: ["my:*"],
  fluidIndentRoot: false,
  fluidArraySpacing: spacing,
};
export const config: Config & FluidOptions = { plugins: [plugin], ...fluid };
export const formatted: Promise<string> = prettier.format("<p>{a}</p>", {
  ...config,
  parser: "fluid",
});
export const optionType: string = options.fluidIndentRoot.type;
export const names: string[] = languages.map((language) => language.name);
export const parser = parsers.fluid;
export const printer = printers.fluid;

// @ts-expect-error: no ArraySpacing
export const wrongSpacing: FluidOptions = { fluidArraySpacing: "sometimes" };
// @ts-expect-error: no boolean
export const wrongType: FluidOptions = { fluidIndentRoot: "yes" };
// @ts-expect-error: internal modules are not exported
import("@beardcoder/prettier-plugin-fluid/dist/lexer.js");
`;

const TSCONFIG = {
  compilerOptions: {
    strict: true,
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    target: 'ES2022',
    types: [],
    noEmit: true,
  },
  files: ['types.ts'],
};

const before = await repositoryState();
const temp = await mkdtemp(join(tmpdir(), 'fluid-package-'));
try {
  // Build and pack. Output of a removed or renamed module must not survive a
  // rebuild, so plant one first; dist/ is build output only.
  const stale = join(packageDir, 'dist', 'removed-module.js');
  await mkdir(join(packageDir, 'dist'), { recursive: true });
  await writeFile(stale, 'export {};\n');
  exec('npm', ['run', 'build'], packageDir);
  assert.ok(!existsSync(stale), 'the build kept stale output in dist/');
  const [packed] = JSON.parse(
    exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], packageDir),
  );
  const contents = packed.files.map((/** @type {{ path: string }} */ file) => file.path).sort();
  // Exactly the JavaScript and declarations of each source module.
  const built = (await listFiles(join(packageDir, 'src')))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .flatMap((file) => {
      const name = `dist/${file.slice(0, -'.ts'.length)}`;

      return [`${name}.js`, `${name}.d.ts`];
    })
    .sort();
  assert.deepEqual(
    contents.filter((file) => file.startsWith('dist/')),
    built,
    'package build output differs from the source modules',
  );
  for (const required of ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
    assert.ok(contents.includes(required), `package lacks ${required}`);
  }
  const entries = [manifest.main, manifest.types, ...Object.values(manifest.exports).flatMap(targets)];
  for (const target of entries) {
    assert.ok(contents.includes(String(target).replace(/^\.\//, '')), `package lacks the entry point ${target}`);
  }
  // TypeScript picks the first matching condition.
  assert.equal(Object.keys(manifest.exports['.'])[0], 'types', 'exports["."] must list "types" first');
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['@prettier/html-tags'], 'runtime dependencies');
  const forbidden = contents.filter((file) => FORBIDDEN.some((pattern) => pattern.test(file)));
  assert.deepEqual(forbidden, [], 'package contains files it must not');

  // Install into a consumer project outside of the repository
  const consumer = join(temp, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  exec(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-save',
      join(temp, packed.filename),
      `prettier@${prettierVersion}`,
      `typescript@${typescriptVersion}`,
    ],
    consumer,
  );

  await writeFile(join(consumer, 'smoke.js'), SMOKE_TEST);
  await writeFile(join(consumer, 'types.ts'), TYPES_TEST);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify(TSCONFIG));
  exec(join(consumer, 'node_modules', '.bin', 'tsc'), ['-p', '.'], consumer);
  const [version, longExtensions] = exec('node', ['smoke.js'], consumer).trim().split(' ');

  // Prettier's CLI, with the plugin given by its package name
  const template = `<div>\n  <f:if condition="{a}">{b}</f:if>\n</div>\n`;
  await writeFile(join(consumer, 'Page.fluid'), template);
  await writeFile(join(consumer, 'Mail.fluid.html'), template);
  exec(
    join(consumer, 'node_modules', '.bin', 'prettier'),
    ['--plugin', manifest.name, '--check', 'Page.fluid', ...(longExtensions === 'true' ? ['Mail.fluid.html'] : [])],
    consumer,
  );

  const after = await repositoryState();
  assert.deepEqual(after, before, 'the check changed the repository');
  console.log(`${packed.filename}: ${contents.length} files, formatted with Prettier ${version}`);
} catch (error) {
  const output = /** @type {{ stderr?: string, stdout?: string }} */ (error);
  console.error(output.stdout ?? '', output.stderr ?? '');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
