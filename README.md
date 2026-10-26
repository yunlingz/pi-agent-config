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

## Model and credentials

`settings.json` selects `existing_gateway/gpt-latest` with `max` reasoning effort. `models.json` uses the same Responses API gateway as Codex, at `http://127.0.0.1:48081`, with text/image input and an explicit hard context limit of 872,000 tokens. The thinking map enables `xhigh` and `max` for this custom model ID.

Compaction uses Pi's defaults, with no overrides: automatic compaction is enabled, 16,384 tokens are reserved, and 20,000 recent tokens are retained. With this context limit, the default threshold is above approximately 855,616 context tokens. Codex's 820,000-token trigger is not migrated. The output limit also uses Pi's default for a custom model.

The gateway must already be running, as it does for Codex. Its credential was copied once into Pi's private `auth.json`; it is excluded from Git. Rotate that credential separately if the server credential changes.

## Instructions and version control

`AGENTS.md` retains portable preferences from the Codex global instructions: visible progress, bounded network requests, efficient changes, focused context, Node.js helpers on Windows, understanding code before edits, verification, and scoped reusable guidance.

The redundant single-agent rules were removed. Codex execution-cell, yield, session-handle, and shell-parameter instructions were replaced with guidance appropriate to Pi's command tools. Progress updates account for blocking tool calls.

No Codex skills, extensions, MCP servers, sessions, or other Codex settings were migrated.

## Sync configuration

Run `/reload` after adding or editing skills or instructions. Invoke `/skill:sync-pi-config` to run its regression tests, check the currently installed Pi's JSON schemas and skill discovery, and start a real read-only agent session in a disposable OS temporary directory with `--no-mcp`. It checks the required global MCP-disable setting before starting the session, and reviews, stages, and commits intended changes only after verification succeeds. It makes real model requests using the existing credentials and configured default model; it does not update Pi, install packages, or push.

`.gitignore` allows only the reviewed configuration, these instructions, this README, and the explicit `sync-pi-config` and `mcp-free-tools` skill files into version control. Credentials, sessions, caches, and other runtime files remain local. Add a narrow ignore exception if you later decide to track another configuration file.

```text
git -C ~/.pi/agent diff --cached
git -C ~/.pi/agent status --short
```
