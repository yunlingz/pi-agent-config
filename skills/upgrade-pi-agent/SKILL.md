---
name: upgrade-pi-agent
description: >
  Use only after an explicit request to upgrade global Pi and its npm extensions through the company registry.
  Verify configuration, skills, and maintained plugins.
  Save reviewed changes locally.
  Push only when explicitly requested.
disable-model-invocation: true
---

# Upgrade global Pi and extensions

## Boundaries

- Honor the explicit request. Reading or reviewing this skill does not authorize upgrades or Git changes.
- Work in `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`; confirm this skill is under that repository.
- Preserve credentials, model choices, resource filters, and unrelated settings.
- Keep MCP disabled and start nested Pi processes with `--no-mcp`.
- Reuse installed tools, dependencies, and saved checks. Do not add a separate upgrade engine.
- The upgrade workflow permits reviewed local commits. Remote pushes require explicit authorization.
- Do not upgrade Node.js, project dependencies, or unrelated global tools without separate authorization.
- Do not edit managed installed code directly or use `pi update`, `npm update`, or upstream installers.

## Registry controls

Use only `https://packagefeedproxy.microsoft.io/npm/` for metadata, installation, and recovery.
Treat its available stable releases as the upgrade limit. Do not downgrade when that registry is behind.
Pass explicit registry flags when supported and enforce these per-process child settings:

```text
npm_config_registry=https://packagefeedproxy.microsoft.io/npm/
npm_config_fetch_retries=0
npm_config_fetch_timeout=20000
npm_config_ignore_scripts=true
```

Check scoped overrides and `npmCommand` for conflicting registry settings.
Use supported per-run overrides or report the blocker. Never change unrelated npm configuration or disable TLS validation.
Keep proxy and credential values out of logs. Follow global timeouts, progress, and temporary-directory ownership rules.

## 1. Establish the baseline

1. Inspect Git status, staged and unstaged diffs, recent commits, and the requested branch scope.
2. Stop before installation when unrelated settings changes or unrelated staged work prevent safe recovery.
3. Locate the active executable, installed package, exact version, Node.js version, and installation prefix.
4. Confirm Pi is npm-managed before using the installation command below.
5. Run required baseline checks from [sync-pi-config](../sync-pi-config/SKILL.md), including offline plugin checks.

On Windows, inspect the executable shim. Elsewhere, resolve its symlink.
Do not assume a fixed drive, prefix, provider, or model.
Baseline failures block upgrades. Record recovery versions, exact extension pins, and relevant settings in owned private temporary state.
Do not copy credentials or session contents.

## 2. Select and install Pi

Query the approved registry:

```text
npm view @earendil-works/pi-coding-agent dist-tags versions engines --json --registry=https://packagefeedproxy.microsoft.io/npm/ --fetch-retries=0 --fetch-timeout=20000
```

Use installed `semver` to select the newest eligible stable release.
Read the selected release's requirements and relevant release notes before installing.
When prerequisites are missing or compatibility evidence is insufficient, report the blocker without changing unrelated tools.

When a newer eligible version exists, install its exact version into the confirmed global prefix:

```text
npm install --global --prefix "<confirmed-prefix>" --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@<exact-version> --registry=https://packagefeedproxy.microsoft.io/npm/ --fetch-retries=0 --fetch-timeout=20000
```

1. Confirm a fresh `pi --version` matches the selected installed manifest.
2. Confirm configuration, credentials, and exact extension pins remain unchanged.
3. Run configuration verification and saved offline compatibility checks before changing extensions.

If installation or required host checks fail, stop the installer and reinstall the previous exact Pi version through the same registry.
Verify recovery before continuing. When recovery fails, stop without final commit or push.
Never restore concurrent edits from a whole-file backup or terminate the caller's running Pi session.
Report retained cleanup paths and installation warnings after checking fresh-process startup.

## 3. Upgrade npm extensions

Read and follow [upgrade-pi-extensions](../upgrade-pi-extensions/SKILL.md).
Its exclusions, exact pins, per-candidate checks, registry controls, and recovery rules remain active.
Report unchanged or out-of-scope packages with reasons.
When running this combined workflow, defer its settings-only commit until the full compatibility checks pass.

## 4. Verify compatibility

Run saved checks from the active agent directory:

```text
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
node themes/verify.ts <installed-pi-package-directory>
node skills/sync-pi-config/scripts/verify.ts <installed-pi-package-directory>
```

The offline workflow covers all maintained plugins, native prompt parity, automatic-to-parallel compaction, lifecycle safeguards, usage, search controls, and rendering.
The configuration verifier uses the configured default model, reasoning level, authentication, and global resources in a temporary read-only session.
It is a real model check, not a feature-complete extension test.
Reuse successful checks from earlier stages when no relevant code, package, or settings changed.

When provider integration or a relevant model capability changed, run the applicable optional live command from [sync-pi-config](../sync-pi-config/SKILL.md).
Do not hard-code or substitute a provider or model to obtain success.
Report unrelated unsupported capabilities and untested browser or native terminal behavior as `Not verified`.

When a required check fails, compare installed contracts and release notes before changing tests.
Fix only authorized compatibility defects. Do not weaken assertions or omit failing cases to keep an upgrade.
For maintained TypeScript changes, follow the shared strict static-checking procedure.
Stop once the required scope passes. Do not investigate unrelated features or build speculative compatibility layers.

## 5. Save and publish only as authorized

1. Block final commits while required checks remain unresolved.
2. Finish any deferred settings-only commit from the extension workflow.
3. Use [sync-pi-config](../sync-pi-config/SKILL.md) for remaining authorized configuration changes.

Honor the user's requested commit grouping and branch workflow instead of forcing multiple commits.
Never infer push, rebase, or cross-branch authorization from a remote's presence or a previous task.
Before authorized publication, inspect branch history and remote state. Never force-push, amend, or bypass hooks.
When history diverges or authentication fails, report the blocker.
After a successful push, compare the remote branch hash with the intended local commit.

Report previous and final versions, unchanged packages, commands and working directories, results, material limits, commits, publication, and cleanup.
Remove owned temporary state after success or verified recovery. When recovery is blocked, retain only necessary private inputs and report their paths.
Recommend restarting with `pi --no-mcp --continue`; `/reload` does not replace the running Pi version.
