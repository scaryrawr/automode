import type { CommandContext } from "@github/copilot-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const joinSession = vi.fn();
  const loadConfig = vi.fn();
  const classifyShellSafetyWithModel = vi.fn();
  const closeClassifierClient = vi.fn();
  const getGitHubAuthToken = vi.fn();
  const listClassifierModels = vi.fn();
  const log = vi.fn();
  const on = vi.fn();
  const select = vi.fn();

  return {
    classifyShellSafetyWithModel,
    closeClassifierClient,
    getGitHubAuthToken,
    joinSession,
    listClassifierModels,
    loadConfig,
    log,
    on,
    select,
  };
});

vi.mock("@github/copilot-sdk/extension", () => ({
  joinSession: mocks.joinSession,
}));

vi.mock("../src/classifier.js", () => ({
  classifyShellSafetyWithModel: mocks.classifyShellSafetyWithModel,
  closeClassifierClient: mocks.closeClassifierClient,
}));

vi.mock("../src/classifier-models.js", () => ({
  listClassifierModels: mocks.listClassifierModels,
}));

vi.mock("../src/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../src/github-auth.js", () => ({
  getGitHubAuthToken: mocks.getGitHubAuthToken,
}));

async function loadExtensionModule() {
  vi.resetModules();
  delete process.env.CLASSIFIER_SESSION;
  return import("../src/extension.js");
}

function getPermissionHandler() {
  const [config] = mocks.joinSession.mock.calls.at(-1) ?? [];
  return config.onPermissionRequest as (
    request: unknown,
    invocation?: { sessionId: string },
  ) => Promise<unknown>;
}

function getHooks() {
  const [config] = mocks.joinSession.mock.calls.at(-1) ?? [];
  return config.hooks as {
    onSessionStart: (request: unknown, invocation?: { sessionId: string }) => Promise<unknown>;
    onUserPromptSubmitted: (request: unknown, invocation?: { sessionId: string }) => Promise<unknown>;
    onPreToolUse?: (request: unknown, invocation?: { sessionId: string }) => Promise<unknown>;
  };
}

function getCommandHandler(commandName: string) {
  const [config] = mocks.joinSession.mock.calls.at(-1) ?? [];
  const command = config.commands.find(
    (candidate: { name: string }) => candidate.name === commandName,
  );
  return command.handler as (context: Pick<CommandContext, "args">) => Promise<void>;
}

describe("extension permission hook", () => {
  let config: { autoMode: boolean; classifierModel?: string };

  function createShellPermissionRequest(command: string, intention: string) {
    const [identifier = ""] = command.trim().split(/\s+/, 1);
    return {
      kind: "shell" as const,
      fullCommandText: command,
      intention,
      commands: [{ identifier, readOnly: false }],
      possiblePaths: [],
      possibleUrls: [],
      hasWriteFileRedirection: false,
      canOfferSessionApproval: false,
      warning: undefined,
    };
  }

  const shellCommand = "npm test -- --runInBand";
  const shellIntention = "Run the test suite";
  const shellRequest = createShellPermissionRequest(shellCommand, shellIntention);

  beforeEach(() => {
    vi.clearAllMocks();

    config = { autoMode: true };
    mocks.getGitHubAuthToken.mockResolvedValue("github-token");
    mocks.loadConfig.mockResolvedValue(config);
    mocks.classifyShellSafetyWithModel.mockResolvedValue({
      classification: "allow",
      reason: "non-destructive command",
    });
    mocks.listClassifierModels.mockResolvedValue([
      { id: "gpt-5-mini", name: "GPT-5 mini", capabilities: {} },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", capabilities: {} },
    ]);
    mocks.select.mockResolvedValue("gpt-5-mini");
    mocks.joinSession.mockResolvedValue({
      capabilities: { ui: { elicitation: true } },
      log: mocks.log,
      on: mocks.on,
      ui: { select: mocks.select },
    });
    mocks.log.mockResolvedValue(undefined);
    mocks.on.mockReturnValue(undefined);
    mocks.closeClassifierClient.mockResolvedValue(undefined);
  });

  it("registers a permission request handler instead of a pre-tool hook", async () => {
    await loadExtensionModule();

    const [joinConfig] = mocks.joinSession.mock.calls.at(-1) ?? [];
    expect(joinConfig.onPermissionRequest).toBeTypeOf("function");
    expect(joinConfig.hooks.onPreToolUse).toBeUndefined();
    expect(joinConfig.hooks.onSessionStart).toBeTypeOf("function");
    expect(joinConfig.hooks.onUserPromptSubmitted).toBeTypeOf("function");
  });

  it("does not register when GitHub authentication is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getGitHubAuthToken.mockRejectedValueOnce(new Error("gh auth token failed"));

    try {
      await loadExtensionModule();

      expect(mocks.loadConfig).not.toHaveBeenCalled();
      expect(mocks.joinSession).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "automode extension disabled: GitHub authentication unavailable. Set GH_TOKEN or GITHUB_TOKEN, or run `gh auth login` so `gh auth token` succeeds.",
        "gh auth token failed",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to normal permission flow when auto mode is disabled", async () => {
    config.autoMode = false;

    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    await expect(
      onPermissionRequest(shellRequest, { sessionId: "test-session" }),
    ).resolves.toEqual({ kind: "no-result" });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("passes command and intention to the classifier and approves allowed commands", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    await expect(
      onPermissionRequest(shellRequest, { sessionId: "test-session" }),
    ).resolves.toEqual({ kind: "approved" });

    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledTimes(1);
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        command: shellCommand,
        intention: shellIntention,
        shellRequest: expect.objectContaining({
          fullCommandText: shellCommand,
          intention: shellIntention,
          commands: [
            {
              identifier: "npm",
              readOnly: false,
              args: ["test", "--", "--runInBand"],
            },
          ],
        }),
      }),
      undefined,
    );
    expect(mocks.log).toHaveBeenCalledWith("classifier running", {
      ephemeral: true,
      level: "info",
    });
    expect(mocks.log).toHaveBeenCalledWith("classifier result: allow (non-destructive command)", {
      ephemeral: true,
      level: "info",
    });
  });

  it("passes the configured classifier model to shell classifications", async () => {
    config.classifierModel = "gpt-5-mini";

    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    await expect(
      onPermissionRequest(shellRequest, { sessionId: "test-session" }),
    ).resolves.toEqual({ kind: "approved" });

    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        command: shellCommand,
        intention: shellIntention,
      }),
      "gpt-5-mini",
    );
  });

  it("uses classifier model changes made after registration", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    config.classifierModel = "claude-sonnet-4.5";

    await expect(
      onPermissionRequest(shellRequest, { sessionId: "test-session" }),
    ).resolves.toEqual({ kind: "approved" });

    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        command: shellCommand,
        intention: shellIntention,
      }),
      "claude-sonnet-4.5",
    );
  });

  it("passes the latest submitted user prompt to shell classifications", async () => {
    await loadExtensionModule();
    const hooks = getHooks();
    const onPermissionRequest = getPermissionHandler();

    await expect(
      hooks.onUserPromptSubmitted(
        {
          prompt: "Please run the test suite",
          timestamp: 1,
          cwd: "/workspace",
        },
        { sessionId: "test-session" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      onPermissionRequest(shellRequest, { sessionId: "test-session" }),
    ).resolves.toEqual({
      kind: "approved",
    });

    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        command: shellCommand,
        intention: shellIntention,
        latestUserPrompt: "Please run the test suite",
      }),
      undefined,
    );
  });

  it("uses the session initial prompt before any submitted user prompt", async () => {
    await loadExtensionModule();
    const hooks = getHooks();
    const onPermissionRequest = getPermissionHandler();

    await expect(
      hooks.onSessionStart(
        {
          source: "startup",
          initialPrompt: "Run the focused tests",
          timestamp: 1,
          cwd: "/workspace",
        },
        { sessionId: "test-session" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      onPermissionRequest(shellRequest, { sessionId: "test-session" }),
    ).resolves.toEqual({
      kind: "approved",
    });

    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        latestUserPrompt: "Run the focused tests",
      }),
      undefined,
    );
  });

  it("keeps latest user prompts isolated by session id", async () => {
    await loadExtensionModule();
    const hooks = getHooks();
    const onPermissionRequest = getPermissionHandler();

    await hooks.onUserPromptSubmitted(
      {
        prompt: "Publish to main",
        timestamp: 1,
        cwd: "/workspace",
      },
      { sessionId: "other-session" },
    );
    await expect(
      onPermissionRequest(shellRequest, { sessionId: "test-session" }),
    ).resolves.toEqual({
      kind: "approved",
    });

    const [classifierInput] = mocks.classifyShellSafetyWithModel.mock.calls[0] ?? [];
    expect(classifierInput).not.toHaveProperty("latestUserPrompt");
  });

  it("denies blocked shell classifications with a default reason", async () => {
    mocks.classifyShellSafetyWithModel.mockResolvedValueOnce({
      classification: "block",
    });

    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    await expect(
      onPermissionRequest(shellRequest, { sessionId: "test-session" }),
    ).resolves.toEqual({
      kind: "denied-by-permission-request-hook",
      message: "Blocked by safety classifier.",
      interrupt: false,
    });
  });

  it("denies blocked shell classifications with the classifier reason", async () => {
    mocks.classifyShellSafetyWithModel.mockResolvedValueOnce({
      classification: "block",
      reason: "deletes tracked files",
    });

    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    await expect(
      onPermissionRequest(shellRequest, { sessionId: "test-session" }),
    ).resolves.toEqual({
      kind: "denied-by-permission-request-hook",
      message: "deletes tracked files",
      interrupt: false,
    });
    expect(mocks.log).toHaveBeenCalledWith("classifier result: block (deletes tracked files)", {
      ephemeral: true,
      level: "info",
    });
  });

  it("falls back to normal permission flow when the classifier errors", async () => {
    mocks.classifyShellSafetyWithModel.mockRejectedValueOnce(new Error("classifier unavailable"));

    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    await expect(
      onPermissionRequest(shellRequest, { sessionId: "test-session" }),
    ).resolves.toEqual({
      kind: "no-result",
    });
    expect(mocks.log).toHaveBeenCalledWith("classifier error: classifier unavailable", {
      ephemeral: true,
      level: "error",
    });
  });

  it("approves read and write permission requests directly", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    await expect(
      onPermissionRequest(
        {
          kind: "read",
          path: "src/extension.ts",
          intention: "Inspect extension source",
        },
        { sessionId: "test-session" },
      ),
    ).resolves.toEqual({ kind: "approved" });
    await expect(
      onPermissionRequest(
        {
          kind: "write",
          fileName: "notes.txt",
          diff: "",
          intention: "Create notes",
          canOfferSessionApproval: false,
        },
        { sessionId: "test-session" },
      ),
    ).resolves.toEqual({ kind: "approved" });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("approves read-only MCP permission requests and falls back for mutating MCP requests", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const mcpRequest = {
      kind: "mcp" as const,
      serverName: "github-mcp-server",
      toolName: "get_issue",
      toolTitle: "Get issue",
      args: { owner: "github", repo: "copilot", issue_number: 1 },
      readOnly: true,
    };

    await expect(onPermissionRequest(mcpRequest, { sessionId: "test-session" })).resolves.toEqual({
      kind: "approved",
    });
    await expect(
      onPermissionRequest({ ...mcpRequest, readOnly: false }, { sessionId: "test-session" }),
    ).resolves.toEqual({ kind: "no-result" });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("falls back for other permission request kinds", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    await expect(
      onPermissionRequest(
        {
          kind: "url",
          url: "https://example.com",
          intention: "Fetch documentation",
        },
        { sessionId: "test-session" },
      ),
    ).resolves.toEqual({ kind: "no-result" });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("approves read-only shell requests without invoking the classifier", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const request = createShellPermissionRequest("git status", "Inspect repository status");

    await expect(
      onPermissionRequest(request, { sessionId: "test-session" }),
    ).resolves.toEqual({
      kind: "approved",
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("approves heuristic read-only shell requests without invoking the classifier", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const request = createShellPermissionRequest(
      "grep -n TODO src/extension.ts",
      "Search for TODO comments",
    );

    await expect(
      onPermissionRequest(request, { sessionId: "test-session" }),
    ).resolves.toEqual({
      kind: "approved",
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("falls back to the classifier for path-qualified shell commands", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const command = "./grep -n TODO src/extension.ts";
    const intention = "Search for TODO comments";
    const request = createShellPermissionRequest(command, intention);

    await expect(
      onPermissionRequest(request, { sessionId: "test-session" }),
    ).resolves.toEqual({
      kind: "approved",
    });
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledTimes(1);
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        command,
        intention,
        shellRequest: expect.objectContaining({
          fullCommandText: command,
          intention,
          commands: [
            {
              identifier: "./grep",
              readOnly: false,
              args: ["-n", "TODO", "src/extension.ts"],
            },
          ],
        }),
      }),
      undefined,
    );
  });

  it("approves safe shell redirections to cwd paths without invoking the classifier", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const request = createShellPermissionRequest(
      "grep -n TODO src/extension.ts > logs/grep-output.txt",
      "Capture TODO matches in a local file",
    );

    await expect(
      onPermissionRequest(request, { sessionId: "test-session" }),
    ).resolves.toEqual({
      kind: "approved",
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("hard denies destructive git commands before invoking the classifier", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const request = createShellPermissionRequest(
      "git reset --hard HEAD~1",
      "Discard local changes and rewind HEAD",
    );

    await expect(
      onPermissionRequest(request, { sessionId: "test-session" }),
    ).resolves.toEqual({
      kind: "denied-by-permission-request-hook",
      message: "git reset can rewrite history or overwrite working tree changes.",
      interrupt: false,
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("hard denies force pushes before invoking the classifier", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const request = createShellPermissionRequest(
      "git push --force origin main",
      "Force-push local commits",
    );

    await expect(
      onPermissionRequest(request, { sessionId: "test-session" }),
    ).resolves.toEqual({
      kind: "denied-by-permission-request-hook",
      message: "git push can force-update or delete remote refs.",
      interrupt: false,
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("still falls back to the classifier for non-inspection git commands", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const command = "git push origin feature";
    const intention = "Publish local commits";
    const request = createShellPermissionRequest(command, intention);

    await expect(onPermissionRequest(request, { sessionId: "test-session" })).resolves.toEqual({
      kind: "approved",
    });
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledTimes(1);
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        command,
        intention,
        shellRequest: expect.objectContaining({
          fullCommandText: command,
          intention,
          commands: [
            {
              identifier: "git",
              readOnly: false,
              args: ["push", "origin", "feature"],
            },
          ],
        }),
      }),
      undefined,
    );
  });

  it("falls back to the classifier without parsed metadata for unsupported shell syntax", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const command = "grep TODO $(rm -rf build)";
    const intention = "Search TODOs";
    const request = createShellPermissionRequest(command, intention);

    await expect(onPermissionRequest(request, { sessionId: "test-session" })).resolves.toEqual({
      kind: "approved",
    });
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      expect.not.objectContaining({
        shellRequest: expect.anything(),
      }),
      undefined,
    );
  });

  it("sets the classifier model from an automodel argument", async () => {
    await loadExtensionModule();
    const handleAutomodel = getCommandHandler("automodel");

    await handleAutomodel({ args: "gpt-5-mini" });

    expect(config.classifierModel).toBe("gpt-5-mini");
    expect(mocks.log).toHaveBeenCalledWith("auto mode classifier model set to gpt-5-mini.");
  });

  it("resets the classifier model to the Copilot default", async () => {
    config.classifierModel = "gpt-5-mini";

    await loadExtensionModule();
    const handleAutomodel = getCommandHandler("automodel");

    await handleAutomodel({ args: "reset" });

    expect(config.classifierModel).toBeUndefined();
    expect(mocks.log).toHaveBeenCalledWith(
      "auto mode classifier model reset to Copilot default.",
    );
  });

  it("selects the classifier model interactively when automodel has no argument", async () => {
    await loadExtensionModule();
    const handleAutomodel = getCommandHandler("automodel");

    await handleAutomodel({ args: "" });

    expect(mocks.listClassifierModels).toHaveBeenCalledTimes(1);
    expect(mocks.select).toHaveBeenCalledWith(
      "Select auto mode classifier model (current: Copilot default)",
      ["claude-sonnet-4.5", "gpt-5-mini"],
    );
    expect(config.classifierModel).toBe("gpt-5-mini");
  });

  it("keeps the classifier model unchanged when interactive model listing fails", async () => {
    config.classifierModel = "gpt-5-mini";
    mocks.listClassifierModels.mockRejectedValueOnce(new Error("Client not connected"));

    await loadExtensionModule();
    const handleAutomodel = getCommandHandler("automodel");

    await handleAutomodel({ args: "" });

    expect(config.classifierModel).toBe("gpt-5-mini");
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(
      "auto mode classifier model unchanged. Could not list models: Client not connected",
    );
  });
});
