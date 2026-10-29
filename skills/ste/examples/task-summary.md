# Example: summarize requirements without adding them

This example uses fictional task descriptions.
No work or verification is implied.

## Source

> This iteration covers the mobile login module. Third-party login is out of scope.
> A session means the login state that the server keeps after successful login.
>
> **Retry Login Requests on Weak Networks** (large, Bug): login requests often time out on weak networks. Retry at most three times.
>
> **Notify Users When the Session Expires** (small, Bug): users receive no notice when their session expires.
>
> **Keep the Password Field Above the Keyboard** (small, Bug): the keyboard hides the password field on some devices.

## STE summary

This summary covers three requirements for mobile login.

**Terms**

- **Session**: the login state that the server keeps after successful login.

**Shared constraints**

- Change only the mobile login module.
- Third-party login is out of scope.

### Retry Login Requests on Weak Networks (large, Bug)

- Problem: login requests often time out on weak networks.
- Required result:
  - If a login request times out, retry it.
  - Retry at most three times.

### Notify Users When the Session Expires (small, Bug)

- Problem: the application gives no notice when a session expires.
- Required result: if the session expires, show a notice.

### Keep the Password Field Above the Keyboard (small, Bug)

- Problem: the keyboard hides the password field on some devices.
- Required result: when the keyboard opens, keep the password field above it.

**Needs confirmation**

- Unconfirmed: the affected device models. Ask for the device list.
- Unconfirmed: what happens after the third retry fails. Ask for the required behavior.
- Unconfirmed: the notice text and the user's next action. Ask for these requirements before implementing the notice.

## Why this works

- Original titles and metadata remain searchable.
- The summary distinguishes current problems from required results.
- It preserves the supplied retry limit.
- It does not invent a backoff algorithm, notice wording, or device list.
- It does not attach `Completed` or `Verified` to requirements.

## Decision example

The following is a separate fictional scenario.
The source requires a release today, and an unrelated logging cleanup is not part of that release.
The user must decide whether to include the cleanup.

```markdown
Decide whether to include the unrelated logging cleanup in today's release.

1. Exclude the cleanup (Recommended) — keep this release within its agreed scope.
2. Include the cleanup — expand the release scope and review its additional changes.
```

This recommendation follows the supplied release constraint.
Do not invent urgency or a deadline to justify a recommendation.
