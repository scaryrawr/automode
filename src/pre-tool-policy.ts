import type { Configuration } from "./config.js";
import {
  createShellPermissionRequestFromCommandText,
  getShellFastPathDecision,
} from "./shell-safety.js";
import { PreToolUseInputSchema, ShellToolArgsSchema, type PreToolUseHookOutput } from "./types.js";

const SHELL_TOOL_NAMES = new Set(["bash", "shell"]);
const READ_TOOL_NAMES = new Set(["read", "view"]);
const WRITE_TOOL_NAMES = new Set(["write", "edit", "create", "apply_patch"]);

type ShellSafetyClassification = {
  classification: "allow" | "block";
  reason?: string;
};

type ClassifyShellSafety = (
  input: { command: string; intention: string },
  model?: string,
) => Promise<ShellSafetyClassification>;

type PreToolPolicyOptions = {
  config: Configuration;
  classifyShellSafetyWithModel: ClassifyShellSafety;
  logClassifierError: (error: unknown) => void;
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

async function handleShellPreToolRequest(
  command: string,
  intention: string,
  shellRequest: Awaited<ReturnType<typeof createShellPermissionRequestFromCommandText>>,
  { config, classifyShellSafetyWithModel, logClassifierError }: PreToolPolicyOptions,
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
    logClassifierError(error);
    return undefined;
  }
}

export function createPreToolUseHandler(options: PreToolPolicyOptions) {
  return async (input: unknown): Promise<PreToolUseHookOutput | undefined> => {
    const preToolInputParse = PreToolUseInputSchema.safeParse(input);
    if (!preToolInputParse.success || !options.config.autoMode) {
      return undefined;
    }

    const preToolInput = preToolInputParse.data;
    const normalizedToolName = getNormalizedToolName(preToolInput.toolName);
    if (READ_TOOL_NAMES.has(normalizedToolName) || WRITE_TOOL_NAMES.has(normalizedToolName)) {
      return approveToolUse();
    }

    if (!SHELL_TOOL_NAMES.has(normalizedToolName)) {
      return undefined;
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

    return handleShellPreToolRequest(command, description, shellRequest, options);
  };
}
