import { execFile } from "node:child_process";
import type { ModelInfo } from "@github/copilot-sdk";
import { z } from "zod";

const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";
const GH_AUTH_TOKEN_TIMEOUT_MS = 10_000;
const DEFAULT_MODEL_CAPABILITIES: ModelInfo["capabilities"] = {
  supports: {
    vision: false,
    reasoningEffort: false,
  },
  limits: {
    max_context_window_tokens: 0,
  },
};

const ApiModelSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
});

const ApiModelArraySchema = z.array(ApiModelSchema);
const ApiModelDataResponseSchema = z.looseObject({ data: ApiModelArraySchema });
const ApiModelModelsResponseSchema = z.looseObject({ models: ApiModelArraySchema });

type ApiModel = z.infer<typeof ApiModelSchema>;
type ProviderModelEnvSource = "COPILOT_PROVIDER_MODEL_ID" | "COPILOT_MODEL";

export type ProviderModelOption = {
  id: string;
  source: ProviderModelEnvSource;
};

export type ClassifierProviderContext = {
  isCustomProvider: boolean;
  providerType: string;
  providerHost?: string;
  modelOptions: ProviderModelOption[];
  defaultModel?: ProviderModelOption;
};

function getRequiredEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getProviderHost(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }

  try {
    return new URL(baseUrl).host;
  } catch {
    return undefined;
  }
}

function getProviderModelOptions(): ProviderModelOption[] {
  const candidates: ProviderModelOption[] = [
    {
      id: getRequiredEnv("COPILOT_PROVIDER_MODEL_ID") ?? "",
      source: "COPILOT_PROVIDER_MODEL_ID",
    },
    {
      id: getRequiredEnv("COPILOT_MODEL") ?? "",
      source: "COPILOT_MODEL",
    },
  ];
  const seenModelIds = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate.id || seenModelIds.has(candidate.id)) {
      return false;
    }
    seenModelIds.add(candidate.id);
    return true;
  });
}

export function getClassifierProviderContext(): ClassifierProviderContext {
  const providerBaseUrl = getRequiredEnv("COPILOT_PROVIDER_BASE_URL");
  const modelOptions = getProviderModelOptions();
  return {
    isCustomProvider: Boolean(providerBaseUrl),
    providerType: getRequiredEnv("COPILOT_PROVIDER_TYPE") ?? "openai",
    providerHost: getProviderHost(providerBaseUrl),
    modelOptions,
    defaultModel: modelOptions[0],
  };
}

function getProviderModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getProviderHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const bearerToken = getRequiredEnv("COPILOT_PROVIDER_BEARER_TOKEN");
  const apiKey = getRequiredEnv("COPILOT_PROVIDER_API_KEY");
  const providerType = getRequiredEnv("COPILOT_PROVIDER_TYPE") ?? "openai";

  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  } else if (apiKey && providerType === "azure") {
    headers["api-key"] = apiKey;
  } else if (apiKey && providerType === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function getGitHubAuthToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["auth", "token"],
      {
        encoding: "utf8",
        timeout: GH_AUTH_TOKEN_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        const token = stdout.trim();
        if (!token) {
          reject(new Error("gh auth token returned an empty token"));
          return;
        }

        resolve(token);
      },
    );
  });
}

function getCopilotHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function extractApiModels(payload: unknown): ApiModel[] {
  const arrayPayload = ApiModelArraySchema.safeParse(payload);
  if (arrayPayload.success) {
    return arrayPayload.data;
  }

  const dataPayload = ApiModelDataResponseSchema.safeParse(payload);
  if (dataPayload.success) {
    return dataPayload.data.data;
  }

  return ApiModelModelsResponseSchema.parse(payload).models;
}

function toModelInfo(model: ApiModel): ModelInfo {
  return {
    id: model.id,
    name: model.name ?? model.id,
    capabilities: DEFAULT_MODEL_CAPABILITIES,
  };
}

function mergeModelInfos(models: ModelInfo[], modelOptions: ProviderModelOption[]): ModelInfo[] {
  const mergedModels = [...models];
  const seenModelIds = new Set(models.map((model) => model.id));
  for (const modelOption of modelOptions) {
    if (!seenModelIds.has(modelOption.id)) {
      mergedModels.push(toModelInfo({ id: modelOption.id, name: modelOption.id }));
      seenModelIds.add(modelOption.id);
    }
  }
  return mergedModels;
}

async function fetchModels(url: string, headers: Record<string, string>): Promise<ModelInfo[]> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to list models from ${url}: ${response.status} ${response.statusText}`);
  }

  return extractApiModels(await response.json()).map(toModelInfo);
}

export async function listClassifierModels(): Promise<ModelInfo[]> {
  const providerBaseUrl = getRequiredEnv("COPILOT_PROVIDER_BASE_URL");
  if (providerBaseUrl) {
    const providerModelOptions = getProviderModelOptions();
    try {
      return mergeModelInfos(
        await fetchModels(getProviderModelsUrl(providerBaseUrl), getProviderHeaders()),
        providerModelOptions,
      );
    } catch (error) {
      const providerModelFallbacks = mergeModelInfos([], providerModelOptions);
      if (providerModelFallbacks.length > 0) {
        return providerModelFallbacks;
      }
      throw error;
    }
  }

  return fetchModels(COPILOT_MODELS_URL, getCopilotHeaders(await getGitHubAuthToken()));
}

function normalizeClassifierModel(model: string | undefined): string | undefined {
  const normalizedModel = model?.trim();
  return normalizedModel ? normalizedModel : undefined;
}

export function resolveClassifierModel(model: string | undefined): string | undefined {
  const classifierModel = normalizeClassifierModel(model);
  if (classifierModel) {
    return classifierModel;
  }

  const providerContext = getClassifierProviderContext();
  if (!providerContext.isCustomProvider) {
    return undefined;
  }

  if (providerContext.defaultModel) {
    return providerContext.defaultModel.id;
  }

  throw new Error(
    "Custom provider mode requires a classifier model. Set COPILOT_MODEL, COPILOT_PROVIDER_MODEL_ID, or run /automodel <model-id>.",
  );
}
