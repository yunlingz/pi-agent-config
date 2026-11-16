---
name: upgrade-pi-agent
description: >
  When the user explicitly requests a global Pi upgrade, use the existing npm or Yarn Classic global installation.
  Use the company registry, verify compatibility, and save authorized changes.
  Push only when explicitly requested.
disable-model-invocation: true
---

# Upgrade global Pi and extensions

## Required boundaries

- **Authorization and repository**
  - Honor the explicit request. Reading or reviewing this skill does not authorize upgrades or Git changes.
  - When `PI_CODING_AGENT_DIR` is set, use it as the active agent directory.
  - Otherwise, use `~/.pi/agent`.
  - Confirm that this skill belongs to that repository.
- **Preserved state and safety**
  - Preserve credentials, model choices, resource filters, and unrelated settings.
  - Keep MCP disabled.
  - Start nested Pi processes with `--no-mcp`.
  - Reuse installed tools, dependencies, and saved checks.
- **Installation limits**
  - Without separate authorization, you must not upgrade Node.js, package managers, or unrelated packages.
  - You must not use `pi update`, broad package upgrades, upstream installers, or direct edits to installed code.
  - Use the existing installation's package manager for upgrades and recovery.
  - You must not change package managers or create a second Pi installation.

## 1. Identify the installation

1. Inspect Git status, staged and unstaged diffs, recent commits, and the requested branch scope.
2. When unrelated settings changes or staged work prevent safe recovery, stop before installation.
3. Locate the active `pi` executable.
4. Resolve its symlink or shim target.
5. Read the target package's name, version, and executable mapping from `package.json`.
6. Record the active Node.js version and package manager version.

- **Executable discovery**
  - On Windows, use `where.exe pi` to locate the selected shim.
  - Elsewhere, use `command -v pi` to locate the selected executable.
  - A package manager's presence on `PATH` does not prove that it owns the active Pi installation.

### Compare installation locations

- **npm locations**
  - For npm, inspect these locations:

    ```text
    npm --version
    npm prefix --global
    npm root --global
    ```

  - Record the confirmed global prefix and package root.
- **Yarn Classic locations**
  - For Yarn Classic, inspect these locations:

    ```text
    yarn --version
    yarn global dir
    yarn global bin
    ```

  - Yarn Classic means Yarn 1.x.
  - Yarn 2 and later require a different procedure.
  - Record the global directory, binary directory, and Pi dependency in the global manifest.
  - Derive the binary prefix from the parent of the reported binary directory.
  - Confirm that `yarn global bin --prefix <confirmed-bin-prefix>` returns the recorded binary directory.
- **Ownership decision**
  - Match the active executable target to the package inside the reported global package directory.
  - When ownership is ambiguous or Pi uses another installation method, report the blocker.

### Establish the baseline

1. Run required checks from [sync-pi-config](../sync-pi-config/SKILL.md), including offline plugin checks.
2. When a baseline check fails, stop before upgrading.
3. Record recovery versions, installation locations, extension pins, and relevant settings in owned private temporary state.
4. For Yarn Classic, retain its global manifest and lockfile as recovery evidence.

- **Private and concurrent data**
  - You must not copy credentials or session contents.
  - You must not restore whole files over concurrent edits.

## 2. Select a version through the company registry

- **Registry and safety**
  - Use only `https://packagefeedproxy.microsoft.io/npm/` for package metadata, downloads, installation, and recovery.
  - You must not change unrelated configuration, switch registries, disable TLS validation, or run lifecycle scripts.
  - Keep proxy and credential values out of logs.

1. Check scoped registry overrides, configured package commands, artifact URLs, and existing lockfile sources for conflicts.
2. When sources conflict, establish an approved route or report the blocker.

- **npm child commands**
  - A registry flag alone does not restrict every absolute artifact URL.
  - For Pi-managed npm child commands, use these values in each child process:

    ```text
    npm_config_registry=https://packagefeedproxy.microsoft.io/npm/
    npm_config_fetch_retries=0
    npm_config_fetch_timeout=20000
    npm_config_ignore_scripts=true
    ```

- **Yarn Classic flags**
  - Use explicit registry, script, network-timeout, and non-interactive flags.
  - You must not assume that npm retry settings control Yarn's retries.
- **Timeouts and temporary state**
  - Use a 30-second outer limit for metadata requests.
  - For installation, use an explicit longer limit.
  - Follow global progress, cancellation, and temporary-directory rules.

### Query npm metadata

```text
npm view @earendil-works/pi-coding-agent dist-tags versions engines --json --registry=https://packagefeedproxy.microsoft.io/npm/ --fetch-retries=0 --fetch-timeout=20000
```

### Query Yarn Classic metadata

```text
yarn info @earendil-works/pi-coding-agent dist-tags.latest --json --registry=https://packagefeedproxy.microsoft.io/npm/ --network-timeout 20000 --non-interactive
yarn info @earendil-works/pi-coding-agent versions --json --registry=https://packagefeedproxy.microsoft.io/npm/ --network-timeout 20000 --non-interactive
yarn info @earendil-works/pi-coding-agent@<exact-version> engines --json --registry=https://packagefeedproxy.microsoft.io/npm/ --network-timeout 20000 --non-interactive
```

- **Yarn output**
  - Yarn emits JSON lines.
  - Read the `inspect` record's `data`.
  - You must not parse all Yarn output as one JSON document.

### Select the candidate

1. Use installed `semver` to compare stable versions available from the company registry.
2. Treat `latest` as a candidate, not proof of stability or compatibility.
3. Check the selected version's requirements and relevant release notes before installation.

- **Version limits**
  - When the company registry is behind the installed version, you must not downgrade.
  - When no newer eligible release exists, keep Pi unchanged.
  - Continue only with authorized extension work.
- **Missing prerequisites**
  - When prerequisites are missing, report them.
  - You must not upgrade unrelated tools or ignore engine checks to satisfy prerequisites.

## 3. Upgrade Pi through its existing manager

- **Command constraints**
  - Use verified locations and a literal version in place of each placeholder.
  - You must not install a movable tag such as `latest`.
  - Run exactly one installation path.
  - You must not run both paths or change the installation's package manager.

### npm global installation

```text
npm install --global --prefix "<confirmed-prefix>" --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@<exact-version> --registry=https://packagefeedproxy.microsoft.io/npm/ --fetch-retries=0 --fetch-timeout=20000
```

### Yarn Classic global installation

```text
yarn global add @earendil-works/pi-coding-agent@<exact-version> --exact --ignore-scripts --global-folder "<confirmed-global-dir>" --prefix "<confirmed-bin-prefix>" --registry=https://packagefeedproxy.microsoft.io/npm/ --network-timeout 20000 --non-interactive
```

- **Storage and version flags**
  - `--global-folder` selects package storage.
  - `--prefix` selects the binary prefix; these locations can differ.
  - `--exact` saves the literal direct dependency version in Yarn's global manifest.
- **Prohibited flags**
  - You must not add `--ignore-engines`, `--force`, or flags that refresh unrelated dependencies.

### Check the installation

1. Resolve the active executable again.
2. Confirm that the executable still uses the recorded installation.
3. Confirm that a fresh `pi --version` matches the selected installed manifest.
4. For Yarn Classic, confirm that its global manifest records Pi's exact version.
5. Check package metadata and dependency changes for unrelated global packages.
6. Confirm that Pi configuration, credentials, and exact extension pins remain unchanged.
7. Run configuration verification and saved offline checks before changing extensions.

### Recover a failed upgrade

When installation or a required host check fails:

1. Stop the installer.
2. Await its exit.
3. Reinstall the previous literal Pi version with the same manager, locations, registry, and safety flags.
4. Verify executable ownership, installed version, settings, and required baseline checks.

- **Recovery command and limits**
  - For Yarn Classic, use the same `global add` command with the recorded previous version.
  - Reinstalling an exact direct version does not guarantee restoration of every transitive dependency.
  - You must not overwrite concurrent changes with saved manifests or lockfiles.
- **Recovery failure**
  - When recovery fails, stop without a final commit or push.
  - Report the blocker and necessary private recovery inputs.
- **Running processes and cleanup**
  - You must not terminate the caller's running Pi session.
  - Report retained cleanup paths and installation warnings.

## 4. Upgrade extensions and verify compatibility

- **Extension procedure**
  - Read [upgrade-pi-extensions](../upgrade-pi-extensions/SKILL.md) before upgrading extension packages.
  - Follow its exact pins, exclusions, registry controls, candidate checks, and recovery rules.
  - Defer its settings commit until the full compatibility checks pass.
- **Package separation**
  - Pi manages extension packages separately from its own npm or Yarn installation.
  - You must not move extension packages into the host package manager's global directory.

Run saved checks from the active agent directory:

```text
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
node themes/verify.ts <installed-pi-package-directory>
node skills/sync-pi-config/scripts/verify.ts <installed-pi-package-directory>
```

- **Coverage and reuse**
  - The offline checks cover maintained plugins, automatic parallel compaction, lifecycle safeguards, usage, search controls, and rendering.
  - The configuration verifier uses the configured default model, reasoning level, authentication, and resources in a temporary read-only session.
  - It makes real model requests.
  - It does not test every extension feature.
  - When no relevant code, package, or settings changed, reuse successful checks.
- **Live checks and limits**
  - When provider integration or a relevant model capability changes, use the applicable live command from [sync-pi-config](../sync-pi-config/SKILL.md).
  - You must not substitute a provider or model to obtain success.
  - Report unrun checks and untested browser or native terminal behavior as `Not verified`.
- **Failed checks and corrections**
  - When a required check fails, compare installed contracts and release notes before changing tests.
  - Fix only authorized defects.
  - You must not weaken assertions or omit failing cases to keep an upgrade.
  - For maintained TypeScript changes, follow the shared strict checking procedure.

## 5. Save and publish authorized changes

1. When required checks remain unresolved, block final commits.
2. Use [sync-pi-config](../sync-pi-config/SKILL.md) to save authorized configuration changes.
3. Honor the requested commit grouping and branch workflow.

- **Publication limits**
  - You must not infer push, rebase, or cross-branch authorization from remote configuration or previous tasks.
  - Before authorized publication, inspect branch history and remote state.
  - You must not force-push, amend, or bypass hooks.
  - When history diverges or authentication fails, report the blocker.
  - After publication, compare each remote branch hash with the intended local commit.
- **Report and cleanup**
  - Report installation ownership, previous and final versions, unchanged packages, executed checks, limitations, commits, publication, and cleanup.
  - After success or verified recovery, remove owned temporary state.
- **Restart**
  - Recommend restarting with `pi --no-mcp --continue`.
  - `/reload` does not replace the running Pi version.

References: [Yarn global](https://classic.yarnpkg.com/en/docs/cli/global), [Yarn add](https://classic.yarnpkg.com/en/docs/cli/add), [Yarn info](https://classic.yarnpkg.com/en/docs/cli/info).
