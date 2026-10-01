#!/usr/bin/env node
// Compiles src/ to dist/ (JavaScript and type declarations) with tsc. dist/ is
// removed first, so deleted or renamed modules leave no stale files behind.
// Nothing else is touched.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
rmSync(join(root, 'dist'), { recursive: true, force: true });
// The tsc of the installed typescript package, also without node_modules/.bin
// on the PATH.
const typescript = createRequire(import.meta.url).resolve('typescript/package.json');
const { bin } = JSON.parse(readFileSync(typescript, 'utf8'));
const tsc = join(dirname(typescript), bin.tsc);
execFileSync(process.execPath, [tsc, '--project', root], {
  cwd: root,
  stdio: 'inherit',
});
