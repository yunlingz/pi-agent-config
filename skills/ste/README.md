# STE: clear English for Pi

A global skill for concise, precise, and evidence-based technical communication in English.
Use it directly in Pi; no other project or tool is required.

## Behavior

- Put key information first. Use short sentences and consistent terms.
- Separate work status from verification status.
- Give evidence that the user can locate. State each check's scope and limitations.
- Distinguish a failed check, an unexecuted check, and missing evidence.
- Give numbered options when the user must decide. Recommend an option only when the facts support it.
- Use flexible patterns for progress, results, diagnosis, decisions, and multi-item summaries.
- Keep simple answers simple. Do not force headings or status labels onto every reply.

## English writing

- Use at most 20 words for an instruction and 25 words for a description. Protect literals and quotations.
- Use concrete verbs, active voice, and clear subjects.
- Distinguish obligation, permission, capability, and recommendation.
- Keep technical meaning intact. Do not replace necessary technical terms with vague language.
- Preserve quoted logs, interface labels, commands, paths, and identifiers.

The skill changes user-facing prose, not code, comments, commit messages, or generated files.
Those artifacts follow the user's requested format and project conventions.
Explicit output formats take precedence. JSON-only output remains JSON-only.

## Use

The skill is installed at `~/.pi/agent/skills/ste/SKILL.md`.
The global `~/.pi/agent/AGENTS.md` instructs Pi to load it at the start of each session.

- Start a new Pi session to use the default style.
- In an existing session, run `/reload`, then `/skill:ste` to enable it explicitly.
- Use `/skill:ste <request>` to apply the skill to a request.
- Say `stop ste` to stop the style for the current session.
- Invoke `/skill:ste` or explicitly request STE style to enable it again.

Stopping the style does not change the global English-language instruction or other policies.
It does not edit persistent configuration.
No extension, dependency, executable, or MCP connection is required.

The skill relies on the model following instructions; it is not a programmatic formatter or compliance checker.
If the style is lost after compaction, invoke `/skill:ste` again unless you intentionally opted out.
To make activation optional in future sessions, remove the **Use English STE for user-facing replies** section from the global `AGENTS.md`.

## Files

| File | Purpose |
| --- | --- |
| [SKILL.md](SKILL.md) | Activation, scope, writing rules, reply patterns, and self-check. |
| [references/terminology.md](references/terminology.md) | Status meanings, evidence boundaries, modal words, and concrete English. |
| [examples/result-report.md](examples/result-report.md) | Before/after report and edge cases for failure, missing evidence, hypotheses, and exact output. |
| [examples/task-summary.md](examples/task-summary.md) | Requirements summary and a decision example. |
| [LICENSE](LICENSE) | MIT license and copyright notice. |

Examples contain fictional facts. Never report their commands or results as checks performed on a real task.

## Relationship to ASD-STE100

ASD-STE100 is the official Simplified Technical English standard for technical documentation.
See the [official site](https://www.asd-ste100.org/) for the standard and its dictionary.

This skill is a practical writing style for agent conversations.
It does not reproduce the standard or its controlled dictionary, does not enforce the complete standard, and has no affiliation with ASD.
Short sentences and familiar principles alone do not establish ASD-STE100 compliance or certification.
