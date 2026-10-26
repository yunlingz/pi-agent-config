---
name: sync-pi-config
description: Validate the global Pi configuration with the currently installed Pi, run a real temporary agent smoke test, and commit reviewed configuration changes locally. Use when asked to sync, verify, or save global Pi configuration in Git.
---

# Sync Pi configuration

Work in the Git repository containing this skill (`../..` from this directory), not the caller's project. Confirm it is the active agent directory (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`). Never update Pi, install dependencies, push, or change a remote.

1. Inspect `git status --short`, unstaged and staged diffs, and recent commit subjects. Preserve unrelated work. If unrelated changes are already staged, stop and ask rather than including or unstaging them.
2. Check `pi --version` and locate that installed package, not a registry copy. On Windows, use `where.exe pi` and inspect its shim; npm's package is normally under `node_modules/@earendil-works/pi-coding-agent` beside the shim. Elsewhere, resolve the `pi` executable's symlink. Read the installed docs if its interface has changed.
3. Run the bundled regression tests with a 30-second outer timeout, then the verifier with an explicit outer timeout of at least 120 seconds:

   ```text
   node --test <this-skill-directory>/scripts/verify.test.mjs
   node <this-skill-directory>/scripts/verify.mjs <installed-pi-package-directory>
   ```

   It uses the installed schemas and dependencies, checks skill discovery and the required global MCP-disable setting, and makes real model requests with the existing private credentials. The disposable session starts with `--no-mcp`, keeps the configured default model, thinking level, and global resources, but enables only `read` for safety. It must read a random marker from a temporary file and return it successfully within 90 seconds. Automatic catalog/update traffic is disabled, not the model request. No sessions or credentials are copied into Git.

   Any schema, resource diagnostic, timeout, model, or tool failure blocks staging and committing. Do not weaken or skip the checks. The verifier covers settings/models/keybindings JSON and global skill discovery; validate any other changed configuration formats using the installed version's schemas/loaders before proceeding. Fix only authorized issues, then rerun verification after any content change.
4. Review the intended diff for credentials, tokens, private headers, and unrelated edits. Never include `auth.json`, sessions, caches, logs, or temporary artifacts. Keep `.gitignore` exceptions narrow for any intentionally added files. Stage explicit reviewed paths with `git add -- <paths>`; never use `git add .`, `git add -A`, or force-add ignored files.
5. Review `git diff --cached`, run `git diff --cached --check`, and commit the verified intended changes with a short imperative subject matching the repo's history. Do not amend or bypass hooks. If there are no changes, report that verification passed and no commit was needed.
6. Report the installed Pi version, schema/live-session results, commit hash and subject (if any), and final Git status. Do not claim interactive UI or every extension integration was tested by the smoke test.
