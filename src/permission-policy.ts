import type { PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
import { getErrorMessage } from "./errors.js";
import type { Configuration } from "./config.js";
import {
  createShellPermissionRequestFromCommandText,
  getShellFastPathDecision,
} from "./shell-safety.js";
import type { ShellPermissionRequest } from "./types.js";

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

type PermissionPolicyOptions = {
  config: Configuration;
  classifyShellSafetyWithModel: ClassifyShellSafety;
  getLatestUserPrompt?: (sessionId: string) => string | undefined;
  logger: Logger;
};

type PermissionInvocation = {
  sessionId: string;
};

type Logger = {
  log: (
    message: string,
    options?: { ephemeral?: boolean; level?: "info" | "warning" | "error" },
  ) => Promise<void> | void;
};

function approvePermissionRequest(): PermissionRequestResult {
  return { kind: "approved" };
}

function noPermissionRequestResult(): PermissionRequestResult {
  return { kind: "no-result" };
}

function denyPermissionRequest(reason: string | undefined): PermissionRequestResult {
  return {
    kind: "denied-by-permission-request-hook",
    message: reason,
    interrupt: false,
  };
}

function getClassifierDenialMessage(reason: string | undefined): string {
  return reason?.trim() || "Blocked by safety classifier.";
}

function formatClassifierResultMessage(classification: ShellSafetyClassification): string {
  const reason = classification.reason?.trim();
  const suffix = reason ? ` (${reason})` : "";
  return `classifier result: ${classification.classification}${suffix}`;
}

async function handleShellPermissionRequest(
  request: Extract<PermissionRequest, { kind: "shell" }>,
  latestUserPrompt: string | undefined,
  { config, classifyShellSafetyWithModel, logger }: PermissionPolicyOptions,
): Promise<PermissionRequestResult> {
  const shellRequest = await createShellPermissionRequestFromCommandText(
    request.fullCommandText,
    request.intention,
  );

  if (shellRequest) {
    const fastPathDecision = getShellFastPathDecision(shellRequest);
    switch (fastPathDecision.kind) {
      case "approved":
        return approvePermissionRequest();
      case "denied":
        return denyPermissionRequest(fastPathDecision.reason);
      default:
        break;
    }
  }

  try {
    void logger.log("classifier running", {
      ephemeral: true,
      level: "info",
    });
    const classification = await classifyShellSafetyWithModel(
      {
        command: request.fullCommandText,
        intention: request.intention,
        ...(latestUserPrompt === undefined ? {} : { latestUserPrompt }),
        ...(shellRequest === null ? {} : { shellRequest }),
      },
      config.classifierModel,
    );
    void logger.log(formatClassifierResultMessage(classification), {
      ephemeral: true,
      level: "info",
    });
    switch (classification.classification) {
      case "allow":
        return approvePermissionRequest();
      case "block":
        return denyPermissionRequest(getClassifierDenialMessage(classification.reason));
      default:
        return noPermissionRequestResult();
    }
  } catch (error) {
    void logger.log(`classifier error: ${getErrorMessage(error)}`, {
      ephemeral: true,
      level: "error",
    });
    return noPermissionRequestResult();
  }
}

export function createPermissionRequestHandler(options: PermissionPolicyOptions) {
  return async (
    request: PermissionRequest,
    invocation: PermissionInvocation,
  ): Promise<PermissionRequestResult> => {
    if (!options.config.autoMode) {
      return noPermissionRequestResult();
    }

    switch (request.kind) {
      case "read":
      case "write":
        return approvePermissionRequest();
      case "mcp":
        return request.readOnly ? approvePermissionRequest() : noPermissionRequestResult();
      case "shell": {
        const latestUserPrompt = options.getLatestUserPrompt?.(invocation.sessionId);
        return handleShellPermissionRequest(request, latestUserPrompt, options);
      }
      default:
        return noPermissionRequestResult();
    }
  };
}
