---
name: maintain-agent-guidance
description: >
  When creating, reviewing, or updating global AGENTS.md, global skills, or TYPESCRIPT.md, preserve policy and keep instructions concise.
  Check scope, hierarchy, references, discovery, and applicable live behavior.
---

# Maintain global agent guidance

## Scope and authorization

- **Boundaries**
  - Follow global English STE and safety rules throughout instructions, documentation, examples, and explanatory comments.
  - Reading this skill does not authorize edits, installations, commits, pushes, or current-session reloads.
  - When the user requests review first, present the draft and wait for approval before implementation.
  - Preserve unrelated changes, credentials, executable behavior, schemas, interface labels, quotations, source metadata, and license notices.
- **Policy preservation**
  - Preserve technical meaning, action order, authorization, safety, and required evidence when reorganizing guidance.
  - Separate editorial changes from proposed policy changes. Get approval before weakening or removing a policy.
  - Map each removed obligation to its retained rule, equivalent wording, or mandatory reference.
  - Do not optimize for word count at the expense of correctness or discoverability.

## Choose the instruction owner

- **Always-loaded policy**
  - Keep universal language, authorization, safety, scope, and evidence requirements in global `AGENTS.md`.
  - Keep explicit loading conditions for mandatory skills and references.
  - Use the wording `load skill` followed by the skill name.
  - Do not duplicate the skill catalog or load every reference at startup.
- **Conditional guidance**
  - Put specialized workflows in skills and their references; use descriptions that identify both task and trigger.
  - Keep general preferences global, shared facts in project instructions, and specialized guidance near the relevant code or procedure.
  - Put tool syntax, selection, and recovery procedures in active tool metadata, not global instructions.
  - Moving text into active tool metadata changes ownership; it does not necessarily reduce the active prompt.
  - Keep common TypeScript design and checking requirements centralized in `../../TYPESCRIPT.md`; do not duplicate them in skills or extensions.
- **Artifact roles**
  - Keep README files descriptive. Agent procedures must use instruction files, not depend on README content.
  - Keep skill instructions in Markdown and configuration data in its required format.
  - Follow project sharing conventions. Do not edit installed third-party code or generated artifacts directly.
  - Record durable commands, validation steps, constraints, and key files; exclude secrets and transient task history from always-loaded instructions.

## Structure instructions hierarchically

- **Headings and groups**
  - Use headings for major topics and labeled parent bullets for related rules, conditions, and exceptions.
  - Place supporting rules under the topic they qualify. Keep sibling groups at consistent outline levels.
  - Normally limit bullet lists to two levels; use deeper nesting only for a real dependency.
  - When lists add no value, use short definitions or explanations.
- **Procedures**
  - Use numbered steps for ordered actions, not unordered rules.
  - Label ordered steps with a parent item or a dedicated procedure heading.
  - When procedures share a section with rule groups, nest each numbered procedure under a sibling labeled parent.
  - Do not place an unlabeled numbered list between sibling rule groups.
  - Put prerequisites, warnings, authorization limits, and other constraints before the actions they govern.
  - Keep procedure steps and their supporting examples within the same parent item.
  - Preserve required frontmatter, tables, code blocks, quotations, and executable examples.
- **Code readability**
  - Keep global-skill code well formatted and easy to read.
  - Use descriptive names and straightforward multi-line control flow; do not minify code or compress it into one-liners.
  - Before validation or committing, review code formatting and readability.

## Review and validate changes

- **Prerequisites**
  - Read the full affected guidance, applicable directory instructions, and relevant references before editing.
  - Before changing Pi skill or extension contracts, read the installed Pi documentation and relevant examples.
  - Use existing verification workflows and the configured provider, model, reasoning level, and authentication for live checks.
  - Do not expose private prompts, credentials, sessions, or raw provider diagnostics in reports or Git.
- **Procedure**
  1. Identify the requested outcome, affected policies, proposed owners, and concrete success checks.
  2. Compare the draft with each current obligation, including exceptions and negative rules.
  3. Create required skills or references before activating their global loading rules.
  4. Review complete affected sections for mixed list levels, misplaced constraints, omissions, duplication, and stale references.
  5. Check English STE, preserved literals, reference paths, skill frontmatter, and discovery.
  6. When a Markdown renderer is available, inspect the rendered hierarchy at suitable narrow and normal widths.
  7. Run applicable existing checks and inspect the resulting diff.
- **Behavior changes**
  - When changing policy placement or loading triggers, test actual skill or reference loading before dependent actions.
  - When requested or materially relevant, compare the previous and proposed instructions with the same live behavioral cases.
  - For global-policy comparisons, run `node scripts/verify-guidance.ts <installed-pi-package-directory> <baseline-commit>` from the active agent directory.
  - Test relevant approval, safety, scope, evidence, and language behavior, not only startup or instruction recitation.
  - When loading or continuity changes, include isolated reload and compaction checks.
  - Use harmless fixtures and guards; do not provoke prohibited access to test a prohibition.
  - Tune observed instruction gaps, then rerun affected cases. Do not weaken assertions, change models, or hide failed cases for success.
  - Stop when the requested checks pass; disclose their coverage and remaining uncertainty.
- **Results**
  - Distinguish static inspection, deterministic checks, live behavior, and untested behavior.
  - Passing samples do not prove universal compliance. Record check commands, working directories, results, and material limitations.
  - Reuse successful unchanged checks; keep failed evidence until diagnosis is complete.
  - Stop and await owned sessions and processes before removing only task-owned fixtures.
