import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TSchema } from "typebox";
import type { Errors } from "typebox/value";
import { selectSearchProvider, type SearchProvider } from "./providers.ts";

export interface SearchSettings {
  $schema: "./web-search.schema.json";
  providers: {
    responsesWebSearch: { modelAllowList: string[] };
  };
  enableProvider: keyof SearchSettings["providers"];
}

export type SearchConfiguration = { status: "valid"; configPath: string; provider: SearchProvider }
  | { status: "invalid"; configPath: string; error: string };

export async function loadSearchConfiguration(agentDirectory: string, validate: typeof Errors): Promise<SearchConfiguration> {
  const configPath = join(agentDirectory, "web-search.json");
  const schemaPath = join(agentDirectory, "web-search.schema.json");
  let path = schemaPath;
  let phase = "read";
  try {
    const schemaText = await readFile(path, "utf8");
    phase = "parse";
    // The companion schema is a maintained source artifact, not a second settings decoder.
    const schema = JSON.parse(schemaText) as TSchema;
    phase = "validate schema";
    if (!("type" in schema) || schema.type !== "object") throw new Error("Expected the object schema for web-search settings.");
    path = configPath;
    phase = "read";
    const settingsText = await readFile(path, "utf8");
    phase = "parse";
    const settings: unknown = JSON.parse(settingsText);
    phase = "validate";
    const errors = validate(schema, settings);
    if (errors.length > 0) {
      const error = errors[0];
      return { status: "invalid", configPath, error: `${configPath}: ${error.instancePath || "/"} ${error.message}` };
    }
    phase = "select provider";
    // The companion schema validates this settings contract once at the file boundary.
    const provider = selectSearchProvider(settings as SearchSettings);
    return { status: "valid", configPath, provider };
  } catch (error) {
    const detail = phase === "select provider" && error instanceof Error ? error.message
      : phase === "validate schema" ? "Expected the object schema for web-search settings."
        : phase === "validate" ? `Cannot validate settings with ${schemaPath}.`
        : phase === "parse" ? "Invalid JSON." : "Cannot read file.";
    return { status: "invalid", configPath, error: `${path}: ${detail}` };
  }
}
