# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/) and is released continuously:
every commit on `main` that contains a `feat`, `fix`, `perf`, `revert` or a
breaking change is published automatically. Entries are generated from
[Conventional Commits](https://www.conventionalcommits.org/) by
[conventional-changelog](https://github.com/conventional-changelog/conventional-changelog).

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
