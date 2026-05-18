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

function clearProviderEnv() {
  delete process.env.COPILOT_MODEL;
  delete process.env.COPILOT_PROVIDER_API_KEY;
  delete process.env.COPILOT_PROVIDER_BASE_URL;
  delete process.env.COPILOT_PROVIDER_BEARER_TOKEN;
  delete process.env.COPILOT_PROVIDER_MODEL_ID;
  delete process.env.COPILOT_PROVIDER_TYPE;
  delete process.env.COPILOT_PROVIDER_WIRE_MODEL;
}

describe("listClassifierModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    clearProviderEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearProviderEnv();
  });

  it("lists models from the configured OpenAI-compatible provider", async () => {
    process.env.COPILOT_PROVIDER_BASE_URL = "http://localhost:11434/v1";
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "qwen2.5-coder:latest" }, { id: "llama3.2", name: "Llama 3.2" }],
        }),
      ),
    );

    const { listClassifierModels } = await loadClassifierModelsModule();
    const models = await listClassifierModels();

    expect(mocks.fetch).toHaveBeenCalledWith("http://localhost:11434/v1/models", {
      headers: { Accept: "application/json" },
    });
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(models.map((model) => model.id)).toEqual(["qwen2.5-coder:latest", "llama3.2"]);
    expect(models[0]?.name).toBe("qwen2.5-coder:latest");
    expect(models[1]?.name).toBe("Llama 3.2");
  });

  it("uses provider credentials when listing custom provider models", async () => {
    process.env.COPILOT_PROVIDER_BASE_URL = "https://models.example.test";
    process.env.COPILOT_PROVIDER_API_KEY = "provider-token";
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [{ id: "gpt-4.1" }],
        }),
      ),
    );

    const { listClassifierModels } = await loadClassifierModelsModule();
    await listClassifierModels();

    expect(mocks.fetch).toHaveBeenCalledWith("https://models.example.test/v1/models", {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer provider-token",
      },
    });
  });

  it("adds configured provider model env values to provider model results", async () => {
    process.env.COPILOT_PROVIDER_BASE_URL = "http://localhost:11434/v1";
    process.env.COPILOT_MODEL = "deepseek-coder-v2:16b";
    process.env.COPILOT_PROVIDER_MODEL_ID = "gpt-5.4";
    process.env.COPILOT_PROVIDER_WIRE_MODEL = "azure-deployment-name";
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "deepseek-coder-v2:16b" }, { id: "llama3.2" }],
        }),
      ),
    );

    const { listClassifierModels } = await loadClassifierModelsModule();
    const models = await listClassifierModels();

    expect(models.map((model) => model.id)).toEqual([
      "deepseek-coder-v2:16b",
      "llama3.2",
      "gpt-5.4",
    ]);
  });

  it("uses configured provider model env values when provider listing fails", async () => {
    process.env.COPILOT_PROVIDER_BASE_URL = "http://localhost:11434/v1";
    process.env.COPILOT_MODEL = "deepseek-coder-v2:16b";
    process.env.COPILOT_PROVIDER_MODEL_ID = "gpt-5.4";
    mocks.fetch.mockResolvedValue(new Response("unavailable", { status: 503 }));

    const { listClassifierModels } = await loadClassifierModelsModule();
    const models = await listClassifierModels();

    expect(models.map((model) => model.id)).toEqual(["gpt-5.4", "deepseek-coder-v2:16b"]);
  });

  it("surfaces provider listing errors when no env fallback is configured", async () => {
    process.env.COPILOT_PROVIDER_BASE_URL = "http://localhost:11434/v1";
    mocks.fetch.mockResolvedValue(new Response("unavailable", { status: 503 }));

    const { listClassifierModels } = await loadClassifierModelsModule();

    await expect(listClassifierModels()).rejects.toThrow(
      "Failed to list models from http://localhost:11434/v1/models: 503",
    );
  });

  it("lists Copilot models with a gh auth token when no custom provider is configured", async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, "github-token\n", "");
    });
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: "gpt-5-mini", name: "GPT-5 mini" },
          { id: "claude-sonnet-4.5" },
        ]),
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
  });
});
