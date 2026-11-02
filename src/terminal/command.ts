export function terminalCommand(program: string, args: string[], shell: string) {
  const quote = (value: string) => {
    if (/[\r\n\0]/.test(value)) {
      throw new Error("Terminal arguments cannot contain control characters.");
    }
    if (shell === "cmd") {
      if (/["%!]/.test(value)) {
        throw new Error(
          "This command contains characters unsupported by Command Prompt. Select PowerShell or Bash.",
        );
      }
      return `"${value}"`;
    }
    if (shell === "bash") {
      return `'${value.replace(/'/g, "'\\''")}'`;
    }
    if (shell === "powershell" || shell === "pwsh") {
      return `'${value.replace(/'/g, "''")}'`;
    }
    throw new Error("Running package commands requires PowerShell, Command Prompt or Bash.");
  };
  return `${shell === "powershell" || shell === "pwsh" ? "& " : ""}${[program, ...args].map(quote).join(" ")}`;
}
