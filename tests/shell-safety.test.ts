import { describe, expect, it } from "vitest";
import {
  createShellPermissionRequestFromCommandText,
  getShellFastPathDecision,
} from "../src/shell-safety.js";
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

  it("does not fast-path approve path-qualified command identifiers", async () => {
    const directRequest = createShellRequest([
      { identifier: "./grep", readOnly: false, args: ["-n", "TODO", "src/extension.ts"] },
    ]);
    const parsedRequest = await createShellPermissionRequestFromCommandText(
      "./grep -n TODO src/extension.ts",
      "Search TODOs",
    );

    expect(getShellFastPathDecision(directRequest)).toEqual({ kind: "no-result" });
    expect(parsedRequest?.commands).toEqual([
      {
        identifier: "./grep",
        readOnly: false,
        args: ["-n", "TODO", "src/extension.ts"],
      },
    ]);
    expect(parsedRequest && getShellFastPathDecision(parsedRequest)).toEqual({ kind: "no-result" });
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

  it("approves relative redirects resolved inside the supplied cwd", () => {
    const shellCwd = path.join(path.dirname(process.cwd()), "automode-shell-cwd");
    const request = createShellRequest(
      [{ identifier: "grep", readOnly: false, args: ["-n", "TODO", "src/extension.ts"] }],
      {
        cwd: shellCwd,
        possiblePaths: [`../${path.basename(shellCwd)}/logs/grep-output.txt`],
        hasWriteFileRedirection: true,
      },
    );

    expect(getShellFastPathDecision(request)).toEqual({ kind: "approved" });
  });

  it("falls back when a relative redirect escapes the supplied cwd", () => {
    const shellCwd = path.join(path.dirname(process.cwd()), "automode-shell-cwd");
    const request = createShellRequest(
      [{ identifier: "grep", readOnly: false, args: ["-n", "TODO", "src/extension.ts"] }],
      {
        cwd: shellCwd,
        possiblePaths: [`../${path.basename(process.cwd())}/logs/grep-output.txt`],
        hasWriteFileRedirection: true,
      },
    );

    expect(getShellFastPathDecision(request)).toEqual({ kind: "no-result" });
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

  it("hard denies git pushes that can rewrite or delete remote refs", () => {
    const forcePushRequest = createShellRequest([
      { identifier: "git", readOnly: false, args: ["push", "--force-with-lease", "origin", "main"] },
    ]);
    const deletePushRequest = createShellRequest([
      { identifier: "git", readOnly: false, args: ["push", "origin", ":old-branch"] },
    ]);
    const shortDeletePushRequest = createShellRequest([
      { identifier: "git", readOnly: false, args: ["push", "-d", "origin", "old-branch"] },
    ]);

    expect(getShellFastPathDecision(forcePushRequest)).toEqual({
      kind: "denied",
      reason: "git push can force-update or delete remote refs.",
    });
    expect(getShellFastPathDecision(deletePushRequest)).toEqual({
      kind: "denied",
      reason: "git push can force-update or delete remote refs.",
    });
    expect(getShellFastPathDecision(shortDeletePushRequest)).toEqual({
      kind: "denied",
      reason: "git push can force-update or delete remote refs.",
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

  it("builds shell permission metadata from pre-tool command text", async () => {
    const request = await createShellPermissionRequestFromCommandText(
      "grep -n TODO src/extension.ts > logs/grep-output.txt",
      "Capture TODO matches",
    );

    expect(request).toEqual({
      kind: "shell",
      fullCommandText: "grep -n TODO src/extension.ts > logs/grep-output.txt",
      intention: "Capture TODO matches",
      commands: [
        {
          identifier: "grep",
          readOnly: false,
          args: ["-n", "TODO", "src/extension.ts"],
        },
      ],
      possiblePaths: ["logs/grep-output.txt"],
      possibleUrls: [],
      hasWriteFileRedirection: true,
      canOfferSessionApproval: false,
      warning: undefined,
    });
    expect(request && getShellFastPathDecision(request)).toEqual({ kind: "approved" });
  });

  it("builds shell permission metadata for pipelines and command lists", async () => {
    const request = await createShellPermissionRequestFromCommandText(
      "grep -n TODO src/extension.ts | wc -l; git status --short",
      "Inspect TODO count and repository status",
    );

    expect(request?.commands).toEqual([
      {
        identifier: "grep",
        readOnly: false,
        args: ["-n", "TODO", "src/extension.ts"],
      },
      {
        identifier: "wc",
        readOnly: false,
        args: ["-l"],
      },
      {
        identifier: "git",
        readOnly: false,
        args: ["status", "--short"],
      },
    ]);
    expect(request && getShellFastPathDecision(request)).toEqual({ kind: "approved" });
  });

  it("handles literal quoted redirect destinations", async () => {
    const request = await createShellPermissionRequestFromCommandText(
      'grep TODO src/extension.ts >> "logs/grep output.txt"',
      "Capture TODO matches",
    );

    expect(request?.possiblePaths).toEqual(["logs/grep output.txt"]);
    expect(request && getShellFastPathDecision(request)).toEqual({ kind: "approved" });
  });

  it("skips variable assignments before command names", async () => {
    const request = await createShellPermissionRequestFromCommandText(
      "LC_ALL=C grep TODO src/extension.ts",
      "Search TODOs",
    );

    expect(request?.commands).toEqual([
      {
        identifier: "grep",
        readOnly: false,
        args: ["TODO", "src/extension.ts"],
      },
    ]);
    expect(request && getShellFastPathDecision(request)).toEqual({ kind: "approved" });
  });

  it("allows file descriptor redirection without treating it as a write path", async () => {
    const request = await createShellPermissionRequestFromCommandText(
      "grep TODO src/extension.ts 2>&1",
      "Search TODOs",
    );

    expect(request?.possiblePaths).toEqual([]);
    expect(request?.hasWriteFileRedirection).toBe(false);
    expect(request && getShellFastPathDecision(request)).toEqual({ kind: "approved" });
  });

  it("keeps pre-tool command parsing conservative for executable expansions", async () => {
    await expect(
      createShellPermissionRequestFromCommandText("grep TODO $(rm -rf build)", "Search TODOs"),
    ).resolves.toBeNull();
    await expect(createShellPermissionRequestFromCommandText("cat ${x@P}", "Read file")).resolves.toBeNull();
  });

  it("keeps pre-tool redirection parsing conservative for dynamic targets", async () => {
    await expect(
      createShellPermissionRequestFromCommandText("grep TODO src/extension.ts > $OUTPUT", "Search TODOs"),
    ).resolves.toBeNull();
    await expect(
      createShellPermissionRequestFromCommandText('grep TODO src/extension.ts > "$OUTPUT"', "Search TODOs"),
    ).resolves.toBeNull();
  });

  it("keeps pre-tool parsing conservative for unsupported shell constructs", async () => {
    await expect(createShellPermissionRequestFromCommandText("grep TODO src &", "Search TODOs")).resolves.toBeNull();
    await expect(
      createShellPermissionRequestFromCommandText("cat <<EOF\nhello\nEOF", "Read heredoc"),
    ).resolves.toBeNull();
    await expect(
      createShellPermissionRequestFromCommandText('if ls; then pwd; fi', "Inspect paths"),
    ).resolves.toBeNull();
    await expect(
      createShellPermissionRequestFromCommandText("{ ls; }", "Inspect paths"),
    ).resolves.toBeNull();
    await expect(
      createShellPermissionRequestFromCommandText("! ls", "Inspect paths"),
    ).resolves.toBeNull();
  });

  it("keeps pre-tool parsing conservative for dynamic command names", async () => {
    await expect(
      createShellPermissionRequestFromCommandText('"$EDITOR" src/extension.ts', "Open editor"),
    ).resolves.toBeNull();
  });
});
