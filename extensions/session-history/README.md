# Lazy saved session history

This local Pi extension restores transcript entries that compaction removes from the interactive view. It does not change model context, session entries, compaction, or installed Pi files.

## Behavior

In fullscreen mode:

- Show the 50 newest hidden entries at startup, resume, or reload.
- Load 50 older entries two screens before scrolling reaches the current history boundary.
- Keep the visible content stable when older entries are prepended.
- Preserve the loaded boundary and scroll position across `/reload` in the same process.
- Refresh restored history after compaction and tree navigation.
- Load all older entries when `Ctrl+Home` requests the session start.

Pi keeps current compacted entries in its normal chat container. The extension mounts a separate history component immediately before that container. It uses Pi's stored active branch as the source.

The extension shows user, assistant, tool, shell, custom-message, compaction, and branch-summary entries. Old tool output starts collapsed. Old thinking starts hidden.

In regular mode, Pi delegates scrolling to the terminal. The extension shows the initial 50 hidden entries, but it cannot detect terminal scroll position. Use fullscreen mode for automatic loading and complete `Ctrl+Home` navigation.

## Threshold choice

A benchmark used the current 46 MB session at 140 columns. It measured the installed Pi renderer and real compacted entries.

| Initial entries | Render time | Rendered lines | Heap increase |
| ---: | ---: | ---: | ---: |
| 50 | 52 ms | 3,078 | 11.6 MB |
| 100 | 71 ms | 8,222 | 28.5 MB |
| 200 | 83 ms | 12,758 | 42.9 MB |
| 1,543 | 500 ms | 69,785 | 54.6 MB |

The 50-entry window limits normal startup cost. Automatic 50-entry chunks keep scrolling continuous without rendering the complete session by default.

## Compatibility

The extension uses one unique zero-line widget to obtain Pi's supported TUI reference. It mounts one component in the public document container.

It does not register tools, commands, shortcuts, providers, compaction hooks, headers, footers, editors, or model-context hooks. Its terminal listener never consumes or rewrites input.

Checks cover the configured extensions:

- `auto-compact`
- `pi-vcc`
- Todo
- Ask User Question
- Plannotator
- Powerline
- Cache Rate

The `auto-compact` and `pi-vcc` integration check covers manual, idle, and pre-quit compaction with restored history active.

## Root-cause evidence

Pi 1.3.0 and 1.4.0 both render `SessionManager.buildContextEntries()`. That method intentionally omits history summarized by the latest compaction.

This session's three `pi-vcc` checkpoints occurred before the Pi 1.4.0 upgrade. Each checkpoint followed 30–32 minutes of inactivity. This matches the local idle auto-compactor.

Four earlier Pi-core checkpoints followed 31–35 minutes of inactivity. Auto-compact timing therefore existed before `pi-vcc` and Pi 1.4.0. The compactor change affected summary and tail policy, not the idle trigger.

`pi-vcc` retained 8–42 raw entries in its checkpoints. Earlier native idle checkpoints retained 17–94 entries. Entry size varies, so these counts do not compare retained token volume directly.

**Hypothesis:** This sequence explains the observed change:

```text
Pi 1.3.0
  -> idle auto-compact
  -> pi-vcc checkpoint
  -> compacted transcript view
  -> later resume under Pi 1.4.0
```

The source comparison confirms that Pi 1.4.0 did not introduce the selector behavior. The session timing confirms the idle checkpoints.

## Checks

Runtime checks from the global agent repository:

```text
node --test extensions/session-history/history-window.test.ts
node extensions/session-history/verify-integration.ts <installed-pi-package-directory>
node extensions/session-history/verify-plugin-compatibility.ts <installed-pi-package-directory>
node extensions/auto-compact/verify-vcc-integration.ts <installed-pi-package-directory>
```

The checks use synthetic history and local fixtures. They make no model or network requests. They remove their temporary files.

Run `/reload` to activate extension changes. A Pi upgrade keeps this extension in the global agent directory. The global upgrade skill runs these compatibility checks against the new installed Pi.
