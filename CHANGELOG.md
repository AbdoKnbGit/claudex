# Changelog

## 0.6.0 - Claudex to Tau migration

- Renamed the product surface from Claudex to Tau across the CLI, docs, terminal UI, and VS Code companion.
- Added the `tau` command and changed install/update flows to use `@abdoknbgit/tau`.
- Kept legacy `claudex` command/config compatibility where needed so existing users are not stranded.
- Reworked the startup logo/theme around the Tau math-symbol identity with the darker red, brown, and black terminal style.
- Renamed the VS Code companion workspace to `tau-vscode` and updated launch defaults to run `tau`.
- Updated provider notes and documented scalable context handling plus fallback recovery.
