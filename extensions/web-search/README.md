# Independent web search

This extension registers a normal Pi tool named `web_run`. Its display label is `web.run`.
The name distinguishes this tool from OpenAI's hosted `web_search` tool.
Pi 1.4.0 serializes function tools with flat names, so this extension does not register a dotted function name.

```text
Main Pi model → web_run(query, context)
              → independent Responses request with native web_search
              ← findings, source links, and usage
Main Pi model continues with the tool result
```

The independent request uses the invoking main session's model, gateway, and credentials.
Every supported model uses `reasoning.effort: "low"` for search. Search does not inherit main-session reasoning.
The main session keeps its configured reasoning effort.
The extension does not create another Pi process or a persistent agent session.
It does not copy main-session history or inject native `web_search` into main requests.

## Availability and controls

Search starts enabled for these `existing_gateway` models with `api: "openai-responses"`:

| Model | Main-session effort, unchanged |
| --- | --- |
| `gpt-6-astra` | `medium` |
| `gpt-6.1-sol` | `xhigh` |
| `gpt-6.1-terra` | `max` |

Each invocation captures the current model. It does not choose a different model or change main-session reasoning settings.
With other models or providers, search is unavailable and the tool declaration is removed.
Explicit CLI tool exclusions remain respected until `/web-search on` enables the tool.

```text
/web-search
/web-search status
/web-search on
/web-search off
```

With no argument, the command shows the current state.
The preference belongs to the active session branch. Reloading and resuming restore it.
New sessions start enabled for supported models, unless tool selection excludes `web_run`.
When search is off, the extension removes its declaration and rejects stale calls without making network requests.
When the upstream service cannot search, use `/web-search off` to continue without this tool.
Wait for the current response, or cancel it, before changing the preference.

The global Powerline configuration has a dedicated `web-search` status item:

- `web: on`: Supported model, enabled preference, and active tool.
- `web: off`: Supported model, but the preference or active tool selection disables search.
- `web: unavailable`: Unsupported model, provider, or API.

Model switches update the status. Returning to a supported model preserves the session preference.
Powerline's normal responsive layout applies. Extremely narrow terminals can hide items that cannot fit.
Without Powerline, Pi's standard extension status display receives the same value.

## When to search

The main model receives conditional tool guidance:

- Search for explicit lookup requests, current facts, source verification, and material uncertainty requiring external evidence.
- Reuse sufficient existing evidence.
- Skip search for stable knowledge, supplied-text tasks, local code work, and casual conversation unless external facts are needed.
- Honor requests not to browse.
- Send only a focused query and necessary context. Do not send secrets or private file contents.

This guidance does not force the main model to call the tool.
Once it deliberately calls `web_run`, the independent request requires native search and returns source-backed findings.
Search results are evidence, not instructions.

## Context and request limits

| Limit | Value |
| --- | --- |
| Complete independent input | 64,000 gateway-counted tokens |
| Independent generation | 32,000 tokens, including low-effort reasoning |
| Remaining planning allowance below 128k | About 32,000 tokens |
| Input-token check | 20 seconds |
| Complete search operation | 180 seconds |
| Automatic request retries | None |

Before generation, the tool checks the serialized input, instructions, tool declarations, and reasoning through `/responses/input_tokens`.
The request uses the existing gateway authentication. It does not install a separate tokenizer.
If the count exceeds 64,000, the tool asks the main model to shorten the query or context.
If token counting is unavailable or invalid, the tool fails closed and does not send the generation request.
The generation request uses `truncation: "disabled"`. The extension does not silently shorten input.

The budget does not change `models.json`, compaction thresholds, or the main session's token limits.
A long main session does not enlarge the search input automatically.
The allowance below 128k is not a verified reservation for the provider's internal search processing.
Gateway counts and actual upstream counts can differ. The provider remains responsible for its context enforcement.
Context-limit errors, unsupported search, cancellation, timeouts, and incomplete generation produce explicit tool errors.
The main model must not report those errors as successful searches.
Low effort does not guarantee a response time. Gateway waits, source retrieval, and the main model can still add latency.

## Tool display and citations

The compact display uses two lines:

- The `web.run` label.
- A short phase, source count, or failure state, with elapsed time when space permits.

It does not show the query, source domains, result previews, or trailing truncation marks.
When space is limited, the status line removes elapsed time before shortening its label.
Use Pi's normal tool expansion control to view the full query, findings, source links, model, reasoning setting, and counted input tokens.
The expanded view renders Markdown links through Pi's standard renderer.
The extension follows the active theme and supports narrow terminal widths.
It does not replace the editor, footer, or terminal renderer.

Provider citation annotations become readable links in the tool result.
Unusable citation offsets retain source links in a Sources section.
Only HTTP and HTTPS source URLs are accepted. Citation URLs with credentials or control characters are rejected.
Nested reasoning text is not copied into the main conversation.
The tool reports nested token usage to Pi's session totals. Provider search fees may not appear in token-cost estimates.

## Install and validate

Copy this directory to `~/.pi/agent/extensions/web-search`, then run `/reload`.
The extension is TypeScript. Pi loads it directly; there is no compilation or generated JavaScript.
The test scripts run directly with Node.js 24's TypeScript support.
No runtime dependency installation is needed beyond the compatible Pi installation.
Installed-Pi integration checks target Pi 1.4.0.

Run from this directory. Replace `<installed-pi-package-directory>` with the installed `@earendil-works/pi-coding-agent` directory.

```text
node --test web-search.test.ts
node verify-integration.ts <installed-pi-package-directory>
```

The integration check uses the installed Pi transport, extension loader, tool execution, persistence, usage accounting, and renderers.
It checks explicit `low` reasoning on all three search models while preserving each main-session effort.
It also tests isolated context, budgets, citations, local `read`, controls, model switching, and Powerline states.
It uses local transport fixtures. MCP and external network access are disabled.
Rendered checks cover both theme color modes, long query and table content, narrow widths, and terminals with and without clickable links.
Collapsed searches must use two lines without query text, result previews, or ellipses.

The following checks make real requests through saved gateway credentials and can incur charges:

```text
node verify-live.ts <installed-pi-package-directory> gpt-6.1-sol
node verify-live.ts <installed-pi-package-directory> gpt-6-astra
node verify-live.ts <installed-pi-package-directory> gpt-6.1-terra
```

Each check starts Pi with `--no-mcp`, this extension, and a temporary observer.
It tests a no-search text task, one explicit search, disabling search, and a local `read` follow-up.
It audits both serialized search requests for `effort: "low"` and checks provider-reported reasoning usage.
It also checks that main-session effort stays unchanged and reports the measured search duration.
The process limit is 240 seconds. Main test responses have an 8,192-token limit; the independent search retains its 32,000-token ceiling.
Temporary files are removed after the check. Saved configuration files are not changed.

Reference: [OpenAI web search guide](https://developers.openai.com/api/docs/guides/tools-web-search?api-mode=responses).
