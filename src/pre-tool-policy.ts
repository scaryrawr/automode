import type { Configuration } from "./config.js";
import {
  createShellPermissionRequestFromCommandText,
  getShellFastPathDecision,
} from "./shell-safety.js";
import {
  PreToolUseInputSchema,
  ShellToolArgsSchema,
  type PreToolUseHookOutput,
  type ShellPermissionRequest,
} from "./types.js";

const SHELL_TOOL_NAMES = new Set(["bash", "shell"]);

type ShellSafetyClassification = {
  classification: "allow" | "block";
  reason?: string;
};

type ClassifyShellSafety = (
  input: {
    command: string;
    intention: string;
    latestUserPrompt?: string | undefined;
    shellRequest?: ShellPermissionRequest | undefined;
  },
  model?: string,
) => Promise<ShellSafetyClassification>;

type PreToolPolicyOptions = {
  config: Configuration;
  classifyShellSafetyWithModel: ClassifyShellSafety;
  getLatestUserPrompt?: (sessionId: string) => string | undefined;
  logger: Logger;
};

type HookInvocation = {
  sessionId: string;
};

type Logger = {
  log: (
    message: string,
    options?: { ephemeral?: boolean; level?: "info" | "warning" | "error" },
  ) => Promise<void> | void;
};

function getNormalizedToolName(toolName: string): string {
  return toolName.startsWith("functions.") ? toolName.slice("functions.".length) : toolName;
}

function approveToolUse(): PreToolUseHookOutput {
  return { permissionDecision: "allow" };
}

function denyToolUse(reason: string | undefined): PreToolUseHookOutput {
  return {
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  };
}

function getClassifierDenialMessage(reason: string | undefined): string {
  return reason?.trim() || "Blocked by safety classifier.";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleShellPreToolRequest(
  command: string,
  intention: string,
  shellRequest: Awaited<ReturnType<typeof createShellPermissionRequestFromCommandText>>,
  latestUserPrompt: string | undefined,
  { config, classifyShellSafetyWithModel, logger }: PreToolPolicyOptions,
): Promise<PreToolUseHookOutput | undefined> {
  if (shellRequest) {
    const fastPathDecision = getShellFastPathDecision(shellRequest);
    switch (fastPathDecision.kind) {
      case "approved":
        return approveToolUse();
      case "denied":
        return denyToolUse(fastPathDecision.reason);
      default:
        break;
    }
  }

  try {
    const classification = await classifyShellSafetyWithModel(
      {
        command,
        intention,
        ...(latestUserPrompt === undefined ? {} : { latestUserPrompt }),
        ...(shellRequest === null ? {} : { shellRequest }),
      },
      config.classifierModel,
    );
    switch (classification.classification) {
      case "allow":
        return approveToolUse();
      case "block":
        return denyToolUse(getClassifierDenialMessage(classification.reason));
      default:
        return undefined;
    }
  } catch (error) {
    void logger.log(`classifier error: ${getErrorMessage(error)}`, {
      ephemeral: true,
      level: "error",
    });
    return undefined;
  }
}

export function createPreToolUseHandler(options: PreToolPolicyOptions) {
  return async (
    input: unknown,
    invocation?: HookInvocation,
  ): Promise<PreToolUseHookOutput | undefined> => {
    const preToolInputParse = PreToolUseInputSchema.safeParse(input);
    if (!preToolInputParse.success || !options.config.autoMode) {
      return undefined;
    }

    const preToolInput = preToolInputParse.data;
    const normalizedToolName = getNormalizedToolName(preToolInput.toolName);
    if (!SHELL_TOOL_NAMES.has(normalizedToolName)) {
      return approveToolUse();
    }

    const shellToolArgsParse = ShellToolArgsSchema.safeParse(preToolInput.toolArgs);
    if (!shellToolArgsParse.success) {
      return undefined;
    }

    const { command, description } = shellToolArgsParse.data;
    const shellRequest = await createShellPermissionRequestFromCommandText(
      command,
      description,
      preToolInput.cwd,
    );
    const sessionId = preToolInput.sessionId ?? invocation?.sessionId;
    const latestUserPrompt =
      sessionId === undefined ? undefined : options.getLatestUserPrompt?.(sessionId);

    return handleShellPreToolRequest(command, description, shellRequest, latestUserPrompt, options);
  };
}
