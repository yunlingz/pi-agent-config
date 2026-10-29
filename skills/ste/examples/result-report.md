# Example: a result report with a verification limit

All paths, commands, results, and requirements in this example are fictional fixtures.
They are not evidence about the user's project or this installation.

## Source facts

- The user requested a fix for intermittent logout after login.
- Acceptance requires the authentication unit tests and an iOS device check.
- At `auth/refresh.ts:42`, the code starts a refresh without checking for an existing refresh request.
- A recorded concurrent-request trace shows that a later refresh invalidates the first request's token.
- The agent changed `auth/refresh.ts` so other callers wait for the same refresh result.
- The agent added a concurrent-refresh regression test at `auth/refresh.test.ts:88`.
- In the repository root, `npm test -- auth` reported 48 passed and 0 failed. The new regression test was included.
- No iOS device check ran because the environment has no iOS build tools or device.
- The agent did not change logging or retry behavior.

## Before

> I first looked at the login module and figured the problem was probably related to token refresh.
> Then I implemented an optimization to handle simultaneous calls.
> The tests look good, so everything should work now, although I could not try iOS.
> Should I also clean up the logs and add retries?

Problems with this report:

- It gives a process diary instead of the task status.
- It calls the cause "probable" despite the supplied trace.
- It does not explain the behavior change.
- It implies completion despite a missing acceptance check.
- It gives no command, result, or test scope.
- It proposes unrelated work without a reason to expand the task.

## After

Partially completed: the authentication change and unit checks are complete. The required iOS device check is blocked.

**Cause**: concurrent refresh requests invalidate an earlier token.

**Evidence**

- `auth/refresh.ts:42`: refresh starts without checking for an existing request.
- The recorded concurrent-request trace shows the earlier token becoming invalid after the later refresh.

**Changes**

- `auth/refresh.ts`: concurrent callers now wait for one refresh result.
- `auth/refresh.test.ts:88`: added a concurrent-refresh regression test.

**Verification**

- Verified: `npm test -- auth`, from the repository root — 48 passed, 0 failed. This includes the new regression test.
- Not verified: the iOS device check did not run. This environment has no iOS build tools or device.

**Not done**

- Run the required iOS device check in an environment that supports it.

## Why this works

The opening does not claim that the entire fix meets acceptance conditions.
The report gives one result record for the unit checks and names the untested platform.
The cause comes from the supplied trace, not from inference alone.
The report does not ask the user to approve unrelated logging or retry changes.

## Edge cases

Each case below is an independent fictional fixture.

### A check failed

Source facts: the code change finished. The required test command ran and printed `FAIL refresh rejects concurrent calls`.

```markdown
Partially completed: the code change is complete. The required regression test failed.

**Verification**
- Failed: `npm test -- auth` — `FAIL refresh rejects concurrent calls`.

**Not done**
- Correct the concurrent-refresh behavior and rerun the regression test.
```

Do not rewrite this result as "Completed, not verified."

### A handoff contains no test evidence

Source facts: a handoff says the parser changed. It contains no command output or check record.

```markdown
The handoff reports a parser change. Its verification result is unconfirmed.

**Verification**
- Unconfirmed: whether the parser checks ran or passed. Obtain the check log or run the relevant suite.
```

Do not claim that the checks did not run. Missing evidence does not establish non-execution.

### Only a hypothesis supports the cause

Source facts: the user reports intermittent logout. Code inspection finds concurrent refresh calls, but no reproduction ran.

```markdown
Cause unconfirmed: concurrent refresh calls are a candidate cause of the logout.

**Evidence**
- Code inspection found calls that can overlap. No runtime reproduction ran.

**Hypothesis**: overlapping refresh calls invalidate a token. Confirm this with a concurrent-request test.
```

### The requested output is exact JSON

If the user requests only `{"status":"unknown"}`, return exactly that object.
Do not add an activation message, Markdown fence, heading, or extra field.

### The answer is simple

User: "What command shows the current Git branch?"

Answer: "Run `git branch --show-current`."

No status table or report headings are necessary.
