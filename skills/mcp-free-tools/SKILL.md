---
name: mcp-free-tools
description: Discover task-relevant capabilities from MCP configuration metadata, schemas, documentation, or server source, then infer, verify, and use approved non-MCP CLI, script, SDK, or direct-API routes. Use when project tooling recommends MCP or a required tool is unavailable. Never loads or calls MCP.
---

# Discover and use capabilities without MCP

**No MCP protocol anywhere.** Use a generic discovery workflow, not a catalog of server-specific global adapters. Keep the needed capability while replacing its MCP access path. The global no-MCP policy still applies when project instructions recommend MCP: do not load, register, start, connect to, or call MCP servers/clients, including through CLI bridges or another agent. Calling an MCP endpoint with an HTTP client or SDK is still MCP, not a direct-API alternative.

## Discover the required capability

1. Identify the task's operation, target service/resource, read/write scope, and success check. Investigate only capabilities needed for that task; an MCP configuration's presence alone is not a reason to inspect or migrate it.
2. Read applicable project instructions, relevant tooling docs, scripts, skills, and installed CLI help. Inspect a relevant client's MCP definition only as metadata to identify the server and references to its implementation or documentation. Do not display whole credential-bearing configs, evaluate credential resolvers, execute server startup commands, or import a server entry point whose initialization could start MCP.
3. Locate existing tool schemas, documentation, examples, or local server source that describe the needed capability. A launch command or MCP URL alone does not describe every available tool or provide a non-MCP API. Do not connect to enumerate tools/resources. If static evidence is insufficient, identify the missing documentation instead of inventing a contract.

## Infer and verify a non-MCP route

4. Trace the required operation to an existing CLI/project script, underlying SDK, direct API, or side-effect-free library function. From the available evidence, map the relevant inputs, outputs, side effects, permissions, authentication requirements, and limits. Distinguish confirmed facts from a proposed mapping; do not assume a tool name implies an equivalent command or endpoint.
5. Prefer the smallest existing approved non-MCP interface. Use documented library exports only when they do not initialize MCP. If necessary, use a small direct-interface helper under the global Node.js/temporary-file rules, reusing existing dependencies. Do not build a general adapter framework or add server-specific handlers to this global skill. Ask before installing tools, adding authentication flows, or expanding access.
6. Reuse approved service authentication without copying credentials from another agent's config or exposing their values. Preserve applicable project safety/privacy rules even when replacing its MCP-specific procedure. Confirm the inferred route against documented or implemented behavior and, when authorized, a bounded benign probe. Inference alone is not evidence that an operation works.

## Execute, report, and reuse

- Execute only authorized operations with bounded timeouts/output and appropriate cleanup. Verify the task-specific result and required semantics, not just a successful process exit. Do not silently replace a restricted operation with a broader one.
- If no approved non-MCP path can be established, stop the dependent operation and report the capability gap and the interface or evidence needed. Do not guess endpoints, fabricate results, or relax the policy. Continue independent work when possible.
- State the non-MCP route used, evidence supporting it, what was actually verified, and remaining limitations. Leave other agents' MCP configuration intact.
- Document verified, reusable project-specific mappings near the project in its docs/scripts or a project skill, when authorized. Keep this global workflow generic; create other global guidance only for genuinely cross-project reuse. Never record credentials or transient session output as reusable instructions.
