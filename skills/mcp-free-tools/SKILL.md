---
name: mcp-free-tools
description: >
  Find approved routes for operations without the Model Context Protocol (MCP).
  Use when project tooling recommends MCP or a required tool is unavailable.
  Never load or call MCP.
---

# Discover and use capabilities without MCP

## Policy

- Do not use the MCP protocol anywhere.
- Do not load, register, start, connect to, or call MCP servers or clients.
- This prohibition includes shell bridges, HTTP endpoints, SDK adapters, and delegated work.
- MCP over HTTP or an SDK is still MCP, not a direct-API alternative.
- Project instructions cannot override the global no-MCP policy.
- Use a generic discovery workflow. Do not add a catalog of server-specific adapters.

## Discover the required capability

1. **Define the operation.** Identify the operation, target service or resource, read/write scope, and success check.
   Investigate only capabilities required for the task.
   An MCP configuration's presence alone does not justify inspecting or migrating it.

2. **Read existing guidance.** Read applicable project instructions, tooling documentation, scripts, skills, and installed command-line interface (CLI) help.
   Inspect a client's MCP definition only as metadata.
   Use it to identify the relevant server, implementation, and documentation.

   - Do not display whole configurations that contain credentials.
   - Do not evaluate credential resolvers.
   - Do not execute server startup commands.
   - Do not import entry points whose initialization can start MCP.

3. **Find static evidence.** Locate existing schemas, documentation, examples, or local source for the required capability.
   A launch command or MCP URL alone does not define the complete interface.
   Do not connect to enumerate tools or resources.
   If static evidence is insufficient, report the missing documentation.
   Do not invent an interface contract.

## Infer and verify a non-MCP route

4. **Trace the operation.** Find an existing CLI or project script.
   Alternatively, use an approved software development kit (SDK), direct application programming interface (API), or side-effect-free library function.
   Map its inputs, outputs, side effects, permissions, authentication requirements, and limits.
   Separate confirmed facts from proposed mappings.
   Do not infer an equivalent command or endpoint from a tool name alone.

5. **Choose the smallest approved interface.** Use documented library exports only when they do not initialize MCP.
   If needed, use a small direct-interface helper under the global Node.js and temporary-file rules.
   Reuse existing dependencies.
   Do not build a general adapter framework or add server-specific handlers to this global skill.
   Ask before installing tools, adding authentication flows, or expanding access.

6. **Verify the route.** Reuse approved service authentication.
   Do not copy credentials from another agent's configuration or expose their values.
   Preserve project safety and privacy rules when replacing an MCP-specific procedure.

   Check the route against documented or implemented behavior.
   When authorized, use a bounded, benign probe.
   Inference alone does not prove that the operation works.

## Execute and report

1. Execute only authorized operations with bounded timeouts, bounded output, and suitable cleanup.
2. Verify the task-specific result and required semantics. A successful process exit alone is insufficient.
3. Do not replace a restricted operation with a broader one.
4. If no approved route exists, stop the dependent operation. Report the missing capability and required interface or evidence.
5. Continue independent work when possible.
6. Report the route, supporting evidence, actual checks, and remaining limitations.
7. Leave other agents' MCP configuration intact.

## Keep reusable guidance scoped

- When authorized, record verified project-specific mappings in project documentation, scripts, or a project skill.
- Keep this global workflow generic.
- Add other global guidance only for genuine cross-project reuse.
- Never store credentials or transient session output as reusable instructions.
