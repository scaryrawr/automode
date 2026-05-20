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

type ApiModel = z.infer<typeof ApiModelSchema>;

function getRequiredEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getGitHubAuthToken(): Promise<string> {
  const envToken = getRequiredEnv("GH_TOKEN") ?? getRequiredEnv("GITHUB_TOKEN");
  if (envToken) {
    return Promise.resolve(envToken);
  }

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
  return ApiModelArraySchema.parse(payload);
}

function toModelInfo(model: ApiModel): ModelInfo {
  return {
    id: model.id,
    name: model.name ?? model.id,
    capabilities: DEFAULT_MODEL_CAPABILITIES,
  };
}

async function fetchModels(url: string, headers: Record<string, string>): Promise<ModelInfo[]> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to list models from ${url}: ${response.status} ${response.statusText}`);
  }

  return extractApiModels(await response.json()).map(toModelInfo);
}

export async function listClassifierModels(): Promise<ModelInfo[]> {
  return fetchModels(COPILOT_MODELS_URL, getCopilotHeaders(await getGitHubAuthToken()));
}

function normalizeClassifierModel(model: string | undefined): string | undefined {
  const normalizedModel = model?.trim();
  return normalizedModel ? normalizedModel : undefined;
}

export function resolveClassifierModel(model: string | undefined): string | undefined {
  return normalizeClassifierModel(model);
}
