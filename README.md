# Pi configuration

This directory is both Pi's default user configuration directory and a local Git repository. Use `/skill:sync-pi-config` to verify and commit reviewed configuration changes locally; no remote or push is required.

## Run

Run `pi` from a project folder. Use `pi --continue` to resume its latest session, `/model` to select a model, `/thinking` to change reasoning effort, and `/compact` for manual compaction.

Pi 1.3.0 is installed globally with npm using `--ignore-scripts`. To update through the same installation method:

```text
npm install --global --ignore-scripts @earendil-works/pi-coding-agent
```

Git Bash is discovered automatically from the existing Git for Windows installation. No shell wrapper or environment-variable changes are needed.

## MCP-free tooling

`settings.json` disables built-in MCP by default with `"extensions": ["-builtin:mcp"]`. The policy is **no MCP protocol anywhere**, including shell bridges, HTTP calls to MCP endpoints, and delegation to another agent. For a per-run opt-out that project settings cannot re-enable, start Pi with `pi --no-mcp`. This flag only disables the built-in integration, not arbitrary third-party MCP adapters; the global instructions prohibit MCP clients/adapters as well. No launcher or shell alias is installed.

When a task references project MCP tools, use `/skill:mcp-free-tools` for generic capability discovery from relevant metadata, schemas, documentation, or source, followed by inference and verification of an approved CLI, script, SDK, or direct API. The global skill contains no server-specific adapter logic, does not launch MCP or import credentials, and reports a capability gap when no non-MCP route can be established. Other agents' MCP configuration remains untouched. Keep project-specific mappings in project docs/scripts/skills and global guidance genuinely cross-project.

## English STE communication

The global [ste skill](skills/ste/README.md) defines a concise, evidence-based English style for technical replies. `AGENTS.md` loads it by default in every session. It puts key information first, separates work status from verification, and requires evidence for task-specific claims. It changes user-facing prose, not project artifacts, and does not claim ASD-STE100 compliance.

Run `/reload`, then `/skill:ste` to enable it in an existing session. Say `stop ste` to stop the style for the current session; `/skill:ste` enables it again. Exact user output formats still take precedence. No extension or dependency is required.

## Installed extensions

Global npm package versions are pinned in `settings.json`; downloaded packages and runtime state remain ignored by Git.

- `@juicesharp/rpiv-todo`: visible task tracking; `/todos` lists tasks and `Ctrl+Shift+T` toggles the panel.
- `@juicesharp/rpiv-ask-user-question`: structured choices when the agent needs clarification; the tool is omitted in non-interactive runs.
- `pi-powerline-footer`: model, thinking, context, token, and Git information; `/powerline` controls the display. AI-generated vibes, automatic follow-up classification, and the welcome overlay are off. Git polling is branch-only, and `/compact` keeps Pi's native meaning.

The local [auto-compact extension](extensions/auto-compact/README.md) compacts before `/quit` and after 30 minutes of inactivity in interactive sessions. It decides when to invoke Pi's native compactor, waits for Pi-managed work, and keeps Pi open if pre-quit compaction fails. The selected model, reasoning level and native output/retention budgets are unchanged. A native incomplete-summary failure needs a Pi compactor/provider fix, not a timing-policy override. Run `/reload` to activate it.

The local [cache-rate item](extensions/cache-rate/README.md) replaces Powerline's native cache percentage through its supported custom-status API. It includes cache writes in the total input denominator, displays one decimal place, and preserves the existing cache slot without patching installed packages.

Autoformat and web-search extensions are not installed. After installing or updating packages, restart with `pi --no-mcp` so lazy UI modules load in a fresh process.

## Theme

The default theme is [ci_dark](themes/README.md), adapted from your iTerm palette for Pi on Windows, Linux, and macOS. Its charcoal surfaces and pastel accents cover messages, Markdown, syntax, tools, and diffs; the existing Powerline footer follows the palette without layout or icon changes. Run `/reload` to apply it here. Terminal profiles and fonts are unchanged.

## Model and credentials

`settings.json` selects `existing_gateway/gpt-latest` with `max` reasoning effort. `models.json` uses the same Responses API gateway as Codex, at `http://127.0.0.1:48081`, with text/image input, a configured context window of 1,050,000 tokens and maximum output allowance of 128,000. The thinking map enables `xhigh` and `max` for this custom model ID.

Automatic compaction is enabled. A native `compaction.modelOverrides` entry reserves 192,000 tokens for `existing_gateway/gpt-latest`: 128,000 for output plus 64,000 extra headroom below the approximately 922,000-token usable-input ceiling observed upstream. The nominal threshold is above 858,000 context tokens; native checks and overflow recovery still govern actual timing. Recent-history retention remains at Pi's 20,000-token default, and other models retain the default 16,384-token reserve. Codex's 820,000-token trigger is not migrated. These are native configuration values, not auto-compact plugin overrides.

The gateway must already be running, as it does for Codex. Its credential was copied once into Pi's private `auth.json`; it is excluded from Git. Rotate that credential separately if the server credential changes.

## Instructions and version control

`AGENTS.md` retains portable preferences from the Codex global instructions: visible progress, bounded network requests, efficient changes, focused context, Node.js helpers on Windows, understanding code before edits, verification, and scoped reusable guidance.

The redundant single-agent rules were removed. Codex execution-cell, yield, session-handle, and shell-parameter instructions were replaced with guidance appropriate to Pi's command tools. Progress updates account for blocking tool calls.

No Codex skills, extensions, MCP servers, sessions, or other Codex settings were migrated.

## Sync configuration

Run `/reload` after adding or editing skills or instructions. Invoke `/skill:sync-pi-config` to run its regression tests, check the currently installed Pi's JSON schemas and skill discovery, and start a real read-only agent session in a disposable OS temporary directory with `--no-mcp`. It checks the required global MCP-disable setting before starting the session, and reviews, stages, and commits intended changes only after verification succeeds. It makes real model requests using the existing credentials and configured default model; it does not update Pi, install packages, or push.

`.gitignore` allows only the reviewed configuration, these instructions, this README, the local auto-compact and cache-rate extensions' source/tests/docs, the ci_dark theme/checks/docs and Powerline color override, and the explicit `sync-pi-config`, `mcp-free-tools`, and `ste` skill files into version control. Credentials, sessions, caches, and other runtime files remain local. Add a narrow ignore exception if you later decide to track another configuration file.

```text
git -C ~/.pi/agent diff --cached
git -C ~/.pi/agent status --short
```
