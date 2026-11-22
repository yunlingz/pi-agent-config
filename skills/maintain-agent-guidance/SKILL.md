---
name: maintain-agent-guidance
description: >
  When creating, reviewing, or updating global AGENTS.md, global skills, or TYPESCRIPT.md, preserve policy and keep instructions concise.
  Check scope, hierarchy, references, discovery, and applicable live behavior.
---

# Maintain global agent guidance

## Scope and ownership

Global English STE, authorization, privacy, evidence, and cleanup rules remain active.
Reading this skill does not authorize edits, installations, Git mutations, or current-session reloads.
When review comes first, present the draft and wait for approval.

- Keep universal preferences and mandatory loading triggers in global `AGENTS.md`.
- Keep project facts in project instructions and specialized procedures beside their code or in skills.
- Keep tool syntax and recovery contracts in active tool metadata, not always-loaded policy.
- Keep shared TypeScript rules in [TYPESCRIPT.md](../../TYPESCRIPT.md).
- Use `load skill` followed by the skill name for mandatory discovery.
- Do not duplicate the skill catalog or load every reference at startup.
- README files describe artifacts; agents must not depend on them for required procedures.
- Skill instructions use Markdown; configuration uses its required format.
- Preserve sharing conventions, schemas, executable behavior, labels, quotations, metadata, licenses, credentials, and unrelated work.
- Do not edit installed third-party code or generated artifacts.
- Keep durable commands and facts; exclude secrets and transient task history.

Moving prose into tool metadata changes ownership, not necessarily prompt size.
Shorter text is not better when it loses meaning or discovery.

## Review procedure

1. Read the complete affected guidance, directory instructions, and relevant references.
2. Identify the outcome, authorization, policy owners, and concrete checks.
3. Map each removed obligation to a retained rule, equivalent wording, or mandatory reference.
4. Separate editorial changes from policy changes that need approval.
5. Create required skills or references before enabling their loading rules.
6. Review hierarchy, language, literals, reference paths, frontmatter, and discovery.
7. Run relevant checks and inspect the complete diff.

Before changing Pi extension or skill contracts, read the installed documentation and relevant examples.
When a Markdown renderer is available, inspect narrow and normal layouts.

## Structure

- Use headings for topics and labeled parent bullets for related rules.
- Keep sibling groups consistent and normally limit bullets to two levels.
- Use numbered steps only for ordered procedures; do not leave them unlabeled between rule groups.
- Put prerequisites and warnings before affected steps.
- Keep procedures and their examples under one owner.
- Keep skill code readable; do not minify examples or compress supporting logic into one-liners.

## Behavior checks

- Test changed skill/reference loading before dependent actions.
- When policy behavior changes materially, compare identical live cases with the configured model, effort, provider, and authentication.
- Use `node scripts/verify-guidance.ts <installed-pi-package-directory> <baseline-commit> [case ...]` from the active agent directory.
- Check relevant approval, safety, scope, evidence, and language behavior, not only instruction recitation.
- Loading or continuity changes require isolated reload and compaction cases.
- Use harmless guarded fixtures; do not provoke prohibited access.
- Correct observed gaps and repeat affected checks without weakening assertions or changing models to obtain success.
- Stop when selected checks pass; report methods, scope, uncertainty, and untested behavior.
- Reuse valid unchanged results and retain failed evidence until diagnosis finishes.
- Stop owned sessions and processes before removing their fixtures.
