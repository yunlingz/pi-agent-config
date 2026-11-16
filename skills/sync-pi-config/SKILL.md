---
name: sync-pi-config
description: >
  Verify global Pi configuration, skills, and maintained plugins with the installed Pi.
  Run a temporary read-only live session.
  Save reviewed changes in a local commit when requested.
  Never update Pi or push.
---

# Verify and save global Pi configuration

## Scope and authorization

- Work in the active agent directory: `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`.
- Confirm that it is the repository containing this skill, at `../..`.
- When the user requests verification only, do not stage or commit.
- When the user requests sync or a local save, commit only reviewed changes within that request.
- Do not upgrade Pi, install runtime packages, push, change remotes, or alter credentials.
- Keep MCP disabled in every test. Do not load MCP adapters.
- Follow global TypeScript rules when code changes require static checks.

## Review the starting state

1. Inspect Git status, staged and unstaged diffs, and recent commit subjects.
2. Identify the authorized files and preserve unrelated edits.
3. When unrelated work is staged, stop before staging or committing.
4. Locate the installed Pi package from the active executable and `pi --version`.

On Windows, inspect the executable shim. Elsewhere, resolve its symlink.
Use that installed package, not a registry copy or a hard-coded installation prefix.

## Verify the requested scope

Run commands from the agent directory. Replace the package placeholder with the verified installation path.

1. Run the saved offline workflow when maintained plugins, shared fixtures, skills, or host compatibility change.

   ```text
   node scripts/verify-extensions.ts <installed-pi-package-directory> offline
   ```

2. Run the configuration verifier's regression tests before its live check.

   ```text
   node --test skills/sync-pi-config/scripts/verify.test.ts
   node skills/sync-pi-config/scripts/verify.ts <installed-pi-package-directory>
   ```

Use a 30-second outer limit for unit tests, 180 seconds for offline integration, and 120 seconds for configuration verification.
The offline workflow already includes the configuration verifier's regression tests; do not repeat them when unchanged.

The configuration verifier checks installed JSON schemas, skill discovery, and the explicit global MCP-disable setting.
Its real temporary Pi session uses the configured default model, reasoning level, authentication, and global resources.
It must read a random marker and return it exactly within 90 seconds.
This live check can incur model charges. It does not prove every extension feature works.

### Additional live coverage

When the change affects compaction, authentication, provider routing, or hosted search, select the relevant live check.
Run it when the user authorized real model requests. Do not silently substitute a model to obtain success.

```text
node extensions/parallel-compact/verify-live.ts <installed-pi-package-directory> [provider/model]
node extensions/web-search/verify-live.ts <installed-pi-package-directory> [provider/model]
```

Both commands use current Pi defaults unless an exact configured model override is supplied.
The compaction check covers auto-compact, parallel-compact, token reset, persistence, and continuation.
The search check requires the selected model's configured search capabilities and allowlist entry.
A model change is not required merely because the search plugin is unavailable.
Report unrelated or unrun live capabilities as `Not verified`; do not turn optional checks into universal blockers.

### Failure and privacy rules

- Treat failed required checks as blockers to saving the affected changes.
- Do not weaken assertions, switch providers, or omit failing cases to obtain a pass.
- Separate provider outages from code defects using existing offline checks.
- Keep credentials, raw provider diagnostics, sessions, and temporary artifacts out of Git and reports.
- Confirm owned temporary processes stop and temporary directories are removed.
- After corrections, rerun affected checks. Do not repeat unrelated successful checks without new evidence.

## Save when authorized

1. Review the intended diff for secrets, unrelated edits, generated files, and missing tracked deliverables.
2. Run `git diff --check`.
3. Stage explicit reviewed paths with `git add -- <paths>`.
4. Review `git diff --cached` and run `git diff --cached --check`.
5. Create one local commit with a short imperative subject matching repository history.

Never use broad staging, force-add ignored files, amend, or bypass hooks.
When no change remains, report that no commit was needed.

## Report

State the named scope, installed Pi version, check commands and working directory, results, material limits, and cleanup status.
Distinguish offline coverage, real model checks, and untested terminal or browser behavior.
When a commit was authorized and created, report its hash and final Git status.
