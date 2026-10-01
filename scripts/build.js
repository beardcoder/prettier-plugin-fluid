#!/usr/bin/env bun
// Bundles src/ with Bun's bundler into dist/index.js, an ES module for
// Node.js 20 and later, and emits the type declarations with tsc. Prettier
// and @prettier/html-tags are not bundled: users install them with the
// plugin. dist/ is removed first, so deleted or renamed modules leave no
// stale files behind. Nothing else is touched.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outdir = join(root, 'dist');
rmSync(outdir, { recursive: true, force: true });

// Rejects with the build errors.
await Bun.build({
  entrypoints: [join(root, 'src', 'index.ts')],
  outdir,
  target: 'node',
  format: 'esm',
  packages: 'external',
});

// Only the declarations, with the tsc of the installed typescript package,
// also without node_modules/.bin on the PATH.
const typescript = createRequire(import.meta.url).resolve('typescript/package.json');
const { bin } = JSON.parse(readFileSync(typescript, 'utf8'));
const tsc = join(dirname(typescript), bin.tsc);
execFileSync(process.execPath, [tsc, '--project', root, '--emitDeclarationOnly'], {
  cwd: root,
  stdio: 'inherit',
});
