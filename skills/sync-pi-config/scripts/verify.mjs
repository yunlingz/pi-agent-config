import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const log = (message) => process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Parser errors can quote private configuration values.
    throw new Error(`Cannot read valid JSON: ${path}`);
  }
};

export async function validateConfig(agentDir, packageDir) {
  const require = createRequire(pathToFileURL(join(packageDir, 'package.json')));
  const { Check } = await import(pathToFileURL(require.resolve('typebox/value')).href);
  for (const name of ['settings', 'models', 'keybindings']) {
    const path = join(agentDir, `${name}.json`);
    if (!existsSync(path)) continue;
    const schema = readJson(join(packageDir, 'schemas', `${name}.schema.json`));
    if (!Check(schema, readJson(path))) {
      throw new Error(`${name}.json does not match the installed Pi schema`);
    }
    log(`PASS: ${name}.json matches installed schema`);
  }
  return existsSync(join(agentDir, 'settings.json')) ? readJson(join(agentDir, 'settings.json')) : {};
}

export function assertHealthy(events, settings, marker) {
  const assistant = events.findLast((event) => event.type === 'message_end' && event.message?.role === 'assistant')?.message;
  const settled = events.findLast((event) => event.type === 'agent_settled');
  const readSucceeded = events.some((event) => event.type === 'tool_execution_end' && event.toolName === 'read'
    && !event.isError && event.result?.content?.some((block) => block.type === 'text' && block.text.includes(marker)));
  const failed = events.some((event) => event.type === 'extension_error'
    || (event.type === 'tool_execution_end' && event.isError)
    || (event.type === 'auto_retry_end' && event.success === false)
    || (event.type === 'message_end' && event.message?.role === 'assistant'
      && ['error', 'aborted', 'length', 'deferred'].includes(event.message.stopReason)));
  const text = assistant?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
  if (failed || !events.some((event) => event.type === 'session' && event.id)
    || settled?.aborted !== false || assistant?.stopReason !== 'stop' || !readSucceeded || text !== marker) {
    throw new Error('Live Pi session failed: require a session header, successful read, exact reply, and non-aborted settlement');
  }
  if ((settings.defaultProvider && assistant.provider !== settings.defaultProvider)
    || (settings.defaultModel && assistant.model !== settings.defaultModel)) {
    throw new Error('Live Pi session did not use the configured default provider/model');
  }
  const thinking = settings.modelThinkingLevels?.[`${assistant.provider}/${assistant.model}`] ?? settings.defaultThinkingLevel;
  if (thinking && assistant.thinkingLevel && assistant.thinkingLevel !== thinking) {
    throw new Error('Live Pi session did not use the configured thinking level');
  }
  return `${assistant.provider}/${assistant.model}`;
}

async function runSession(packageDir, packageInfo, agentDir, cwd, onRecord) {
  const child = spawn(process.execPath, [resolve(packageDir, packageInfo.bin.pi),
    '--mode', 'json', '--no-session', '--offline', '--no-approve', '--tools', 'read',
    'This is a read-only configuration smoke test. Use the read tool to read healthcheck.txt in the current directory. Reply with exactly the file contents, without formatting or commentary. Do not invoke skills or run any other tasks.'], {
    cwd,
    shell: false,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = [];
  let pending = '';
  let invalidJson = false;
  let stderrBytes = 0;
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    let index;
    // Split only on LF: readline also splits valid Unicode separators inside JSON strings.
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      try {
        const event = JSON.parse(line);
        onRecord();
        if (event.type !== 'message_update') events.push(event);
      } catch {
        invalidJson = true;
      }
    }
  });
  // Never echo raw diagnostics or model events: they can contain credentials or private headers.
  child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 90_000);
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    if (timedOut) throw new Error('Live Pi session exceeded its 90-second timeout');
    if (code !== 0) throw new Error(`Live Pi process exited with status ${code}; raw diagnostics withheld`);
    if (stderrBytes) throw new Error(`Live Pi emitted ${stderrBytes} bytes of diagnostics; review privately before committing`);
    if (invalidJson || pending.length) throw new Error('Live Pi output was not complete JSONL');
    return events;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node verify.mjs <installed-pi-package-directory>');
  const packageDir = resolve(process.argv[2]);
  const packageInfo = readJson(join(packageDir, 'package.json'));
  const agentDir = fileURLToPath(new URL('../../../', import.meta.url));
  let phase = 'schema and skill checks';
  let records = 0;
  let temp;
  const heartbeat = setInterval(() => log(`Waiting: ${phase}; ${records} JSON records received`), 20_000);
  try {
    log(`Verifying global config with installed Pi ${packageInfo.version}`);
    const settings = await validateConfig(agentDir, packageDir);
    const { loadSkillsFromDir } = await import(pathToFileURL(resolve(packageDir, packageInfo.main)).href);
    const { skills, diagnostics } = loadSkillsFromDir({ dir: join(agentDir, 'skills'), source: 'user' });
    if (diagnostics.length || !skills.some((skill) => skill.name === 'sync-pi-config'
      && resolve(skill.filePath) === join(agentDir, 'skills', 'sync-pi-config', 'SKILL.md'))) {
      throw new Error('Global skill discovery failed or reported diagnostics');
    }
    log('PASS: global skills load without diagnostics, including sync-pi-config');
    temp = mkdtempSync(join(tmpdir(), 'sync-pi-config-'));
    const marker = `PI_CONFIG_OK_${randomUUID()}`;
    writeFileSync(join(temp, 'healthcheck.txt'), `${marker}\n`);
    phase = 'real, read-only Pi session (90-second limit)';
    log(`Starting ${phase}`);
    const events = await runSession(packageDir, packageInfo, agentDir, temp, () => { records++; });
    const model = assertHealthy(events, settings, marker);
    log(`PASS: real session on ${model}; read tool, exact reply, and settled lifecycle verified`);
  } finally {
    clearInterval(heartbeat);
    if (temp) {
      rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      log('Temporary verification directory removed');
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(() => log('SUCCESS: configuration verification passed'), (error) => {
    log(`FAILURE: ${error.message}`);
    process.exitCode = 1;
  });
}
