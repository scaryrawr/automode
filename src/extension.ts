import type { CommandContext, PermissionRequestResult } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";
import { classifyShellSafetyWithModel, closeClassifierClient } from "./classifier.js";
import { loadConfig } from "./config.js";
import { getShellFastPathDecision } from "./shell-safety.js";
import { MCPPermissionRequestSchema, ShellPermissionRequestSchema } from "./types.js";

const config = await loadConfig();

const session = await joinSession({
  commands: [
    {
      name: "auto",
      description: "Enable, disable, or show auto mode status",
      handler: async (context: CommandContext): Promise<void> => {
        const action = context.args.trim().toLowerCase();

        if (!action || action === "on" || action === "enable") {
          config.autoMode = true;
          await session.log("auto mode enabled.");
          return;
        }

        if (action === "show" || action === "status") {
          await session.log(`auto mode is ${config.autoMode ? "enabled" : "disabled"}.`);
          return;
        }

        if (action === "off" || action === "disable") {
          config.autoMode = false;
          await session.log("auto mode disabled.");
          return;
        }
      },
    },
  ],
  onPermissionRequest: (request) => {
    if (!config.autoMode) {
      return { kind: "no-result" };
    }

    switch (request.kind) {
      case "mcp": {
        const mcpRequestParse = MCPPermissionRequestSchema.safeParse(request);
        if (mcpRequestParse.data?.readOnly) {
          // approve all readOnly actions by default
          return { kind: "approved" };
        }

        return { kind: "no-result" };
      }
      case "read":
        return { kind: "approved" };
      case "write":
        return { kind: "approved" };
      case "shell": {
        const shellRequestParse = ShellPermissionRequestSchema.safeParse(request);
        if (!shellRequestParse.success) {
          return { kind: "no-result" };
        }

        const shellRequest = shellRequestParse.data;
        const fastPathDecision = getShellFastPathDecision(shellRequest);
        switch (fastPathDecision.kind) {
          case "approved":
            return { kind: "approved" };
          case "denied":
            return {
              kind: "denied-by-permission-request-hook",
              message: fastPathDecision.reason,
              interrupt: false,
            };
          default:
            break;
        }

        return classifyShellSafetyWithModel(shellRequest.fullCommandText)
          .then((classification): PermissionRequestResult => {
            session.log(
              `classifier decision: ${classification.decision}\nreason: ${classification.reason}\nintent: ${shellRequest.intention}`,
              { ephemeral: true, level: "info" },
            );
            switch (classification.decision) {
              case "safe":
                return { kind: "approved" };
              case "dangerous":
                return {
                  kind: "denied-by-permission-request-hook",
                  message: classification.reason,
                  interrupt: false,
                };
              case "unsafe":
                return {
                  kind: "no-result",
                };
              default:
                return { kind: "no-result" };
            }
          })
          .catch((err): PermissionRequestResult => {
            session.log(`classifier error: ${(err as Error).message}`, {
              ephemeral: true,
              level: "error",
            });

            return { kind: "no-result" };
          });
      }
      default:
        return {
          kind: "no-result",
        };
    }
  },
});

session.on("session.shutdown", async (): Promise<void> => {
  await closeClassifierClient();
});
