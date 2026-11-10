---
name: upgrade-pi-agent
description: >
  Use only after an explicit request to upgrade global Pi and its extensions through the company npm registry.
  Verify configuration, global skills, and local extensions.
  Sync reviewed configuration locally.
  Push only when explicitly requested.
disable-model-invocation: true
---

# Upgrade Pi through the company registry

## Boundaries

- Honor the requested scope; do not upgrade unrelated tools or project packages.
- Work in `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`.
  Confirm this is the repository containing this skill, at `../..`.
- Keep this skill text-only; reuse installed tools, dependencies, and existing checks.
- Keep MCP disabled; start nested agent sessions with `--no-mcp`.
- Preserve models, credentials, resource filters, and unrelated settings.
- The execution workflow includes reviewed local commits; remote pushes require explicit authorization.
- Creating, reading, reviewing, or testing this skill does not authorize upgrades or Git changes.

## Mandatory registry

Always use `https://packagefeedproxy.microsoft.io/npm/` for npm metadata, downloads, installations, and recovery.
Treat its stable releases as the upgrade limit, even when Pi advertises newer public releases.
Do not use `pi update`, `npm update`, upstream installers, or direct edits to managed `node_modules`.

For child package commands, set these environment values:

- `npm_config_registry=https://packagefeedproxy.microsoft.io/npm/`
- `npm_config_fetch_retries=0`
- `npm_config_fetch_timeout=20000`
- `npm_config_ignore_scripts=true`

Use explicit registry flags when supported.
Check scoped registry overrides and the configured `npmCommand` for conflicting registry settings.
If overrides conflict, use supported per-run overrides or report a blocker; do not change unrelated npm configuration.
If company access fails, report the blocker; do not bypass it with alternate registries, upstream tarballs, or insecure TLS options.
Keep credentials, proxy values, and authenticated URLs out of logs.

## Workflow

Use these five stage names for task tracking.
Apply the global progress, timeout, temporary-file, and privacy rules throughout.

### 1. Inspect upgrade requirements and registry

- Inspect Git status, staged and unstaged diffs, recent commits, and the intended remote.
- If `settings.json` has existing changes or unrelated work is staged, stop before upgrading.
- Inspect installed Pi and Node.js versions, exact extension pins, and installed manifests.
- Resolve the active executable and installation prefix; do not assume a drive or npm default.
  On Windows, inspect `where.exe pi` and its shim; elsewhere, resolve the executable's symlink.
- If Pi is not npm-managed, report the installation mismatch; do not create a second installation.
- Query the company registry for available stable Pi releases.

```text
npm view @earendil-works/pi-coding-agent dist-tags versions engines --json --registry=https://packagefeedproxy.microsoft.io/npm/ --fetch-retries=0 --fetch-timeout=20000
```

- Use the installed `semver` dependency to compare versions.
- Select the newest stable Pi release available from the company registry.
  Do not downgrade Pi when the mirror is behind the installed version.
- Check the selected release's Node.js requirements and relevant release notes before installation.
  Report missing prerequisites instead of silently upgrading unrelated tools.
- Run the [sync skill's](../sync-pi-config/SKILL.md) regression tests, then its read-only baseline verifier.
  Use its required timeouts; a baseline failure blocks upgrades.
- Record recovery versions, prefix, pins, and settings in a private OS temporary directory.
  Never copy credential files or session contents.

### 2. Upgrade Pi from the company registry

When the selected release is newer, install its exact version into the confirmed global prefix with lifecycle scripts disabled.
Replace both placeholders with the verified prefix and literal version.

```text
npm install --global --prefix "<confirmed-prefix>" --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@<exact-version> --registry=https://packagefeedproxy.microsoft.io/npm/ --fetch-retries=0 --fetch-timeout=20000
```

- Confirm a fresh `pi --version` matches the installed manifest.
  After an upgrade, require the selected version; otherwise, require the unchanged original version.
- Confirm the host upgrade preserved configuration and exact extension pins.
- Disable automatic catalog, version-check, and telemetry traffic during verification.
  Keep the verifier's required real model request enabled.
- Run the verifier against the new Pi before changing extensions.
- If installation or host verification fails, stop installers and reinstall the previous exact version through the company registry.
  Verify recovery before continuing.
  If recovery fails, stop without final sync or push.
- Never overwrite concurrent settings changes with a whole-file backup.
- If npm reports cleanup warnings, verify fresh-process startup and report retained paths.
  Do not terminate the caller's session or delete active libraries.

### 3. Upgrade all global npm extensions

Read and follow [upgrade-pi-extensions](../upgrade-pi-extensions/SKILL.md).
Its Pi, project-package, migration, and push exclusions remain active within that step.

- Use the mandatory company registry environment for every nested lookup, install, and recovery command.
- Keep its exact pins, per-candidate verification, settings-preservation checks, and automatic recovery.
- Leave packages unchanged when no newer compatible approved release exists, and report why.
- Report Git/local packages as outside the npm upgrade scope.
  Verify configured local resources in stage 4.
- Complete stage 4 before the extension skill's settings-only commit.

### 4. Verify global Pi compatibility

- Run installed-Pi schema validation, global skill discovery, and the real read-only session required by `sync-pi-config`.
- Preserve the configured model, thinking level, and global resources in that live check.
- From the agent directory, run the focused unit tests:

  ```text
  node --test extensions/auto-compact/controller.test.ts extensions/cache-rate/cache-rate.test.ts extensions/session-history/history-window.test.ts extensions/vcc-recall-safe/request.test.ts extensions/web-search/web-search.test.ts scripts/verification-data.test.ts
  ```

- Run these scripts with `node <script> <installed-pi-package-directory>`:
  - `extensions/auto-compact/verify-integration.ts`: native compaction, persistence, and quit ordering.
  - `extensions/auto-compact/verify-summary-integration.ts`: summary limits, failure handling, and explicit retry.
  - `extensions/auto-compact/verify-vcc-integration.ts`: actual pi-vcc compaction and shared history cleanup.
  - `extensions/cache-rate/verify-integration.ts`: installed Pi lifecycle and Powerline integration.
  - `extensions/session-history/verify-integration.ts`: loading, view state, and unchanged model context.
  - `extensions/session-history/verify-plugin-compatibility.ts`: configured extensions and shared TUI lifecycle.
  - `extensions/web-search/verify-integration.ts`: request isolation, reasoning, controls, usage, and rendering.
  - `themes/verify.ts`: installed schema, color modes, contrast, and rendering.
- Exercise updated third-party tools with suitable existing automatic checks.
  Use actual installed extensions; add temporary fixtures only for material coverage gaps.
  Do not install extra tooling merely to run unpublished test suites.
- When a check fails, reproduce the failure and compare current release notes, public APIs, and documented contracts.
  Correct outdated test expectations only when evidence confirms an intentional upstream change.
  Do not weaken assertions, change the selected model, or bypass failing checks to obtain a pass.
- Fix authorized compatibility defects only; rerun affected checks after corrections.
- Stop once required checks pass; do not investigate unrelated features or build a general verification framework.
- Record untested browser and native terminal workflows as `Not verified`.
  Metadata and startup success do not prove every feature works.

### 5. Sync configuration and push when authorized

- Block final commits and push while any required compatibility check remains unresolved.
- When extension pins changed, finish the extension skill's reviewed settings-only commit.
- Run [sync-pi-config](../sync-pi-config/SKILL.md) to verify and save remaining reviewed configuration changes.
- Preserve both skills' local-only limits; perform any authorized push separately afterward.
- If the current request explicitly authorizes pushing, use its requested remote or configured `origin`.
  Inspect the current branch and remote history before pushing.
  Do not infer push permission from a remote's presence or a previous request.
  If history diverges or authentication fails, report the blocker.
  Never force-push, amend, change remotes, or bypass hooks.
- After an authorized push, confirm the remote branch commit with `git ls-remote <remote> refs/heads/<branch>` against local `HEAD`.
- Report before and after versions, unchanged packages, check commands with working directories, test coverage, commits, push status, and limitations.
- Remove owned temporary artifacts after success or verified recovery.
  If recovery remains blocked, retain only necessary private recovery inputs and report their paths.
- Recommend restarting Pi with `pi --no-mcp --continue`; `/reload` does not replace the running Pi version.
