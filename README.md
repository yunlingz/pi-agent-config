# Pi configuration

This directory is both Pi's default user configuration directory and a local Git repository. Use `/skill:sync-pi-config` to verify and commit reviewed configuration changes locally; no remote or push is required.

## Run

Run `pi --no-mcp` from a project folder. Use `pi --no-mcp --continue` to resume its latest session.
`/model` selects a model, `/thinking` changes reasoning effort, and `/compact` starts manual compaction.

The maintained configuration targets Pi 1.5.1 and Node.js 22.19 or newer compatible runtimes.
The upgrade skill supports existing npm global and Yarn Classic global installations.
It identifies the active executable's installation before choosing a package manager.
It preserves that manager and its package and binary locations; no fixed drive or shell is required.
The upgrade skills use the approved company registry and disable lifecycle scripts.
They do not use `pi update` or modify installed code directly.

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

The local [compact-quit extension](extensions/compact-quit/README.md) adds only `/compact-quit`.
It waits for Pi's current agent work, requests native compaction, then exits after success or a native no-op.
Failure or cancellation keeps Pi open. Ordinary `/quit` exits normally without requesting compaction.
Idle time no longer triggers compaction. Native threshold checks, overflow recovery, and summary scheduling remain unchanged.
The command does not change prompts, model selection, reasoning effort, token budgets, or saved settings.
Compaction can incur model charges. Pi saves session history without compaction.

The local [token-usage item](extensions/token-usage/README.md) replaces the separate cost and cache displays. It reports `in`, `cr`, `cw`, `out`, and the input-token cache percentage in one item. Counts start after the latest successful manual or automatic compaction and survive reload and resume. The four raw fields remain separate; this item does not use native `token_in` or `token_out`.

The local [web-search extension](extensions/web-search/README.md) registers and displays `web_run`.
[`web-search.json`](web-search.json) selects one search provider and its model allowlist; [`web-search.schema.json`](web-search.schema.json) supplies editor and runtime validation.
The supplied Responses provider allows Astra, Sol, and Terra through `existing_gateway`; runtime code does not restrict model names or gateways.
Each search uses an independent request with the main session's model, required native search, and low reasoning.
It sends selected context, not the full conversation, and retains 64k gateway-counted input and 32k generation limits.
`/web-search on|off|status` controls the session preference. Powerline shows `web: on`, `web: off`, `web: unavailable`, or `web: invalid setting`.
Configuration edits take effect on `/reload`. The extension uses TypeScript without a build step or MCP.

The local [managed scripts extension](extensions/temp-scripts/README.md) provides `script_inline`, `script_js`, and `script_job`.
It runs JavaScript helpers and native commands in fresh supervised Node.js processes, with streamed output and retained workspaces.
When enabled, it blocks agent-issued Bash and PowerShell calls; manual user shell commands remain unchanged.
`/temp-scripts on|off|status` controls the branch preference. Powerline displays `scripts: on` or `scripts: off`.
Normal session tools author scripts. CodeAnchor supplies optional hashline/AST behavior without a runtime dependency between the extensions.
The extension uses no third-party runtime packages. Its [README](extensions/temp-scripts/README.md) describes retention and compatibility limits.

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

Use the global [upgrade-pi-extensions skill](skills/upgrade-pi-extensions/SKILL.md) with `/skill:upgrade-pi-extensions`. It automatically selects compatible stable releases for global npm extensions, keeps exact version pins, and verifies each upgrade. Failed candidates are replaced with the previous version before an older compatible candidate is tried. There are no approval or interactive-test questions. Verified settings changes receive one local commit; nothing is pushed.

The skill reuses Pi's commands and the existing configuration verifier, without a separate planner or upgrade engine. Pi itself, project packages, Git/local packages, and local extension source files are outside scope. Models, credentials, resource filters, and unrelated settings are preserved. Browser and interactive feature behavior is not automatically verified.

## Theme

The default theme is [ci_dark](themes/README.md), adapted from your iTerm palette for Pi on Windows, Linux, and macOS. Its charcoal surfaces and pastel accents cover messages, Markdown, syntax, tools, and diffs; the existing Powerline footer follows the palette without layout or icon changes. Run `/reload` to apply it here. Terminal profiles and fonts are unchanged.

## Model and credentials

`settings.json` selects `existing_gateway/gpt-6.1-sol` with `xhigh` reasoning effort for new sessions.
Per-model settings and thinking maps restrict Astra to `high`, Sol to `xhigh`, and Terra to `max`.
`models.json` defines the Responses endpoint, authentication reference, and text/image support.
Endpoint and credential configuration can differ between branches; the saved provider configuration is authoritative.
Each model has a configured context window of 1,050,000 tokens and a maximum output allowance of 128,000 tokens.
Independent web searches retain `low` effort without changing the main session's effort.
Resumed sessions restore their saved model and effort; startup defaults do not replace session history.

Native automatic compaction is enabled. Native `compaction.modelOverrides` entries reserve 192,000 tokens for each of the three configured models: 128,000 for output plus 64,000 extra headroom below the approximately 922,000-token usable-input ceiling observed upstream. The nominal threshold is above 858,000 context tokens; native checks and overflow recovery still govern actual timing. For built-in compaction, recent-history retention remains at Pi's 20,000-token default. Other models retain the default 16,384-token reserve. Codex's 820,000-token trigger is not migrated. The compact-quit command does not override these native configuration values.

On Pi 1.4.0, native summaries use the model's output limit.
The reserve controls automatic compaction timing, not summary output length.

The configured gateway must be reachable. Pi resolves authentication from the provider configuration, environment, or private credential storage.
Credentials and sessions remain excluded from Git. Tests do not print secret values or require a fixed credential source.

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

## Reusable verification

Run commands from this agent directory, using the active installed Pi package path:

```text
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
node themes/verify.ts <installed-pi-package-directory>
node skills/sync-pi-config/scripts/verify.ts <installed-pi-package-directory>
```

The managed-script feature has separate real-provider and terminal checks:

```text
node extensions/temp-scripts/verify-live.ts <installed-pi-package-directory>
node extensions/temp-scripts/verify-tui.ts <installed-pi-package-directory> <existing-node-pty-directory> <powerline-directory>
```

Offline plugin tests use controlled responses and synthetic models. They need no service credentials or external model requests.
They cover native compact-quit ordering, sequential summary requests, failures, cancellation, no-ops, usage, search controls, and rendering.
The configuration verifier makes a real read-only request with the configured default model and global resources.

Feature-specific live checks are optional and can incur model charges:

```text
node scripts/verify-extensions.ts <installed-pi-package-directory> live [provider/model]
```

Live checks use Pi's configured default model, reasoning level, and authentication unless an exact model override is supplied.
They do not substitute another model when a capability is unavailable.
The compaction test covers compact-quit, native checkpoint persistence, token reset, session reopening, and continuation.
The web-search test requires the configured search provider's API, allowlist, hosted search, and input-count capabilities.
These checks use synthetic history; they do not test every terminal or browser workflow.
MCP remains disabled and temporary state is removed after each check.

## Instructions and version control

`AGENTS.md` retains portable preferences from the Codex global instructions.
These cover bounded network requests, efficient changes, focused context, code inspection before edits, verification, and scoped reusable guidance.
Managed execution tools own temporary-script routing, process progress, retention, and cleanup contracts.
The former global progress and temporary-helper sections were removed after replacement verification.
Maintained local code retains the centralized TypeScript rules; disposable helpers use JavaScript.

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
