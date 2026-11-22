import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readPackageInfo } from "./verification-data.ts";

export function parseLiveArguments(args: string[]) {
  const [packageArgument, modelOverride] = args;
  if (!packageArgument || args.length > 2) {
    throw new Error("Usage: node <verifier> <installed-pi-package-directory> [provider/model]");
  }
  if (modelOverride !== undefined && !/^[^/\s]+\/\S+$/u.test(modelOverride)) {
    throw new Error("The model override must be an exact provider/model identifier.");
  }
  return { packageDirectory: resolve(packageArgument), modelOverride };
}

export async function createLiveSession(options: {
  packageDirectory: string;
  agentDirectory: string;
  cwd: string;
  extensionPaths: string[];
  modelOverride?: string;
  extensionFactories?: ExtensionFactory[];
  appendSystemPrompt?: string[];
}) {
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";
  const { packageDirectory, agentDirectory, cwd, modelOverride } = options;
  assert.equal(readPackageInfo(join(packageDirectory, "package.json")).name, "@earendil-works/pi-coding-agent");
  const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
  const savedSettings = sdk.SettingsManager.create(cwd, agentDirectory, { projectTrusted: true });
  // Keep the selected configuration without installing packages or saving SDK-generated identity data.
  const settings = sdk.SettingsManager.inMemory({
    ...savedSettings.getSettings(), packages: [], extensions: ["-builtin:mcp"], cacheWarming: "off",
  });
  const http: typeof import("@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js") =
    await import(pathToFileURL(join(packageDirectory, "dist/core/http-dispatcher.js")).href);
  http.applyHttpProxySettings(settings.getGlobalSettings().httpProxy);
  http.configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(agentDirectory, "auth.json"), modelsPath: join(agentDirectory, "models.json"),
    modelsStorePath: join(cwd, "models-store.json"), allowModelNetwork: false,
  });
  assert.equal(runtime.getError(), undefined, "Pi must load the configured model runtime");
  const loader = new sdk.DefaultResourceLoader({
    cwd, agentDir: agentDirectory, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    disabledBuiltinExtensions: ["mcp"], additionalExtensionPaths: options.extensionPaths,
    extensionFactories: options.extensionFactories,
    appendSystemPrompt: options.appendSystemPrompt ?? ["This is a read-only verification with synthetic history. Do not browse or change files. Do not use MCP."],
  });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0, "The selected extensions must load without errors");
  let model;
  if (modelOverride) {
    const slash = modelOverride.indexOf("/");
    model = runtime.getModel(modelOverride.slice(0, slash), modelOverride.slice(slash + 1));
    assert(model, "The exact model override is unavailable; no fallback is permitted");
  } else {
    const provider = settings.getDefaultProvider();
    const id = settings.getDefaultModel();
    if (provider && id) {
      model = runtime.getModel(provider, id);
      assert(model, "The configured default model is unavailable; no fallback is permitted");
    }
  }
  const manager = sdk.SessionManager.create(cwd, join(cwd, "sessions"));
  const { session } = await sdk.createAgentSession({
    cwd, agentDir: agentDirectory, settingsManager: settings, modelRuntime: runtime,
    model, resourceLoader: loader, sessionManager: manager, tools: [],
  });
  return { sdk, settings, runtime, loader, manager, session };
}

export async function closeLiveSession(session: AgentSession) {
  session.abortCompaction();
  await session.abort();
  await session.waitForIdle();
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}
