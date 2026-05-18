import type { CommandContext } from "@github/copilot-sdk";
import type { Configuration } from "../config.js";

export type ExtensionCommand = {
  name: string;
  description: string;
  handler: (context: CommandContext) => Promise<void>;
};

export type CommandSession = {
  capabilities: {
    ui?: {
      elicitation?: boolean;
    };
  };
  log: (message: string) => Promise<void>;
  ui: {
    select: (prompt: string, options: string[]) => Promise<string | null>;
  };
};

export type CommandFactoryOptions = {
  config: Configuration;
  getSession: () => CommandSession;
};
