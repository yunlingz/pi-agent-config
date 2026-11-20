import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** An existing project program for interpreter and natural-choice acceptance tests. Never imports production logic. */
export async function projectFixture(root: string, language: "python" | "powershell", executable: string) {
  const project = join(root, `project-${language}`);
  await mkdir(join(project, "scripts"), { recursive: true });
  const receipt = join(project, "invocations.jsonl");
  const script = join(project, "scripts", language === "python" ? "measure.py" : "measure.ps1");
  const source = language === "python" ? [
    "import json, os, sys",
    "from pathlib import Path",
    "case = sys.argv[1]",
    "text = Path('inputs/' + case + '.txt').read_text(encoding='utf-8')",
    "result = dict(case=case, characters=len(text), cwd=os.getcwd(), marker=os.environ.get('NODE_REUSE_MARKER'))",
    "with open('invocations.jsonl', 'a', encoding='utf-8') as output:",
    "    output.write(json.dumps(result) + '\\n')",
    "print(json.dumps(result))",
    "print('PROJECT_STDERR', file=sys.stderr)",
    "sys.exit(7 if case == 'failure' else 0)",
  ].join("\n") + "\n" : [
    "param([Parameter(Mandatory=$true)][string]$Case)",
    "$ErrorActionPreference = 'Stop'",
    "$text = [System.IO.File]::ReadAllText((Join-Path (Get-Location) ('inputs/' + $Case + '.txt')))",
    "$result = @{case=$Case; characters=$text.Length; cwd=(Get-Location).Path; marker=$env:NODE_REUSE_MARKER} | ConvertTo-Json -Compress",
    "[System.IO.File]::AppendAllText((Join-Path (Get-Location) 'invocations.jsonl'), $result + [Environment]::NewLine)",
    "[Console]::Out.WriteLine($result)",
    "[Console]::Error.WriteLine('PROJECT_STDERR')",
    "if ($Case -eq 'failure') { exit 7 }",
  ].join("\n") + "\n";
  await writeFile(script, source);
  await mkdir(join(project, "inputs"));
  await writeFile(join(project, "inputs", "alpha.txt"), "Example alpha\n");
  await writeFile(join(project, "inputs", "beta.txt"), "A different beta sample\n");
  await writeFile(join(project, "inputs", "failure.txt"), "Expected failure\n");
  const prefix = language === "python" ? [script] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-Case"];
  await writeFile(join(project, "README.md"), [
    "# Project measurement workflow",
    "Measure a named input with the project's existing measurement program. It writes one JSON receipt per execution.",
    `Working directory: ${project}`,
    `Executable: ${executable}`,
    `Arguments for alpha: ${JSON.stringify([...prefix, "alpha"])}`,
    "The last argument selects the input: alpha, beta, or failure. No dependencies or network are needed.",
    "Do not edit the existing program or copy its implementation. It also writes PROJECT_STDERR; failure exits with code 7.",
  ].join("\n") + "\n");
  return { project, receipt, script, source, executable, prefix };
}

/** Test-only thin launcher: native file tools author this source; it runs the original program without a shell. */
export function launcherSource(fixture: Awaited<ReturnType<typeof projectFixture>>) {
  return [
    'import { spawn } from "node:child_process";',
    `const child = spawn(${JSON.stringify(fixture.executable)}, [...${JSON.stringify(fixture.prefix)}, ...process.argv.slice(2)], { cwd: ${JSON.stringify(fixture.project)}, shell: false, windowsHide: true, stdio: "inherit" });`,
    'child.once("error", error => { console.error(error.code ?? "SPAWN_FAILED"); process.exitCode = 1; });',
    'child.once("exit", (code, signal) => { if (signal) console.error(signal); process.exitCode = code ?? 1; });',
  ].join("\n") + "\n";
}
