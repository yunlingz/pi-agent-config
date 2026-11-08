import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildRecallArguments } from "./request.mjs";

const ORIGINAL_TOOL = "vcc_recall";
const SAFE_TOOL = "vcc_recall_safe";

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("search"),
    Type.Literal("range"),
    Type.Literal("expand"),
    Type.Literal("touched"),
    Type.Literal("file"),
  ], { description: "The one recall action to perform." }),
  input: Type.String({
    description: "Action input. Optional trailing modifiers are page:N and scope:all or scope:lineage.",
  }),
}, { additionalProperties: false });

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Invalid safe recall request: ${message}` }],
    details: undefined,
    isError: true,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: SAFE_TOOL,
    label: "Safe VCC Recall",
    description: [
      "Recall this session through one explicit action.",
      "Use search text, range A-B, expand index lists, touched modifiers, or file #N:path syntax.",
      "Append page:N or scope:all to the input when needed.",
    ].join("\n"),
    promptSnippet: "Use vcc_recall_safe for session-history recall. It replaces direct vcc_recall calls.",
    promptGuidelines: [
      "When prior text says `vcc_recall`, call `vcc_recall_safe` instead.",
      "Pass one action and one input. Put optional page and scope tokens at the input end.",
    ],
    parameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    exposure: "model-only",
    prepareLoadout: (loadout) => loadout.declared.some((tool) => tool.name === ORIGINAL_TOOL)
      ? { hiddenDeclarations: [ORIGINAL_TOOL] }
      : undefined,
    reachesTools: () => [ORIGINAL_TOOL],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let arguments_;
      try {
        arguments_ = buildRecallArguments(params.action, params.input);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }

      const outcome = await ctx.executeTool(ORIGINAL_TOOL, arguments_, { signal });
      return outcome.isError ? { ...outcome.result, isError: true } : outcome.result;
    },
  });
}
