# Maintain managed script execution

## Boundaries

- **Runtime dependencies**
  - Use Node.js built-ins and Pi-supplied APIs only.
  - Keep runtime code independent of CodeAnchor; ordinary session tools provide authoring.
  - Keep test fixtures separate from runtime modules.
- **Execution contracts**
  - Preserve fresh-process execution, explicit deadlines, streamed output, and owned-process shutdown.
  - Keep shell gates limited to agent-issued tool calls; preserve manual user commands.
  - Do not claim a sandbox or complete Bash emulation.
  - Preserve retained evidence when termination or ownership is uncertain.
- **Guidance ownership**
  - Keep execution guidance in active tool metadata, not global `AGENTS.md` or README procedures.
  - Keep maintained TypeScript rules centralized in the global instructions and `TYPESCRIPT.md`.

## Verification

- **Required coverage**
  - Run the focused tests and real Pi offline integration after runtime changes.
  - When output or controls change, run the terminal verifier with the existing terminal driver.
  - When execution contracts change, run the saved live verifier with current defaults and normal authentication.
  - Report platform and runtime coverage separately.
- **Test ownership**
  - Stop and await sessions and children before removing owned fixtures.
  - Preserve unresolved process leases; never delete another session's jobs.
  - Do not install runtime dependencies for this extension.
