import { basename } from "node:path";

export const SHELL_BLOCK_REASON = "Agent-issued Bash and PowerShell calls are blocked. Use script_inline for commands or small JavaScript helpers; use script_job and script_js for developed helpers. Do not retry through another shell.";

export function blockedTool(name: string): string | undefined {
  return name === "bash" || name === "powershell" ? SHELL_BLOCK_REASON : undefined;
}

/** This checks the supported native execution API, not arbitrary Node.js code or descendant programs. */
export function nativeBlockReason(command: string, args: readonly string[]): string | undefined {
  const program = basename(command.replaceAll("\\", "/")).toLowerCase();
  if (/^(?:powershell|pwsh)(?:[-.]?\d+(?:\.\d+)*)?(?:\.exe)?$/u.test(program) || /\.(?:ps1|psm1)$/iu.test(program)) {
    return "PowerShell execution is blocked, including Windows PowerShell, PowerShell 7, and .ps1 scripts.";
  }
  if (/^(?:bash|sh|zsh|dash|fish|ksh|csh|tcsh|cmd)(?:\.exe)?$/u.test(program)) {
    return "Shell execution is blocked. Write orchestration in JavaScript and pass executable arguments as an array.";
  }
  if (/^(?:python[\d.]*|ruby[\d.]*|perl|php|lua[\d.]*|rscript|julia|deno|bun)(?:\.exe)?$/u.test(program)
    && args.some(arg => /^(?:-[ec]|--eval|--execute|eval|run|-)(?:=|$)/u.test(arg))) {
    return "New inline helpers must use JavaScript in the managed Node.js process, not another interpreter.";
  }
  return undefined;
}
