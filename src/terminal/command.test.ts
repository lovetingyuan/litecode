import { describe, expect, it } from "vitest";
import { terminalCommand } from "./command";

describe("Package command shell escaping", () => {
  it("passes script names literally to PowerShell and Bash", () => {
    const script = "build'; echo $HOME & more";
    expect(terminalCommand("npm", ["run", "--", script], "powershell")).toBe(
      "& 'npm' 'run' '--' 'build''; echo $HOME & more'",
    );
    expect(terminalCommand("npm", ["run", "--", script], "bash")).toBe(
      "'npm' 'run' '--' 'build'\\''; echo $HOME & more'",
    );
  });
  it("quotes Command Prompt arguments and refuses expansion or command injection", () => {
    expect(terminalCommand("npm", ["run", "--", "build & serve"], "cmd")).toBe(
      '"npm" "run" "--" "build & serve"',
    );
    for (const script of [
      'build" & echo injected',
      "%PATH%",
      "!PATH!",
      "build\rwhoami",
      "build\nwhoami",
    ]) {
      expect(() => terminalCommand("npm", ["run", script], "cmd")).toThrow();
    }
    expect(() => terminalCommand("npm", ["run", "build"], "unknown")).toThrow(
      "requires PowerShell",
    );
  });
});
