# Changelog

## Unreleased - Session navigation: tree, clone, and import

Three new slash commands let you move around your conversations the same way you move around files. None of the existing commands changed; these are pure additions you can ignore until you need them.

- `/tree` — Opens a picture of every conversation in this project. The lines `├─ │ └─` show which conversation came from which (a fork, a clone, or a fresh start). The one you're currently in has a green `← active` next to it. Use the arrow keys to walk the picture, type any letters to filter by title, and hit Enter to jump into a different conversation. Esc closes the picture without changing anything. Think of it as a map of your work in this project.
- `/clone` — Makes a safety copy of the conversation you're in right now and drops you inside the copy, so the original is left frozen as a backup. Use this before you try something risky ("let me refactor this whole thing"): if it goes sideways you don't lose your previous state — open `/tree` (or `/resume`) and pick the original back. Optional label: `/clone before-refactor` will name the copy so future-you can spot it in `/tree`.
- `/import` — Pulls in a conversation that someone else shared with you. Ask them to send you the `.jsonl` file from their `~/.claude/projects/<their-project>/<id>.jsonl`, save it anywhere on your machine, then run `/import ~/Downloads/their-session.jsonl`. Tau will confirm before doing anything, then make a fresh copy in your project (their original file is not touched), retitle it `... (Imported)`, and drop you inside it so you can keep working from where they stopped. The imported conversation also shows up in `/tree`, hanging off the conversation it came from.

Quick mental model: `/branch` already existed and creates a fork (a new conversation that diverges from a chosen point — same as before). `/clone` is "fork right now and keep going in the copy." `/tree` is "show me everything you have." `/import` is "take this file from a friend and add it to my map."

Nothing existing was changed: `/branch` (`/fork`), `/export`, `/rewind`, and `/resume` all behave exactly as before. The on-disk session format is identical, so you can roll back without migration.

**Smarter naming for branches and clones.** When you opened `/branch` from a slash-command, the new conversation was getting titled with the command-launcher boilerplate ("`<local-command-caveat>...`") instead of your real first message — making `/tree` unreadable. Now `/branch`, `/clone`, and `/import` all skip the wrapper noise (slash-command echoes, IDE metadata tags, `<local-command-caveat>`, hook output) and pick the first thing you actually typed. Already-saved garbage titles are also auto-cleaned in the `/tree` view by falling back to the same skip-aware preview, so you don't have to rename old branches by hand.

**Distinguishable branch names.** Because `/branch` and `/clone` copy the entire conversation forward, every new branch was being titled after the root session — three branches off "hey" all read "hey (Branch)", "hey (Branch 2)", "hey (Branch 3)" in `/tree` with no way to tell them apart. Two changes fix this:

- Auto-named branches now use the **latest** thing you said before branching as the seed (instead of the very first), so the title reflects where the branch diverged. For example: branching after asking "fix the auth bug" produces "fix the auth bug (Branch · 14:32)" instead of generic "hey (Branch)".
- Every auto-named branch/clone/import now ends with a short **`HH:MM` time stamp** (`(Branch · 14:32)`, `(Clone · 14:35)`, `(Imported · 14:38)`). Even when two branches genuinely share the same seed text, the timestamp keeps them visually distinct in `/tree` and helps you connect each entry to "what I was doing around 2:32".

If you pass an explicit name (`/branch fix-bug`, `/clone safe`), your label still wins — only the auto-generated default gets the timestamp treatment.

## 0.6.0 - Claudex to Tau migration

- Renamed the product surface from Claudex to Tau across the CLI, docs, terminal UI, and VS Code companion.
- Added the `tau` command and changed install/update flows to use `@abdoknbgit/tau`.
- Kept legacy `claudex` command/config compatibility where needed so existing users are not stranded.
- Reworked the startup logo/theme around the Tau math-symbol identity with the darker red, brown, and black terminal style.
- Renamed the VS Code companion workspace to `tau-vscode` and updated launch defaults to run `tau`.
- Updated provider notes and documented scalable context handling plus fallback recovery.
