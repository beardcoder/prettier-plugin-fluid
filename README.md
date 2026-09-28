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
detected automatically.

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

| Option                      | Default | Description                                                                                              |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `fluidBlockViewHelpers`     | `[]`    | Additional ViewHelpers laid out as blocks. Supports `*` wildcards.                                       |
| `fluidInlineViewHelpers`    | `[]`    | ViewHelpers laid out inline even if they are blocks by default. Takes precedence.                        |
| `fluidVerbatimViewHelpers`  | `[]`    | Additional ViewHelpers kept exactly as written, like `f:comment`. `f:spaceless` always is. Wildcards ok. |
| `fluidIndentRoot`           | `true`  | Indent the content of the root `<fluid>` tag. See [root tag](#root-tag).                                 |
| `fluidRootAttributePerLine` | `false` | With `fluidIndentRoot: false`: put every attribute of the root tag on its own line.                      |
| `fluidFinalNewline`         | `true`  | End the file with a line break. `false` omits it, e.g. for projects whose templates have none.           |

All standard Prettier options apply, such as `printWidth`, `tabWidth`,
`bracketSameLine` and `singleAttributePerLine`.

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
`data-namespace-typo3-fluid="true"`, such as `<html>`. Add
`"fluidRootAttributePerLine": true` to always put the root tag's attributes
on separate lines, as above.

### Content that must not change

Some ViewHelpers produce strings instead of markup, e.g. a class list built
with `<f:if>` inside `<f:spaceless>`. Added line breaks or indentation would
end up in that string. The content of `f:spaceless` is therefore kept exactly
as written, like `f:comment`. Add your own ViewHelpers of this kind:

```json
{
  "fluidVerbatimViewHelpers": ["my:classList", "my:format.*"]
}
```

### Custom ViewHelpers

Every tag of the form `<ns:name>` is recognized as a ViewHelper, including
your own (`<my:card.teaser>`) and third-party ones (`<v:variable.set>`).
Only these core ViewHelpers are blocks by default:

`f:if` `f:then` `f:else` `f:for` `f:groupedFor` `f:switch` `f:case`
`f:defaultCase` `f:section` `f:layout` `f:render` `f:variable` `f:alias`
`f:argument` `f:slot` `f:fragment` `f:spaceless` `f:cache.*` `f:comment`
`f:form` `f:asset.css` `f:asset.script`

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
- Multi-line Fluid expressions keep their line breaks. A tag containing one
  always puts each attribute on its own line, and the expression's lines move
  along with the tag's indentation.
- Range formatting always formats the whole file.

## How it works

1. Every Fluid shorthand expression is replaced by an opaque placeholder of
   the same width. The expressions are found with the grammar of Fluid's
   `SPLIT_PATTERN_SHORTHANDSYNTAX`. Equal expressions share a placeholder, so
   dynamic tag names like `<h{level}>…</h{level}>` stay balanced.
2. `<f:comment>` elements become opaque HTML comments. Block ViewHelpers get a
   hidden `<!-- display: block -->` hint. Script and style blocks that contain
   Fluid get a hidden `<!-- prettier-ignore -->`.
3. The result is formatted with `parser: "html"`, which uses whichever `html`
   parser the loaded plugins provide.
4. The hints are removed and every placeholder is replaced by the original
   code. A missing placeholder is an error. Parse errors are mapped back to the
   template's own line and column.

## Development

The project uses [Bun](https://bun.sh) for development:

```sh
bun install
bun run check                     # types (tsc on JSDoc), formatting, tests
UPDATE=1 bun test                 # regenerate test/fixtures/*.output.html
bun run test:node                 # same tests on Node.js
bun run corpus path/to/templates  # lossless + idempotency check on real templates
```

The plugin itself is plain ESM without Bun-specific APIs, since Prettier
usually runs on Node.js. The tests use `node:test` so they run on both
runtimes, and CI covers Node 20, 22 and 24.

`bun run corpus` formats every `.html` file below the given directories. It
fails if a Fluid expression or ViewHelper tag is lost, or if a second
formatting pass changes anything. It also lists templates that are not
well-nested HTML, and templates where Prettier normalized content.

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

For a release, the workflow bumps `package.json` and prepends a
[conventional-changelog](https://github.com/conventional-changelog/conventional-changelog)
section to `CHANGELOG.md`. It commits both as `chore(release): vX.Y.Z` and
tags the commit. It then publishes to npm via trusted publishing with
provenance and creates the GitHub release with the same notes.

Preview the next release locally with `bun run release --dry-run`.

## License

[MIT](LICENSE)
