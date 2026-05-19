import { joinSession } from "@github/copilot-sdk/extension";
import { classifyShellSafetyWithModel, closeClassifierClient } from "./classifier.js";
import { createAutoCommand } from "./commands/auto.js";
import { createAutomodelCommand } from "./commands/automodel.js";
import { loadConfig } from "./config.js";
import { createPreToolUseHandler } from "./pre-tool-policy.js";

const config = await loadConfig();
let session: Awaited<ReturnType<typeof joinSession>>;
const latestUserPrompts = new Map<string, string>();

type SessionPromptInput = {
  sessionId?: string;
  initialPrompt?: string;
};

type UserPromptInput = {
  sessionId?: string;
  prompt: string;
};

type HookInvocation = {
  sessionId: string;
};

function rememberInitialPrompt(input: SessionPromptInput, invocation?: HookInvocation): void {
  const sessionId = input.sessionId ?? invocation?.sessionId;
  if (sessionId !== undefined && input.initialPrompt !== undefined) {
    latestUserPrompts.set(sessionId, input.initialPrompt);
  }
}

function rememberLatestUserPrompt(input: UserPromptInput, invocation?: HookInvocation): void {
  const sessionId = input.sessionId ?? invocation?.sessionId;
  if (sessionId !== undefined) {
    latestUserPrompts.set(sessionId, input.prompt);
  }
}

session = await joinSession({
  commands: [
    createAutoCommand({ config, getSession: () => session }),
    createAutomodelCommand({ config, getSession: () => session }),
  ],
  hooks: {
    onSessionStart: async (input, invocation) => {
      rememberInitialPrompt(input, invocation);
    },
    onUserPromptSubmitted: async (input, invocation) => {
      rememberLatestUserPrompt(input, invocation);
    },
    onPreToolUse: createPreToolUseHandler({
      config,
      classifyShellSafetyWithModel,
      getLatestUserPrompt: (sessionId) => latestUserPrompts.get(sessionId),
      logger: {
        log: (...args) => session.log(...args),
      },
    }),
  },
});

session.on("session.shutdown", async (): Promise<void> => {
  latestUserPrompts.clear();
  await closeClassifierClient();
});
