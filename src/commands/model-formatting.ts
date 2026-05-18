import {
  getClassifierProviderContext,
  type ClassifierProviderContext,
} from "../classifier-models.js";

export function formatProviderContext(providerContext: ClassifierProviderContext): string {
  if (!providerContext.isCustomProvider) {
    return "Copilot";
  }

  const provider = `custom ${providerContext.providerType} provider`;
  return providerContext.providerHost ? `${provider} at ${providerContext.providerHost}` : provider;
}

export function formatClassifierModel(
  model: string | undefined,
  providerContext = getClassifierProviderContext(),
): string {
  if (model) {
    return model;
  }

  if (providerContext.isCustomProvider) {
    const defaultModel = providerContext.defaultModel;
    return defaultModel
      ? `${defaultModel.id} (from ${defaultModel.source})`
      : "custom provider default (not configured)";
  }

  return "Copilot default";
}
