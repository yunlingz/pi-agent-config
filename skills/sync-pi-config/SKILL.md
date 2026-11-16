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

- **Repository**
  - When `PI_CODING_AGENT_DIR` is set, use it as the active agent directory.
  - Otherwise, use `~/.pi/agent`.
  - Confirm that `../..` from this skill is the repository for the active agent directory.
- **Git authorization**
  - When the user requests verification only, you must not stage or commit.
  - When the user requests sync or a local save, commit only reviewed changes within that request.
- **Safety and checking**
  - You must not upgrade Pi, install runtime packages, push, change remotes, or alter credentials.
  - Keep MCP disabled in every test.
  - You must not load MCP adapters.
  - When code changes require static checks, follow the global TypeScript rules.

## 1. Review the starting state

- **Installation discovery**
  - On Windows, inspect the executable shim.
  - Elsewhere, resolve its symlink.
  - Use the selected installation, not a registry copy or a fixed installation prefix.
- **Procedure**
  1. Inspect Git status, staged and unstaged diffs, and recent commit subjects.
  2. Identify the authorized files.
  3. Preserve unrelated edits.
  4. When unrelated work is staged, stop before staging or committing.
  5. Locate the installed Pi package from the active executable and `pi --version`.

## 2. Verify the requested scope

- **Command context**
  - Run commands from the active agent directory.
  - Replace `<installed-pi-package-directory>` with the verified installation path.
- **Outer timeouts**
  - Unit tests: 30 seconds.
  - Offline integration: 180 seconds.
  - Configuration verification: 120 seconds.

### Offline plugin checks

- **Required coverage**
  - When maintained plugins, shared fixtures, skills, or host compatibility change, run the saved offline workflow:

    ```text
    node scripts/verify-extensions.ts <installed-pi-package-directory> offline
    ```

  - This workflow includes regression tests for the configuration verifier.
  - When those tests passed and remain unchanged, you must not repeat them without new evidence.

### Configuration checks

- **Cost and limits**
  - The live check can incur model charges.
  - It does not prove that every extension feature works.
- **Procedure**
  1. When the offline workflow has not covered the regression tests, run them first:

     ```text
     node --test skills/sync-pi-config/scripts/verify.test.ts
     ```

  2. Run the configuration verifier:

     ```text
     node skills/sync-pi-config/scripts/verify.ts <installed-pi-package-directory>
     ```

- **Verifier coverage**
  - The configuration verifier checks JSON schemas from the installed Pi, skill discovery, and the explicit setting that disables built-in MCP.
  - Its temporary Pi session uses the configured default model, reasoning level, authentication, and global resources.
  - The session must read a random marker and return it exactly within 90 seconds.

### Live checks after upgrades

- **Before installation**
  - Before upgrading Pi or an extension, define required checks and record known coverage gaps.
  - Select feature checks from the changed package, its dependencies, affected integrations, and configured capabilities.
  - Upgrade verification requires real model requests, which can incur charges.
  - When real model requests are prohibited or unavailable, report the blocker before installation.
- **After upgrading Pi**
  - Run the full offline plugin workflow against the newly installed Pi.
  - Run fresh live configuration verification with global extensions loaded.
  - Run applicable live compaction and search checks.
- **After each extension candidate**
  - Run fresh live configuration verification after each candidate installation.
  - Run existing automatic checks for that extension and affected integrations.
  - When shared dependencies or request handling change, run the affected live plugin checks.
  - You must not require unrelated live features merely because another extension changed.
- **Acceptance and recovery**
  - Before accepting a candidate, require all selected mandatory checks to pass.
  - Results from before installation do not verify the changed installation.
  - After restoring a previous version, run fresh live configuration verification and affected checks against the restored installation.
  - When a required live check cannot pass, block candidate acceptance and follow the upgrade skill's recovery procedure.
- **Capabilities and coverage**
  - Before installation, identify unsupported or unconfigured features and state why their live checks do not apply.
  - When a previously supported feature fails after installation, treat its required check as a blocker.
  - You must not silently omit a required check or substitute another model.
  - Startup success does not prove browser, dialog, or native terminal behavior.
  - Report missing feature coverage explicitly; do not claim that basic live verification tested those features.

### Feature-specific live checks

- **Selection and authorization**
  - When ordinary configuration changes affect compaction, authentication, provider routing, or hosted search, select relevant live checks.
  - During upgrades, apply the mandatory requirements above.
  - When real model requests are authorized, run the selected check:

    ```text
    node extensions/parallel-compact/verify-live.ts <installed-pi-package-directory> [provider/model]
    node extensions/web-search/verify-live.ts <installed-pi-package-directory> [provider/model]
    ```

  - Without an exact configured model override, both commands use current Pi defaults.
  - During upgrades, preserve the configured provider, model, reasoning level, and authentication.
  - You must not use an override or fallback merely to obtain success.
- **Coverage and capabilities**
  - The compaction check covers auto-compact, parallel-compact, token reset, persistence, and continuation.
  - The search check requires the selected model's configured search capabilities and allowlist entry.
  - When search is unavailable, you must not change models merely to pass that check.
- **Unrun checks**
  - Report unrun live checks as `Not verified`.
  - For capabilities outside the requested scope, you must not make optional checks universal blockers.

### Failures and privacy

- **Failed checks**
  - When a required check fails, block saving the affected changes.
  - You must not weaken assertions, switch providers, or omit failing cases to obtain a pass.
  - Use existing offline checks to distinguish provider outages from code defects.
  - A provider outage does not permit acceptance of an unverified candidate.
- **Private and temporary data**
  - Keep credentials, raw provider diagnostics, sessions, and temporary artifacts out of Git and reports.
  - Confirm that owned temporary processes stopped and their directories were removed.
- **Corrections and repetition**
  - After a correction, rerun affected checks.
  - After installation or restoration, collect fresh results for required checks.
  - When no relevant package, code, or settings changed after a successful check, reuse that result.

## 3. Save authorized changes

- **Commit limits**
  - Honor the user's requested commit grouping.
  - You must not use broad staging, force-add ignored files, amend, or bypass hooks.
  - When no change remains, report that no commit was needed.
- **Procedure**
  1. Review the intended diff for secrets, unrelated edits, generated files, and missing deliverables.
  2. Run `git diff --check`.
  3. Stage explicit reviewed paths with `git add -- <paths>`.
  4. Review `git diff --cached`.
  5. Run `git diff --cached --check`.
  6. Create a local commit with a short imperative subject that matches repository history.

## Report

- **Results and coverage**
  - Report the named scope, installed Pi version, check commands, working directory, results, material limits, and cleanup status.
  - Distinguish offline coverage, real model checks, and untested terminal or browser behavior.
- **Git result**
  - When a commit was authorized and created, report its hash and final Git status.
