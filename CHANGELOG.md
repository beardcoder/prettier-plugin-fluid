# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/) and is released continuously:
every commit on `main` that contains a `feat`, `fix`, `perf`, `revert` or a
breaking change is published automatically. Entries are generated from
[Conventional Commits](https://www.conventionalcommits.org/) by
[conventional-changelog](https://github.com/conventional-changelog/conventional-changelog).

## [0.5.1](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.5.0...v0.5.1) (2026-09-28)

### Bug Fixes

- keep ViewHelper arguments with escaped quotes outside of expressions ([7d7a503](https://github.com/beardcoder/prettier-plugin-fluid/commit/7d7a5032cb12f8851c79c2403f7cfd2c0ca6a387))
- register for the html-fluid VS Code language instead of fluid ([eef2ae4](https://github.com/beardcoder/prettier-plugin-fluid/commit/eef2ae412f1a32693e4e02beb47c0a48dc7dc0d6))

## [0.5.0](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.4.0...v0.5.0) (2026-09-28)

### Features

- format the content of f:asset.css and f:asset.script as CSS and JavaScript ([7c9e242](https://github.com/beardcoder/prettier-plugin-fluid/commit/7c9e242725ee5c21fe2b2e13191ff889219a6789))

## [0.4.0](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.3.0...v0.4.0) (2026-09-28)

### Features

- add fluidFinalNewline to keep or omit the final line break ([12c90a3](https://github.com/beardcoder/prettier-plugin-fluid/commit/12c90a33483e6fbc40c5dbf2e737e520b02ebee9))

## [0.3.0](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.2.0...v0.3.0) (2026-09-28)

### Features

- add fluidIndentRoot, fluidVerbatimViewHelpers and reflow multi-line attributes ([94d5c42](https://github.com/beardcoder/prettier-plugin-fluid/commit/94d5c42eafd2d6c6d78667dcbfd5df9becc43c9a))

### Bug Fixes

- keep the quotes of attribute values whose Fluid code contains quotes ([175171e](https://github.com/beardcoder/prettier-plugin-fluid/commit/175171e65fca331a7b88654338113e3739cb21fe))

## [0.2.0](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.1.0...v0.2.0) (2026-09-28)

### Features

- keep ViewHelper elements with unbalanced HTML as written ([a6f15d9](https://github.com/beardcoder/prettier-plugin-fluid/commit/a6f15d9b502d56fc7add98dd88d00719b0141a32))

## [0.1.0](https://github.com/beardcoder/prettier-plugin-fluid/releases/tag/v0.1.0) (2026-09-28)

### Features

- `fluid` parser for TYPO3 Fluid templates, built on Prettier's `html` parser so
  that plugins such as `prettier-plugin-organize-attributes` and
  `prettier-plugin-tailwindcss` work unchanged.
- Lossless handling of Fluid shorthand syntax, including nested inline syntax,
  escaped quotes, dynamic tag names and expressions in attribute-name position.
- Block layout for structural core ViewHelpers. Custom ViewHelpers are
  configurable via `fluidBlockViewHelpers` / `fluidInlineViewHelpers` (with `*`
  wildcards).
- Verbatim `<f:comment>`, CDATA, and `<script>`/`<style>` blocks that contain
  Fluid code.
- Parse errors that report the line and column in the original template.
- `requirePragma` / `insertPragma` support.
