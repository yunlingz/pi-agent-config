# TypeScript rules for local Pi code

Read this file and the shared `tsconfig.json` before writing maintained local Pi code.
These rules cover extensions, skill scripts, tests, verification tools, shared fixtures, and executable examples.
Disposable helpers follow the separate policy in `AGENTS.md`; temporary TypeScript helpers still require these checks.

## Design code for the shared rules

- Use the same strict configuration for every covered directory.
- Do not create weaker per-skill or per-extension configurations.
- Design types and fixtures before implementation so the first draft follows the shared rules.
- Treat static checking as a safeguard, not a reason to add assertions until errors disappear.
- Prefer inference, explicit annotations, `satisfies`, and discriminated unions.
- Reuse SDK and library types; use `Pick`, `Omit`, or generics instead of copying their schemas.
- Keep already-typed values typed; do not convert them to `unknown` and validate them again.
- Do not use non-null assertions (`value!`) or double casts (`as unknown as`).
- Capture checked values in stable variables instead of repeatedly asserting them.
- Use a documented type assertion at a controlled serialization boundary when the producer's contract is known.
- A type assertion restores a known contract; it does not validate untrusted data.
- Use `as const` for literal inference when appropriate; it does not bypass assignability checks.
- Validate genuinely external or untrusted data once, using an existing schema when available.
- Trust established SDK contracts and controlled Pi output; do not build parallel decoders for them.
- Parse controlled JSON with the producer's type; do not reconstruct every field merely to satisfy strict checking.
- Do not use `any`; contain untyped library results at one boundary with the known type or `unknown`.
- Keep `unknown` for genuinely opaque values; narrow only the fields needed for correctness or security.
- Keep required semantic checks, such as successful tool execution, token limits, and safe citation URLs.
- Do not add `@ts-ignore`, `@ts-nocheck`, or disabled checks to obtain a pass.

## Run directly with Node.js

- Write ESM `.ts` files with explicit `.ts` extensions for local imports.
- Use `import type` for imports that supply only types.
- Use erasable syntax that Node.js can execute through type stripping.
- Do not add a runtime compilation step or generated JavaScript.
- Do not write maintained local `.js`, `.mjs`, or `.cjs` source files.
- Keep skill instructions in Markdown and configuration data in its required format.
- Leave installed third-party code and generated artifacts unchanged.

Use the oldest supported Node.js LTS as the API and declaration baseline, not the current machine's newer runtime.
Keep compatible newer LTS versions supported.
Verify available supported runtimes and report unavailable coverage.
The shared ESM configuration does not require a repository package manifest or a runtime bundler.

## Check types separately from runtime behavior

Node.js strips types during execution; it does not check them.
Run strict static checks for new or changed TypeScript before reporting completion.
Passing runtime tests and passing static checks cover different requirements; neither replaces the other.

1. Create a uniquely named, task-owned OS temporary directory.
2. Install the Go-based TypeScript compiler and baseline Node.js declarations there, with lifecycle scripts disabled.
3. Resolve required host declarations from installed Pi package metadata, including hoisted dependencies.
4. Create a temporary configuration that extends the shared `tsconfig.json` without weakening its rules.
5. Set temporary declaration paths and include all maintained source, tests, verifiers, fixtures, and temporary TypeScript helpers.
6. Run the compiler with `noEmit` and `erasableSyntaxOnly` enabled.
7. Run the relevant runtime tests against the actual implementation.
8. Remove owned temporary tools and artifacts after verification.

For stable Go-based releases distributed as `typescript`, the CLI command is:

```text
node <temporary-toolchain-directory>/node_modules/typescript/bin/tsc --project <temporary-tsconfig.json> --noEmit
```

Verify the compiler distribution and CLI when selecting a different release.
Use forward slashes in temporary JSON paths and an explicit file list to make checking coverage clear.
When changing the checking setup, confirm that a synthetic type error fails.
`skipLibCheck` excludes installed declarations from checking; maintained source remains strictly checked.
Do not add repository dependencies, lockfiles, or permanent runners for checking alone.

When a required check cannot run, report `Blocked` or `Not verified` and name the missing prerequisite.
Report each check's command, working directory, result, and coverage.
Report cleanup that could not finish.
