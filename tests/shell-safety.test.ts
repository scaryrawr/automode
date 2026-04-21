import { describe, expect, it } from "vitest";
import { getShellFastPathDecision } from "../src/shell-safety.js";
import type { ShellPermissionRequest } from "../src/types.js";
import os from "node:os";
import path from "node:path";

function createShellRequest(
  commands: ShellPermissionRequest["commands"],
  overrides: Partial<ShellPermissionRequest> = {},
): ShellPermissionRequest {
  return {
    kind: "shell",
    fullCommandText: "command",
    intention: "Inspect project state",
    commands,
    possiblePaths: [],
    possibleUrls: [],
    hasWriteFileRedirection: false,
    canOfferSessionApproval: false,
    warning: undefined,
    ...overrides,
  };
}

describe("getShellFastPathDecision", () => {
  it("approves common inspection commands that were not marked read-only", () => {
    const request = createShellRequest([
      { identifier: "grep", readOnly: false, args: ["-n", "TODO", "src/extension.ts"] },
      { identifier: "head", readOnly: false, args: ["-n", "20", "README.md"] },
    ]);

    expect(getShellFastPathDecision(request)).toEqual({ kind: "approved" });
  });

  it("approves safe sed invocations without in-place edits", () => {
    const request = createShellRequest([
      { identifier: "sed", readOnly: false, args: ["-n", "1,10p", "src/extension.ts"] },
    ]);

    expect(getShellFastPathDecision(request)).toEqual({ kind: "approved" });
  });

  it("falls back when sed uses in-place edits", () => {
    const request = createShellRequest([
      { identifier: "sed", readOnly: false, args: ["-i.bak", "s/old/new/", "src/extension.ts"] },
    ]);

    expect(getShellFastPathDecision(request)).toEqual({ kind: "no-result" });
  });

  it("approves safe commands that redirect output to a temp file", () => {
    const request = createShellRequest(
      [{ identifier: "grep", readOnly: false, args: ["-n", "TODO", "src/extension.ts"] }],
      {
        possiblePaths: [path.join(os.tmpdir(), "pilotauto-grep.txt")],
        hasWriteFileRedirection: true,
      },
    );

    expect(getShellFastPathDecision(request)).toEqual({ kind: "approved" });
  });

  it("approves safe commands that redirect output under the cwd", () => {
    const request = createShellRequest(
      [{ identifier: "grep", readOnly: false, args: ["-n", "TODO", "src/extension.ts"] }],
      {
        possiblePaths: ["logs/grep-output.txt"],
        hasWriteFileRedirection: true,
      },
    );

    expect(getShellFastPathDecision(request)).toEqual({ kind: "approved" });
  });

  it("falls back when redirected output may escape the cwd", () => {
    const request = createShellRequest(
      [{ identifier: "grep", readOnly: false, args: ["-n", "TODO", "src/extension.ts"] }],
      {
        possiblePaths: ["../grep-output.txt"],
        hasWriteFileRedirection: true,
      },
    );

    expect(getShellFastPathDecision(request)).toEqual({ kind: "no-result" });
  });

  it("still falls back for non-safe commands even when redirected output stays under the cwd", () => {
    const request = createShellRequest(
      [{ identifier: "npm", readOnly: false, args: ["test"] }],
      {
        possiblePaths: ["logs/test-output.txt"],
        hasWriteFileRedirection: true,
      },
    );

    expect(getShellFastPathDecision(request)).toEqual({ kind: "no-result" });
  });

  it("approves git inspection commands and falls back for non-inspection ones", () => {
    const inspectionRequest = createShellRequest([
      { identifier: "git", readOnly: false, args: ["-C", "repo", "status", "--short"] },
    ]);
    const pushRequest = createShellRequest([
      { identifier: "git", readOnly: false, args: ["push", "origin", "main"] },
    ]);

    expect(getShellFastPathDecision(inspectionRequest)).toEqual({ kind: "approved" });
    expect(getShellFastPathDecision(pushRequest)).toEqual({ kind: "no-result" });
  });

  it("hard denies destructive git commands with a reason", () => {
    const request = createShellRequest([
      { identifier: "git", readOnly: false, args: ["reset", "--hard", "HEAD~1"] },
    ]);

    expect(getShellFastPathDecision(request)).toEqual({
      kind: "denied",
      reason: "git reset can rewrite history or overwrite working tree changes.",
    });
  });

  it("falls back for unsafe find expressions", () => {
    const request = createShellRequest([
      { identifier: "find", readOnly: false, args: [".", "-exec", "rm", "{}", ";"] },
    ]);

    expect(getShellFastPathDecision(request)).toEqual({ kind: "no-result" });
  });

  it("approves common PowerShell inspection commands", () => {
    const request = createShellRequest([
      { identifier: "Get-Content", readOnly: false, args: ["README.md"] },
      { identifier: "Select-String", readOnly: false, args: ["TODO", "src/extension.ts"] },
    ]);

    expect(getShellFastPathDecision(request)).toEqual({ kind: "approved" });
  });
});
