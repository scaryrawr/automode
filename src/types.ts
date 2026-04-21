import z from "zod";

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
  hasWriteFileRedirection: z.boolean(),
  canOfferSessionApproval: z.boolean(),
  warning: z.nullish(z.string()),
});

export type ShellPermissionRequest = z.infer<typeof ShellPermissionRequestSchema>;

export const MCPPermissionRequestSchema = z.object({
  kind: z.literal("mcp"),
  readOnly: z.boolean(),
});
