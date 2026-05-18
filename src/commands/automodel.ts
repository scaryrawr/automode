import { getClassifierProviderContext, listClassifierModels } from "../classifier-models.js";
import { formatClassifierModel, formatProviderContext } from "./model-formatting.js";
import type { CommandFactoryOptions, ExtensionCommand } from "./types.js";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAutomodelCommand({
  config,
  getSession,
}: CommandFactoryOptions): ExtensionCommand {
  return {
    name: "automodel",
    description: "Set or show the auto mode classifier model",
    handler: async (context): Promise<void> => {
      const arg = context.args.trim();
      const action = arg.toLowerCase();
      const session = getSession();

      if (action === "show" || action === "status") {
        const providerContext = getClassifierProviderContext();
        await session.log(
          `auto mode classifier model: ${formatClassifierModel(config.classifierModel, providerContext)}; provider: ${formatProviderContext(providerContext)}.`,
        );
        return;
      }

      if (action === "default" || action === "reset" || action === "clear") {
        config.classifierModel = undefined;
        const providerContext = getClassifierProviderContext();
        await session.log(
          providerContext.isCustomProvider
            ? `auto mode classifier model reset; provider fallback is ${formatClassifierModel(undefined, providerContext)}.`
            : "auto mode classifier model reset to Copilot default.",
        );
        return;
      }

      if (arg) {
        config.classifierModel = arg;
        await session.log(`auto mode classifier model set to ${arg}.`);
        return;
      }

      const providerContext = getClassifierProviderContext();
      if (!session.capabilities.ui?.elicitation) {
        await session.log(
          providerContext.isCustomProvider
            ? "auto mode classifier model unchanged. Use /automodel <model-id> to set it, or /automodel reset to use the configured provider fallback."
            : "auto mode classifier model unchanged. Use /automodel <model-id> to set it, or /automodel reset to use the Copilot default.",
        );
        return;
      }

      let models;
      try {
        models = await listClassifierModels();
      } catch (error) {
        await session.log(
          `auto mode classifier model unchanged. Could not list models: ${getErrorMessage(error)}`,
        );
        return;
      }

      const modelOptions = [...new Set(models.map((model) => model.id))].sort((a, b) =>
        a.localeCompare(b),
      );

      if (modelOptions.length === 0) {
        await session.log(
          `auto mode classifier model unchanged. No ${formatProviderContext(providerContext)} models are available.`,
        );
        return;
      }

      const selectionPrompt = providerContext.isCustomProvider
        ? `Select auto mode classifier model from ${formatProviderContext(providerContext)} (current: ${formatClassifierModel(config.classifierModel, providerContext)})`
        : `Select auto mode classifier model (current: ${formatClassifierModel(config.classifierModel, providerContext)})`;
      const selectedModel = await session.ui.select(selectionPrompt, modelOptions);

      if (!selectedModel) {
        await session.log("auto mode classifier model unchanged.");
        return;
      }

      config.classifierModel = selectedModel;
      await session.log(`auto mode classifier model set to ${selectedModel}.`);
    },
  };
}
