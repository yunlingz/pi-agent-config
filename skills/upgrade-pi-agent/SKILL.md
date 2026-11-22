---
name: upgrade-pi-agent
description: >
  When the user explicitly requests a global Pi upgrade, use the existing npm or Yarn Classic global installation.
  Use the company registry, verify compatibility, and save authorized changes.
  Push only when explicitly requested.
disable-model-invocation: true
---

# Upgrade global Pi and extensions

## Scope and prerequisites

- Honor explicit upgrade and Git authorization; reading this skill authorizes neither.
- Use `PI_CODING_AGENT_DIR` when set; otherwise use `~/.pi/agent`. Confirm this skill belongs to that repository.
- Preserve credentials, models, resource filters, and unrelated settings.
- Use the existing installation and its manager; do not create another installation or change managers.
- Node.js, package managers, unrelated packages, and migrations require separate authorization.
- Do not use `pi update`, broad upgrades, upstream installers, or direct edits to installed code.
- Do not use `--ignore-engines`, `--force`, or flags that refresh unrelated dependencies.

Load [Upgrade execution safety](references/execution-safety.md) before installation or recovery.
It owns registry enforcement, path handling, preflight, native-file locks, and recovery safety.
Load [sync-pi-config](../sync-pi-config/SKILL.md) for checks, acceptance, saving, and evidence reporting.

## 1. Identify the installation

Unrelated settings changes or staged work must not prevent safe recovery.

1. Inspect Git status, diffs, history, and requested branch scope.
2. Locate the active executable with `where.exe pi` on Windows or `command -v pi` elsewhere.
3. Resolve its shim or symlink to the installed package.
4. Read its manifest name, version, executable mapping, and runtime requirements.
5. Record Node.js and the owning manager's version.

A manager on `PATH` does not prove ownership. Match the resolved executable to its recorded package location.

| Manager | Discovery commands |
| --- | --- |
| npm | `npm --version`, `npm prefix --global`, `npm root --global` |
| Yarn Classic | `yarn --version`, `yarn global dir`, `yarn global bin` |

Yarn Classic means Yarn 1.x; newer Yarn requires a different procedure.
Its global package directory and binary prefix can differ.
Derive the binary prefix from the reported binary directory and confirm it with `yarn global bin --prefix <confirmed-bin-prefix>`.
When ownership remains ambiguous, stop and report the missing prerequisite.

### Establish the baseline

1. Define required checks and coverage gaps under `sync-pi-config`.
2. Pass baseline checks and the shared read-only preflight.
3. Record recovery version, installation paths, pins, and relevant non-secret settings in owned private temporary state.
4. Retain Yarn's global manifest and lockfile as recovery evidence when applicable.

Do not copy credentials or session contents. Do not proceed after a failed baseline.

## 2. Select a release

Use only the registry and child-process controls in the shared safety reference.

### npm metadata

```text
npm view @earendil-works/pi-coding-agent dist-tags versions engines --json --registry=https://packagefeedproxy.microsoft.io/npm/ --fetch-retries=0 --fetch-timeout=20000
```

### Yarn Classic metadata

```text
yarn info @earendil-works/pi-coding-agent dist-tags.latest --json --registry=https://packagefeedproxy.microsoft.io/npm/ --network-timeout 20000 --non-interactive
yarn info @earendil-works/pi-coding-agent versions --json --registry=https://packagefeedproxy.microsoft.io/npm/ --network-timeout 20000 --non-interactive
yarn info @earendil-works/pi-coding-agent@<exact-version> engines --json --registry=https://packagefeedproxy.microsoft.io/npm/ --network-timeout 20000 --non-interactive
```

Yarn returns JSON lines; read the `inspect` record's `data`, not the entire output as one JSON value.

1. Compare eligible stable releases with installed `semver`.
2. Check runtime requirements and relevant release notes.
3. Select a literal version only after compatibility is established.

`latest` is a candidate, not proof of compatibility. Never downgrade when the registry is behind.
If no newer eligible release exists, retain Pi and continue only separately authorized extension work.
Do not upgrade unrelated tools to satisfy missing prerequisites.

## 3. Install through the existing manager

Use confirmed paths and one installation route. Do not install movable tags.
On Windows, follow the shared lock rules and run host replacement externally after owning Pi processes exit.

### npm

```text
npm install --global --prefix "<confirmed-prefix>" --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@<exact-version> --registry=https://packagefeedproxy.microsoft.io/npm/ --fetch-retries=0 --fetch-timeout=20000
```

### Yarn Classic

```text
yarn global add @earendil-works/pi-coding-agent@<exact-version> --exact --ignore-scripts --global-folder "<confirmed-global-dir>" --prefix "<confirmed-bin-prefix>" --registry=https://packagefeedproxy.microsoft.io/npm/ --network-timeout 20000 --non-interactive
```

`--global-folder` controls package storage; `--prefix` controls binaries; `--exact` saves the direct literal dependency.

1. Await installer termination.
2. Resolve the executable again and confirm ownership stayed unchanged.
3. Compare `pi --version` and the installed manifest with the selected version.
4. Check the global manifest and dependency changes for unrelated packages.
5. Confirm preserved configuration, credentials, and exact extension pins.
6. Pass Pi-upgrade acceptance checks from `sync-pi-config` before changing extensions.

### Recover a failed upgrade

Classify helper, provider, installation, and lock failures under the shared reference.
Use the same installation command with the prior literal version; do not overwrite concurrent manifests or lockfiles.

1. Stop and await the installer.
2. Reinstall the prior version through the same manager, paths, registry, and safety flags.
3. Verify executable ownership, version, and settings.
4. Pass restoration checks from `sync-pi-config`.

If recovery fails, stop without a final commit or push. Report required private recovery inputs and retained cleanup paths.

## 4. Extensions and publication

Load [upgrade-pi-extensions](../upgrade-pi-extensions/SKILL.md) for separately authorized third-party extension upgrades.
Keep extension packages separate from the host installation. Defer their settings commit until combined checks pass.

Use `sync-pi-config` to save only verified changes with the requested commit grouping.
Publication requires explicit branch, push, and rebase authorization; previous requests do not supply it.
Before publication, inspect history and remote state. Do not force-push, amend, or bypass hooks.
When history diverges or authentication fails, report the blocker.
After publication, compare remote branch hashes with intended local commits.

Report ownership, versions, unchanged packages, checks, limitations, commits, publication, and cleanup.
Recommend `pi --continue` after success or verified recovery; `/reload` cannot replace the running Pi version.

References: [Yarn global](https://classic.yarnpkg.com/en/docs/cli/global), [Yarn add](https://classic.yarnpkg.com/en/docs/cli/add), [Yarn info](https://classic.yarnpkg.com/en/docs/cli/info).
