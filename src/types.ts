import { z } from "zod";

function parseJsonToolArgs(toolArgs: unknown): unknown {
  if (typeof toolArgs !== "string") {
    return toolArgs;
  }

  try {
    return JSON.parse(toolArgs) as unknown;
  } catch {
    return toolArgs;
  }
}

export const ShellPermissionCommandSchema = z.object({
  identifier: z.string(),
  readOnly: z.boolean(),
  args: z.array(z.string()).optional(),
});

export type ShellPermissionCommand = z.infer<typeof ShellPermissionCommandSchema>;

export const ShellPermissionRequestSchema = z.object({
  kind: z.literal("shell"),
  fullCommandText: z.string(),
  intention: z.string(),
  commands: z.array(ShellPermissionCommandSchema),
  possiblePaths: z.array(z.string()),
  possibleUrls: z.array(
    z.object({
      url: z.string(),
    }),
  ),
  cwd: z.string().optional(),
  hasWriteFileRedirection: z.boolean(),
  canOfferSessionApproval: z.boolean(),
  warning: z.nullish(z.string()),
});

export type ShellPermissionRequest = z.infer<typeof ShellPermissionRequestSchema>;

export const PreToolUseInputSchema = z.looseObject({
  sessionId: z.string().optional(),
  timestamp: z.number(),
  cwd: z.string(),
  toolName: z.string(),
  toolArgs: z.unknown(),
});

export const PreToolUseHookOutputSchema = z.object({
  permissionDecision: z.enum(["allow", "deny", "ask"]).optional(),
  permissionDecisionReason: z.string().optional(),
  modifiedArgs: z.unknown().optional(),
  additionalContext: z.string().optional(),
  suppressOutput: z.boolean().optional(),
});

export type PreToolUseHookOutput = z.infer<typeof PreToolUseHookOutputSchema>;

export const ShellToolArgsSchema = z.preprocess(
  parseJsonToolArgs,
  z.looseObject({
    command: z.string(),
    description: z.string(),
    timeout: z.number().optional(),
    shellId: z.string().optional(),
    async: z.boolean().optional(),
  }),
);
