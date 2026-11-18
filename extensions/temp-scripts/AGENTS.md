# Maintain managed script execution

## Boundaries

- **Runtime dependencies**
  - Use Node.js built-ins and Pi-supplied APIs only.
  - Keep runtime code independent of CodeAnchor; ordinary session tools provide authoring.
  - Keep test fixtures separate from runtime modules.
- **Execution contracts**
  - Preserve fresh-process execution, explicit foreground deadlines, streamed output, and owned-process shutdown.
  - Keep shell gates limited to agent-issued tool calls; preserve manual user commands.
  - Do not claim a sandbox or complete Bash emulation.
  - Preserve retained evidence when termination or ownership is uncertain.
  - Compaction and reload must preserve jobs. Quit and session replacement must stop owned jobs.
  - Interruption cancels waiting, not execution; explicit stop terminates a job.
  - Keep background status in a fixed editor widget, not periodic transcript messages.
  - Delete safe successful inline files automatically; keep workspace evidence until explicit immediate release.
  - Use private `~/.pi-temp-scripts` storage; do not migrate or scan legacy temporary jobs automatically.
- **Guidance ownership**
  - Keep execution guidance in active tool metadata, not global `AGENTS.md` or README procedures.
  - Keep maintained TypeScript rules centralized in the global instructions and `TYPESCRIPT.md`.

## Verification

- **Required coverage**
  - Run the focused tests and real Pi offline integration after runtime changes.
  - Verify native manual and automatic compaction without loading other compaction extensions.
  - Verify native dedicated tools remain active and preferred across controls and reload.
  - When output or controls change, run the terminal verifier with the existing terminal driver.
  - When execution contracts change, run the saved live verifier with current defaults and normal authentication.
  - Report platform and runtime coverage separately.
- **Test ownership**
  - Stop and await sessions and children before removing owned fixtures.
  - Preserve unresolved process leases; never delete another session's jobs.
  - Do not install runtime dependencies for this extension.
