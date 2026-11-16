# TypeScript rules for local Pi code

Read this file and the shared `tsconfig.json` before writing maintained local Pi code.

- **Scope**
  - These rules cover extensions, skill scripts, tests, verification tools, shared fixtures, and executable examples.
  - Disposable helpers follow the separate policy in `AGENTS.md`.
  - Temporary TypeScript helpers still require these checks.

## Design code for the shared rules

- **Configuration and design**
  - Use the same strict configuration for every covered directory.
  - You must not create weaker configurations for individual skills or extensions.
  - Design types and fixtures before implementation so the first draft follows the shared rules.
  - Treat static checking as a safeguard, not a reason to add assertions until errors disappear.
- **Inference and reuse**
  - Prefer inference, explicit annotations, `satisfies`, and discriminated unions.
  - Reuse SDK and library types.
  - Use `Pick`, `Omit`, or generics instead of copying their schemas.
  - Keep already-typed values typed; you must not convert them to `unknown` and validate them again.
  - When appropriate, use `as const` for literal inference; it does not bypass assignability checks.
- **Assertions and narrowing**
  - You must not use non-null assertions (`value!`) or double casts (`as unknown as`).
  - Capture checked values in stable variables instead of repeatedly asserting them.
  - When the producer's contract is known, use a documented type assertion at a controlled serialization boundary.
  - A type assertion restores a known contract; it does not validate untrusted data.
  - You must not use `any`.
  - Contain untyped library results at one boundary with the known type or `unknown`.
  - Keep `unknown` for genuinely opaque values; narrow only the fields needed for correctness or security.
- **Validation and contracts**
  - Validate genuinely external or untrusted data once, using an existing schema when available.
  - Trust SDK contracts and controlled Pi output; you must not build parallel decoders for them.
  - Parse controlled JSON with the producer's type.
  - You must not reconstruct every field merely to satisfy strict checking.
  - Keep required semantic checks, such as successful tool execution, token limits, and safe citation URLs.
  - You must not add `@ts-ignore`, `@ts-nocheck`, or disabled checks to obtain a pass.

## Run directly with Node.js

- **Source format**
  - Write ESM `.ts` files with explicit `.ts` extensions for local imports.
  - Use `import type` for imports that supply only types.
  - Use erasable syntax that Node.js can execute through type stripping.
  - You must not add a runtime compilation step or generated JavaScript.
  - You must not write maintained local `.js`, `.mjs`, or `.cjs` source files.
- **Other artifacts**
  - Keep skill instructions in Markdown and configuration data in its required format.
  - Leave installed third-party code and generated artifacts unchanged.
- **Runtime baseline**
  - Use the oldest supported Node.js LTS as the API and declaration baseline, not the current machine's newer runtime.
  - Keep compatible newer LTS versions supported.
  - Verify available supported runtimes.
  - Report unavailable runtime coverage.
  - The shared ESM configuration does not require a repository package manifest or a runtime bundler.

## Check types separately from runtime behavior

Node.js strips types during execution; it does not check them.
Passing runtime tests and passing static checks cover different requirements; neither replaces the other.

- **Required checks**
  - Run strict static checks for new or changed TypeScript before reporting completion.
  - Follow the temporary-directory ownership rules in `AGENTS.md`.
- **Directory ownership**
  - Run steps 2–7 inside the directory owner's `try` block.
  - Its `finally` block must perform step 8.

### Run the checking procedure

1. Create a uniquely named, task-owned OS temporary directory.
2. Install the Go-based TypeScript compiler and baseline Node.js declarations there, with lifecycle scripts disabled.
3. Resolve required host declarations from installed Pi package metadata, including hoisted dependencies.
4. Create a temporary configuration that extends the shared `tsconfig.json` without weakening its rules.
5. Set temporary declaration paths and include all maintained source, tests, verifiers, fixtures, and temporary TypeScript helpers.
6. Run the compiler with `noEmit` and `erasableSyntaxOnly` enabled.
7. Run the relevant runtime tests against the actual implementation.
8. Remove the owned directory in `finally`, including after setup, installation, or checking failures.

### Configure and report checks

- **Compiler command**
  - For stable Go-based releases distributed as `typescript`, use this command:

    ```text
    node <temporary-toolchain-directory>/node_modules/typescript/bin/tsc --project <temporary-tsconfig.json> --noEmit
    ```

  - When selecting a different release, verify the compiler distribution and command-line interface.
- **Checking configuration**
  - Use forward slashes in temporary JSON paths and an explicit file list to make checking coverage clear.
  - When changing the checking setup, confirm that a synthetic type error fails.
  - `skipLibCheck` excludes installed declarations from checking; maintained source remains strictly checked.
  - You must not add repository dependencies, lockfiles, or permanent runners for checking alone.
- **Results and limitations**
  - When a required check cannot run, report `Blocked` or `Not verified` and name the missing prerequisite.
  - Report each check's command, working directory, result, and coverage.
  - Report cleanup that could not finish.
