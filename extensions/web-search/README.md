# Web search

`web_run(query, context?)` performs independent Responses API research with the invoking session's model, gateway, and authentication.
It sends the supplied query and necessary context, not the conversation history.
The request requires hosted `web_search` and low reasoning; the main model's reasoning remains unchanged.
Findings, citations, and reported usage return through a normal Pi tool result.

## Configuration and controls

[web-search.json](../../web-search.json) selects `responsesWebSearch` and an exact `provider/model` allowlist.
[The companion schema](../../web-search.schema.json) supplies local editor completion and runtime validation.
Only this provider is implemented; no automatic fallback or provider selection occurs.
The public configuration format remains unchanged.

Models require `api: "openai-responses"` and an exact case-sensitive allowlist match.
An empty allowlist permits no models. Wildcards, duplicates, unknown fields, and invalid identifiers are rejected.
Allowlisting declares intended support; it does not prove upstream search or token-count capabilities.
Configuration loads on startup or `/reload`; missing or invalid files fail without hidden defaults or file creation.

```text
/web-search [on|off|status]
```

The branch preference survives reload/resume. New sessions default to on for supported models, respecting tool selection.
Off, unavailable, and invalid states remove the active tool declaration and reject stale calls without a search request.
Controls leave native tools and existing prompt sections unchanged.
Wait for the current response to finish before changing the preference.

Powerline shows `web: on`, `web: off`, `web: unavailable`, or `web: invalid setting`.
The status command identifies the provider and configuration path; invalid startup settings produce one interactive warning.

## Limits and output

| Control | Value |
| --- | --- |
| Complete serialized input | 64,000 gateway-counted tokens |
| Generation, including reasoning | 32,000 tokens |
| Input-token check | 20 seconds |
| Complete operation | 180 seconds |
| Automatic retries | None |

The tool checks the serialized input through `/responses/input_tokens` before generation.
Unavailable, malformed, or excessive counts stop generation without truncation.
These budgets do not change main-session limits or reserve provider-internal capacity.
Unsupported search, cancellation, timeouts, and incomplete output produce explicit errors.
A completed native search is required before reporting success.

Collapsed output shows only the tool label and an execution status, with elapsed time when space permits.
Normal expansion reveals the query, findings, links, model, effort, and counted input.
Citation annotations become Markdown links; invalid offsets retain fallback links.
Only HTTP/HTTPS citation URLs without credentials or control characters are accepted.
Plain answer links are not promoted to structured citations. Raw nested reasoning stays out of the main conversation.
The renderer follows Pi's theme without replacing the editor or footer.

Guidance encourages useful research, respects requests not to browse, and reuses sufficient findings.
Results are evidence, not instructions. Neither invocation frequency nor factual accuracy is guaranteed.

## Checks

Run from the agent directory:

```text
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
node extensions/web-search/verify-live.ts <installed-pi-package-directory> [provider/model]
```

Offline checks exercise schema errors, actual Pi transport/tool execution, context isolation, budgets, usage, controls, reload, and rendering.
The optional live check uses the configured model and authentication; an override must identify an exact configured model.
It checks model-selected search, evidence reuse, local Bash/read, off behavior, serialized effort, citations, and usage.
The live process has a 240-second limit and an 8,192-token main-response ceiling; search retains its normal ceiling.
Tests isolate MCP and remove temporary state. Live requests can incur charges and cover only the tested prompts/model.

Reference: [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search?api-mode=responses).
