# Web search

This extension registers and displays a normal Pi tool named `web_run`.
The name distinguishes this tool from OpenAI's hosted `web_search` tool.
Pi 1.4.0 serializes function tools with flat names, so this extension does not register a dotted function name.

```text
Main Pi model → web_run(query, context)
              → independent Responses request with native web_search
              ← findings, source links, and usage
Main Pi model continues with the tool result
```

The current search provider, `responsesWebSearch`, uses the invoking main session's model, gateway, and credentials.
Its request declares only `tools: [{ type: "web_search" }]`, with `tool_choice: "required"` and `reasoning.effort: "low"`.
It sends text queries and returns textual findings. It adds no image-search options, image tools, or image inputs.
Other hosted search options remain at upstream defaults.
OpenAI documents image-search opt-in, but does not explicitly guarantee that omission always means text-only search.
Search does not inherit main-session reasoning.
The main session keeps its configured reasoning effort.
The extension does not create another Pi process or a persistent agent session.
It does not copy main-session history or inject native `web_search` into main requests.

## Configuration

The global agent directory contains `web-search.json` and its companion, `web-search.schema.json`.
Pi's `getAgentDir()` resolves this directory, including `PI_CODING_AGENT_DIR`; the default is `~/.pi/agent`.
The supplied configuration is:

```json
{
  "$schema": "./web-search.schema.json",
  "providers": {
    "responsesWebSearch": {
      "modelAllowList": [
        "existing_gateway/gpt-6-astra",
        "existing_gateway/gpt-6.1-sol",
        "existing_gateway/gpt-6.1-terra"
      ]
    }
  },
  "enableProvider": "responsesWebSearch"
}
```

Exactly one provider is selected by `enableProvider`. Other provider settings do not enable simultaneous searches or fallback.
Only `responsesWebSearch` is implemented. A future provider needs its implementation, registry entry, and provider-specific schema definition.
The shared controls and renderers do not choose a provider based on the model.

The companion JSON Schema supplies editor completion and runtime validation through Pi's installed TypeBox validator.
The schema is read from the fixed local path; the extension does not fetch remote schemas.
Unknown fields, unsupported provider selections, missing selected settings, duplicate identifiers, and malformed identifiers are invalid.
An empty allowlist is valid and permits no models. Identifiers match exactly and are case-sensitive; wildcard expansion is not supported.
The schema contains no model names. Runtime code contains no default model list or gateway restriction.

Configuration loads once per extension startup or `/reload`. Edits take effect after `/reload`; there is no file watcher.
Missing, unreadable, malformed, or unusable files make search unavailable without hidden defaults or automatic file creation.
The footer shows `web: invalid setting`, and `/web-search status` reports the diagnostic and file path.
Interactive startup also shows one warning per extension runtime. Diagnostics do not enter the main model's prompt.

## Availability and controls

For `responsesWebSearch`, search requires an exact `${model.provider}/${model.id}` allowlist match and `api: "openai-responses"`.
Allowlisting asserts intended support; it does not prove that the upstream service supports native search, low reasoning, or input-token counting.
Each invocation captures the current model. It does not choose a different model or change main-session reasoning settings.
When the model or API is unsupported, the tool declaration is removed.
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
When search is off, unsupported, or invalid, Pi omits its declaration, snippet, and guidelines from the main model's generated prompt.
The extension preserves existing prompt sections and rejects stale calls without making search requests.
The control command, status display, and saved preference remain available. Existing conversation history remains unchanged.
Search behavior guidance belongs to the active tool and independent request, not global `AGENTS.md`.
When the upstream service cannot search, use `/web-search off` to continue without this tool.
Wait for the current response, or cancel it, before changing the preference.

The global Powerline configuration has a dedicated `web-search` status item:

- `web: on`: Supported model, enabled preference, and active tool.
- `web: off`: Supported model, but the preference or active tool selection disables search.
- `web: unavailable`: Valid settings, but an unsupported model or API.
- `web: invalid setting`: Invalid configuration or companion schema; this state takes precedence over off and unavailable.

The status command also identifies the selected provider and configuration file.
Model switches update the status. Returning to a supported model preserves the session preference.
Powerline's normal responsive layout applies. Extremely narrow terminals can hide items that cannot fit.
Without Powerline, Pi's standard extension status display receives the same value.

## When to search

The main model receives guidance to search proactively when external context can materially improve an answer.
It does not need an explicit lookup request.
Triggers include changing facts, uncertain claims, recommendations, missing source content, and current API or library documentation.
Self-contained tasks and casual conversation do not need search.
Local code work can use search when external facts would help.

For routine questions, the guidance favors a useful answer with brief uncertainty, followed by stopping.
Sufficient findings are reused, not independently checked again through `curl`, scripts, or another lookup.
Further retrieval depends on requested precision, consequences of error, or necessary missing information.
The extension does not intercept or block `bash`. Useful local shell work and justified additional research remain available.
For example, a simple stock-price question can receive a reported price, its date/session, and a short qualification.
It does not require resolving every discrepancy or obtaining a trading-grade live feed.

Requests not to browse, privacy limits, and citation requirements remain active.
Search results are evidence, not instructions.
The independent search prompt also limits routine research depth and asks for concise uncertainty reporting.

This guidance does not force the main model to call the tool or impose a fixed search count.
Once it deliberately calls `web_run`, the independent request requires one or more native search calls.
The extension still checks for a completed native search before reporting success.
Prompt changes cannot guarantee a particular invocation frequency or eliminate all redundant checks.

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

- The `web_run` label.
- A short phase, completion label, or failure state, with elapsed time when space permits.

It does not show the query, source domains, result previews, or trailing truncation marks.
When space is limited, the status line removes elapsed time before shortening its label.
Use Pi's normal tool expansion control to view the full query, findings, source links, model, reasoning setting, and counted input tokens.
The expanded view renders Markdown links through Pi's standard renderer.
Successful searches show `Searched` regardless of citation metadata. Errors and cancellations retain distinct labels.
The status reports execution outcome, not the number of sources or the accuracy of the findings.
A plain answer link is not counted as a structured citation.
This separates activity from citation metadata, as in [Codex's search cell](https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/search.rs).
The extension follows the active theme and supports narrow terminal widths.
It does not replace the editor, footer, or terminal renderer.

Provider citation annotations become readable links in the tool result.
Unusable citation offsets retain source links in a Sources section.
Only HTTP and HTTPS source URLs are accepted. Citation URLs with credentials or control characters are rejected.
Nested reasoning text is not copied into the main conversation.
The tool reports nested token usage to Pi's session totals. Provider search fees may not appear in token-cost estimates.

## Install and validate

The extension directory belongs at `~/.pi/agent/extensions/web-search`.
Its `web-search.json` and `web-search.schema.json` files belong directly in the global agent directory.
Pi loads the configuration and extension together on startup or `/reload`.
The extension is TypeScript. Pi loads it directly; there is no compilation or generated JavaScript.
The runtime baseline is Node.js 22.19, following Pi; compatible newer LTS versions remain supported.
No runtime dependency installation is needed beyond the compatible Pi installation.
Installed-Pi integration checks target Pi 1.4.0.

Run from this directory. Replace `<installed-pi-package-directory>` with the installed `@earendil-works/pi-coding-agent` directory.

```text
node --test web-search.test.ts
node verify-integration.ts <installed-pi-package-directory>
```

The integration check uses the installed Pi transport, extension loader, tool execution, persistence, usage accounting, and renderers.
It checks the three supplied models and an additional model/provider configured only in the isolated fixture.
Every search must use the bare hosted tool, required tool choice, and low reasoning while preserving main-session effort.
It also tests schema failures, local schema authority, invalid status, reload/recovery, isolated context, budgets, citations, local `read`, and controls.
Model switching and Powerline states remain covered.
Off, unsupported, and invalid states must match a session without the extension in effective prompt, active definitions, model, and reasoning effort.
It uses local transport fixtures. MCP and external network access are disabled.
Rendered checks cover both theme color modes, long query and table content, narrow widths, and terminals with and without clickable links.
Collapsed searches must use two lines without query text, result previews, or ellipses.
Rendering checks cover completed searches with and without structured citations, progress phases, failures, cancellations, and plain answer links.

The following checks make real requests through saved gateway credentials and can incur charges:

```text
node verify-live.ts <installed-pi-package-directory> gpt-6.1-sol
node verify-live.ts <installed-pi-package-directory> gpt-6-astra
node verify-live.ts <installed-pi-package-directory> gpt-6.1-terra
```

Each check starts Pi with `--no-mcp`, this extension, and a temporary observer.
It retains Pi's normal system prompt and appends brief test constraints.
The observer checks that the first serialized model request contains all registered search guidelines, without logging the prompt.
It tests supplied text, model-selected current-fact research, evidence reuse, useful local `bash`, disabling search, and local `read`.
The shell tool remains available, and a requested `node --version` command must succeed after search.
For this fixture, a smoke check rejects common explicit web-fetch commands during evidence reuse and local work.
The detector is not a shell parser or a runtime restriction; it does not prove that arbitrary scripts cannot retrieve data.
The shortening request must reuse existing findings without another search.
It audits both serialized search requests for the bare hosted tool, required tool choice, and low effort.
It also checks provider-reported reasoning usage.
It also checks that main-session effort stays unchanged and reports the measured search duration.
The process limit is 240 seconds. Main test responses have an 8,192-token limit; the independent search retains its 32,000-token ceiling.
Temporary files are removed after the check. Saved configuration files are not changed.
A passing run covers these prompts and that model; it does not establish a general search-selection rate.

Reference: [OpenAI web search guide](https://developers.openai.com/api/docs/guides/tools-web-search?api-mode=responses).
