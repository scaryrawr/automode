import { formatClassifierModel } from "./model-formatting.js";
import type { CommandFactoryOptions, ExtensionCommand } from "./types.js";

export function createAutoCommand({
  config,
  getSession,
}: CommandFactoryOptions): ExtensionCommand {
  return {
    name: "auto",
    description: "Enable, disable, or show auto mode status",
    handler: async (context): Promise<void> => {
      const action = context.args.trim().toLowerCase();
      const session = getSession();

      if (!action || action === "on" || action === "enable") {
        config.autoMode = true;
        await session.log("auto mode enabled.");
        return;
      }

      if (action === "show" || action === "status") {
        await session.log(
          `auto mode is ${config.autoMode ? "enabled" : "disabled"}; classifier model: ${formatClassifierModel(config.classifierModel)}.`,
        );
        return;
      }

      if (action === "off" || action === "disable") {
        config.autoMode = false;
        await session.log("auto mode disabled.");
        return;
      }
    },
  };
}
