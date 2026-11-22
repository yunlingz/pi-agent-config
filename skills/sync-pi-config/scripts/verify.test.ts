import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessage, TextContent } from '@earendil-works/pi-ai';
import type { JsonAgentSessionEvent, SessionHeader } from '@earendil-works/pi-coding-agent';
import { parseTrustedJson } from '../../../scripts/verification-data.ts';
import { assertHealthy, type VerificationEvent, type VerificationSettings } from './verify.ts';

const settings = {
  defaultProvider: 'test',
  defaultModel: 'model',
  defaultThinkingLevel: 'max',
} satisfies VerificationSettings;
const marker = 'test-marker';

function createHealthyFixture() {
  const header: SessionHeader = {
    type: 'session', id: 'temporary-test-session', timestamp: '2026-01-01T00:00:00Z', cwd: '.',
  };
  const fileText: TextContent = { type: 'text', text: marker };
  const read: Extract<VerificationEvent, { type: 'tool_execution_end' }> = {
    type: 'tool_execution_end', toolCallId: 'read-marker', toolName: 'read', isError: false,
    result: { content: [fileText], details: undefined },
  };
  const reply: TextContent = { type: 'text', text: marker };
  const assistant: AssistantMessage = {
    role: 'assistant', api: 'openai-responses', provider: 'test', model: 'model',
    thinkingLevel: 'max', stopReason: 'stop', timestamp: 0, content: [reply],
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const settled: Extract<JsonAgentSessionEvent, { type: 'agent_settled' }> = {
    type: 'agent_settled', aborted: false,
  };
  const events: VerificationEvent[] = [header, read, { type: 'message_end', message: assistant }, settled];
  return { events, read, assistant, settled, fileText, reply };
}

test('trusted CLI JSON reuses SDK records without reconstructing their fields', () => {
  const fixture = createHealthyFixture();
  const events = fixture.events.map((event) => parseTrustedJson<VerificationEvent>(JSON.stringify(event)));
  assert.equal(assertHealthy(events, settings, marker), 'test/model');
  const finalMessage = events.find((event) => event.type === 'message_end');
  assert.ok(finalMessage?.type === 'message_end');
  assert.deepEqual(finalMessage.message, fixture.assistant);
});

test('healthy session requires real read evidence and the configured model', () => {
  assert.equal(assertHealthy(createHealthyFixture().events, settings, marker), 'test/model');
});

test('non-read tool results must not satisfy the native read check', () => {
  const fixture = createHealthyFixture();
  fixture.read.toolName = 'grep';
  assert.throws(() => assertHealthy(fixture.events, settings, marker));
});

for (const missing of ['session', 'tool_execution_end', 'message_end', 'agent_settled']) {
  test(`reject session missing ${missing}`, () => {
    const events = createHealthyFixture().events.filter((event) => event.type !== missing);
    assert.throws(() => assertHealthy(events, settings, marker));
  });
}

for (const reason of ['error', 'aborted', 'length', 'deferred'] as const) {
  test(`reject assistant stop reason ${reason}`, () => {
    const fixture = createHealthyFixture();
    fixture.assistant.stopReason = reason;
    assert.throws(() => assertHealthy(fixture.events, settings, marker));
  });
}

for (const field of ['provider', 'model'] as const) {
  test(`reject ${field} fallback`, () => {
    const fixture = createHealthyFixture();
    fixture.assistant[field] = 'unexpected';
    assert.throws(() => assertHealthy(fixture.events, settings, marker));
  });
}

test('reject thinkingLevel fallback', () => {
  const fixture = createHealthyFixture();
  fixture.assistant.thinkingLevel = 'low';
  assert.throws(() => assertHealthy(fixture.events, settings, marker));
});

const failureCases: { name: string; mutate(fixture: ReturnType<typeof createHealthyFixture>): void }[] = [
  {
    name: 'failed read',
    mutate(fixture) {
      fixture.read.isError = true;
    },
  },
  {
    name: 'wrong file content',
    mutate(fixture) {
      fixture.fileText.text = 'wrong';
    },
  },
  {
    name: 'wrong reply',
    mutate(fixture) {
      fixture.reply.text = 'wrong';
    },
  },
  {
    name: 'aborted settlement',
    mutate(fixture) {
      fixture.settled.aborted = true;
    },
  },
  {
    name: 'extension failure',
    mutate(fixture) {
      fixture.events.push({ type: 'extension_error', extensionPath: 'fixture.ts', event: 'tool_call', error: 'failure' });
    },
  },
  {
    name: 'failed retry',
    mutate(fixture) {
      fixture.events.push({ type: 'auto_retry_end', success: false, attempt: 1 });
    },
  },
];

for (const { name, mutate } of failureCases) {
  test(`reject ${name}`, () => {
    const fixture = createHealthyFixture();
    mutate(fixture);
    assert.throws(() => assertHealthy(fixture.events, settings, marker));
  });
}
