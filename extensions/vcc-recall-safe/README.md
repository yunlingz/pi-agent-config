# Safe VCC recall

A local, dependency-free Pi extension that makes `pi-vcc` recall calls unambiguous. It does not modify the installed `pi-vcc` package.

## Problem

The original `vcc_recall` schema exposes `query`, `range`, `expand`, and `mode` as separate optional fields. Some models populate several fields in one call. Every value can pass schema validation, but `pi-vcc` then selects one action by precedence.

This can execute a different recall action from the model's intended action.

## Behavior

The extension registers `vcc_recall_safe` with exactly two model-facing fields:

- `action`: `search`, `range`, `expand`, `touched`, or `file`.
- `input`: the selected action's value and optional trailing modifiers.

It hides the original declaration while keeping the original tool callable internally. Each safe call validates and converts one action, then delegates through Pi's `ctx.executeTool()` API.

The extension does not read session files, duplicate VCC search logic, or change compaction behavior. Original results and errors pass through unchanged.

## Input forms

```text
search   SF Mono Terminal
range    1250-1290 page:2
expand   1253,1254
touched  page:2 scope:all
file     #1253:src/auth.ts:full
```

Append `scope:all` or `scope:lineage` when needed. Append `page:N` only to `search`, `range`, or `touched`.

## Activate

Run `/reload`, or start a fresh Pi session. Pi discovers this directory's `index.ts` automatically.

The extension prompt redirects earlier instructions that mention `vcc_recall` to `vcc_recall_safe`.

## Checks

From the global agent repository:

```text
node --test extensions/vcc-recall-safe/request.test.mjs
```

The focused tests cover every action, modifier parsing, normalization, and invalid input. Live verification must also confirm that provider requests declare only `vcc_recall_safe` and that nested original calls succeed.

Remove this extension after upstream `pi-vcc` provides an enforced single-action schema and ambiguous-call handling.
