---
name: sync-pi-config
description: >
  When asked to verify or save global Pi configuration, check settings, skills, and maintained plugins with the installed Pi.
  Run a temporary read-only live session.
  When the user requests a local save, commit reviewed changes.
  You must not update Pi or push.
---

# Verify and save global Pi configuration

## Scope

- Use `PI_CODING_AGENT_DIR` when set; otherwise use `~/.pi/agent`.
- Confirm that `../..` from this skill is the active repository.
- Verification alone does not authorize staging or committing.
- A sync or local-save request permits only reviewed changes within that request.
- You must not update Pi, install runtime packages, push, change remotes, or alter credentials.
- Apply global safety, evidence, and cleanup rules and [TYPESCRIPT.md](../../TYPESCRIPT.md).
- Temporary checks disable built-in MCP to avoid unrelated connections; normal sessions remain unrestricted.

## 1. Establish the scope

1. Inspect Git status, diffs, and recent commit subjects.
2. Identify authorized paths and preserve unrelated edits.
3. Stop before staging when unrelated work is already staged.
4. Resolve the active Pi executable to its installed package.
5. Confirm the package version with `pi --version`.

On Windows, inspect the executable shim. Elsewhere, resolve its symlink.
Use that installation, not a registry copy or a fixed prefix.

## 2. Run checks

Run commands from the active agent directory with the confirmed `<installed-pi-package-directory>`.

| Scope | Command | Outer limit |
| --- | --- | --- |
| Changed plugins, fixtures, skills, or host compatibility | `node scripts/verify-extensions.ts <installed-pi-package-directory> offline` | 180 seconds |
| Configuration-verifier tests, if not already covered | `node --test skills/sync-pi-config/scripts/verify.test.ts` | 30 seconds |
| Changed theme or renderer integration | `node themes/verify.ts <installed-pi-package-directory>` | 180 seconds |
| Fresh global configuration | `node skills/sync-pi-config/scripts/verify.ts <installed-pi-package-directory>` | 120 seconds |

The configuration verifier checks installed JSON schemas and skill discovery.
Its real read-only session uses the default model, reasoning level, authentication, and global resources.
It must read a random marker and return it exactly within 90 seconds.
This check can incur model charges and does not cover every extension feature.

### Upgrade acceptance

This section owns verification requirements for both upgrade skills.

- Before installation, define checks for the candidate, affected dependencies, configured capabilities, and known coverage gaps.
- When real model checks are unavailable or prohibited, stop before installation.
- After a Pi upgrade, require the full offline workflow, fresh global verification, and applicable live compaction/search checks.
- After each extension candidate, require fresh global verification and automatic checks for the extension and affected integrations.
- Changes to shared dependencies or request handling require affected live feature checks.
- Do not require unrelated features merely because another extension changed.
- Accept only after every selected mandatory check passes.
- After restoring a version, repeat required checks against that restored installation.
- Preserve the configured provider, model, effort, and authentication; do not substitute them to obtain success.
- Record unsupported capabilities before installation; previously supported failures remain blockers.
- Startup success does not prove browser, dialog, or native terminal behavior.

### Feature-specific checks

When compaction, authentication, routing, or hosted search changes, select relevant authorized live checks:

```text
node extensions/compact-quit/verify-live.ts <installed-pi-package-directory> [provider/model]
node extensions/web-search/verify-live.ts <installed-pi-package-directory> [provider/model]
```

Both use current defaults unless an exact configured model override is supplied.
Do not use an override or fallback merely to obtain success.
The compaction check covers checkpoints, token reset, reopening, and continuation.
The search check requires the configured API, allowlist, hosted search, and token-count capabilities.
Unrelated optional features are not universal blockers; report unrun checks as `Not verified`.

### Failed checks

- Block saving or acceptance while a required check remains unresolved.
- Do not weaken assertions, omit failing cases, or hide failures.
- Use offline evidence to distinguish provider outages from code defects.
- A provider outage does not permit acceptance of an unverified candidate.
- Correct defective helpers before changing installed packages.
- Repeat affected checks after corrections, installation, or restoration; otherwise reuse valid unchanged results.
- Keep credentials, private diagnostics, sessions, and fixtures out of Git and reports.
- Stop owned processes before removing only their temporary directories.

## 3. Save authorized changes

Do not use broad staging, force-add ignored files, amend, or bypass hooks.
Honor requested commit grouping; make no commit when nothing changed.

1. Review the intended diff for secrets, unrelated edits, generated files, and missing deliverables.
2. Run `git diff --check`.
3. Stage explicit reviewed paths with `git add -- <paths>`.
4. Inspect `git diff --cached`.
5. Run `git diff --cached --check`.
6. Create a short imperative commit subject that matches repository history.

Report the result, installed version, commands, working directory, coverage, limitations, cleanup, commit hash, and final Git status.
Distinguish offline checks, real model checks, and untested browser or terminal behavior.
