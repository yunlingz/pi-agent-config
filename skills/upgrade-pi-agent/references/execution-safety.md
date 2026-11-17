# Upgrade execution safety

Apply these rules before Pi or extension installation and recovery.

## Use tested paths and checks

- **Saved workflows**
  - Reuse saved checks instead of combining installation and verification in a new helper.
  - When helper files are necessary, use task-owned files instead of large inline scripts.
- **Path handling**
  - Pass discovered paths through arguments or environment variables.
  - Use `node:path` to derive child paths.
  - You must not embed Windows backslash paths inside nested shell and JavaScript strings.
  - Resolve filesystem paths and symlinks before comparing installation identity.
  - Compare resolved targets, not raw shim text or handwritten escaped strings.

## Respect Windows file locks

- **Host installation**
  - You must not replace the Pi installation used by a running Windows Pi process.
  - Windows can lock loaded native modules and executables, preventing replacement and rollback.
  - For host upgrades, prepare exact installation and recovery commands for an external terminal.
  - Before external execution, require all Pi processes using that installation to exit.
  - A nested Pi process or child installer does not release its parent's locks.
  - You must not terminate the caller or start a detached installer to bypass this boundary.
- **Extension installation**
  - Before Windows extension upgrades, inspect affected packages and shared dependencies for native modules and executables.
  - When native components may be loaded, require external execution after their owning processes exit.
  - When safe replacement cannot be established, stop before installation and report the blocker.

## Run a read-only preflight

- **Required scope**
  - Before mutation, run the exact discovery and ownership checks against the currently installed version.
  - Exercise any new helper's path comparisons, command arguments, timeout handling, and cleanup before installation.
  - Keep installation and recovery disabled during this preflight.
  - When helper code changes, repeat its read-only preflight before using it to change packages.
- **Procedure**
  1. Resolve the active executable and its package target.
  2. Compare that target with the package manager's recorded location.
  3. Confirm that the reported version matches the installed manifest.
  4. Run the required baseline checks.
  5. Confirm that verification preserved settings and stopped owned processes.
  6. When any preflight check fails, stop before changing packages.

## Classify failures before recovery

- **Verification helper defects**
  - When a verification helper fails, inspect its failure before changing installed packages.
  - When the helper is defective, correct it and rerun the original required check.
  - Preserve the required assertions, target installation, and verification scope.
  - You must not accept a candidate while required checks remain unresolved.
- **Installation and compatibility failures**
  - When installation or a valid required check fails, follow the applicable recovery procedure.
  - When `EBUSY`, `EPERM`, or cleanup warnings concern native files, stop further package changes.
  - Report the affected path and require its owning processes to exit before installation or recovery.
  - You must not repeatedly reinstall, force replacement, or delete staging directories while files remain locked.
- **User-run recovery**
  - After user-run recovery, rediscover the executable and rerun required checks.
  - User confirmation alone does not verify recovery.
