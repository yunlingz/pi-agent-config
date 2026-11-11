# Pi configuration

This directory is both Pi's default user configuration directory and a local Git repository. Use `/skill:sync-pi-config` to verify and commit reviewed configuration changes locally; no remote or push is required.

## Run

Run `pi` from a project folder. Use `pi --continue` to resume its latest session, `/model` to select a model, `/thinking` to change reasoning effort, and `/compact` for manual compaction.

Pi 1.4.0 is installed globally with npm using `--ignore-scripts`.
On this devbox, use the company registry instead of `pi update`.

Query the available release, then install an exact version:

```text
npm view @earendil-works/pi-coding-agent version --registry=https://packagefeedproxy.microsoft.io/npm/ --fetch-retries=0 --fetch-timeout=20000
npm install --global --prefix Q:/.tools/.npm-global --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.4.0 --registry=https://packagefeedproxy.microsoft.io/npm/ --fetch-retries=0 --fetch-timeout=20000
```

For a later upgrade, replace `1.4.0` with the query result.

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
- `pi-powerline-footer`: model, thinking, context, token, and Git information; `/powerline` controls the display. AI-generated vibes, automatic follow-up classification, and the welcome overlay are off. Git polling is branch-only. Powerline does not intercept `/compact`.
- `@plannotator/pi-extension`: browser plan reviews, Markdown annotations, and code reviews; `/plannotator-plan-mode` controls plan mode.

The local [auto-compact extension](extensions/auto-compact/README.md) requests Pi's native compaction before `/quit` and after 30 minutes of inactivity.
It adds no custom summary instructions and does not change model selection, reasoning effort, retention, or output limits.
Native compaction makes model requests and can incur latency and cost.
Work guards, cancellation handling, and failure-before-quit safeguards remain active.
Pi's native transcript view handles compacted sessions; saved session files remain intact.

The local [token-usage item](extensions/token-usage/README.md) replaces the separate cost and cache displays. It reports `in`, `cr`, `cw`, `out`, and the input-token cache percentage in one item. Counts start after the latest successful manual or automatic compaction and survive reload and resume. The four raw fields remain separate; this item does not use native `token_in` or `token_out`.

The local [web-search extension](extensions/web-search/README.md) registers and displays `web_run`.
[`web-search.json`](web-search.json) selects one search provider and its model allowlist; [`web-search.schema.json`](web-search.schema.json) supplies editor and runtime validation.
The supplied Responses provider allows Astra, Sol, and Terra through `existing_gateway`; runtime code does not restrict model names or gateways.
Each search uses an independent request with the main session's model, required native search, and low reasoning.
It sends selected context, not the full conversation, and retains 64k gateway-counted input and 32k generation limits.
`/web-search on|off|status` controls the session preference. Powerline shows `web: on`, `web: off`, `web: unavailable`, or `web: invalid setting`.
Configuration edits take effect on `/reload`. The extension uses TypeScript without a build step or MCP.

Autoformat is not installed. After installing or updating packages, restart with `pi --no-mcp` so lazy UI modules load in a fresh process.

## Upgrade Pi and extensions

Use [upgrade-pi-agent](skills/upgrade-pi-agent/SKILL.md) with `/skill:upgrade-pi-agent` for the full company-registry workflow.
It covers Pi, npm extensions, compatibility checks, and reviewed local configuration commits.
Every npm operation uses `https://packagefeedproxy.microsoft.io/npm/`.
A remote push requires an explicit request.

This skill contains text instructions only.
It reuses `upgrade-pi-extensions`, `sync-pi-config`, and existing repository checks.
Creating or reviewing it does not run upgrades or change Git history.

## Upgrade extensions

Use the global [upgrade-pi-extensions skill](skills/upgrade-pi-extensions/README.md) with `/skill:upgrade-pi-extensions`. It automatically selects compatible stable releases for global npm extensions, keeps exact version pins, and verifies each upgrade. Failed candidates are replaced with the previous version before an older compatible candidate is tried. There are no approval or interactive-test questions. Verified settings changes receive one local commit; nothing is pushed.

The skill reuses Pi's commands and the existing configuration verifier, without a separate planner or upgrade engine. Pi itself, project packages, Git/local packages, and local extension source files are outside scope. Models, credentials, resource filters, and unrelated settings are preserved. Browser and interactive feature behavior is not automatically verified.

## Theme

The default theme is [ci_dark](themes/README.md), adapted from your iTerm palette for Pi on Windows, Linux, and macOS. Its charcoal surfaces and pastel accents cover messages, Markdown, syntax, tools, and diffs; the existing Powerline footer follows the palette without layout or icon changes. Run `/reload` to apply it here. Terminal profiles and fonts are unchanged.

## Model and credentials

`settings.json` selects `existing_gateway/gpt-6.1-sol` with `xhigh` reasoning effort for new sessions.
Per-model settings and thinking maps restrict Astra to `high`, Sol to `xhigh`, and Terra to `max`.
`models.json` uses the Responses API gateway at `http://127.0.0.1:48080`, with text/image input.
Each model has a configured context window of 1,050,000 tokens and a maximum output allowance of 128,000 tokens.
Independent web searches retain `low` effort without changing the main session's effort.
Resumed sessions restore their saved model and effort; startup defaults do not replace session history.

Automatic compaction is enabled. Native `compaction.modelOverrides` entries reserve 192,000 tokens for each of the three configured models: 128,000 for output plus 64,000 extra headroom below the approximately 922,000-token usable-input ceiling observed upstream. The nominal threshold is above 858,000 context tokens; native checks and overflow recovery still govern actual timing. For built-in compaction, recent-history retention remains at Pi's 20,000-token default. Other models retain the default 16,384-token reserve. Codex's 820,000-token trigger is not migrated. These are native configuration values, not auto-compact plugin overrides.

On Pi 1.4.0, native summaries use the model's output limit.
The reserve controls automatic compaction timing, not summary output length.

The gateway must already be running, as it does for Codex. Its credential was copied once into Pi's private `auth.json`; it is excluded from Git. Rotate that credential separately if the server credential changes.

## TypeScript development

Maintained local extensions, skill scripts, tests, and verification tools use directly executable TypeScript.
Skill instructions remain Markdown; configuration and themes retain JSON.
Installed third-party JavaScript and compiled host paths remain unchanged.

One shared [tsconfig.json](tsconfig.json) covers extensions, skills, tests, theme checks, and shared fixtures.
It enables strict checking, erasable syntax, explicit type imports, and no output generation.
Its ESM configuration requires no root package manifest or runtime bundler.
Checking tools and declarations stay in disposable OS temporary directories.

The runtime baseline follows Pi's minimum supported LTS, Node.js 22.19; compatible newer LTS versions remain supported.
Global agent instructions own the coding policy and reference [TYPESCRIPT.md](TYPESCRIPT.md) for detailed procedures.
README files describe the configuration; agents do not depend on them for instructions.

## Instructions and version control

`AGENTS.md` retains portable preferences from the Codex global instructions.
These cover visible progress, bounded network requests, efficient changes, focused context, code inspection before edits, verification, and scoped reusable guidance.
Small disposable helpers and simple command orchestration prefer plain JavaScript with Node.js.
Large or complex helpers use TypeScript when static checks materially improve safety or correctness.
Temporary TypeScript helpers follow the shared checking rules; small JavaScript helpers need no compiler setup.

The redundant single-agent rules were removed. Codex execution-cell, yield, session-handle, and shell-parameter instructions were replaced with guidance appropriate to Pi's command tools. Progress updates account for blocking tool calls.

No Codex skills, extensions, MCP servers, sessions, or other Codex settings were migrated.

## Sync configuration

Run `/reload` after adding or editing skills or instructions. Invoke `/skill:sync-pi-config` to run its regression tests, check the currently installed Pi's JSON schemas and skill discovery, and start a real read-only agent session in a disposable OS temporary directory with `--no-mcp`. It checks the required global MCP-disable setting before starting the session, and reviews, stages, and commits intended changes only after verification succeeds. It makes real model requests using the existing credentials and configured default model; it does not update Pi, install packages, or push.

`.gitignore` tracks only reviewed configuration, documentation, local extensions, themes, and explicitly listed global skill files.
The tracked global skills are `sync-pi-config`, `mcp-free-tools`, `upgrade-pi-extensions`, and `upgrade-pi-agent`.
The retained STE license is also tracked.
Credentials, sessions, caches, and other runtime files remain local.
Add a narrow ignore exception before tracking another configuration file.

```text
git -C ~/.pi/agent diff --cached
git -C ~/.pi/agent status --short
```
