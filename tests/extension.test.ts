import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const joinSession = vi.fn();
  const loadConfig = vi.fn();
  const classifyShellSafetyWithModel = vi.fn();
  const closeClassifierClient = vi.fn();
  const log = vi.fn();
  const on = vi.fn();

  return {
    classifyShellSafetyWithModel,
    closeClassifierClient,
    joinSession,
    loadConfig,
    log,
    on,
  };
});

vi.mock("@github/copilot-sdk/extension", () => ({
  joinSession: mocks.joinSession,
}));

vi.mock("../src/classifier.js", () => ({
  classifyShellSafetyWithModel: mocks.classifyShellSafetyWithModel,
  closeClassifierClient: mocks.closeClassifierClient,
}));

vi.mock("../src/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

async function loadExtensionModule() {
  vi.resetModules();
  delete process.env.CLASSIFIER_SESSION;
  return import("../src/extension.js");
}

function getPermissionHandler() {
  const [config] = mocks.joinSession.mock.calls.at(-1) ?? [];
  return config.onPermissionRequest as (request: unknown) => Promise<unknown>;
}

describe("extension permission hook", () => {
  const shellRequest = {
    kind: "shell" as const,
    fullCommandText: "npm test -- --runInBand",
    intention: "Run the test suite",
    commands: [{ identifier: "npm", readOnly: false }],
    possiblePaths: ["./package.json"],
    possibleUrls: [{ url: "https://registry.npmjs.org/" }],
    hasWriteFileRedirection: false,
    canOfferSessionApproval: true,
    warning: "May execute project scripts",
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.loadConfig.mockResolvedValue({ autoMode: true });
    mocks.classifyShellSafetyWithModel.mockResolvedValue({
      decision: "safe",
      reason: "non-destructive command",
    });
    mocks.joinSession.mockResolvedValue({
      log: mocks.log,
      on: mocks.on,
    });
    mocks.log.mockResolvedValue(undefined);
    mocks.on.mockReturnValue(undefined);
    mocks.closeClassifierClient.mockResolvedValue(undefined);
  });

  it("passes fullCommandText to the classifier and approves safe commands", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    await expect(onPermissionRequest(shellRequest)).resolves.toEqual({ kind: "approved" });

    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledTimes(1);
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(shellRequest.fullCommandText);
  });

  it("returns no-result for unsafe shell classifications", async () => {
    mocks.classifyShellSafetyWithModel.mockResolvedValueOnce({
      decision: "unsafe",
      reason: "requires user review",
    });

    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    await expect(onPermissionRequest(shellRequest)).resolves.toEqual({ kind: "no-result" });
  });

  it("denies dangerous shell classifications with the classifier reason", async () => {
    mocks.classifyShellSafetyWithModel.mockResolvedValueOnce({
      decision: "dangerous",
      reason: "deletes tracked files",
    });

    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    await expect(onPermissionRequest(shellRequest)).resolves.toEqual({
      kind: "denied-by-permission-request-hook",
      message: "deletes tracked files",
      interrupt: false,
    });
  });

  it("falls back to no-result when the classifier errors", async () => {
    mocks.classifyShellSafetyWithModel.mockRejectedValueOnce(new Error("classifier unavailable"));

    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    await expect(onPermissionRequest(shellRequest)).resolves.toEqual({ kind: "no-result" });
  });

  it("approves read-only shell requests without invoking the classifier", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const request = {
      kind: "shell" as const,
      fullCommandText: "git status",
      intention: "Inspect repository status",
      commands: [{ identifier: "git", readOnly: true }],
      possiblePaths: ["."],
      possibleUrls: [],
      hasWriteFileRedirection: false,
      canOfferSessionApproval: false,
    };

    await expect(Promise.resolve(onPermissionRequest(request))).resolves.toEqual({
      kind: "approved",
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("approves heuristic read-only shell requests without invoking the classifier", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const request = {
      ...shellRequest,
      fullCommandText: "grep -n TODO src/extension.ts",
      intention: "Search for TODO comments",
      commands: [{ identifier: "grep", readOnly: false, args: ["-n", "TODO", "src/extension.ts"] }],
      possiblePaths: ["src/extension.ts"],
      possibleUrls: [],
      hasWriteFileRedirection: false,
      canOfferSessionApproval: false,
      warning: undefined,
    };

    await expect(Promise.resolve(onPermissionRequest(request))).resolves.toEqual({
      kind: "approved",
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("approves safe shell redirections to cwd paths without invoking the classifier", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const request = {
      ...shellRequest,
      fullCommandText: "grep -n TODO src/extension.ts > logs/grep-output.txt",
      intention: "Capture TODO matches in a local file",
      commands: [{ identifier: "grep", readOnly: false, args: ["-n", "TODO", "src/extension.ts"] }],
      possiblePaths: ["logs/grep-output.txt"],
      possibleUrls: [],
      hasWriteFileRedirection: true,
      canOfferSessionApproval: false,
      warning: undefined,
    };

    await expect(Promise.resolve(onPermissionRequest(request))).resolves.toEqual({
      kind: "approved",
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("hard denies destructive git commands before invoking the classifier", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const request = {
      ...shellRequest,
      fullCommandText: "git reset --hard HEAD~1",
      intention: "Discard local changes and rewind HEAD",
      commands: [{ identifier: "git", readOnly: false, args: ["reset", "--hard", "HEAD~1"] }],
      possiblePaths: ["."],
      possibleUrls: [],
      hasWriteFileRedirection: false,
      canOfferSessionApproval: false,
      warning: "Rewrites working tree state",
    };

    await expect(Promise.resolve(onPermissionRequest(request))).resolves.toEqual({
      kind: "denied-by-permission-request-hook",
      message: "git reset can rewrite history or overwrite working tree changes.",
      interrupt: false,
    });
    expect(mocks.classifyShellSafetyWithModel).not.toHaveBeenCalled();
  });

  it("still falls back to the classifier for non-inspection git commands", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const request = {
      ...shellRequest,
      fullCommandText: "git push origin main",
      intention: "Publish local commits",
      commands: [{ identifier: "git", readOnly: false, args: ["push", "origin", "main"] }],
      possiblePaths: ["."],
      possibleUrls: [],
      hasWriteFileRedirection: false,
      canOfferSessionApproval: false,
      warning: "Updates a remote repository",
    };

    await expect(onPermissionRequest(request)).resolves.toEqual({
      kind: "approved",
    });
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledTimes(1);
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(request.fullCommandText);
  });

  it("tolerates a null warning field and still invokes the classifier", async () => {
    await loadExtensionModule();
    const onPermissionRequest = getPermissionHandler();

    const requestWithNullWarning = {
      ...shellRequest,
      warning: null,
    };

    await expect(onPermissionRequest(requestWithNullWarning)).resolves.toEqual({
      kind: "approved",
    });
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledTimes(1);
    expect(mocks.classifyShellSafetyWithModel).toHaveBeenCalledWith(
      requestWithNullWarning.fullCommandText,
    );
  });
});
