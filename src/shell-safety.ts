import os from "node:os";
import path from "node:path";
import type { ShellPermissionCommand, ShellPermissionRequest } from "./types.js";

export type ShellFastPathDecision =
  | { kind: "approved" }
  | { kind: "denied"; reason: string }
  | { kind: "no-result" };

const ALWAYS_SAFE_IDENTIFIERS = new Set([
  "ack",
  "ag",
  "basename",
  "blame",
  "cat",
  "comm",
  "cmp",
  "cut",
  "diff",
  "dir",
  "egrep",
  "fgrep",
  "file",
  "grep",
  "head",
  "less",
  "ls",
  "more",
  "nl",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "stat",
  "tail",
  "tree",
  "tr",
  "type",
  "uniq",
  "wc",
  "where",
  "which",
]);

const SAFE_POWERSHELL_IDENTIFIERS = new Set([
  "cat",
  "dir",
  "gci",
  "gc",
  "gi",
  "gl",
  "get-childitem",
  "get-content",
  "get-item",
  "get-location",
  "ls",
  "pwd",
  "resolve-path",
  "select-string",
]);

const GIT_INSPECTION_SUBCOMMANDS = new Set([
  "blame",
  "describe",
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);

const GIT_BRANCH_LIST_FLAGS = new Set(["-a", "--all", "-l", "--list", "-r", "--remotes", "-v", "-vv"]);
const GIT_BRANCH_MUTATION_FLAGS = new Set([
  "-c",
  "-C",
  "-d",
  "-D",
  "-m",
  "-M",
  "--copy",
  "--delete",
  "--move",
]);
const GIT_TAG_LIST_FLAGS = new Set(["-l", "--list"]);
const GIT_TAG_DELETE_FLAGS = new Set(["-d", "--delete"]);

const GIT_DESTRUCTIVE_SUBCOMMAND_REASONS: Record<string, string> = {
  clean: "git clean can delete untracked files.",
  reset: "git reset can rewrite history or overwrite working tree changes.",
  restore: "git restore can overwrite tracked files.",
  rm: "git rm can delete tracked files from the working tree.",
};

const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

const FIND_UNSAFE_TOKENS = new Set(["-delete", "-exec", "-execdir", "-fls", "-fprint", "-fprintf", "-ok", "-okdir"]);
const POSIX_TEMP_DIRECTORIES = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];

export function getShellFastPathDecision(request: ShellPermissionRequest): ShellFastPathDecision {
  if (request.commands.length === 0) {
    return { kind: "no-result" };
  }

  if (request.hasWriteFileRedirection) {
    const writeRedirectionDecision = getWriteRedirectionDecision(request.possiblePaths);
    if (writeRedirectionDecision.kind !== "approved") {
      return writeRedirectionDecision;
    }
  }

  for (const command of request.commands) {
    if (command.readOnly) {
      continue;
    }

    const decision = getCommandDecision(command);
    if (decision.kind !== "approved") {
      return decision;
    }
  }

  return { kind: "approved" };
}

function getCommandDecision(command: ShellPermissionCommand): ShellFastPathDecision {
  const identifier = command.identifier.toLowerCase();
  if (ALWAYS_SAFE_IDENTIFIERS.has(identifier) || SAFE_POWERSHELL_IDENTIFIERS.has(identifier)) {
    return { kind: "approved" };
  }

  switch (identifier) {
    case "find":
      return classifyFind(command.args ?? []);
    case "git":
      return classifyGit(command.args ?? []);
    case "sed":
      return classifySed(command.args ?? []);
    default:
      return { kind: "no-result" };
  }
}

function getWriteRedirectionDecision(possiblePaths: string[]): ShellFastPathDecision {
  if (possiblePaths.length === 0) {
    return { kind: "no-result" };
  }

  return possiblePaths.every(isAutoApprovedWritePath) ? { kind: "approved" } : { kind: "no-result" };
}

function isAutoApprovedWritePath(possiblePath: string): boolean {
  const normalizedPath = normalizePossiblePath(possiblePath);
  if (!normalizedPath) {
    return false;
  }

  if (isPathWithinDirectory(normalizedPath, process.cwd())) {
    return true;
  }

  return getTempDirectories().some((directory) => isPathWithinDirectory(normalizedPath, directory));
}

function normalizePossiblePath(possiblePath: string): string | null {
  const trimmedPath = possiblePath.trim();
  if (!trimmedPath || trimmedPath.startsWith("~")) {
    return null;
  }

  return path.normalize(path.isAbsolute(trimmedPath) ? trimmedPath : path.resolve(process.cwd(), trimmedPath));
}

function getTempDirectories(): string[] {
  const directories = [os.tmpdir()];
  if (process.platform !== "win32") {
    directories.push(...POSIX_TEMP_DIRECTORIES);
  }

  return Array.from(new Set(directories.map((directory) => path.resolve(directory))));
}

function isPathWithinDirectory(candidatePath: string, directory: string): boolean {
  const relativePath = path.relative(directory, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function classifyFind(args: string[]): ShellFastPathDecision {
  const normalizedArgs = args.map((arg) => arg.toLowerCase());
  if (
    normalizedArgs.some(
      (arg) =>
        FIND_UNSAFE_TOKENS.has(arg) ||
        arg.startsWith("-fprint") ||
        arg.startsWith("-fprintf") ||
        arg.startsWith("-exec") ||
        arg.startsWith("-ok"),
    )
  ) {
    return { kind: "no-result" };
  }

  return { kind: "approved" };
}

function classifySed(args: string[]): ShellFastPathDecision {
  const normalizedArgs = args.map((arg) => arg.toLowerCase());
  if (
    normalizedArgs.some(
      (arg) => arg === "--in-place" || arg.startsWith("--in-place=") || arg === "-i" || /^-[^-]*i/.test(arg),
    )
  ) {
    return { kind: "no-result" };
  }

  return { kind: "approved" };
}

function classifyGit(rawArgs: string[]): ShellFastPathDecision {
  const args = skipGitGlobalOptions(rawArgs);
  const [subcommand, ...restArgs] = args;
  if (!subcommand) {
    return { kind: "no-result" };
  }

  const normalizedSubcommand = subcommand.toLowerCase();
  const normalizedRestArgs = restArgs.map((arg) => arg.toLowerCase());

  if (normalizedSubcommand in GIT_DESTRUCTIVE_SUBCOMMAND_REASONS) {
    return {
      kind: "denied",
      reason: GIT_DESTRUCTIVE_SUBCOMMAND_REASONS[normalizedSubcommand],
    };
  }

  if (GIT_INSPECTION_SUBCOMMANDS.has(normalizedSubcommand)) {
    return { kind: "approved" };
  }

  switch (normalizedSubcommand) {
    case "branch":
      return classifyGitBranch(normalizedRestArgs);
    case "checkout":
      if (normalizedRestArgs.includes("--") || hasFlag(normalizedRestArgs, ["-f", "--force"])) {
        return { kind: "denied", reason: "git checkout can overwrite working tree files." };
      }

      return { kind: "no-result" };
    case "stash":
      return classifyGitStash(normalizedRestArgs);
    case "switch":
      if (hasFlag(normalizedRestArgs, ["-c", "-C", "--create", "--force-create", "--discard-changes"])) {
        return { kind: "denied", reason: "git switch can discard or overwrite working tree changes." };
      }

      return { kind: "no-result" };
    case "tag":
      return classifyGitTag(normalizedRestArgs);
    default:
      return { kind: "no-result" };
  }
}

function classifyGitBranch(args: string[]): ShellFastPathDecision {
  if (args.some((arg) => GIT_BRANCH_MUTATION_FLAGS.has(arg))) {
    return { kind: "denied", reason: "git branch can delete or rewrite local branch refs." };
  }

  if (args.length === 0 || args.some((arg) => GIT_BRANCH_LIST_FLAGS.has(arg))) {
    return { kind: "approved" };
  }

  return { kind: "no-result" };
}

function classifyGitStash(args: string[]): ShellFastPathDecision {
  const [action] = args;
  switch (action) {
    case "list":
    case "show":
      return { kind: "approved" };
    case "clear":
    case "drop":
    case "pop":
      return { kind: "denied", reason: `git stash ${action} can discard saved work.` };
    default:
      return { kind: "no-result" };
  }
}

function classifyGitTag(args: string[]): ShellFastPathDecision {
  if (args.some((arg) => GIT_TAG_DELETE_FLAGS.has(arg))) {
    return { kind: "denied", reason: "git tag --delete can remove local tags." };
  }

  if (args.length === 0 || args.some((arg) => GIT_TAG_LIST_FLAGS.has(arg))) {
    return { kind: "approved" };
  }

  return { kind: "no-result" };
}

function hasFlag(args: string[], flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

function skipGitGlobalOptions(args: string[]): string[] {
  let index = 0;

  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") {
      index += 1;
      continue;
    }

    if (!arg.startsWith("-")) {
      break;
    }

    if (GIT_GLOBAL_OPTIONS_WITH_VALUES.has(arg)) {
      index += 2;
      continue;
    }

    if (
      arg.startsWith("-c") ||
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=") ||
      arg.startsWith("--namespace=") ||
      arg.startsWith("--super-prefix=") ||
      arg.startsWith("--config-env=") ||
      arg.startsWith("--exec-path=")
    ) {
      index += 1;
      continue;
    }

    index += 1;
  }

  return args.slice(index);
}
