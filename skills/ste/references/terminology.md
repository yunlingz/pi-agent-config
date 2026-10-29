# Terms for English STE reports

Use these terms consistently when the distinction matters.
This is a small reporting vocabulary, not the ASD-STE100 controlled dictionary.

## 1. Work and verification states

A status describes a named scope, not the entire conversation.
`Completed` and `Verified` answer different questions.

| State | Meaning | Required detail |
| --- | --- | --- |
| **Completed** | All actions in the stated scope finished. No known result contradicts completion of that scope. | Name the completed scope. Do not imply that checks passed. |
| **Partially completed** | Only part of the stated scope finished. | Name the finished, unfinished, and failed parts that matter. |
| **Not started** | No action in the stated scope began. | Identify the scope. |
| **In progress** | Work began and has not finished. | Name the current action and object. |
| **Verified** | A check ran and passed for the stated scope. | Give the method or command, result, and covered scope. |
| **Not verified** | A relevant check is known not to have run. | Name the check or behavior and explain why it was not checked. |
| **Failed** | An action or check ran but did not meet its requirement. | Quote the key failure output when available. Explain the effect on completion. |
| **Skipped** | An action or check was deliberately not run. | Explain why. If relevant behavior remains untested, also state that limitation. |
| **Blocked** | Work cannot continue because a prerequisite is missing. | Name the prerequisite and the action needed to unblock work. |
| **Unconfirmed** | Evidence is insufficient to establish a fact, whether a check ran, or its result. | Identify the missing evidence and how to obtain it. |

Use these labels when stating a status. Do not replace them with "done," "all set," "basically complete," or "looks good."
An ordinary explanatory sentence does not need a status label.
`Passed` and `failed` can describe a check's measured outcome; they do not establish whole-task completion.

### Completion boundaries

- Acceptance conditions come from the user's request, applicable project requirements, and the task's goal. Do not invent extra acceptance conditions.
- If a required check failed or did not run, do not report the whole task as `Completed`.
- A narrower statement can be valid: "Completed: the code changes. Runtime behavior is not verified."
- If that runtime check is required, report the overall task as `Partially completed` or `Blocked`, as appropriate. Name the missing check.
- Never hide a known failure behind "Completed, not verified."
- If another source says "tests passed" but gives no result record, attribute the claim. Do not present it as your own verification.
- Reading code or documentation can verify what the source contains. It cannot verify that an application runs correctly.
- Passing one check does not verify untested platforms, configurations, performance, security, or production behavior.

### Three different evidence states

| Available evidence | Correct report |
| --- | --- |
| The agent knows that `npm test` was not run. | `Not verified: npm test was not run — <reason>.` |
| A handoff contains no test record. | `Unconfirmed: the test result — obtain the test log or run the relevant suite.` |
| The test output reports an assertion failure. | `Failed: <command> — <exact relevant output>.` |

Do not change one state into another to make a report sound more positive.

## 2. Modal words and uncertainty

| Wording | Meaning | Example |
| --- | --- | --- |
| **must** | Required action or condition | "The client must reject an expired token." |
| **must not** | Prohibited action | "The log must not contain credentials." |
| **may** | Permission or an optional action | "You may omit the optional heading." |
| **can** | Capability | "The parser can read JSON." |
| **recommend** | Advice, not a requirement | "I recommend the focused regression test first." |
| **Hypothesis** | A possible explanation, not an established cause | "Hypothesis: concurrent refresh requests invalidate the token. Confirm this with a concurrent-request test." |
| **Unconfirmed** | An unresolved fact | "Unconfirmed: the affected browser versions. Ask for the version list." |

Do not use "should work," "probably fixed," or "seems fine" as verification.
Do not use `may` for both permission and an uncertain cause in the same report.
Use a labeled hypothesis to make an uncertain cause explicit.

## 3. Concrete English

These are local writing preferences, not claims about the official STE dictionary.
Choose the replacement that preserves the actual meaning.

| Vague or indirect wording | More direct wording |
| --- | --- |
| perform an inspection of the configuration | check the configuration |
| make a modification to the parser | change the parser |
| utilize / leverage the existing helper | use the existing helper |
| implement an improvement to error handling | state the behavior, such as "show the connection error" |
| handle / process the issue | name the action: reject, retry, save, remove, or report |
| optimize the module | name the change and any measured result |
| a number of failures | give the known count, or say "failures" if no count is available |
| seamless / robust / production-ready | state the supported behavior and verification scope |
| obviously / simply / just | remove the word unless it adds necessary meaning |
| tests look good | give the check command and its actual result |

Keep necessary technical terms. Plain English must not change technical meaning.
Use normal articles and complete grammar; do not make reports read like telegrams.

## 4. Section names and literals

Use these headings when a section is useful: **Changes**, **Verification**, **Not done**, **Evidence**, **Recommendation**, **Needs confirmation**.
Use **Shared constraints**, **Problem**, and **Required result** for requirements summaries.
Do not add all headings to every reply.

- Write file references as `path:line` only when the line was inspected.
- Put commands, paths, identifiers, and exact error fragments in backticks.
- Preserve source titles, identifiers, numbers, and quoted messages. Mark omitted sensitive text as redacted if a quotation needs it.
- Include the relevant working directory when a command would otherwise be ambiguous.
- Count an inline code span as one unit for the local sentence-length rule. Do not alter a command to reduce its word count.
- Use ordinary English punctuation. Keep punctuation inside a quoted literal unchanged.
