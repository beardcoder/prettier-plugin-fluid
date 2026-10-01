# @beardcoder/prettier-plugin-fluid

[![npm](https://img.shields.io/npm/v/@beardcoder/prettier-plugin-fluid)](https://www.npmjs.com/package/@beardcoder/prettier-plugin-fluid)
[![CI](https://github.com/beardcoder/prettier-plugin-fluid/actions/workflows/ci.yml/badge.svg)](https://github.com/beardcoder/prettier-plugin-fluid/actions/workflows/ci.yml)

[Prettier](https://prettier.io) plugin for [TYPO3 Fluid](https://github.com/typo3/fluid) templates.

- **Plays nicely with other plugins.** The HTML structure is formatted by
  Prettier's own `html` parser, so plugins that hook into it keep working, such as
  [attribute sorting](#sorting-attributes) and Tailwind class sorting.
- **Never touches your Fluid code.** Shorthand syntax like
  `{item.title -> f:format.crop(maxCharacters: 20)}` is kept byte-for-byte,
  including arbitrarily nested inline syntax and escaped quotes:
  `{f:if(condition: '{a}', then: '{f:translate(key: \'x\')}')}`.
- **Understands ViewHelpers.** Structural tags (`f:if`, `f:for`,
  `f:section`, …) are laid out as blocks. Inline ones (`f:link.*`,
  `f:translate`, …) behave like `<a>`. Custom ViewHelpers
  [are configurable](#custom-viewhelpers).
- **Formats inline assets.** The content of `<f:asset.css>` and
  `<f:asset.script>` is formatted as CSS and JavaScript, just like `<style>`
  and `<script>`.
- **Safe by design.** Some parts are kept verbatim: `<f:comment>` content,
  CDATA sections, conditional wrappers like
  `<f:if …><div></f:if>`, and `<script>`/`<style>`/`<f:asset.*>` blocks that contain Fluid
  code. If formatting would ever drop Fluid code, the plugin fails instead of
  writing the file.
- **Helpful errors.** When a template is invalid HTML, the error points at the
  line and column in your template.

## Installation

```sh
bun add -d prettier @beardcoder/prettier-plugin-fluid
# or
npm install --save-dev prettier @beardcoder/prettier-plugin-fluid
```

Requires Prettier 3 and Node.js 20 or later, or Bun.

Fluid templates are usually plain `.html` files, so assign the `fluid` parser
to them in your Prettier config (`.prettierrc.json`):

```json
{
  "plugins": ["@beardcoder/prettier-plugin-fluid"],
  "overrides": [
    {
      "files": [
        "**/Resources/Private/**/{Templates,Layouts,Partials,Components,PageView}/**/*.html",
        "**/ContentBlocks/**/templates/**/*.html"
      ],
      "options": { "parser": "fluid" }
    }
  ]
}
```

These are the same locations the
[Fluid extension for VS Code](https://github.com/FriendsOfTYPO3/vscode-fluid-language)
treats as Fluid templates. Files ending in `.fluid` or `.fluid.html` are
detected automatically (`.fluid.html` from Prettier 3.6 on; older versions
treat it as `.html`, so assign the parser via `overrides` there).

```sh
bunx prettier --write "**/Resources/Private/**/*.html"
```

Only HTML templates are supported. Plain-text templates (e.g. `*.fluid.txt`
for text emails) are not formatted: an HTML formatter would change their line
breaks.

### VS Code

Install the [Prettier extension](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
and the [Fluid extension](https://marketplace.visualstudio.com/items?itemName=FriendsOfTYPO3.fluid-language).
The Fluid extension marks HTML templates with the language `html-fluid`, which
this plugin registers for. Prettier then formats them on save:

```json
{
  "[html-fluid]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.formatOnSave": true
  }
}
```

## Sorting attributes

Use
[`prettier-plugin-organize-attributes`](https://github.com/NiklasPor/prettier-plugin-organize-attributes).
It sorts attributes on HTML tags and on ViewHelper tags. This order suits
Fluid templates: the attributes that identify a ViewHelper call come first,
then everything else alphabetically.

```json
{
  "plugins": [
    "@beardcoder/prettier-plugin-fluid",
    "prettier-plugin-organize-attributes"
  ],
  "attributeGroups": [
    "^data-namespace-typo3-fluid$",
    "^xmlns$",
    "^partial$",
    "^section$",
    "^name$",
    "^type$",
    "^each$",
    "^as$",
    "^key$",
    "^tagName$",
    "^src$",
    "$DEFAULT"
  ],
  "attributeSort": "ASC",
  "attributeIgnoreCase": true
}
```

organize-attributes matches namespaced attributes by their local name only:
`xmlns:ce` is sorted as `ce`, so it would end up before
`data-namespace-typo3-fluid`. That is why `data-namespace-typo3-fluid` needs a
group of its own at the start. A `^xmlns` group only matches a plain `xmlns`
attribute.

### Tailwind CSS

Add
[`prettier-plugin-tailwindcss`](https://github.com/tailwindlabs/prettier-plugin-tailwindcss)
as the **last** plugin. It chains organize-attributes internally:

```json
{
  "plugins": [
    "@beardcoder/prettier-plugin-fluid",
    "prettier-plugin-organize-attributes",
    "prettier-plugin-tailwindcss"
  ]
}
```

Tailwind treats Fluid expressions inside `class` as unknown classes and
moves them to the front.

## Options

| Option                       | Default      | Description                                                                                              |
| ---------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `fluidBlockViewHelpers`      | `[]`         | Additional ViewHelpers laid out as blocks. Supports `*` wildcards.                                       |
| `fluidInlineViewHelpers`     | `[]`         | ViewHelpers laid out inline even if they are blocks by default. Takes precedence.                        |
| `fluidVerbatimViewHelpers`   | `[]`         | Custom ViewHelpers kept exactly as written, like `f:comment`, `f:spaceless`, `f:variable`. Wildcards ok. |
| `fluidIndentRoot`            | `true`       | Indent the content of the root `<fluid>` tag. See [root tag](#root-tag).                                 |
| `fluidRootAttributePerLine`  | `false`      | With `fluidIndentRoot: false`: put every attribute of the root tag on its own line.                      |
| `fluidFinalNewline`          | `true`       | End the file with a line break. `false` omits it, e.g. for projects whose templates have none.           |
| `fluidArraySpacing`          | `"preserve"` | Spaces inside Fluid arrays: `"always"` → `{ a: 1 }`, `"never"` → `{a: 1}`. See [arrays](#arrays).        |
| `fluidArraySpacingInStrings` | `false`      | With `fluidArraySpacing`: also format arrays in quoted strings of ViewHelper arguments.                  |

All standard Prettier options apply, such as `printWidth`, `tabWidth`,
`bracketSameLine` and `singleAttributePerLine`.

The package ships TypeScript declarations. In a `prettier.config.ts`, the
plugin's options are typed with `FluidOptions`:

```ts
import type { Config } from 'prettier';
import type { FluidOptions } from '@beardcoder/prettier-plugin-fluid';

const config: Config & FluidOptions = {
  plugins: ['@beardcoder/prettier-plugin-fluid'],
  fluidArraySpacing: 'always',
};

export default config;
```

### Root tag

TYPO3 recommends `<fluid data-namespace-typo3-fluid="true" …>` as the root of
a template. Many projects do not indent its content. With
`"fluidIndentRoot": false`, the root tag is formatted on its own and its
content is not indented. An empty line follows the opening tag and precedes
the closing tag:

```html
<fluid
  data-namespace-typo3-fluid="true"
  xmlns:f="http://typo3.org/ns/TYPO3/CMS/Fluid/ViewHelpers"
>
  <f:layout name="Default" />
</fluid>
```

This applies to `<fluid>` and to any root tag with
`data-namespace-typo3-fluid="true"`, such as `<html>`. A DOCTYPE and
comments before the root tag are kept as written. Add
`"fluidRootAttributePerLine": true` to always put the root tag's attributes
on separate lines, as above.

### Arrays

By default, Fluid expressions are kept exactly as written. With
`"fluidArraySpacing": "always"` or `"never"`, single-line Fluid arrays get one
space after each comma and spaces inside the braces, or none:

```html
<!-- "always" -->
<f:render partial="Card" arguments="{item:item,title:'A'}" />
<f:render partial="Card" arguments="{ item:item, title:'A' }" />

<!-- "never" -->
<p>{f:translate(key: 'x', arguments: { 0: 'a', 1: 'b' })}</p>
<p>{f:translate(key: 'x', arguments: {0: 'a', 1: 'b'})}</p>
```

Like Fluid itself, the plugin only sees arrays in ViewHelper arguments: in
attribute values of ViewHelper tags and in the arguments of inline ViewHelpers.
Elsewhere, Fluid outputs `{a: 1}` as text, so it is never changed, e.g. in
`<p>{a: 1}</p>` or Alpine's `x-data="{open: false}"`. Nested arrays are
formatted the same way. Keys, values and the space around `:` stay as written,
as do strings and multi-line arrays.

Quoted strings in ViewHelper arguments are parsed by Fluid as well, so
`then: '{a: 1}'` also contains an array. Such strings are kept as written by
default; add `"fluidArraySpacingInStrings": true` to format their arrays, too:

```html
<p>{f:if(condition: x, then: '{a:1,b:2}')}</p>
<p>{f:if(condition: x, then: '{ a:1, b:2 }')}</p>
```

### Content that must not change

Some ViewHelpers produce strings instead of markup, e.g. a class list built
with `<f:if>` inside `<f:spaceless>`, or the value of `<f:variable>` given as
its content. Added line breaks or indentation would end up in that string. The
content of `f:spaceless` and `f:variable` is therefore kept exactly as written,
like `f:comment`. Add your own ViewHelpers of this kind:

```json
{
  "fluidVerbatimViewHelpers": ["my:classList", "my:format.*"]
}
```

### Custom ViewHelpers

Every tag of the form `<ns:name>` is recognized as a ViewHelper, including
your own (`<my:card.teaser>`) and third-party ones (`<v:variable.set>`).
Only these core ViewHelpers (and those of EXT:form, with its usual `formvh`
prefix) are blocks by default:

`f:if` `f:then` `f:else` `f:for` `f:groupedFor` `f:switch` `f:case`
`f:defaultCase` `f:section` `f:layout` `f:render` `f:variable` `f:alias`
`f:argument` `f:slot` `f:fragment` `f:spaceless` `f:cache.*` `f:comment`
`f:form` `f:asset.css` `f:asset.script` `formvh:form`
`formvh:renderAllFormValues` `formvh:renderFormValue` `formvh:renderRenderable`

Custom ViewHelpers that wrap markup should usually be added:

```json
{
  "fluidBlockViewHelpers": ["my:grid", "my:card.*", "v:variable.set"]
}
```

To change the layout of a single tag, put `<!-- display: inline -->` or
`<!-- display: block -->` in front of it.

### Ignoring code

Exclude a single element with a comment:

```html
<!-- prettier-ignore -->
<f:if condition="{a}"><b>kept   exactly as written</b></f:if>
```

Exclude a range, up to the end of the template if the end comment is missing:

```html
<!-- prettier-ignore-start -->
<p>kept exactly</p>
<p>as written</p>
<!-- prettier-ignore-end -->
```

To keep these comments out of the rendered HTML, wrap them in `<f:comment>`:
`<f:comment><!-- prettier-ignore --></f:comment>`. This also works for
`prettier-ignore-attribute` and `display: …`.

Exclude whole templates in `.prettierignore`, e.g. ones that are not valid
HTML (see [limitations](#limitations)):

```gitignore
packages/*/Resources/Private/Partials/Legacy/**
**/Templates/Page/Special.fluid.html
```

The plugin also supports `requirePragma` and `insertPragma`
(`<!-- @format -->`).

## Limitations

- **Conditional wrappers are kept as written.** Fluid allows a ViewHelper
  around only an opening or a closing tag:

  ```html
  <f:if condition="{link}"><a href="{link}"></f:if>
  ```

  An HTML formatter cannot restructure such a ViewHelper element, so it is kept
  exactly as written. The rest of the template is still formatted. For the same
  reason, elements with implied end tags inside a ViewHelper (`<li>a<li>b`) are
  kept as written.

- **Invalid HTML elsewhere fails.** Examples are Fluid tags inside another
  tag's attribute list, or a tag that is never closed. Such templates fail with
  an error that points at the line and column in the template. Restructure
  them, or exclude them with `<!-- prettier-ignore -->` or `.prettierignore`.

- **Prettier itself changes some HTML**, just as for plain HTML files:
  - Void elements are self-closed: `<img>` → `<img />`, `<br>` → `<br />`.
  - Implied end tags are completed: `<li>a<li>b` → `<li>a</li><li>b</li>`.
  - CSS in `style` attributes is normalized, e.g. a missing `;` is added.
  - Short content is joined into one line: `<div>\n  x\n</div>` → `<div>x</div>`,
    also inside ViewHelpers like `<f:else>`.
  - Files end with exactly one line break, unless `fluidFinalNewline` is
    `false`.
- A block ViewHelper inside inline content may add whitespace, just as Prettier
  does around block elements.
- An inline element that does not fit the print width cannot be broken
  between its tags and content without adding whitespace. Its opening tag
  instead gets each attribute on its own line, with the `>` directly before the
  content at the tag's indentation (or after the last attribute with
  `bracketSameLine`). Closing tags stay on one line:

  <!-- prettier-ignore -->
  ```html
  <f:link.page
    pageUid="{uid}"
    class="underline hover:text-accent"
  >Privacy policy</f:link.page>
  ```

- Multi-line Fluid expressions keep their line breaks. A tag containing one
  always puts each attribute on its own line, and the expression's lines move
  along with the tag's indentation.
- Range formatting always formats the whole file.

## How it works

1. Every Fluid shorthand expression is replaced by an opaque placeholder of
   the same width. The expressions are found with the grammar of Fluid's
   `SPLIT_PATTERN_SHORTHANDSYNTAX`. Equal expressions share a placeholder, so
   dynamic tag names like `<h{level}>…</h{level}>` stay balanced.
2. `<f:comment>` elements become opaque HTML comments. ViewHelper tags become
   custom elements of the same width (`<f:if>` → `<f-if>`). Block ViewHelpers
   get a hidden `<!-- display: block -->` hint. Script and style blocks that
   contain Fluid get a hidden `<!-- prettier-ignore -->`, also after a
   `display: …` or `prettier-ignore-attribute` comment.
3. The result is formatted with `parser: "html"`, which uses whichever `html`
   parser the loaded plugins provide.
4. Tags of inline elements Prettier broke before their content
   (`<a href="…"\n  >text</a\n>`) get the layout above. The hints are
   removed and every placeholder is replaced by the original code. A missing,
   duplicated or unknown placeholder is an error. Parse errors are mapped back
   to the template's own line and column.

## Development

The project uses [Bun](https://bun.sh) for development:

```sh
bun install
bun run build                     # compile src/ to dist/ (deletes dist/ first)
bun run typecheck                 # tsc --noEmit
bun run lint                      # oxlint (type-aware), `lint:fix` applies fixes
bun run format                    # oxfmt, `format:check` only checks
bun run check                     # types, lint, formatting, build, tests, strict corpus check
bun run test                      # bun test, directly on the TypeScript sources
UPDATE=1 bun run test             # regenerate test/fixtures/*.output.html
bun run corpus path/to/templates  # lossless + idempotency check on real templates
bun run corpus:strict             # strict check of the versioned corpus in test/corpus
bun run test:package              # build, then smoke test of the packed npm package
```

The plugin is written in TypeScript (`src/`) and compiled by `tsc` to ESM
JavaScript with type declarations in `dist/`, which is not checked in. The
npm package contains only `dist/` (plus `README.md`, `LICENSE` and
`CHANGELOG.md`), so users need neither Bun nor TypeScript, and
`@prettier/html-tags` as its only dependency. `bun run build` deletes `dist/`
before compiling, so no stale modules remain; `npm pack` and `npm publish`
build via `prepack`. Tests and the corpus check run the TypeScript sources
directly with Bun; the package script builds first, so it always checks freshly
compiled code. Building needs Node.js 20.10 or later (for
TypeScript 7's `tsc`); the built plugin runs on Node.js 20 and later.

The source is split by responsibility:

| Module                     | Responsibility                                                          |
| -------------------------- | ----------------------------------------------------------------------- |
| `index.ts`                 | Plugin object: `fluid` parser and printer, public exports               |
| `options.ts`               | Language registration, Fluid options with defaults, `FluidOptions`      |
| `format.ts`                | Nested Prettier call, forwarded options, root tag, error positions      |
| `elements.ts`              | Element categories (void, raw text, assets) and default ViewHelpers     |
| `lexer.ts`                 | Recognizes Fluid/HTML syntax and returns ranges into the unchanged text |
| `preprocess.ts`            | Protection rules; placeholders, hints and the intermediate HTML         |
| `restore.ts`               | Restoring placeholders and tags, occurrence check, quotes, indentation  |
| `arrays.ts`                | `fluidArraySpacing`                                                     |
| `positions.ts`, `types.ts` | Position mapping for errors; shared data structures                     |

Void elements come from [`@prettier/html-tags`](https://github.com/prettier/html-tags),
except for historical ones (`basefont`, `bgsound`, `command`, `frame`,
`image`, `keygen`, `param`), which the plugin keeps treating as ordinary
elements; which elements are raw text, assets or block ViewHelpers are rules
of this plugin. The tests use [`bun:test`](https://bun.com/docs/test). CI runs
them with Prettier 3.0.0 and the latest 3.x release, and runs the packed
package with both on Node 20, 22 and 24 (`bun run test:package`).

Fixtures in `test/fixtures` are formatted with this plugin alone, unless their
`<name>.options.json` lists further `plugins` they are an integration test
for. Tests with `prettier-plugin-tailwindcss` are only skipped for the known
incompatible combination (0.8.x before Prettier 3.7); any other failure fails
the suite.

`bun run corpus` formats every `.html`, `.fluid.html` and `.fluid` file below
the given directories (not plain-text templates like `.fluid.txt`). It fails
if an occurrence of a Fluid expression, a ViewHelper tag, verbatim content
(`<f:comment>`, ignored ranges, …) or a script/style body with Fluid is lost
or changed, if a second formatting pass changes anything or fails, or on
unexpected errors. Re-indenting expressions outside of strings and sorting
attributes are fine. It also lists templates that are not well-nested HTML,
and templates where Prettier normalized content.

With `--strict` (`bun scripts/check-corpus.js --strict <dir>`), parse errors
and finding no template at all fail, too. `bun run corpus:strict` checks the
small corpus of regression templates in `test/corpus` this way; `bun run
check` and CI include it.

`bun run test:package` builds the package, packs it with
`npm pack --ignore-scripts` (`prepare` would install Git hooks) into a
temporary directory and installs the tarball with its dependencies, Prettier
and TypeScript from the registry into a temporary consumer project. There it
imports the plugin by its package name, checks the exports (internal modules
are not importable), formats templates twice, detects `.fluid` and
`.fluid.html` by file name, formats `.html` with `parser: "fluid"`, runs
Prettier's CLI and type-checks a TypeScript file using the plugin and
`FluidOptions` with `tsc --noEmit`. It also checks that a rebuild leaves no output of removed modules,
that the package contains exactly the compiled modules and declarations of
`src/` and no sources, tests or other development files, and that the
repository is left as it was.
Nothing is published. It needs network access to the npm registry;
`--prettier <version>` selects the Prettier version, `--package-dir <dir>`
another checkout.

### Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/),
e.g. `fix(parser): keep f:comment content verbatim`. `bun install` sets up a
[commitlint](https://commitlint.js.org) Git hook, and CI checks every commit.

### Releasing

Releases are fully automatic (rolling release). After CI passes on `main`, the
[release workflow](.github/workflows/release.yml) looks at the commits since
the last version tag:

| Commits                                                 | Release                          |
| ------------------------------------------------------- | -------------------------------- |
| `feat`                                                  | minor                            |
| `fix`, `perf`, `revert`                                 | patch                            |
| breaking change (`feat!:` or `BREAKING CHANGE:` footer) | major (minor while still on 0.x) |
| only `docs`, `chore`, `ci`, `test`, `refactor`, …       | none                             |

For a release, the workflow runs [release-it](https://github.com/release-it/release-it)
(configured in [`.release-it.js`](.release-it.js)). It bumps `package.json`,
prepends a
[conventional-changelog](https://github.com/conventional-changelog/conventional-changelog)
section to `CHANGELOG.md`, commits both as `chore(release): vX.Y.Z`, tags and
pushes the commit and creates the GitHub release with the same notes. The
workflow then publishes to npm via trusted publishing with provenance.

The whole job is [`scripts/release.js`](scripts/release.js), the same for the
automatic run after CI and for a manual run:

1. `bun run check` runs first; if it fails, nothing is committed, tagged,
   released or published.
2. release-it pushes the release commit and tag atomically. If `main` moved on
   since the tested commit, the push fails without side effects, and the CI
   run of the newer commit releases everything together.
3. The current version is finished only if its tag `vX.Y.Z` is on origin,
   is on `main` and points to a commit whose `package.json` has this name and
   version. If npm or GitHub lack the release, exactly the tagged commit is
   checked out into a separate worktree, checked again and published or
   released from there; `dist/` is built there from the tagged sources.

`npm view` and `gh release view` must answer "not found" for a missing
release; any other error (authentication, network, …) aborts the job instead
of publishing. An already published version is never published again.

**Resuming a release.** If a run failed after the tag was pushed (e.g. npm or
GitHub were unavailable), start the workflow manually on `main` ("Run
workflow"). It publishes the missing npm package and/or creates the missing
GitHub release from the tagged sources, even if commits without a version
bump followed; those are released with the next version. If a newer version
was released in the meantime, only that one is finished on `main`; to publish
the skipped version, run the workflow with its tag as the ref. This works for
tags made with this release setup (`scripts/release.js` and `.release-it.js`
in the tagged commit), not for older ones such as `v0.11.0`.

Operational requirements, which the tests cannot check:

- npm: a trusted publisher for the package bound to this repository, the
  workflow file `release.yml` and the environment `npm`. The job installs npm
  ≥ 11.5.1, which trusted publishing needs.
- GitHub: an environment named `npm`; the workflow's `GITHUB_TOKEN` needs
  `contents: write` (release commit, tag, release) and `id-token: write`
  (OIDC), and must be allowed to push to `main` if it is protected.
- Provenance is signed for the workflow run; when resuming, the published
  files are those of the tag, even if the run was started for a later commit.

The release logic is simulated in `test/release.test.js` with temporary Git
repositories, a local remote and fake `bun`, `npm` and `gh` commands; it runs
with the other tests. Preview the next release locally with
`bun run release --dry-run`.

## License

[MIT](LICENSE)
