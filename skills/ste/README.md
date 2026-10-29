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
- Review every draft against the full rule set before sending. Correct violations instead of checking sentence length alone.

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
The global `~/.pi/agent/AGENTS.md` requires it for every user-facing reply in every session.
Pi must read the skill and its terminology reference before the first reply.

- Start a new Pi session to load the current global instructions.
- In an existing session, run `/reload` to refresh the instructions.
- Use `/skill:ste` to reload the skill rules when needed.
- Use `/skill:ste <request>` to include a request with the skill rules.

STE is always active. There is no session disable command.
Reloads, compaction, and handoffs must preserve this requirement.
The model must complete the full pre-send review before every reply.
No extension, dependency, executable, or MCP connection is required.

The skill relies on the model following instructions; it is not a programmatic formatter or compliance checker.
The required review covers the complete rule set, not just sentence length.

## Files

| File | Purpose |
| --- | --- |
| [SKILL.md](SKILL.md) | Always-active scope, writing rules, reply patterns, and required pre-send review. |
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
