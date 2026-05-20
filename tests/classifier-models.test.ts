import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const execFile = vi.fn();
  const fetch = vi.fn();

  return {
    execFile,
    fetch,
  };
});

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

async function loadClassifierModelsModule() {
  vi.resetModules();
  return import("../src/classifier-models.js");
}

function clearGitHubAuthEnv() {
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
}

describe("listClassifierModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    clearGitHubAuthEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearGitHubAuthEnv();
  });

  it("lists Copilot models with a gh auth token", async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, "github-token\n", "");
    });
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-5-mini", name: "GPT-5 mini" },
            { id: "claude-sonnet-4.5" },
          ],
          object: "list",
        }),
      ),
    );

    const { listClassifierModels } = await loadClassifierModelsModule();
    const models = await listClassifierModels();

    expect(mocks.execFile).toHaveBeenCalledWith(
      "gh",
      ["auth", "token"],
      expect.objectContaining({
        encoding: "utf8",
        timeout: 10_000,
      }),
      expect.any(Function),
    );
    expect(mocks.fetch).toHaveBeenCalledWith("https://api.githubcopilot.com/models", {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer github-token",
      },
    });
    expect(models.map((model) => model.id)).toEqual(["gpt-5-mini", "claude-sonnet-4.5"]);
    expect(models[0]?.name).toBe("GPT-5 mini");
    expect(models[1]?.name).toBe("claude-sonnet-4.5");
  });

  it("uses GH_TOKEN before shelling out for Copilot model listing", async () => {
    process.env.GH_TOKEN = "env-github-token";
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "gpt-5-mini" }] })));

    const { listClassifierModels } = await loadClassifierModelsModule();
    await listClassifierModels();

    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith("https://api.githubcopilot.com/models", {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer env-github-token",
      },
    });
  });

  it("uses GITHUB_TOKEN for Copilot model listing when GH_TOKEN is unset", async () => {
    process.env.GITHUB_TOKEN = "env-github-token";
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "gpt-5-mini" }] })));

    const { listClassifierModels } = await loadClassifierModelsModule();
    await listClassifierModels();

    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith("https://api.githubcopilot.com/models", {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer env-github-token",
      },
    });
  });

  it("prefers GH_TOKEN over GITHUB_TOKEN for Copilot model listing", async () => {
    process.env.GH_TOKEN = "env-gh-token";
    process.env.GITHUB_TOKEN = "env-github-token";
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "gpt-5-mini" }] })));

    const { listClassifierModels } = await loadClassifierModelsModule();
    await listClassifierModels();

    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith("https://api.githubcopilot.com/models", {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer env-gh-token",
      },
    });
  });

  it("surfaces Copilot model listing errors", async () => {
    process.env.GH_TOKEN = "env-github-token";
    mocks.fetch.mockResolvedValue(new Response("unavailable", { status: 503 }));

    const { listClassifierModels } = await loadClassifierModelsModule();

    await expect(listClassifierModels()).rejects.toThrow(
      "Failed to list models from https://api.githubcopilot.com/models: 503",
    );
  });
});
