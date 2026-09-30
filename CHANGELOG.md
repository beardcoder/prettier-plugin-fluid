# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/) and is released continuously:
every commit on `main` that contains a `feat`, `fix`, `perf`, `revert` or a
breaking change is published automatically. Entries are generated from
[Conventional Commits](https://www.conventionalcommits.org/) by
[release-it](https://github.com/release-it/release-it) with
[conventional-changelog](https://github.com/conventional-changelog/conventional-changelog).

## [0.11.1](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.11.0...v0.11.1) (2026-09-30)

### Bug Fixes

- keep every Fluid occurrence and protect more edge cases ([baa6b51](https://github.com/beardcoder/prettier-plugin-fluid/commit/baa6b514c3b0bf95fa0284cd348b3fcdddaae13c))

## [0.11.0](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.10.0...v0.11.0) (2026-09-30)

### Features

- add fluidArraySpacingInStrings to format arrays in argument strings ([9c50cb9](https://github.com/beardcoder/prettier-plugin-fluid/commit/9c50cb969ae8aba63708aa4566dedf52996bb96b))

## [0.10.0](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.9.2...v0.10.0) (2026-09-30)

### Features

- format arrays only in ViewHelper arguments, like Fluid ([d191d03](https://github.com/beardcoder/prettier-plugin-fluid/commit/d191d036f470febd91b80b1a9d848200812e26e8))

## [0.9.2](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.9.1...v0.9.2) (2026-09-30)

### Bug Fixes

- keep ternary expressions with && or < in the condition as written ([08a7e11](https://github.com/beardcoder/prettier-plugin-fluid/commit/08a7e11feafffd955af4cc5018734d14873c07cc))

## [0.9.1](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.9.0...v0.9.1) (2026-09-30)

### Bug Fixes

- keep too long inline elements on one line instead of hugging their tags ([889ace5](https://github.com/beardcoder/prettier-plugin-fluid/commit/889ace503f5f938d4f9374b649394e83e2784a24))

## [0.9.0](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.8.0...v0.9.0) (2026-09-29)

### Features

- keep f:variable content as written and support all directives in f:comment ([2e7cd4c](https://github.com/beardcoder/prettier-plugin-fluid/commit/2e7cd4c11cab676805d1e44e9db3b460dec467c7))

## [0.8.0](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.7.0...v0.8.0) (2026-09-29)

### Features

- format EXT:form ViewHelpers that render children as blocks ([162598a](https://github.com/beardcoder/prettier-plugin-fluid/commit/162598a742e1d05af27e1dbf35141d21612a06aa))

## [0.7.0](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.6.0...v0.7.0) (2026-09-29)

### Features

- support prettier-ignore in f:comment and prettier-ignore-start/end ranges ([3248fb3](https://github.com/beardcoder/prettier-plugin-fluid/commit/3248fb36bf2458ace4630cba818276d886bc8160))

## [0.6.0](https://github.com/beardcoder/prettier-plugin-fluid/compare/v0.5.1...v0.6.0) (2026-09-28)

### Features

- add fluidArraySpacing option for spaces in Fluid arrays ([9cf397f](https://github.com/beardcoder/prettier-plugin-fluid/commit/9cf397f39bb20850b2509ac0c9c1a1b2ee40608b))

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
