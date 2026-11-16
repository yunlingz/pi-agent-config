---
name: sync-pi-config
description: >
  When asked to verify or save global Pi configuration, check settings, skills, and maintained plugins with the installed Pi.
  Run a temporary read-only live session.
  When the user requests a local save, commit reviewed changes.
  You must not update Pi or push.
---

# Verify and save global Pi configuration

## Scope and authorization

- When `PI_CODING_AGENT_DIR` is set, use it as the active agent directory.
- Otherwise, use `~/.pi/agent`.
- Confirm that `../..` from this skill is the repository for the active agent directory.
- When the user requests verification only, you must not stage or commit.
- When the user requests sync or a local save, commit only reviewed changes within that request.
- You must not upgrade Pi, install runtime packages, push, change remotes, or alter credentials.
- Keep MCP disabled in every test.
- You must not load MCP adapters.
- When code changes require static checks, follow the global TypeScript rules.

## 1. Review the starting state

1. Inspect Git status, staged and unstaged diffs, and recent commit subjects.
2. Identify the authorized files.
3. Preserve unrelated edits.
4. When unrelated work is staged, stop before staging or committing.
5. Locate the installed Pi package from the active executable and `pi --version`.

On Windows, inspect the executable shim.
Elsewhere, resolve its symlink.
Use the selected installation, not a registry copy or a fixed installation prefix.

## 2. Verify the requested scope

Run commands from the active agent directory.
Replace `<installed-pi-package-directory>` with the verified installation path.

### Offline plugin checks

When maintained plugins, shared fixtures, skills, or host compatibility change, run the saved offline workflow:

```text
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
```

This workflow includes regression tests for the configuration verifier.
When those tests passed and remain unchanged, you must not repeat them without new evidence.

### Configuration checks

When the offline workflow has not covered the regression tests, run them first:

```text
node --test skills/sync-pi-config/scripts/verify.test.ts
```

Then run the configuration verifier:

```text
node skills/sync-pi-config/scripts/verify.ts <installed-pi-package-directory>
```

Use these outer timeouts:

- Unit tests: 30 seconds.
- Offline integration: 180 seconds.
- Configuration verification: 120 seconds.

The configuration verifier checks JSON schemas from the installed Pi, skill discovery, and the explicit setting that disables built-in MCP.
Its temporary Pi session uses the configured default model, reasoning level, authentication, and global resources.
The session must read a random marker and return it exactly within 90 seconds.
The live check can incur model charges.
It does not prove that every extension feature works.

### Additional live checks

When a change affects compaction, authentication, provider routing, or hosted search, select the relevant live check.
When real model requests are authorized, run that check:

```text
node extensions/parallel-compact/verify-live.ts <installed-pi-package-directory> [provider/model]
node extensions/web-search/verify-live.ts <installed-pi-package-directory> [provider/model]
```

Without an exact configured model override, both commands use current Pi defaults.
You must not substitute a model to obtain success.

- The compaction check covers auto-compact, parallel-compact, token reset, persistence, and continuation.
- The search check requires the selected model's configured search capabilities and allowlist entry.
- When search is unavailable, you must not change models merely to pass that check.

Report unrun live checks as `Not verified`.
For capabilities outside the requested scope, you must not make optional checks universal blockers.

### Failures and privacy

- When a required check fails, block saving the affected changes.
- You must not weaken assertions, switch providers, or omit failing cases to obtain a pass.
- Use existing offline checks to distinguish provider outages from code defects.
- Keep credentials, raw provider diagnostics, sessions, and temporary artifacts out of Git and reports.
- Confirm that owned temporary processes stopped and their directories were removed.
- After a correction, rerun affected checks.
- Unless new evidence requires repetition, retain the results of unrelated successful checks.

## 3. Save authorized changes

1. Review the intended diff for secrets, unrelated edits, generated files, and missing deliverables.
2. Run `git diff --check`.
3. Stage explicit reviewed paths with `git add -- <paths>`.
4. Review `git diff --cached`.
5. Run `git diff --cached --check`.
6. Create a local commit with a short imperative subject that matches repository history.

Honor the user's requested commit grouping.
You must not use broad staging, force-add ignored files, amend, or bypass hooks.
When no change remains, report that no commit was needed.

## Report

Report the named scope, installed Pi version, check commands, working directory, results, material limits, and cleanup status.
Distinguish offline coverage, real model checks, and untested terminal or browser behavior.
When a commit was authorized and created, report its hash and final Git status.
