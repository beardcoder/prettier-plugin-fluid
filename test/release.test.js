// Simulates the release job (scripts/release.js) with temporary Git
// repositories and a local bare remote. `bun`, `npm` and `gh` are fakes that
// log their calls; nothing is published and no real tag or release is made.
// Like the real `bun run check`, the fake one builds: it writes dist.txt from
// the checked-out src.txt, and the fake `npm publish` publishes that build.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const releaseScript = fileURLToPath(new URL('../scripts/release.js', import.meta.url));
const NAME = '@example/fluid-release-test';

/** @type {string[]} */
const directories = [];
after(() => Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true }))));

// The fakes run with the same runtime as the tests (Node.js or Bun).
const FAKES = {
  bun: String.raw`
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { log, sha, version, state } = require(process.env.FAKE_LIB);
const args = process.argv.slice(2).join(" ");
if (args === "run check") {
  log("check", sha(), version());
  const fail = process.env.FAKE_CHECK_FAIL ?? "";
  if (fail === "all" || fail === sha()) process.exit(1);
  fs.writeFileSync("dist.txt", "built from " + fs.readFileSync("src.txt", "utf8"));
  process.exit(0);
}
if (args === "install --frozen-lockfile") {
  log("install", sha());
  process.exit(0);
}
if (args === "run release --ci") {
  log("release-it", sha());
  const next = process.env.FAKE_RELEASE ?? "none";
  if (next === "none") process.exit(0);
  if (next === "fail") process.exit(1);
  // Like release-it with .release-it.js: bump, changelog, commit, tag, push
  // atomically, then create the GitHub release.
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.version = next;
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
  const at = changelog.search(/^## /m);
  fs.writeFileSync(
    "CHANGELOG.md",
    changelog.slice(0, at) + "## [" + next + "] (2026-10-01)\n\n* notes of " + next + "\n\n" + changelog.slice(at),
  );
  const git = (...a) => execFileSync("git", a, { stdio: "inherit" });
  git("commit", "-q", "-am", "chore(release): v" + next);
  git("tag", "-a", "v" + next, "-m", "v" + next);
  try {
    git("push", "-q", "--follow-tags", "--atomic");
  } catch {
    process.exit(1);
  }
  fs.writeFileSync(state("gh-release-v" + next), "");
  process.exit(0);
}
log("bun?", args);
process.exit(1);
`,
  npm: String.raw`
const fs = require("node:fs");
const { log, sha, version, state } = require(process.env.FAKE_LIB);
const [command, spec, ...rest] = process.argv.slice(2);
if (command === "view") {
  const error = process.env.FAKE_NPM_ERROR;
  const wanted = spec.slice(spec.lastIndexOf("@") + 1);
  if (error) {
    console.log(JSON.stringify({ error: { code: error, summary: "fake " + error } }));
    console.error("npm error code " + error);
    process.exit(1);
  }
  if (fs.existsSync(state("npm-" + wanted))) {
    console.log(JSON.stringify(wanted));
    process.exit(0);
  }
  console.log(JSON.stringify({ error: { code: "E404", summary: "No match found for version " + wanted } }));
  console.error("npm error code E404");
  process.exit(1);
}
if (command === "publish") {
  log("publish", sha(), version(), [spec, ...rest].join(" "), fs.readFileSync("dist.txt", "utf8").trim());
  fs.writeFileSync(state("npm-" + version()), "");
  process.exit(0);
}
log("npm?", process.argv.slice(2).join(" "));
process.exit(1);
`,
  gh: String.raw`
const fs = require("node:fs");
const { log, sha, state } = require(process.env.FAKE_LIB);
const [group, command, tag, ...rest] = process.argv.slice(2);
if (group === "release" && command === "view") {
  if (process.env.FAKE_GH_ERROR) {
    console.error("HTTP 401: Bad credentials (https://api.github.com/graphql)");
    process.exit(1);
  }
  if (fs.existsSync(state("gh-release-" + tag))) {
    console.log(JSON.stringify({ tagName: tag }));
    process.exit(0);
  }
  console.error("release not found");
  process.exit(1);
}
if (group === "release" && command === "create") {
  const notes = fs.readFileSync(rest[rest.indexOf("--notes-file") + 1], "utf8");
  log("gh-release", tag, sha(), rest.filter((a) => a.startsWith("--") && a !== "--notes-file").join(" "), JSON.stringify(notes.trim()));
  fs.writeFileSync(state("gh-release-" + tag), "");
  process.exit(0);
}
log("gh?", process.argv.slice(2).join(" "));
process.exit(1);
`,
};

const FAKE_LIB = String.raw`
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
exports.log = (...parts) =>
  fs.appendFileSync(process.env.FAKE_LOG, parts.join(" ") + "\n");
exports.sha = () =>
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
exports.version = () =>
  JSON.parse(fs.readFileSync("package.json", "utf8")).version;
exports.state = (name) => path.join(process.env.FAKE_STATE, name);
`;

/**
 * A repository with version 0.1.0 released: commit, annotated tag, pushed.
 * `published`/`released` set up npm and GitHub for that version.
 */
async function setup({ published = false, released = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fluid-release-'));
  directories.push(root);
  const bin = join(root, 'bin');
  const stateDir = join(root, 'state');
  await mkdir(bin);
  await mkdir(stateDir);
  await writeFile(join(root, 'fake-lib.cjs'), FAKE_LIB);
  for (const [name, source] of Object.entries(FAKES)) {
    const file = join(bin, name);
    await writeFile(file, `#!${process.execPath}\n${source}`);
    await chmod(file, 0o755);
  }
  await writeFile(join(root, 'gitconfig'), '');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    // Isolated from the user's Git configuration (signing, hooks, …).
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    FAKE_LIB: join(root, 'fake-lib.cjs'),
    FAKE_LOG: join(root, 'log'),
    FAKE_STATE: stateDir,
  };
  // Nothing of the surrounding CI or a scenario of another test leaks in.
  for (const name of Object.keys(env)) {
    if (/^(npm_|GITHUB_|GH_|FAKE_(RELEASE|CHECK_FAIL|NPM_ERROR|GH_ERROR)$)/.test(name)) {
      delete env[name];
    }
  }
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  /** @param {string} cwd @param {...string} args */
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  await writeFile(join(work, 'package.json'), `${JSON.stringify({ name: NAME, version: '0.1.0' }, null, 2)}\n`);
  await writeFile(
    join(work, 'CHANGELOG.md'),
    '# Changelog\n\n## [0.1.0] (2026-09-01)\n\n* notes of 0.1.0\n\n## [0.0.1] (2026-08-01)\n\n* first\n',
  );
  await writeFile(join(work, 'src.txt'), 'sources of 0.1.0\n');
  // Build output, as in the plugin's repository.
  await writeFile(join(work, '.gitignore'), 'dist.txt\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'chore(release): v0.1.0');
  git(work, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  git(work, 'push', '-q', '--follow-tags', 'origin', 'HEAD:main');
  if (published) await writeFile(join(stateDir, 'npm-0.1.0'), '');
  if (released) await writeFile(join(stateDir, 'gh-release-v0.1.0'), '');

  /** Commits and pushes a change of src.txt. */
  const commit = async (message, content = message) => {
    await writeFile(join(work, 'src.txt'), `${content}\n`);
    git(work, 'commit', '-q', '-am', message);
    git(work, 'push', '-q', 'origin', 'HEAD:main');

    return git(work, 'rev-parse', 'HEAD');
  };

  /** Runs the release job like the workflow: on a detached checkout. */
  const release = async (scenario = {}, ref = 'HEAD') => {
    git(work, 'switch', '-q', '--detach', ref);
    const result = spawnSync(process.execPath, [releaseScript], {
      cwd: work,
      env: { ...env, ...scenario },
      encoding: 'utf8',
    });
    const log = await readFile(env.FAKE_LOG, 'utf8').catch(() => '');
    await rm(env.FAKE_LOG, { force: true });

    return {
      status: result.status,
      output: result.stdout + result.stderr,
      log: log.trim().split('\n').filter(Boolean),
    };
  };

  const remoteTags = () =>
    git(root, 'ls-remote', '--tags', origin)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t')[1]);

  return {
    root,
    work,
    origin,
    env,
    git: (...args) => git(work, ...args),
    gitIn: git,
    commit,
    release,
    remoteTags,
    tagSha: () => git(work, 'rev-parse', 'v0.1.0^{commit}'),
  };
}

const PUBLISH = '--provenance --access public';

// Each simulation runs several Git and fake commands; Bun's default of 5 s
// per test is too tight for slow CI machines.
/** @param {string} name @param {() => Promise<void>} fn */
const simulate = (name, fn) => test(name, { timeout: 60_000 }, fn);

describe('release job', () => {
  simulate('checks, releases and publishes the tagged release commit', async () => {
    const repo = await setup({ published: true, released: true });
    const head = await repo.commit('feat: something new');
    const result = await repo.release({ FAKE_RELEASE: '0.2.0' });
    assert.equal(result.status, 0, result.output);
    const tag = repo.git('rev-parse', 'v0.2.0^{commit}');
    assert.deepEqual(result.log, [
      `check ${head} 0.1.0`,
      `release-it ${head}`,
      `install ${tag}`,
      `check ${tag} 0.2.0`,
      `publish ${tag} 0.2.0 ${PUBLISH} built from feat: something new`,
    ]);
    assert.ok(repo.remoteTags().includes('refs/tags/v0.2.0'));
  });

  simulate('failed checks write nothing', async () => {
    const repo = await setup({ published: true, released: true });
    const head = await repo.commit('feat: something new');
    const result = await repo.release({
      FAKE_RELEASE: '0.2.0',
      FAKE_CHECK_FAIL: 'all',
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.log, [`check ${head} 0.1.0`]);
    assert.ok(!repo.remoteTags().includes('refs/tags/v0.2.0'));
  });

  simulate('resuming publishes exactly the sources of the version tag', async () => {
    const repo = await setup({ released: true });
    const tag = repo.tagSha();
    // A later commit without a version bump must not be published as 0.1.0.
    const head = await repo.commit('docs: later change', 'not released');
    const result = await repo.release();
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.log, [
      `check ${head} 0.1.0`,
      `release-it ${head}`,
      `install ${tag}`,
      `check ${tag} 0.1.0`,
      `publish ${tag} 0.1.0 ${PUBLISH} built from sources of 0.1.0`,
    ]);
  });

  simulate('a skipped version is published by running on its tag', async () => {
    // v0.1.0 never reached npm; v0.2.0 was released after it.
    const repo = await setup({ released: true });
    const tag = repo.tagSha();
    await repo.commit('feat: next');
    const first = await repo.release({ FAKE_RELEASE: '0.2.0' });
    assert.equal(first.status, 0, first.output);
    assert.ok(first.log.some((line) => / 0\.2\.0 --provenance/.test(line)));
    // A manual run for the tag v0.1.0.
    const result = await repo.release({}, 'v0.1.0');
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.log, [
      `check ${tag} 0.1.0`,
      `release-it ${tag}`,
      `install ${tag}`,
      `check ${tag} 0.1.0`,
      `publish ${tag} 0.1.0 ${PUBLISH} built from sources of 0.1.0`,
    ]);
  });

  simulate('a failed check of the tag sources publishes nothing', async () => {
    const repo = await setup();
    const tag = repo.tagSha();
    await repo.commit('docs: later change');
    const result = await repo.release({ FAKE_CHECK_FAIL: tag });
    assert.notEqual(result.status, 0);
    assert.ok(!result.log.some((line) => /^(publish|gh-release)/.test(line)));
    assert.equal(result.log.at(-1), `check ${tag} 0.1.0`);
  });

  simulate('a complete release is left alone', async () => {
    const repo = await setup({ published: true, released: true });
    const head = await repo.commit('docs: later change');
    const result = await repo.release();
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.log, [`check ${head} 0.1.0`, `release-it ${head}`]);
    assert.match(result.output, /v0\.1\.0 is already published and released/);
  });

  simulate("a missing GitHub release is created from the tag's changelog", async () => {
    const repo = await setup({ published: true });
    const tag = repo.tagSha();
    await repo.commit('docs: later change');
    const result = await repo.release();
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.log.slice(2), [
      `install ${tag}`,
      `check ${tag} 0.1.0`,
      `gh-release v0.1.0 ${tag} --title --verify-tag "* notes of 0.1.0"`,
    ]);
  });

  for (const code of ['E401', 'ENEEDAUTH', 'ECONNREFUSED', 'ETIMEDOUT']) {
    simulate(`npm ${code} aborts instead of publishing`, async () => {
      const repo = await setup({ released: true });
      const result = await repo.release({ FAKE_NPM_ERROR: code });
      assert.notEqual(result.status, 0);
      assert.match(result.output, new RegExp(`cannot tell whether ${NAME}@0\\.1\\.0 is published.*${code}`));
      assert.ok(!result.log.some((line) => /^(install|publish|gh-release)/.test(line)));
    });
  }

  simulate('GitHub errors abort instead of publishing', async () => {
    const repo = await setup();
    const result = await repo.release({ FAKE_GH_ERROR: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /cannot tell whether the GitHub release v0\.1\.0 exists.*Bad credentials/);
    assert.ok(!result.log.some((line) => /^(install|publish|gh-release)/.test(line)));
  });

  simulate('if main moved on, the atomic push fails and nothing is released', async () => {
    const repo = await setup({ published: true, released: true });
    await repo.commit('feat: something new');
    // Another commit reaches main after CI tested ours.
    const other = join(repo.root, 'other');
    repo.gitIn(repo.root, 'clone', '-q', repo.origin, other);
    await writeFile(join(other, 'src.txt'), 'newer\n');
    repo.gitIn(other, 'commit', '-q', '-am', 'fix: newer');
    repo.gitIn(other, 'push', '-q', 'origin', 'HEAD:main');
    const result = await repo.release({ FAKE_RELEASE: '0.2.0' });
    assert.notEqual(result.status, 0);
    assert.ok(!repo.remoteTags().includes('refs/tags/v0.2.0'));
    assert.ok(!result.log.some((line) => /^(install|publish|gh-release)/.test(line)));
  });

  simulate('a tag whose sources have another version is refused', async () => {
    const repo = await setup();
    // v0.2.0 on origin, but its commit still says 0.1.0.
    const wrong = await repo.commit('docs: no bump');
    repo.git('tag', '-a', 'v0.2.0', '-m', 'v0.2.0', wrong);
    repo.git('push', '-q', 'origin', 'v0.2.0');
    const pkg = JSON.parse(await readFile(join(repo.work, 'package.json'), 'utf8'));
    await writeFile(join(repo.work, 'package.json'), JSON.stringify({ ...pkg, version: '0.2.0' }));
    repo.git('commit', '-q', '-am', 'chore: bump without tag');
    repo.git('push', '-q', 'origin', 'HEAD:main');
    const result = await repo.release();
    assert.notEqual(result.status, 0);
    assert.match(result.output, /v0\.2\.0 .*version 0\.1\.0/);
    assert.ok(!result.log.some((line) => /^(install|publish|gh-release)/.test(line)));
  });

  simulate('a tag that is not on main is refused', async () => {
    const repo = await setup({ published: true, released: true });
    repo.git('switch', '-q', '-c', 'side');
    const pkg = JSON.parse(await readFile(join(repo.work, 'package.json'), 'utf8'));
    await writeFile(join(repo.work, 'package.json'), `${JSON.stringify({ ...pkg, version: '0.3.0' }, null, 2)}\n`);
    repo.git('commit', '-q', '-am', 'chore(release): v0.3.0');
    repo.git('tag', '-a', 'v0.3.0', '-m', 'v0.3.0');
    repo.git('push', '-q', 'origin', 'v0.3.0');
    // main gets the same version without that tagged commit.
    repo.git('switch', '-q', 'main');
    await writeFile(join(repo.work, 'package.json'), `${JSON.stringify({ ...pkg, version: '0.3.0' }, null, 2)}\n`);
    repo.git('commit', '-q', '-am', 'chore: other 0.3.0');
    repo.git('push', '-q', 'origin', 'HEAD:main');
    const result = await repo.release();
    assert.notEqual(result.status, 0);
    assert.match(result.output, /v0\.3\.0 is not on main/);
    assert.ok(!result.log.some((line) => /^(install|publish|gh-release)/.test(line)));
  });

  simulate('an untagged version is not published', async () => {
    const repo = await setup({ published: true, released: true });
    const pkg = JSON.parse(await readFile(join(repo.work, 'package.json'), 'utf8'));
    await writeFile(join(repo.work, 'package.json'), `${JSON.stringify({ ...pkg, version: '0.4.0' }, null, 2)}\n`);
    repo.git('commit', '-q', '-am', 'chore: bump without release');
    repo.git('push', '-q', 'origin', 'HEAD:main');
    const result = await repo.release();
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /v0\.4\.0 is not tagged on origin/);
    assert.ok(!result.log.some((line) => /^(install|publish|gh-release)/.test(line)));
  });
});

describe('release workflow', () => {
  test('runs the release job script on both triggers', async () => {
    const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    assert.match(workflow, /workflow_run:\n\s+workflows: \[CI\]/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /github\.event_name == 'workflow_dispatch' \|\|/);
    assert.match(workflow, /\n\s+node scripts\/release\.js\n/);
    assert.match(workflow, /id-token: write/);
    assert.match(workflow, /environment: npm/);
    // Every writing step is in the tested script.
    assert.doesNotMatch(
      workflow.replace(/^\s*#.*$/gm, ''),
      /\bnpm publish\b|\bgh release create\b|\bbun run release\b/,
    );
  });
});
