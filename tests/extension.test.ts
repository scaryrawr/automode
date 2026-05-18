import type { CommandContext } from "@github/copilot-sdk";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const joinSession = vi.fn();
  const loadConfig = vi.fn();
  const classifyShellSafetyWithModel = vi.fn();
  const closeClassifierClient = vi.fn();
  const getClassifierProviderContext = vi.fn();
  const listClassifierModels = vi.fn();
  const log = vi.fn();
  const on = vi.fn();
  const select = vi.fn();

  return {
    classifyShellSafetyWithModel,
    closeClassifierClient,
    getClassifierProviderContext,
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
  getClassifierProviderContext: mocks.getClassifierProviderContext,
  listClassifierModels: mocks.listClassifierModels,
}));

vi.mock("../src/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

async function loadExtensionModule() {
  vi.resetModules();
  delete process.env.CLASSIFIER_SESSION;
  return import("../src/extension.js");
}

function getPreToolHandler() {
  const [config] = mocks.joinSession.mock.calls.at(-1) ?? [];
  return config.hooks.onPreToolUse as (request: unknown) => Promise<unknown>;
}

function getCommandHandler(commandName: string) {
  const [config] = mocks.joinSession.mock.calls.at(-1) ?? [];
  const command = config.commands.find(
    (candidate: { name: string }) => candidate.name === commandName,
  );
  return command.handler as (context: Pick<CommandContext, "args">) => Promise<void>;
}

describe("extension pre-tool hook", () => {
  let config: { autoMode: boolean; classifierModel?: string };

  function createShellToolInput(command: string, description: string, cwd = "/workspace") {
    return {
      toolName: "bash",
      toolArgs: JSON.stringify({
        command,
        description,
      }),
      timestamp: 1,
      cwd,
    };
  }

  const shellCommand = "npm test -- --runInBand";
  const shellDescription = "Run the test suite";
  const shellToolInput = createShellToolInput(shellCommand, shellDescription);

  const objectShellToolInput = {
    toolName: "bash",
    toolArgs: {
      command: shellCommand,
      description: shellDescription,
    },
    timestamp: 1,
    cwd: "/workspace",
  };

  beforeEach(() => {
    vi.clearAllMocks();

    config = { autoMode: true };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.classifyShellSafetyWithModel.mockResolvedValue({
      classification: "allow",
      reason: "non-destructive command",
    });
    mocks.getClassifierProviderContext.mockReturnValue({
      isCustomProvider: false,
      providerType: "openai",
      modelOptions: [],
      defaultModel: undefined,
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

  it("registers a pre-tool hook instead of a permission request handler", async () => {
    await loadExtensionModule();

    const [joinConfig] = mocks.joinSession.mock.calls.at(-1) ?? [];
    expect(joinConfig.onPermissionRequest).toBeUndefined();
    expect(joinConfig.hooks.onPreToolUse).toBeTypeOf("function");
  });

  it("falls back to normal permission flow when auto mode is disabled", async () => {
    config.autoMode = false;

    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    await expect(onPreToolUse(shellToolInput)).resolves.toBeUndefined();
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("passes command and intention to the classifier and approves allowed commands", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    await expect(onPreToolUse(shellToolInput)).resolves.toEqual({ permissionDecision: "allow" });

    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledTimes(1);
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      {
        command: shellCommand,
        intention: shellDescription,
      },
      undefined,
    );
  });

  it("accepts object shell arguments for compatibility with direct hook tests", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    await expect(onPreToolUse(objectShellToolInput)).resolves.toEqual({
      permissionDecision: "allow",
    });

    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      {
        command: shellCommand,
        intention: shellDescription,
      },
      undefined,
    );
  });

  it("passes the configured classifier model to shell classifications", async () => {
    config.classifierModel = "gpt-5-mini";

    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    await expect(onPreToolUse(shellToolInput)).resolves.toEqual({ permissionDecision: "allow" });

    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      {
        command: shellCommand,
        intention: shellDescription,
      },
      "gpt-5-mini",
    );
  });

  it("uses classifier model changes made after registration", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    config.classifierModel = "claude-sonnet-4.5";

    await expect(onPreToolUse(shellToolInput)).resolves.toEqual({ permissionDecision: "allow" });

    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      {
        command: shellCommand,
        intention: shellDescription,
      },
      "claude-sonnet-4.5",
    );
  });

  it("denies blocked shell classifications with a default reason", async () => {
    mocks.classifyShellSafetyWithModel.mockResolvedValueOnce({
      classification: "block",
    });

    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    await expect(onPreToolUse(shellToolInput)).resolves.toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "Blocked by safety classifier.",
    });
  });

  it("denies blocked shell classifications with the classifier reason", async () => {
    mocks.classifyShellSafetyWithModel.mockResolvedValueOnce({
      classification: "block",
      reason: "deletes tracked files",
    });

    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    await expect(onPreToolUse(shellToolInput)).resolves.toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "deletes tracked files",
    });
  });

  it("falls back to normal permission flow when the classifier errors", async () => {
    mocks.classifyShellSafetyWithModel.mockRejectedValueOnce(new Error("classifier unavailable"));

    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    await expect(onPreToolUse(shellToolInput)).resolves.toBeUndefined();
  });

  it("approves read and write tools directly", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    for (const toolName of [
      "view",
      "read",
      "edit",
      "create",
      "apply_patch",
      "functions.view",
      "functions.edit",
    ]) {
      await expect(
        onPreToolUse({
          toolName,
          toolArgs: { path: "src/extension.ts" },
          timestamp: 1,
          cwd: "/workspace",
        }),
      ).resolves.toEqual({ permissionDecision: "allow" });
    }

    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("does not approve non-built-in tools by suffix alone", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    await expect(
      onPreToolUse({
        toolName: "custom-server.view",
        toolArgs: { path: "src/extension.ts" },
        timestamp: 1,
        cwd: "/workspace",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not approve MCP pre-tool calls without read-only metadata", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    await expect(
      onPreToolUse({
        toolName: "github-mcp-server.get_issue",
        toolArgs: { owner: "github", repo: "copilot", issue_number: 1 },
        timestamp: 1,
        cwd: "/workspace",
      }),
    ).resolves.toBeUndefined();
  });

  it("approves read-only shell requests without invoking the classifier", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    const request = createShellToolInput("git status", "Inspect repository status");

    await expect(Promise.resolve(onPreToolUse(request))).resolves.toEqual({
      permissionDecision: "allow",
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("approves heuristic read-only shell requests without invoking the classifier", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    const request = createShellToolInput(
      "grep -n TODO src/extension.ts",
      "Search for TODO comments",
    );

    await expect(Promise.resolve(onPreToolUse(request))).resolves.toEqual({
      permissionDecision: "allow",
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("falls back to the classifier for path-qualified shell commands", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    const command = "./grep -n TODO src/extension.ts";
    const description = "Search for TODO comments";
    const request = createShellToolInput(command, description);

    await expect(Promise.resolve(onPreToolUse(request))).resolves.toEqual({
      permissionDecision: "allow",
    });
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledTimes(1);
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      {
        command,
        intention: description,
      },
      undefined,
    );
  });

  it("approves safe shell redirections to cwd paths without invoking the classifier", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    const request = createShellToolInput(
      "grep -n TODO src/extension.ts > logs/grep-output.txt",
      "Capture TODO matches in a local file",
    );

    await expect(Promise.resolve(onPreToolUse(request))).resolves.toEqual({
      permissionDecision: "allow",
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("uses pre-tool cwd when approving relative shell redirections", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    const shellCwd = path.join(path.dirname(process.cwd()), "automode-shell-cwd");
    const request = createShellToolInput(
      `grep -n TODO src/extension.ts > ../${path.basename(shellCwd)}/logs/grep-output.txt`,
      "Capture TODO matches in a local file",
      shellCwd,
    );

    await expect(Promise.resolve(onPreToolUse(request))).resolves.toEqual({
      permissionDecision: "allow",
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("falls back when a relative redirection escapes the pre-tool cwd", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    const command = `grep -n TODO src/extension.ts > ../${path.basename(process.cwd())}/logs/grep-output.txt`;
    const description = "Capture TODO matches outside the shell cwd";
    const shellCwd = path.join(path.dirname(process.cwd()), "automode-shell-cwd");
    const request = createShellToolInput(command, description, shellCwd);

    await expect(Promise.resolve(onPreToolUse(request))).resolves.toEqual({
      permissionDecision: "allow",
    });
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledTimes(1);
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      {
        command,
        intention: description,
      },
      undefined,
    );
  });

  it("hard denies destructive git commands before invoking the classifier", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    const request = createShellToolInput(
      "git reset --hard HEAD~1",
      "Discard local changes and rewind HEAD",
    );

    await expect(Promise.resolve(onPreToolUse(request))).resolves.toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "git reset can rewrite history or overwrite working tree changes.",
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("hard denies force pushes before invoking the classifier", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    const request = createShellToolInput("git push --force origin main", "Force-push local commits");

    await expect(Promise.resolve(onPreToolUse(request))).resolves.toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "git push can force-update or delete remote refs.",
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("still falls back to the classifier for non-inspection git commands", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    const command = "git push origin main";
    const description = "Publish local commits";
    const request = createShellToolInput(command, description);

    await expect(onPreToolUse(request)).resolves.toEqual({
      permissionDecision: "allow",
    });
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledTimes(1);
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      {
        command,
        intention: description,
      },
      undefined,
    );
  });

  it("ignores permission request metadata that is not part of pre-tool hook input", async () => {
    await loadExtensionModule();
    const onPreToolUse = getPreToolHandler();

    const embeddedShellRequest = {
      kind: "shell" as const,
      fullCommandText: "npm test -- --runInBand",
      intention: "Run the test suite",
      commands: [{ identifier: "npm", readOnly: false }],
      possiblePaths: ["./package.json"],
      possibleUrls: [{ url: "https://registry.npmjs.org/" }],
      hasWriteFileRedirection: false,
      canOfferSessionApproval: true,
      warning: null,
    };

    await expect(
      onPreToolUse({
        ...shellToolInput,
        permissionRequest: embeddedShellRequest,
      }),
    ).resolves.toEqual({
      permissionDecision: "allow",
    });
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledTimes(1);
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      {
        command: shellCommand,
        intention: shellDescription,
      },
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

  it("shows provider fallback model when automodel status runs in provider mode", async () => {
    mocks.getClassifierProviderContext.mockReturnValue({
      isCustomProvider: true,
      providerType: "openai",
      providerHost: "localhost:11434",
      modelOptions: [{ id: "deepseek-coder-v2:16b", source: "COPILOT_MODEL" }],
      defaultModel: { id: "deepseek-coder-v2:16b", source: "COPILOT_MODEL" },
    });

    await loadExtensionModule();
    const handleAutomodel = getCommandHandler("automodel");

    await handleAutomodel({ args: "status" });

    expect(mocks.log).toHaveBeenCalledWith(
      "auto mode classifier model: deepseek-coder-v2:16b (from COPILOT_MODEL); provider: custom openai provider at localhost:11434.",
    );
  });

  it("describes provider fallback when automodel reset runs in provider mode", async () => {
    config.classifierModel = "gpt-5-mini";
    mocks.getClassifierProviderContext.mockReturnValue({
      isCustomProvider: true,
      providerType: "openai",
      providerHost: "localhost:11434",
      modelOptions: [{ id: "deepseek-coder-v2:16b", source: "COPILOT_MODEL" }],
      defaultModel: { id: "deepseek-coder-v2:16b", source: "COPILOT_MODEL" },
    });

    await loadExtensionModule();
    const handleAutomodel = getCommandHandler("automodel");

    await handleAutomodel({ args: "reset" });

    expect(config.classifierModel).toBeUndefined();
    expect(mocks.log).toHaveBeenCalledWith(
      "auto mode classifier model reset; provider fallback is deepseek-coder-v2:16b (from COPILOT_MODEL).",
    );
  });

  it("labels the interactive automodel picker with the active provider", async () => {
    mocks.getClassifierProviderContext.mockReturnValue({
      isCustomProvider: true,
      providerType: "openai",
      providerHost: "localhost:11434",
      modelOptions: [{ id: "deepseek-coder-v2:16b", source: "COPILOT_MODEL" }],
      defaultModel: { id: "deepseek-coder-v2:16b", source: "COPILOT_MODEL" },
    });
    mocks.listClassifierModels.mockResolvedValue([
      { id: "deepseek-coder-v2:16b", name: "deepseek-coder-v2:16b", capabilities: {} },
      { id: "llama3.2", name: "llama3.2", capabilities: {} },
    ]);
    mocks.select.mockResolvedValue("llama3.2");

    await loadExtensionModule();
    const handleAutomodel = getCommandHandler("automodel");

    await handleAutomodel({ args: "" });

    expect(mocks.select).toHaveBeenCalledWith(
      "Select auto mode classifier model from custom openai provider at localhost:11434 (current: deepseek-coder-v2:16b (from COPILOT_MODEL))",
      ["deepseek-coder-v2:16b", "llama3.2"],
    );
    expect(config.classifierModel).toBe("llama3.2");
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
