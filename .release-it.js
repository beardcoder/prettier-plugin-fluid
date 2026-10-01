// Rolling release: the release workflow runs release-it after CI succeeded on
// main. It only releases if a commit since the last tag warrants a release.
import { readFileSync } from 'node:fs';

import createPreset from 'conventional-changelog-conventionalcommits';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
// The intro of CHANGELOG.md; new sections go below it.
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const header = changelog.slice(0, changelog.search(/^## /m)).trim();
const { whatBump } = createPreset();

/** @type {import("release-it").Config} */
export default {
  git: {
    commitMessage: 'chore(release): v${version}',
    tagName: 'v${version}',
    tagAnnotation: 'v${version}',
    requireBranch: 'main',
    // Fails without side effects if main moved on in the meantime; the
    // release of the newer commit then includes everything.
    pushArgs: ['--follow-tags', '--atomic'],
  },
  github: { release: true, releaseName: 'v${version}' },
  // release-it would publish before pushing; the workflow publishes after the
  // push succeeded, via trusted publishing.
  npm: { publish: false },
  hooks: {
    // Right after the changelog is written, before release-it stages it.
    'after:@release-it/conventional-changelog:beforeRelease': 'oxfmt CHANGELOG.md',
  },
  plugins: {
    '@release-it/conventional-changelog': {
      preset: { name: 'conventionalcommits' },
      infile: 'CHANGELOG.md',
      header,
      // While the version is 0.x, breaking changes bump the minor version
      // instead of releasing 1.0.0; features still bump the minor version.
      whatBump: (commits) => {
        const result = whatBump(commits);

        return result?.level === 0 && version.startsWith('0.') ? { ...result, level: 1 } : result;
      },
    },
  },
};
