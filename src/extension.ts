import { joinSession } from "@github/copilot-sdk/extension";
import { classifyShellSafetyWithModel, closeClassifierClient } from "./classifier.js";
import { createAutoCommand } from "./commands/auto.js";
import { createAutomodelCommand } from "./commands/automodel.js";
import { loadConfig } from "./config.js";
import { createPreToolUseHandler } from "./pre-tool-policy.js";

const config = await loadConfig();
let session: Awaited<ReturnType<typeof joinSession>>;

session = await joinSession({
  commands: [
    createAutoCommand({ config, getSession: () => session }),
    createAutomodelCommand({ config, getSession: () => session }),
  ],
  hooks: {
    onPreToolUse: createPreToolUseHandler({
      config,
      classifyShellSafetyWithModel,
      logger: {
        log: (...args) => session.log(...args),
      },
    }),
  },
});

session.on("session.shutdown", async (): Promise<void> => {
  await closeClassifierClient();
});
