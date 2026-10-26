import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHealthy, assertMcpDisabled } from './verify.mjs';

const settings = {
  defaultProvider: 'test',
  defaultModel: 'model',
  defaultThinkingLevel: 'max',
};
const marker = 'test-marker';

function createHealthyEvents() {
  return [
    {
      type: 'session',
      id: 'temporary-test-session',
    },
    {
      type: 'tool_execution_end',
      toolName: 'read',
      isError: false,
      result: {
        content: [{ type: 'text', text: marker }],
      },
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'test',
        model: 'model',
        thinkingLevel: 'max',
        stopReason: 'stop',
        content: [{ type: 'text', text: marker }],
      },
    },
    {
      type: 'agent_settled',
      aborted: false,
    },
  ];
}

test('MCP must be explicitly disabled without conflicting enable entries', () => {
  assert.doesNotThrow(() => {
    assertMcpDisabled({ extensions: ['-builtin:mcp'] });
  });
  assert.doesNotThrow(() => {
    assertMcpDisabled({
      extensions: ['-builtin:mcp', 'custom-extension.js'],
    });
  });

  const invalidSettings = [
    {},
    { extensions: [] },
    { extensions: ['builtin:mcp'] },
    { extensions: ['+builtin:mcp'] },
    { extensions: ['-builtin:mcp', '+builtin:mcp'] },
    { extensions: ['builtin:mcp', '-builtin:mcp'] },
  ];

  for (const config of invalidSettings) {
    assert.throws(() => assertMcpDisabled(config), /explicitly disable built-in MCP/);
  }
});

test('healthy session requires real read evidence and the configured model', () => {
  const model = assertHealthy(createHealthyEvents(), settings, marker);
  assert.equal(model, 'test/model');
});

const requiredEvents = ['session', 'tool_execution_end', 'message_end', 'agent_settled'];

for (const missing of requiredEvents) {
  test(`reject session missing ${missing}`, () => {
    const events = createHealthyEvents().filter((event) => event.type !== missing);
    assert.throws(() => assertHealthy(events, settings, marker));
  });
}

for (const reason of ['error', 'aborted', 'length', 'deferred']) {
  test(`reject assistant stop reason ${reason}`, () => {
    const events = createHealthyEvents();
    events[2].message.stopReason = reason;
    assert.throws(() => assertHealthy(events, settings, marker));
  });
}

for (const field of ['provider', 'model', 'thinkingLevel']) {
  test(`reject ${field} fallback`, () => {
    const events = createHealthyEvents();
    events[2].message[field] = 'unexpected';
    assert.throws(() => assertHealthy(events, settings, marker));
  });
}

const failureCases = [
  {
    name: 'failed read',
    mutate(events) {
      events[1].isError = true;
    },
  },
  {
    name: 'wrong file content',
    mutate(events) {
      events[1].result.content[0].text = 'wrong';
    },
  },
  {
    name: 'wrong reply',
    mutate(events) {
      events[2].message.content[0].text = 'wrong';
    },
  },
  {
    name: 'aborted settlement',
    mutate(events) {
      events[3].aborted = true;
    },
  },
  {
    name: 'extension failure',
    mutate(events) {
      events.push({ type: 'extension_error' });
    },
  },
  {
    name: 'failed retry',
    mutate(events) {
      events.push({ type: 'auto_retry_end', success: false });
    },
  },
];

for (const { name, mutate } of failureCases) {
  test(`reject ${name}`, () => {
    const events = createHealthyEvents();
    mutate(events);
    assert.throws(() => assertHealthy(events, settings, marker));
  });
}
