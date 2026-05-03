# Changelog

## [Unreleased]

### Added
- Improved cache-hit notes in `/stats` with better formatting and detailed explanations.

### Changed
- Refined `/github wrap` prompt with strict writing style and clearer task phases.
- Updated `/github wrap` safety protocol and authorization rules.

### Added
- New `/github` command (Phase 1) for repository interaction.
- Hardened `/github issue` flow with permission gating to prevent visible failures on read-only repos.
- Silent labeling for GitHub issues: only applies existing labels and skips label creation if unauthorized.
- Improved attachment handling in GitHub issues: fetches images/PDFs once via WebFetch with explicit 404/timeout handling.

## 0.6.2

### Added
- Session report command (`/report`) for generating detailed session summaries.
- Session statistics command (`/stats`) to track usage and performance.
- Navigation commands: `/tree`, `/clone`, and `/import` for enhanced session management.
- Improved branch naming: auto-named branches now use a `last-prompt` seed and `HH:MM` timestamp for better uniqueness.

### Fixed
- Resolved "garbage" names for branches, clones, and imports when launched via slash commands.
- Fixed Tau CI workflow and Kilo cache build issues.

### Changed
- Refined README with centered logo and updated branding assets.

## 0.6.0 - Claudex to Tau migration

- Renamed the product surface from Claudex to Tau across the CLI, docs, terminal UI, and VS Code companion.
- Added the `tau` command and changed install/update flows to use `@abdoknbgit/tau`.
- Kept legacy `claudex` command/config compatibility where needed so existing users are not stranded.
- Reworked the startup logo/theme around the Tau math-symbol identity with the darker red, brown, and black terminal style.
- Renamed the VS Code companion workspace to `tau-vscode` and updated launch defaults to run `tau`.
- Updated provider notes and documented scalable context handling plus fallback recovery.
