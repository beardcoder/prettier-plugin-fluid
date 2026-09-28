#!/usr/bin/env bun
// Rolling release helper, driven by Conventional Commits.
//
//   bun scripts/release.js [--dry-run]   prepare the next release
//   bun scripts/release.js notes <v>     print the CHANGELOG.md section of <v>
//
// `prepare` looks at the commits since the last version tag. If any of them
// warrants a release (feat, fix, perf, revert or a breaking change), it bumps
// package.json and prepends a conventional-changelog section to CHANGELOG.md.
// Committing, tagging and publishing are left to the release workflow.
// While the version is 0.x, breaking changes bump the minor version instead
// of releasing 1.0.0; features still bump the minor version.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ConventionalChangelog } from "conventional-changelog";
import { Bumper } from "conventional-recommended-bump";
import * as prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const PACKAGE_JSON = new URL("package.json", ROOT);
const CHANGELOG = new URL("CHANGELOG.md", ROOT);
const cwd = ROOT.pathname;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean" } },
});

/**
 * @param {string} version
 * @param {"major" | "minor" | "patch"} releaseType
 */
function increment(version, releaseType) {
  const [major, minor, patch] = version.split(/[.+-]/, 3).map(Number);
  switch (releaseType) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

/** Passes values to later steps of a GitHub Actions job. */
async function setOutput(values) {
  const lines = Object.entries(values).map(
    ([key, value]) => `${key}=${value}\n`,
  );
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, lines.join(""));
  }
  process.stdout.write(lines.join(""));
}

/** @param {string} markdown */
async function formatMarkdown(markdown) {
  const config = await prettier.resolveConfig(CHANGELOG.pathname);
  return prettier.format(markdown, { ...config, parser: "markdown" });
}

/**
 * Returns the section of `version` without its heading.
 *
 * @param {string} changelog
 * @param {string} version
 */
function extractNotes(changelog, version) {
  const sections = changelog.split(/^(?=## )/m);
  const section = sections.find((part) =>
    new RegExp(`^## \\[?${version.replaceAll(".", "\\.")}\\]?[ (]`).test(part),
  );
  return section?.replace(/^## .*\n/, "").trim() ?? "";
}

async function prepare() {
  const pkg = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
  const preset = "conventionalcommits";

  const recommendation = await new Bumper(cwd).loadPreset(preset).bump();
  if (!("releaseType" in recommendation)) {
    console.error(
      `No release: none of the ${recommendation.commits.length} commit(s) since the last tag is a feat, fix, perf, revert or breaking change.`,
    );
    await setOutput({ released: false });
    return;
  }

  const releaseType =
    recommendation.releaseType === "major" && pkg.version.startsWith("0.")
      ? "minor"
      : recommendation.releaseType;
  const version = increment(pkg.version, releaseType);
  console.error(
    `${pkg.version} → ${version} (${releaseType}): ${recommendation.reason}`,
  );

  const generator = new ConventionalChangelog(cwd)
    .package({ ...pkg, version })
    .repository(pkg.repository.url)
    .loadPreset(preset);
  let section = "";
  for await (const chunk of generator.write()) {
    section += chunk;
  }

  if (values["dry-run"]) {
    console.error(`\n${section}`);
    await setOutput({ released: false, version });
    return;
  }

  // Keep the intro of CHANGELOG.md and put the new section above older ones.
  const changelog = await readFile(CHANGELOG, "utf8");
  const firstSection = changelog.search(/^## /m);
  const [intro, releases] =
    firstSection === -1
      ? [changelog, ""]
      : [changelog.slice(0, firstSection), changelog.slice(firstSection)];
  await writeFile(
    CHANGELOG,
    await formatMarkdown(
      `${intro.trimEnd()}\n\n${section.trim()}\n\n${releases}`,
    ),
  );
  await writeFile(
    PACKAGE_JSON,
    `${JSON.stringify({ ...pkg, version }, null, 2)}\n`,
  );
  await setOutput({ released: true, version });
}

async function notes(version) {
  if (!version) {
    throw new Error("Usage: bun scripts/release.js notes <version>");
  }
  const text = extractNotes(
    await readFile(CHANGELOG, "utf8"),
    version.replace(/^v/, ""),
  );
  if (!text) {
    throw new Error(`CHANGELOG.md has no section for ${version}`);
  }
  process.stdout.write(`${text}\n`);
}

const [command = "prepare", ...args] = positionals;
if (command === "prepare") {
  await prepare();
} else if (command === "notes") {
  await notes(args[0]);
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}
