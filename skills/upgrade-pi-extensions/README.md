# Upgrade global Pi extensions

Use this command to upgrade global third-party npm extensions:

```text
/skill:upgrade-pi-extensions
```

After installing or changing this skill, run `/reload` in an existing session.
The skill does not ask for approval or interactive tests.
Reading, creating, reviewing, or testing this skill does not authorize real upgrades.

## Workflow

1. Check the current configuration with the existing verifier.
2. Select the newest stable releases compatible with installed Pi, Node.js, and settings.
3. Install one exact version at a time.
4. Verify each candidate. If a check fails, restore the previous exact version.
5. When needed, try an older eligible candidate.
6. Create one local settings commit for verified upgrades. Never push.

Each upgrade replaces one fixed version number with another.
The skill never saves `@latest` or a version range.
It preserves resource filters, models, credentials, and unrelated settings.
It does not perform configuration or data migrations.

Pi itself, project packages, Git packages, local packages, and local extension source files are outside scope.
If settings are already modified or work is staged, the skill stops without changing them.

## Verification limits

The skill reuses the [existing configuration verifier](../sync-pi-config/scripts/verify.mjs).
Its checks cover schemas, resource loading, and basic agent operation with MCP disabled.
The skill uses package-specific automatic checks when they need no extra tooling.
Browser and interactive terminal behavior is not verified automatically.
The report must state this limitation.
The skill does not require manual confirmation.

Exact package pins do not fully lock dependency versions.
Reinstalling a previous version cannot guarantee reversal of publisher install scripts or external side effects.
