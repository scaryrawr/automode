import { listClassifierModels } from "../classifier-models.js";
import { formatClassifierModel } from "./model-formatting.js";
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
        await session.log(
          `auto mode classifier model: ${formatClassifierModel(config.classifierModel)}.`,
        );
        return;
      }

      if (action === "default" || action === "reset" || action === "clear") {
        config.classifierModel = undefined;
        await session.log("auto mode classifier model reset to Copilot default.");
        return;
      }

      if (arg) {
        config.classifierModel = arg;
        await session.log(`auto mode classifier model set to ${arg}.`);
        return;
      }

      if (!session.capabilities.ui?.elicitation) {
        await session.log(
          "auto mode classifier model unchanged. Use /automodel <model-id> to set it, or /automodel reset to use the Copilot default.",
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
        await session.log("auto mode classifier model unchanged. No Copilot models are available.");
        return;
      }

      const selectionPrompt = `Select auto mode classifier model (current: ${formatClassifierModel(config.classifierModel)})`;
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
