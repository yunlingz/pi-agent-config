---
name: sync-pi-config
description: >
  Validate global Pi configuration with the installed Pi.
  Run a real temporary agent test.
  Commit reviewed configuration changes locally.
  Use when asked to sync, verify, or save global configuration in Git.
---

# Sync Pi configuration

## Scope

- **Repository**
  - Work in the Git repository containing this skill, not the caller's project.
  - The repository is `../..` from this skill directory.
  - Confirm it is the active agent directory: `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`.
- **Prohibited changes**
  - Never update Pi.
  - Never install dependencies.
  - Never push.
  - Never change a remote.

## Workflow

1. **Review the starting state.**
   - Inspect `git status --short`, unstaged and staged diffs, and recent commit subjects.
   - Preserve unrelated work.
   - If unrelated changes are already staged, stop and ask.
     - Do not include or unstage those changes.

2. **Locate the installed Pi package.**
   - Check `pi --version`.
   - Use the installed package, not a registry copy.
   - **Windows**
     - On Windows, run `where.exe pi`.
     - Inspect its shim.
     - The npm package is normally under `node_modules/@earendil-works/pi-coding-agent` beside the shim.
   - Elsewhere, resolve the `pi` executable's symlink.
   - If the interface has changed, read the installed documentation.

3. **Run the checks.**
   - **Commands and timeouts**
     - Run the bundled regression tests before the verifier.
     - Use a 30-second outer timeout for the tests.
     - Use an explicit outer timeout of at least 120 seconds for the verifier.

     ```text
     node --test <this-skill-directory>/scripts/verify.test.mjs
     node <this-skill-directory>/scripts/verify.mjs <installed-pi-package-directory>
     ```

   - **Verifier coverage**
     - The verifier uses the installed schemas and dependencies.
     - It checks skill discovery and the required global MCP-disable setting.
     - It makes real model requests using existing private credentials.
     - The verifier covers settings, models, and keybindings JSON, plus global skill discovery.
   - **Read-only session**
     - The disposable session starts with `--no-mcp`.
     - It keeps the configured default model, thinking level, and global resources.
     - It enables only `read` for safety.
     - It must read a random marker from a temporary file.
     - It must return that marker successfully within 90 seconds.
   - **Network and privacy**
     - Automatic catalog and update traffic is disabled.
     - The model request remains enabled.
     - No sessions or credentials are copied into Git.
   - **Failure handling**
     - Any schema, resource diagnostic, timeout, model, or tool failure blocks staging and committing.
     - Do not weaken or skip these checks.
     - For other changed formats, validate with the installed version's schemas or loaders before proceeding.
     - Fix only authorized issues.
     - After any content change, rerun verification.

4. **Review files for staging.**
   - **Review boundaries**
     - Check the intended diff for credentials, tokens, private headers, and unrelated edits.
     - Never include `auth.json`, sessions, caches, logs, or temporary artifacts.
     - Keep `.gitignore` exceptions narrow for intentionally added files.
   - **Explicit paths**
     - Stage explicit reviewed paths with `git add -- <paths>`.
     - Never use `git add .`, `git add -A`, or force-add ignored files.

5. **Review and commit.**
   - Review `git diff --cached`.
   - Run `git diff --cached --check`.
   - Commit verified intended changes with a short imperative subject matching repository history.
     - Do not amend or bypass hooks.
   - If there are no changes, report that verification passed and no commit was needed.

6. **Report the result.**
   - Report the installed Pi version, schema results, live-session results, and final Git status.
     - If a commit was created, include its hash and subject.
   - Do not claim that the basic agent test verified interactive features or every extension integration.
