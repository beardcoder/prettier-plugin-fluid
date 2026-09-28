# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-28

### Added

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

[Unreleased]: https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/beardcoder/prettier-plugin-fluid/releases/tag/v0.1.0
