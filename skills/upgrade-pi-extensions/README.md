# Upgrade global Pi extensions

One command upgrades global third-party npm extensions automatically:

```text
/skill:upgrade-pi-extensions
```

Run `/reload` first in an existing session after installing this skill.
There are no approval or interactive-test questions.
Reading or testing the skill does not start real upgrades.

## Behavior

1. Check the current configuration with the existing verifier.
2. Select the newest stable releases compatible with the installed Pi, Node.js, and existing settings.
3. Install one exact version at a time.
4. Verify each candidate and restore the previous version if a check fails.
5. Try an older eligible candidate when needed.
6. Create one local settings commit for verified upgrades. Never push.

Each upgrade replaces one fixed version number with another.
The skill never saves `@latest` or a version range.
It preserves resource filters, models, credentials, and unrelated settings.
It does not perform configuration or data migrations.

Pi itself, project packages, Git/local packages, and local extension source files are outside scope.
If settings are already modified or work is staged, the skill stops without changing them.

## Verification limits

The skill reuses the [existing configuration verifier](../sync-pi-config/scripts/verify.mjs).
Its checks cover schemas, resource loading, and basic agent operation with MCP disabled.
Package-specific automatic checks are used when available without extra tooling.
Browser and interactive terminal features are not confirmed automatically.
The report must state that limit; no manual confirmation is required.

Exact package versions do not fully lock dependency versions.
Reinstalling an old version cannot guarantee reversal of a publisher's install scripts or external side effects.
