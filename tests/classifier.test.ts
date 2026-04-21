import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const createSession = vi.fn();
  const deleteSession = vi.fn();
  const stop = vi.fn();
  const sendAndWait = vi.fn();
  const disconnect = vi.fn();
  const approveAll = vi.fn();
  const CopilotClient = vi.fn(function MockCopilotClient() {
    return {
      createSession,
      deleteSession,
      stop,
    };
  });

  return {
    CopilotClient,
    approveAll,
    createSession,
    deleteSession,
    disconnect,
    sendAndWait,
    stop,
  };
});

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: mocks.CopilotClient,
  approveAll: mocks.approveAll,
}));

async function loadClassifierModule() {
  vi.resetModules();
  return import("../src/classifier.js");
}

describe("classifyShellSafetyWithModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.CopilotClient.mockImplementation(function MockCopilotClient() {
      return {
        createSession: mocks.createSession,
        deleteSession: mocks.deleteSession,
        stop: mocks.stop,
      };
    });
    mocks.createSession.mockResolvedValue({
      sessionId: "classifier-session",
      disconnect: mocks.disconnect,
      sendAndWait: mocks.sendAndWait,
    });
    mocks.deleteSession.mockResolvedValue(undefined);
    mocks.disconnect.mockResolvedValue(undefined);
    mocks.sendAndWait.mockResolvedValue(undefined);
    mocks.stop.mockResolvedValue([]);
  });

  it("deletes the nested classifier session after a successful classification", async () => {
    const cleanupOrder: string[] = [];
    mocks.disconnect.mockImplementation(async () => {
      cleanupOrder.push("disconnect");
    });
    mocks.deleteSession.mockImplementation(async () => {
      cleanupOrder.push("delete");
    });
    mocks.sendAndWait.mockImplementation(async () => {
      const [config] = mocks.createSession.mock.calls.at(-1) ?? [];
      await config.tools[0].handler({ decision: "safe", reason: "read-only command" });
    });

    const { classifyShellSafetyWithModel } = await loadClassifierModule();
    const result = await classifyShellSafetyWithModel("git status");

    expect(result).toEqual({
      decision: "safe",
      reason: "read-only command",
    });
    expect(mocks.deleteSession).toHaveBeenCalledWith("classifier-session");
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(cleanupOrder).toEqual(["disconnect", "delete"]);
  });

  it("deletes the nested classifier session when classification fails", async () => {
    mocks.sendAndWait.mockRejectedValue(new Error("classifier timeout"));

    const { classifyShellSafetyWithModel } = await loadClassifierModule();

    await expect(classifyShellSafetyWithModel("npm install")).rejects.toThrow("classifier timeout");
    expect(mocks.deleteSession).toHaveBeenCalledWith("classifier-session");
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });
});
