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

The writing policy is at the top of [AGENTS.md](AGENTS.md#use-english-ste).
Six writing groups retain the upstream principles, fixed status meanings, and an internal review.
STE applies to every reply and to updates of global `AGENTS.md` and global skills.
For global skills, it covers instructions, documentation, examples, and explanatory comments.
Style edits preserve executable behavior, commands, schemas, identifiers, quoted text, and license notices.
Other project artifacts follow the requested format and project conventions.

STE stays active across reloads, compaction, and handoffs.
There is no session disable command.
Run `/reload` to refresh global instructions in an existing session.
There is no standalone STE skill or extra reference to load.
Exact output formats still take precedence.
No extension or dependency is required.

This is a practical writing policy, not a claim of formal STE compliance or certification.
The STE-derived guidance retains its [MIT license notice](licenses/ste/LICENSE).

## Installed extensions

Global npm package versions are pinned in `settings.json`; downloaded packages and runtime state remain ignored by Git.

- `@juicesharp/rpiv-todo`: visible task tracking; `/todos` lists tasks and `Ctrl+Shift+T` toggles the panel.
- `@juicesharp/rpiv-ask-user-question`: structured choices when the agent needs clarification; the tool is omitted in non-interactive runs.
- `pi-powerline-footer`: model, thinking, context, token, and Git information; `/powerline` controls the display. AI-generated vibes, automatic follow-up classification, and the welcome overlay are off. Git polling is branch-only, and `/compact` keeps Pi's native meaning.

The local [auto-compact extension](extensions/auto-compact/README.md) compacts before `/quit` and after 30 minutes of inactivity in interactive sessions. It decides when to invoke Pi's native compactor, waits for Pi-managed work, and keeps Pi open if pre-quit compaction fails. The selected model, reasoning level and native output/retention budgets are unchanged. A native incomplete-summary failure needs a Pi compactor/provider fix, not a timing-policy override. Run `/reload` to activate it.

The local [cache-rate item](extensions/cache-rate/README.md) replaces Powerline's native cache percentage through its supported custom-status API. It includes cache writes in the total input denominator, displays one decimal place, and preserves the existing cache slot without patching installed packages.

Autoformat and web-search extensions are not installed. After installing or updating packages, restart with `pi --no-mcp` so lazy UI modules load in a fresh process.

## Upgrade extensions

Use the global [upgrade-pi-extensions skill](skills/upgrade-pi-extensions/README.md) with `/skill:upgrade-pi-extensions`. It automatically selects compatible stable releases for global npm extensions, keeps exact version pins, and verifies each upgrade. Failed candidates are replaced with the previous version before an older compatible candidate is tried. There are no approval or interactive-test questions. Verified settings changes receive one local commit; nothing is pushed.

The skill reuses Pi's commands and the existing configuration verifier, without a separate planner or upgrade engine. Pi itself, project packages, Git/local packages, and local extension source files are outside scope. Models, credentials, resource filters, and unrelated settings are preserved. Browser and interactive feature behavior is not automatically verified.

## Theme

The default theme is [ci_dark](themes/README.md), adapted from your iTerm palette for Pi on Windows, Linux, and macOS. Its charcoal surfaces and pastel accents cover messages, Markdown, syntax, tools, and diffs; the existing Powerline footer follows the palette without layout or icon changes. Run `/reload` to apply it here. Terminal profiles and fonts are unchanged.

## Model and credentials

`settings.json` selects `existing_gateway/gpt-latest` with `max` reasoning effort. `models.json` uses the same Responses API gateway as Codex, at `http://127.0.0.1:48081`, with text/image input, a configured context window of 1,050,000 tokens and maximum output allowance of 128,000. The thinking map enables `xhigh` and `max` for this custom model ID.

Automatic compaction is enabled. A native `compaction.modelOverrides` entry reserves 192,000 tokens for `existing_gateway/gpt-latest`: 128,000 for output plus 64,000 extra headroom below the approximately 922,000-token usable-input ceiling observed upstream. The nominal threshold is above 858,000 context tokens; native checks and overflow recovery still govern actual timing. Recent-history retention remains at Pi's 20,000-token default, and other models retain the default 16,384-token reserve. Codex's 820,000-token trigger is not migrated. These are native configuration values, not auto-compact plugin overrides.

The gateway must already be running, as it does for Codex. Its credential was copied once into Pi's private `auth.json`; it is excluded from Git. Rotate that credential separately if the server credential changes.

## Instructions and version control

`AGENTS.md` retains portable preferences from the Codex global instructions.
These cover visible progress, bounded network requests, efficient changes, focused context, code inspection before edits, verification, and scoped reusable guidance.
Temporary helpers and command orchestration use JavaScript and Node.js on every platform.

The redundant single-agent rules were removed. Codex execution-cell, yield, session-handle, and shell-parameter instructions were replaced with guidance appropriate to Pi's command tools. Progress updates account for blocking tool calls.

No Codex skills, extensions, MCP servers, sessions, or other Codex settings were migrated.

## Sync configuration

Run `/reload` after adding or editing skills or instructions. Invoke `/skill:sync-pi-config` to run its regression tests, check the currently installed Pi's JSON schemas and skill discovery, and start a real read-only agent session in a disposable OS temporary directory with `--no-mcp`. It checks the required global MCP-disable setting before starting the session, and reviews, stages, and commits intended changes only after verification succeeds. It makes real model requests using the existing credentials and configured default model; it does not update Pi, install packages, or push.

`.gitignore` tracks only reviewed configuration, documentation, local extensions, themes, and explicitly listed global skill files.
The tracked global skills are `sync-pi-config`, `mcp-free-tools`, and `upgrade-pi-extensions`.
The retained STE license is also tracked.
Credentials, sessions, caches, and other runtime files remain local.
Add a narrow ignore exception before tracking another configuration file.

```text
git -C ~/.pi/agent diff --cached
git -C ~/.pi/agent status --short
```
