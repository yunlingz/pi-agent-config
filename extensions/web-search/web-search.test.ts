import assert from "node:assert/strict";
import test from "node:test";
import { citationSource, cleanText, renderCitations } from "./citations.ts";
import { createBudgetedFetch, INPUT_TOKEN_LIMIT, OUTPUT_TOKEN_LIMIT, runSearch, searchPayload } from "./search-request.ts";
import { registerWebSearch, SEARCH_GUIDELINES, STATE_TYPE, TOOL_NAME } from "./web-search.ts";

const MODELS = [["gpt-6-astra", "medium"], ["gpt-6.1-sol", "xhigh"], ["gpt-6.1-terra", "max"]];
const TEXT = "The release is available.";
const CITATION = { type: "url_citation", title: "Release notes", url: "https://example.com/releases", start_index: 0, end_index: TEXT.length };
const USAGE = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };

function harness({ id = MODELS[0][0], mode = "tui", active = true } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const state = { branch: [], statuses: [], notifications: [], idle: true, active: ["read"], tools: new Map() };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { state.tools.set(tool.name, tool); if (active) state.active.push(tool.name); },
    appendEntry(customType, data) { state.branch.push({ type: "custom", customType, data }); },
    getActiveTools: () => [...state.active],
    setActiveTools: (names) => { state.active = [...names]; },
    getThinkingLevel: () => "medium",
  };
  const ctx = {
    model: { id, provider: "existing_gateway", api: "openai-responses" },
    thinkingLevel: MODELS.find(([model]) => model === id)?.[1],
    mode, isIdle: () => state.idle,
    sessionManager: { getBranch: () => state.branch },
    ui: {
      setStatus(key, value) { state.statuses.push({ key, value }); },
      notify(text, level) { state.notifications.push({ text, level }); },
    },
  };
  registerWebSearch(pi, { parameters: { type: "object" } });
  return {
    ctx, state, handlers,
    tool: state.tools.get(TOOL_NAME),
    emit: (name, event = {}) => handlers.get(name)(event, ctx),
    command: (args) => commands.get("web-search").handler(args, ctx),
  };
}

function response(stopReason = "stop") {
  return { role: "assistant", content: [{ type: "text", text: TEXT }], stopReason, usage: USAGE };
}

function fakeRegistry({ stopReason = "stop", search = true, citations = true, capture = () => {} } = {}) {
  return {
    streamSimple(model, context, options) {
      capture({ model, context, options });
      return (async function* () {
        options.onResponse({ status: 200 });
        if (search) options.onProviderStreamEvent({ type: "response.output_item.done", item: {
          type: "web_search_call", id: "search_1", status: "completed", action: { type: "search", query: "release" },
        } });
        const item = { type: "message", id: "message_1", content: [{ type: "output_text", text: TEXT, annotations: citations ? [CITATION] : [] }] };
        options.onProviderStreamEvent({ type: "response.output_item.done", item });
        options.onProviderStreamEvent({ type: "response.completed", response: { output: [item] } });
        yield { type: "text_start" };
        yield { type: "done", message: response(stopReason) };
      })();
    },
  };
}

function budgetFixture(count = 100, status = 200) {
  const calls = [];
  const failures = [];
  const counts = [];
  const signal = new AbortController().signal;
  const fetchRequest = createBudgetedFetch({
    signal,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({ url: request.url, headers: request.headers, body: await request.json() });
      return request.url.endsWith("/input_tokens")
        ? new Response(JSON.stringify({ input_tokens: count }), { status })
        : new Response("generation");
    },
    onCount: (value) => counts.push(value),
    onFailure: (message) => failures.push(message),
  });
  const payload = searchPayload({
    model: MODELS[0][0], input: [{ role: "user", content: "query" }],
    instructions: "Search with primary sources.", reasoning: { effort: "medium" }, stream: true,
  });
  return {
    calls, failures, counts, payload,
    run: () => fetchRequest("https://example.com/v1/responses", {
      method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify(payload),
    }),
  };
}

for (const [id, thinkingLevel] of MODELS) {
  test(`${id}: default on, keep the main model, and use low search effort`, async () => {
    const h = harness({ id });
    h.emit("session_start");
    assert.equal(h.state.statuses.at(-1).value, "web: on");
    let captured;
    h.ctx.modelRegistry = fakeRegistry({ capture: (value) => { captured = value; } });
    const result = await h.tool.execute("call", { query: "release", context: "Relevant background" }, undefined, undefined, h.ctx);
    assert.equal(result.isError, undefined);
    assert.equal(captured.model.id, id);
    assert.equal(captured.options.reasoning, undefined);
    assert.deepEqual(captured.options.onPayload({ reasoning: { effort: thinkingLevel } }).reasoning, { effort: "low" });
    assert.equal(result.details.thinkingLevel, "low");
    assert.equal(h.ctx.thinkingLevel, thinkingLevel);
    assert.equal(captured.options.maxTokens, OUTPUT_TOKEN_LIMIT);
    assert.equal(captured.options.maxRetries, 0);
    assert.equal(captured.context.messages.length, 1);
    assert.deepEqual(JSON.parse(captured.context.messages[0].content), { query: "release", context: "Relevant background" });
    assert.equal(result.usage, USAGE);
    assert.match(result.content[0].text, /\[Release notes\]/u);
    assert.equal(result.details.sources.length, 1);
    assert.equal(result.details.searchCount, 1);
  });
}

test("register a normal web_run tool without main provider hooks", () => {
  const h = harness();
  assert.equal(h.tool.name, "web_run");
  assert.equal(h.tool.label, "web.run");
  assert.equal(h.tool.namespace.name, "web");
  assert.equal(h.handlers.has("before_provider_request"), false);
  assert.equal(h.handlers.has("provider_stream_event"), false);
  assert.equal(h.handlers.has("message_end"), false);
  assert.equal(h.tool.annotations.readOnlyHint, true);
});

test("prompt guidance makes main-session search conditional", () => {
  const text = SEARCH_GUIDELINES.join(" ");
  assert.match(text, /only for explicit web requests/u);
  assert.match(text, /Reuse sufficient evidence/u);
  assert.match(text, /Honor requests not to browse/u);
  assert.match(text, /local code work/u);
  const h = harness();
  const event = { systemPromptOptions: { sections: { native_web_search: "Old guidance", existing: "Keep" } } };
  h.emit("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.sections, { existing: "Keep" });
});

test("off removes the declaration and blocks execution without a network request", async () => {
  const h = harness();
  await h.command("off");
  assert.deepEqual(h.state.active, ["read"]);
  assert.equal(h.state.statuses.at(-1).value, "web: off");
  const result = await h.tool.execute("call", { query: "release" }, undefined, undefined, h.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Web search is off/u);
  await h.command("on");
  assert.deepEqual(h.state.active, ["read", TOOL_NAME]);
  assert.equal(h.state.statuses.at(-1).value, "web: on");
});

test("unsupported providers, APIs, and models show unavailable and cannot be enabled", async () => {
  for (const change of [{ provider: "another" }, { api: "openai-completions" }, { id: "other" }]) {
    const h = harness();
    Object.assign(h.ctx.model, change);
    h.emit("model_select");
    await h.command("on");
    assert.deepEqual(h.state.active, ["read"]);
    assert.equal(h.state.statuses.at(-1).value, "web: unavailable");
    assert.equal(h.state.branch.length, 0);
    const result = await h.tool.execute("call", { query: "release" }, undefined, undefined, h.ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unavailable/u);
  }
});

test("model switching restores supported search while preserving the off preference", async () => {
  const h = harness();
  h.ctx.model.id = "unsupported";
  h.emit("model_select");
  h.ctx.model.id = MODELS[1][0];
  h.emit("model_select");
  assert.equal(h.state.statuses.at(-1).value, "web: on");
  await h.command("off");
  h.ctx.model.id = "unsupported";
  h.emit("model_select");
  h.ctx.model.id = MODELS[2][0];
  h.emit("model_select");
  assert.equal(h.state.statuses.at(-1).value, "web: off");
});

test("explicit CLI tool exclusions remain off until the user enables search", async () => {
  const h = harness({ active: false });
  h.emit("session_start");
  h.emit("before_agent_start", { systemPromptOptions: { sections: {} } });
  assert.deepEqual(h.state.active, ["read"]);
  assert.equal(h.state.statuses.at(-1).value, "web: off");
  h.ctx.model.id = "other";
  h.emit("model_select");
  h.ctx.model.id = MODELS[0][0];
  h.emit("model_select");
  assert.deepEqual(h.state.active, ["read"]);
  await h.command("on");
  assert.ok(h.state.active.includes(TOOL_NAME));
});

test("session preferences restore from the active branch and status is read-only", async () => {
  const h = harness();
  h.state.branch = [{ type: "custom", customType: STATE_TYPE, data: { enabled: false } }];
  h.emit("session_start");
  assert.equal(h.state.statuses.at(-1).value, "web: off");
  await h.command("status");
  assert.equal(h.state.branch.length, 1);
  h.state.branch = [];
  h.emit("session_tree");
  assert.equal(h.state.statuses.at(-1).value, "web: on");
});

test("busy and invalid commands do not change state", async () => {
  const h = harness();
  await h.command("invalid");
  h.state.idle = false;
  await h.command("off");
  assert.equal(h.state.branch.length, 0);
  assert.ok(h.state.active.includes(TOOL_NAME));
});

test("non-interactive modes never publish footer statuses", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const h = harness({ mode });
    h.emit("session_start");
    await h.command("off");
    h.emit("session_shutdown");
    assert.deepEqual(h.state.statuses, []);
  }
});

test("shutdown clears only this status and cancels future nested work", async () => {
  const h = harness();
  h.ctx.modelRegistry = { streamSimple() { assert.fail("No request after shutdown"); } };
  h.emit("session_shutdown");
  const result = await h.tool.execute("call", { query: "release" }, undefined, undefined, h.ctx);
  assert.equal(h.state.statuses.at(-1).value, undefined);
  assert.equal(result.details.status, "cancelled");
});

test("empty queries fail before accessing the model runtime", async () => {
  const h = harness();
  const result = await h.tool.execute("call", { query: "  " }, undefined, undefined, h.ctx);
  assert.match(result.content[0].text, /non-empty/u);
  assert.equal(result.isError, true);
});

test("independent payload forces native search and removes conversation attachment", () => {
  const original = { model: "model", input: [], reasoning: { effort: "xhigh" }, previous_response_id: "old", conversation: "old", tools: [{ type: "function", name: "read" }] };
  const copy = structuredClone(original);
  const result = searchPayload(original);
  assert.deepEqual(result.tools, [{ type: "web_search" }]);
  assert.deepEqual(result.tool_choice, { type: "web_search" });
  assert.equal(result.max_output_tokens, 32000);
  assert.equal(result.truncation, "disabled");
  assert.equal(result.previous_response_id, undefined);
  assert.equal(result.conversation, undefined);
  assert.deepEqual(original, copy);
  assert.deepEqual(result.reasoning, { effort: "low" });
});

test("the input-token check includes the actual input, instructions, tools, and reasoning", async () => {
  const h = budgetFixture(INPUT_TOKEN_LIMIT);
  await h.run();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url, "https://example.com/v1/responses/input_tokens");
  assert.equal(h.calls[0].headers.get("authorization"), "Bearer fixture");
  assert.deepEqual(h.calls[0].body.input, h.payload.input);
  assert.equal(h.calls[0].body.instructions, h.payload.instructions);
  assert.deepEqual(h.calls[0].body.tools, h.payload.tools);
  assert.deepEqual(h.calls[0].body.reasoning, h.payload.reasoning);
  assert.equal(h.calls[0].body.stream, undefined);
  assert.deepEqual(h.calls[1].body, h.payload);
  assert.deepEqual(h.counts, [64000]);
});

test("64,001 input tokens are rejected without truncation or generation", async () => {
  const h = budgetFixture(INPUT_TOKEN_LIMIT + 1);
  await assert.rejects(h.run(), /64,001 tokens/u);
  assert.equal(h.calls.length, 1);
  assert.match(h.failures[0], /Nothing was truncated/u);
});

test("missing or failed input counts fail closed", async () => {
  for (const count of [undefined, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
    const h = budgetFixture(count === undefined ? null : count);
    await assert.rejects(h.run(), /invalid input-token count/u);
    assert.equal(h.calls.length, 1);
  }
  const h = budgetFixture(0, 404);
  await assert.rejects(h.run(), /HTTP 404/u);
  assert.equal(h.calls.length, 1);
});

test("input-counter network errors do not expose diagnostics or credentials", async () => {
  let failure;
  const fetchRequest = createBudgetedFetch({
    fetch: async () => { throw new Error("private address and sk-secret"); },
    signal: new AbortController().signal,
    onCount() {}, onFailure: (message) => { failure = message; },
  });
  await assert.rejects(fetchRequest("https://example.com/responses", { method: "POST", body: "{}" }), /could not complete/u);
  assert.doesNotMatch(failure, /private|secret/u);
});

test("search output preserves citations and suppresses raw provider thinking", async () => {
  const result = await runSearch({
    ctx: { modelRegistry: fakeRegistry() }, model: { id: "model" }, query: "release",
    signal: new AbortController().signal,
  });
  assert.equal(result.details.status, "done");
  assert.match(result.content[0].text, /### Sources/u);
  assert.equal(result.details.sources.length, 1);
  assert.equal(result.usage, USAGE);
});

test("missing native search is not reported as verified evidence", async () => {
  const result = await runSearch({
    ctx: { modelRegistry: fakeRegistry({ search: false }) }, model: { id: "model" }, query: "release",
    signal: new AbortController().signal,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no completed native search/u);
  assert.doesNotMatch(result.content[0].text, /The release is available/u);
});

test("generation limits return an explicit partial error and retain usage", async () => {
  const result = await runSearch({
    ctx: { modelRegistry: fakeRegistry({ stopReason: "length" }) }, model: { id: "model" }, query: "release",
    signal: new AbortController().signal,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /findings are incomplete/u);
  assert.match(result.content[0].text, /Partial findings/u);
  assert.equal(result.usage, USAGE);
});

test("pre-cancelled work never starts a model request", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runSearch({
    ctx: { modelRegistry: { streamSimple() { assert.fail("Must not start"); } } },
    model: { id: "model" }, query: "release", signal: controller.signal,
  });
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "cancelled");
});

test("cancellation reaches an active independent request and retains incurred usage", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const modelRegistry = {
    streamSimple(_model, _context, options) {
      return (async function* () {
        started.resolve();
        await new Promise((resolveAbort) => options.signal.addEventListener("abort", resolveAbort, { once: true }));
        yield { type: "error", error: response("aborted") };
      })();
    },
  };
  const running = runSearch({ ctx: { modelRegistry }, model: { id: "model" }, query: "release", signal: controller.signal });
  await started.promise;
  controller.abort();
  const result = await running;
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "cancelled");
  assert.equal(result.usage, USAGE);
});

test("the operation timeout cancels active work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const started = Promise.withResolvers();
  const modelRegistry = {
    streamSimple(_model, _context, options) {
      return (async function* () {
        started.resolve();
        await new Promise((resolveAbort) => options.signal.addEventListener("abort", resolveAbort, { once: true }));
        yield { type: "error", error: response("aborted") };
      })();
    },
  };
  const running = runSearch({ ctx: { modelRegistry }, model: { id: "model" }, query: "release", signal: new AbortController().signal });
  await started.promise;
  t.mock.timers.tick(180000);
  const result = await running;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /180-second limit/u);
});

test("provider errors do not expose raw private diagnostics", async () => {
  const result = await runSearch({
    ctx: { modelRegistry: { streamSimple() { throw new Error("secret credentials"); } } },
    model: { id: "model" }, query: "release", signal: new AbortController().signal,
  });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /secret credentials/u);
});

test("citation links preserve claims, deduplicate annotations, and retain fallback sources", () => {
  assert.equal(renderCitations(TEXT, [CITATION, CITATION]), `${TEXT} [Release notes](<https://example.com/releases>)`);
  assert.equal(renderCitations(TEXT, [{ ...CITATION, end_index: 999 }]), `${TEXT}\n\nSources: [Release notes](<https://example.com/releases>)`);
});

test("provider citation markers become readable links", () => {
  const marker = "\uE200cite\uE202turn0search0\uE201";
  const text = `Answer.${marker}`;
  assert.equal(renderCitations(text, [{ ...CITATION, start_index: 7, end_index: text.length }]), "Answer. [Release notes](<https://example.com/releases>)");
});

test("untrusted citations cannot inject executable URLs, credentials, or terminal controls", () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://example.com/\nattack", "https://user:password@example.com/", "invalid"]) {
    assert.equal(citationSource({ ...CITATION, url }), undefined);
  }
  assert.equal(cleanText("Safe\u001b[31m title\u001b[0m"), "Safe title");
  assert.equal(renderCitations(TEXT, [null, { type: "file_citation" }]), TEXT);
  assert.equal(renderCitations(TEXT, undefined), TEXT);
});
