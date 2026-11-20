import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentToolResult, ExtensionError, JsonAgentSessionEvent, SessionHeader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { parseTrustedJson, readJson } from '../../../scripts/verification-data.ts';

export type VerificationSettings = Pick<ReturnType<SettingsManager['getGlobalSettings']>,
  'extensions' | 'defaultProvider' | 'defaultModel' | 'defaultThinkingLevel' | 'modelThinkingLevels'>;
type ToolCompletion = Extract<JsonAgentSessionEvent, { type: 'tool_execution_end' }>;
// Upstream leaves tool results untyped; Pi tools use AgentToolResult.
export type VerificationEvent = SessionHeader
  | Exclude<JsonAgentSessionEvent, ToolCompletion>
  | (Omit<ToolCompletion, 'result'> & { result: AgentToolResult<unknown> })
  | ({ type: 'extension_error' } & ExtensionError);

interface PackageInfo {
  name: string;
  version: string;
  main: string;
  bin: { pi: string };
}

function log(message: string) {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

export async function validateConfig(agentDir: string, packageDir: string): Promise<VerificationSettings> {
  const require = createRequire(pathToFileURL(join(packageDir, 'package.json')));
  const validatorUrl = pathToFileURL(require.resolve('typebox/value'));
  const { Check }: { Check(schema: unknown, value: unknown): boolean } = await import(validatorUrl.href);
  let settings: VerificationSettings = {};

  for (const name of ['settings', 'models', 'keybindings']) {
    const configPath = join(agentDir, `${name}.json`);
    if (!existsSync(configPath)) {
      continue;
    }

    const schemaPath = join(packageDir, 'schemas', `${name}.schema.json`);
    const schema = readJson(schemaPath);
    const config = readJson(configPath);

    if (!Check(schema, config)) {
      throw new Error(`${name}.json does not match the installed Pi schema`);
    }

    if (name === 'settings') {
      // The installed schema validates these settings before they enter the verifier's narrower contract.
      settings = config as VerificationSettings;
    }
    log(`PASS: ${name}.json matches installed schema`);
  }

  return settings;
}

export function assertMcpDisabled(settings: VerificationSettings) {
  const extensions = settings.extensions ?? [];
  const hasDisableEntry = extensions.includes('-builtin:mcp');
  const hasEnableEntry = extensions.some(
    (entry) => entry === 'builtin:mcp' || entry === '+builtin:mcp',
  );

  if (!hasDisableEntry || hasEnableEntry) {
    throw new Error(
      'Global settings must explicitly disable built-in MCP ' +
        'without a conflicting enable entry',
    );
  }
}

export function assertHealthy(events: VerificationEvent[], settings: VerificationSettings, marker: string) {
  const assistant = events.filter((event) => event.type === 'message_end')
    .map((event) => event.message)
    .findLast((message) => message.role === 'assistant');
  const settled = events.findLast((event) => event.type === 'agent_settled');
  const hasSessionHeader = events.some((event) => event.type === 'session' && event.id);
  const readSucceeded = events.some(
    (event) =>
      event.type === 'tool_execution_end' &&
      event.toolName === 'hashline_read' &&
      !event.isError &&
      event.result?.content?.some((block) => block.type === 'text' && block.text?.includes(marker)),
  );
  const failed = events.some((event) => {
    if (event.type === 'extension_error') {
      return true;
    }
    if (event.type === 'tool_execution_end' && event.isError) {
      return true;
    }
    if (event.type === 'auto_retry_end' && event.success === false) {
      return true;
    }

    return (
      event.type === 'message_end' &&
      event.message?.role === 'assistant' &&
      ['error', 'aborted', 'length', 'deferred'].includes(event.message.stopReason ?? '')
    );
  });
  const text = assistant?.content
    ?.filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (
    failed ||
    !hasSessionHeader ||
    settled?.aborted !== false ||
    assistant?.stopReason !== 'stop' ||
    !readSucceeded ||
    text !== marker
  ) {
    throw new Error(
      'Live Pi session failed: require a session header, successful read, ' +
        'exact reply, and non-aborted settlement',
    );
  }

  const providerMismatch =
    settings.defaultProvider && assistant.provider !== settings.defaultProvider;
  const modelMismatch = settings.defaultModel && assistant.model !== settings.defaultModel;

  if (providerMismatch || modelMismatch) {
    throw new Error('Live Pi session did not use the configured default provider/model');
  }

  const modelKey = `${assistant.provider}/${assistant.model}`;
  const thinking = settings.modelThinkingLevels?.[modelKey] ?? settings.defaultThinkingLevel;

  if (thinking && assistant.thinkingLevel && assistant.thinkingLevel !== thinking) {
    throw new Error('Live Pi session did not use the configured thinking level');
  }

  return modelKey;
}

async function runSession(packageDir: string, packageInfo: PackageInfo, agentDir: string, cwd: string, onRecord: () => void): Promise<VerificationEvent[]> {
  const prompt = [
    'This is a read-only configuration smoke test.',
    'Use the hashline_read tool to read healthcheck.txt in the current directory.',
    'Reply with exactly the file contents, without formatting or commentary.',
    'Do not invoke skills or run any other tasks.',
  ].join(' ');
  const args = [
    resolve(packageDir, packageInfo.bin.pi),
    '--mode',
    'json',
    '--no-session',
    '--offline',
    '--no-approve',
    '--no-mcp',
    '--tools',
    'hashline_read',
    prompt,
  ];
  const child = spawn(process.execPath, args, {
    cwd,
    shell: false,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const events: VerificationEvent[] = [];
  let pending = '';
  let invalidJson = false;
  let stderrBytes = 0;
  let timedOut = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    let newlineIndex;

    // Split only on line feed (LF).
    // `readline` also splits Unicode separators inside JSON strings.
    while ((newlineIndex = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
      pending = pending.slice(newlineIndex + 1);

      try {
        // This child runs the installed Pi; reuse its JSON wire types without a parallel schema.
        const event = parseTrustedJson<VerificationEvent>(line);
        onRecord();
        if (event.type !== 'message_update') {
          events.push(event);
        }
      } catch {
        invalidJson = true;
      }
    }
  });

  // Raw diagnostics and events can contain credentials or private headers.
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 90_000);

  try {
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });

    if (timedOut) {
      throw new Error('Live Pi session exceeded its 90-second timeout');
    }
    if (code !== 0) {
      throw new Error(`Live Pi process exited with status ${code}; raw diagnostics withheld`);
    }
    if (stderrBytes) {
      throw new Error(
        `Live Pi emitted ${stderrBytes} bytes of diagnostics; ` +
          'review privately before committing',
      );
    }
    if (invalidJson || pending.length) {
      throw new Error('Live Pi output was not complete JSONL');
    }

    return events;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
      child.kill('SIGKILL');
      await closed;
    }
  }
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error('Usage: node verify.ts <installed-pi-package-directory>');
  }

  const packageDir = resolve(process.argv[2]);
  const packageInfo = readJson<PackageInfo>(join(packageDir, 'package.json'));
  if (packageInfo.name !== '@earendil-works/pi-coding-agent') throw new Error('Expected the installed Pi package');
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? fileURLToPath(new URL('../../../', import.meta.url));
  let phase = 'schema and skill checks';
  let receivedRecords = 0;
  let temporaryDirectory;

  const heartbeat = setInterval(() => {
    log(`Waiting: ${phase}; ${receivedRecords} JSON records received`);
  }, 20_000);

  try {
    log(`Verifying global config with installed Pi ${packageInfo.version}`);
    const settings = await validateConfig(agentDir, packageDir);
    assertMcpDisabled(settings);
    log('PASS: global settings explicitly disable built-in MCP');

    const sdkUrl = pathToFileURL(resolve(packageDir, packageInfo.main));
    const { loadSkillsFromDir }: typeof import('@earendil-works/pi-coding-agent') = await import(sdkUrl.href);
    const { skills, diagnostics } = loadSkillsFromDir({
      dir: join(agentDir, 'skills'),
      source: 'user',
    });
    const syncSkillPath = join(agentDir, 'skills', 'sync-pi-config', 'SKILL.md');
    const syncSkillFound = skills.some(
      (skill) => skill.name === 'sync-pi-config' && resolve(skill.filePath) === syncSkillPath,
    );

    if (diagnostics.length || !syncSkillFound) {
      throw new Error('Global skill discovery failed or reported diagnostics');
    }

    const skillNames = skills.map((skill) => skill.name).join(', ');
    log(`PASS: global skills load without diagnostics: ${skillNames}`);

    temporaryDirectory = mkdtempSync(join(tmpdir(), 'sync-pi-config-'));
    const marker = `PI_CONFIG_OK_${randomUUID()}`;
    writeFileSync(join(temporaryDirectory, 'healthcheck.txt'), `${marker}\n`);

    phase = 'real, read-only Pi session (90-second limit)';
    log(`Starting ${phase}`);
    const events = await runSession(packageDir, packageInfo, agentDir, temporaryDirectory, () => {
      receivedRecords++;
    });
    const model = assertHealthy(events, settings, marker);
    log(
      `PASS: real session on ${model}; ` + 'hashline_read, exact reply, and settled lifecycle verified',
    );
  } finally {
    clearInterval(heartbeat);
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      if (existsSync(temporaryDirectory)) throw new Error('Temporary verification directory still exists');
      log('Temporary verification directory removed');
    }
  }
}

const isCommandLineRun =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isCommandLineRun) {
  main().then(
    () => {
      log('SUCCESS: configuration verification passed');
    },
    (error) => {
      log(`FAILURE: ${error instanceof Error ? error.message : 'Configuration verification failed.'}`);
      process.exitCode = 1;
    },
  );
}
