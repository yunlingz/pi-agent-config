# Pi configuration

Global configuration for Pi 1.5.1 and Node.js 22.19 or newer compatible runtimes.
Run `pi` in a project or `pi --continue` to resume its latest session.
Use `/reload` after changing local extensions, skills, or settings.

## Configuration

- [settings.json](settings.json): native tools, model defaults, packages, compaction, and footer layout.
- [models.json](models.json): Responses models with text/image support and per-model reasoning maps.
- [web-search.json](web-search.json): exact model allowlist for independent web research.
- [ci-dark](themes/README.md): terminal UI and export colors from the original iTerm palette.
- [AGENTS.md](AGENTS.md): global working preferences and English STE writing policy.
- [TYPESCRIPT.md](TYPESCRIPT.md): maintained-code rules with one strict [tsconfig.json](tsconfig.json).

The default model is `existing_gateway/gpt-6.1-sol` at `xhigh`; Astra uses `high` and Terra uses `max`.
All three declare a 1,050,000-token context and 128,000-token output allowance.
Native compaction reserves 192,000 tokens per model; actual timing follows Pi's checks and overflow recovery.
Credentials, sessions, caches, and downloaded packages remain local and untracked.

## Extensions

| Extension | Purpose |
| --- | --- |
| [compact-quit](extensions/compact-quit/README.md) | `/compact-quit`: native compaction followed by graceful exit |
| [token-usage](extensions/token-usage/README.md) | Raw input/cache/output counts and cache rate since compaction |
| [web-search](extensions/web-search/README.md) | `web_run` and `/web-search on\|off\|status` |
| ci-dark | Default text and background colors independent of the terminal scheme |
| `@juicesharp/rpiv-todo` | Task tracking and `/todos` |
| `@juicesharp/rpiv-ask-user-question` | Structured interactive questions |
| `pi-powerline-footer` | Model, context, Git, and extension statuses |
| `@plannotator/pi-extension` | Browser plan, Markdown, and code reviews |

Package versions are pinned in settings. Powerline's welcome, generated vibes, and automatic follow-ups are off.
Native `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` remain available. Normal sessions do not block MCP.

## Skills and checks

- [sync-pi-config](skills/sync-pi-config/SKILL.md): verify and save reviewed local configuration.
- [upgrade-pi-agent](skills/upgrade-pi-agent/SKILL.md): upgrade through the existing npm or Yarn Classic installation.
- [upgrade-pi-extensions](skills/upgrade-pi-extensions/SKILL.md): select, verify, and recover third-party package upgrades.
- [maintain-agent-guidance](skills/maintain-agent-guidance/SKILL.md): preserve policy and keep guidance concise.

Run checks from this directory with the active installed Pi package path:

```text
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
node themes/verify.ts <installed-pi-package-directory>
node skills/sync-pi-config/scripts/verify.ts <installed-pi-package-directory>
```

Offline checks need no external model requests. Live configuration and feature checks can incur charges.
Upgrade skills use the company registry without lifecycle scripts. Commits and pushes require the applicable explicit authorization.
The [STE MIT notice](licenses/ste/LICENSE) remains part of this repository.
