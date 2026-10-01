#!/usr/bin/env node
// The release job of .github/workflows/release.yml, for the automatic run
// after CI and for manual runs alike:
//
// 1. `bun run check` on the checked-out commit, before anything is written.
// 2. release-it (.release-it.js): if a commit since the last tag warrants a
//    release, bump, changelog, commit, tag, push atomically (fails without
//    side effects if main moved on) and create the GitHub release.
// 3. Finish the release of the current version, also one whose earlier run
//    failed after the push: only if its tag `v<version>` is on origin, on
//    main, and the tagged commit has this name and version. Then, only if npm
//    or the GitHub release lack it, the exact tagged sources are checked out
//    into a worktree, checked again and published from there. dist/ is built
//    there from those sources (by the check and again by npm's `prepack`),
//    never taken from another checkout. A later commit without a version bump
//    is therefore never published under the old version. Errors of `npm view`/`gh release view` other than "not found"
//    abort instead of publishing.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs a command with visible output; throws if it fails.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 */
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

/**
 * Runs a command and returns its result instead of throwing.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 */
function query(command, args, cwd) {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    const { stdout = '', stderr = '' } = /** @type {any} */ (error);

    return { ok: false, stdout: String(stdout), stderr: String(stderr) };
  }
}

/** @param {string[]} args @param {string} [cwd] */
function git(args, cwd) {
  const result = query('git', args, cwd);
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

/**
 * The commit a tag on origin points to, or undefined.
 *
 * @param {string} tag
 */
function remoteTagCommit(tag) {
  const lines = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  // An annotated tag is listed twice; `^{}` is the commit it points to.
  const peeled = lines.find(([, ref]) => ref.endsWith('^{}'));

  return (peeled ?? lines[0])?.[0];
}

/**
 * @param {string} name
 * @param {string} version
 * @returns {boolean} Whether npm has this version; throws if npm cannot tell.
 */
function isPublished(name, version) {
  const result = query('npm', ['view', `${name}@${version}`, 'version', '--json']);
  /** @type {any} */
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = undefined;
  }
  if (result.ok && json === version) {
    return true;
  }
  if (!result.ok && json?.error?.code === 'E404') {
    return false;
  }
  const reason = json?.error?.code ?? (result.stderr.trim() || result.stdout.trim() || 'no answer');
  throw new Error(`cannot tell whether ${name}@${version} is published (${reason}); not publishing.`);
}

/**
 * @param {string} tag
 * @returns {boolean} Whether the GitHub release exists; throws if gh cannot tell.
 */
function hasGitHubRelease(tag) {
  const result = query('gh', ['release', 'view', tag, '--json', 'tagName']);
  if (result.ok) {
    return true;
  }
  if (/^release not found$/m.test(result.stderr.trim())) {
    return false;
  }
  throw new Error(
    `cannot tell whether the GitHub release ${tag} exists (${result.stderr.trim() || 'no answer'}); not publishing.`,
  );
}

/**
 * The CHANGELOG.md section of a version, without its heading.
 *
 * @param {string} changelog
 * @param {string} version
 */
function releaseNotes(changelog, version) {
  /** @type {string[]} */
  const notes = [];
  let inSection = false;
  for (const line of changelog.split('\n')) {
    if (line.startsWith('## ')) {
      inSection = line.startsWith(`## [${version}]`);
    } else if (inSection) {
      notes.push(line);
    }
  }

  return `${notes.join('\n').trim()}\n`;
}

async function finishRelease() {
  const { name, version } = JSON.parse(await readFile('package.json', 'utf8'));
  const tag = `v${version}`;
  const commit = remoteTagCommit(tag);
  if (!commit) {
    console.log(`${tag} is not tagged on origin; nothing to publish.`);

    return;
  }

  // The tag on origin must be the one checked out, on main, and its sources
  // must be this package in this version.
  git([
    'fetch',
    '--quiet',
    '--force',
    'origin',
    `+refs/tags/${tag}:refs/tags/${tag}`,
    '+refs/heads/main:refs/remotes/origin/main',
  ]);
  if (git(['rev-parse', `refs/tags/${tag}^{commit}`]) !== commit) {
    throw new Error(`the local tag ${tag} differs from origin; not publishing.`);
  }
  const tagged = JSON.parse(git(['show', `${commit}:package.json`]));
  if (tagged.name !== name || tagged.version !== version) {
    throw new Error(`${tag} points to ${commit}, which is ${tagged.name} version ${tagged.version}; not publishing.`);
  }
  if (!query('git', ['merge-base', '--is-ancestor', commit, 'origin/main']).ok) {
    throw new Error(`${tag} is not on main; not publishing.`);
  }

  const published = isPublished(name, version);
  const released = hasGitHubRelease(tag);
  if (published && released) {
    console.log(`${tag} is already published and released.`);

    return;
  }

  const temp = await mkdtemp(join(tmpdir(), 'release-'));
  const sources = join(temp, 'sources');
  git(['worktree', 'add', '--quiet', '--detach', sources, commit]);
  try {
    if (git(['rev-parse', 'HEAD'], sources) !== commit) {
      throw new Error(`the worktree of ${tag} is not at ${commit}.`);
    }
    console.log(`Finishing ${tag} from ${commit}.`);
    run('bun', ['install', '--frozen-lockfile'], sources);
    run('bun', ['run', 'check'], sources);
    if (!published) {
      run('npm', ['publish', '--provenance', '--access', 'public'], sources);
    }
    if (!released) {
      const notes = join(temp, 'release-notes.md');
      await writeFile(notes, releaseNotes(await readFile(join(sources, 'CHANGELOG.md'), 'utf8'), version));
      run('gh', ['release', 'create', tag, '--title', tag, '--notes-file', notes, '--verify-tag'], sources);
    }
  } finally {
    query('git', ['worktree', 'remove', '--force', sources]);
    await rm(temp, { recursive: true, force: true });
  }
}

try {
  run('bun', ['run', 'check']);
  // release-it needs a branch; it pushes atomically, so this fails without
  // side effects if main moved on in the meantime. The CI run of the newer
  // commit then releases everything together.
  git(['switch', '--quiet', '--force-create', 'main']);
  git(['branch', '--quiet', '--set-upstream-to', 'origin/main']);
  run('bun', ['run', 'release', '--ci']);
  await finishRelease();
} catch (error) {
  console.error(`Release failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
