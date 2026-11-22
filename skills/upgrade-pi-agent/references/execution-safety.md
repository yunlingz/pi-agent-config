# Upgrade execution safety

Both upgrade skills must load this reference before installation or recovery.
Global authorization, credential protection, scope, and cleanup rules remain active.

## Registry controls

Use only `https://packagefeedproxy.microsoft.io/npm/` for metadata, installation, downloads, and recovery.
You must not change unrelated npm configuration, switch registries, disable TLS validation, or run lifecycle scripts.
Use the existing package manager and installed tools; do not add managers or checking dependencies during upgrades.

Check scoped overrides, artifact URLs, lockfile sources, and `npmCommand` before installation.
When supported, pass the registry explicitly. If supported overrides cannot enforce these controls, stop the dependent upgrade.

For Pi-managed child package commands, set:

```text
npm_config_registry=https://packagefeedproxy.microsoft.io/npm/
npm_config_fetch_retries=0
npm_config_fetch_timeout=20000
npm_config_ignore_scripts=true
```

Yarn Classic requires explicit registry, script, network-timeout, and non-interactive flags.
Do not assume npm retry settings govern Yarn.
Use a 30-second metadata limit and a deliberate longer installation limit.
Keep proxy and credential values out of logs.

## Preflight and paths

- Reuse saved checks; keep installation separate from verification.
- Use task-owned helper files rather than large inline programs when helpers are necessary.
- Pass discovered paths through arguments or environment variables; derive child paths with `node:path`.
- Resolve symlinks before comparing installation identity.
- Do not embed Windows backslash paths in nested shell or JavaScript strings.

Before mutation:

1. Resolve the active executable and its package target.
2. Compare it with the package manager's recorded location.
3. Confirm the manifest and executable versions agree.
4. Run baseline checks from [sync-pi-config](../../sync-pi-config/SKILL.md).
5. Exercise new helpers' path comparisons, arguments, deadlines, and cleanup with mutation disabled.
6. Confirm settings stayed unchanged and owned checking processes stopped.

Repeat preflight after helper changes. Stop before mutation if any prerequisite fails.

## Windows file locks

- Do not replace a Pi installation while Windows Pi processes still use it.
- Prepare host upgrades for an external terminal after every owning Pi process exits.
- A nested installer does not release its parent's native-file locks.
- Do not terminate the caller or start a detached installer to bypass this boundary.
- Before extension replacement, inspect affected packages and shared dependencies for native modules or executables.
- When locks can block replacement, require external execution after owning processes exit.

## Failure classification and recovery

- Inspect helper failures before changing installed packages; correct helpers and rerun their original checks.
- Preserve assertions, target installation, and required coverage.
- For actual installation or compatibility failures, use the owning skill's recovery procedure.
- `EBUSY`, `EPERM`, or native-file cleanup warnings require owning processes to exit before further package changes.
- Do not repeatedly reinstall, force replacement, or delete staging directories while files remain locked.
- Reinstallation cannot guarantee reversal of transitive dependency changes or external side effects.
- Never restore whole-file backups over concurrent edits or copy credentials and session contents into recovery state.
- After user-run recovery, rediscover the executable and rerun checks; confirmation alone is not verification.
- Require fresh checks after candidate installation or restoration, as defined by [sync-pi-config](../../sync-pi-config/SKILL.md).
- When recovery fails, stop without committing and report the prerequisite for private recovery.
