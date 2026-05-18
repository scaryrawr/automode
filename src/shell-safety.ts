import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
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
const SHELL_WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);
const SHELL_READ_REDIRECTS = new Set(["<"]);
const SHELL_EXPANSIONS_THAT_EXECUTE = ["`", "$(", "<(", ">("];
const SHELL_UNSUPPORTED_NODE_TYPES = [
  "case_statement",
  "command_substitution",
  "c_style_for_statement",
  "compound_statement",
  "for_statement",
  "function_definition",
  "heredoc_redirect",
  "herestring_redirect",
  "if_statement",
  "negated_command",
  "process_substitution",
  "subshell",
  "while_statement",
];
const SHELL_CONTROL_OPERATOR_TYPES = new Set(["&"]);
const SHELL_REDIRECT_OPERATORS = new Set([
  ...SHELL_WRITE_REDIRECTS,
  ...SHELL_READ_REDIRECTS,
  "<&",
  ">&",
  ">&-",
]);

const require = createRequire(import.meta.url);

let parserPromise: Promise<Parser> | undefined;

type ParsedShellCommandText = {
  commands: ShellPermissionCommand[];
  possiblePaths: string[];
};

export function getShellFastPathDecision(request: ShellPermissionRequest): ShellFastPathDecision {
  if (request.commands.length === 0) {
    return { kind: "no-result" };
  }

  if (request.hasWriteFileRedirection) {
    const writeRedirectionDecision = getWriteRedirectionDecision(request.possiblePaths, request.cwd);
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

export async function createShellPermissionRequestFromCommandText(
  fullCommandText: string,
  intention: string,
  cwd?: string,
): Promise<ShellPermissionRequest | null> {
  const parsedCommandText = await parseShellCommandText(fullCommandText);
  if (!parsedCommandText) {
    return null;
  }

  return {
    kind: "shell",
    fullCommandText,
    intention,
    commands: parsedCommandText.commands,
    possiblePaths: parsedCommandText.possiblePaths,
    possibleUrls: [],
    ...(cwd === undefined ? {} : { cwd }),
    hasWriteFileRedirection: parsedCommandText.possiblePaths.length > 0,
    canOfferSessionApproval: false,
    warning: undefined,
  };
}

async function createParser(): Promise<Parser> {
  await Parser.init({
    locateFile: () => require.resolve(["web-tree-sitter", "web-tree-sitter.wasm"].join("/")),
  });

  const bashWasmPath = path.join(
    path.dirname(require.resolve(["tree-sitter-bash", "package.json"].join("/"))),
    "tree-sitter-bash.wasm",
  );
  const bash = await Language.load(bashWasmPath);
  const parser = new Parser();
  parser.setLanguage(bash);
  return parser;
}

function getParser(): Promise<Parser> {
  parserPromise ??= createParser().catch((error: unknown) => {
    parserPromise = undefined;
    throw error;
  });

  return parserPromise;
}

async function parseShellCommandText(commandText: string): Promise<ParsedShellCommandText | null> {
  if (
    !commandText.trim() ||
    SHELL_EXPANSIONS_THAT_EXECUTE.some((expansion) => commandText.includes(expansion))
  ) {
    return null;
  }

  let parser: Parser;
  try {
    parser = await getParser();
  } catch {
    return null;
  }

  parser.reset();
  const tree = parser.parse(commandText);
  if (!tree) {
    return null;
  }

  try {
    const root = tree.rootNode;
    if (root.hasError || hasUnsupportedShellSyntax(root)) {
      return null;
    }

    const possiblePaths = getWriteRedirectPaths(root);
    if (!possiblePaths) {
      return null;
    }

    const commands: ShellPermissionCommand[] = [];
    for (const commandNode of root.descendantsOfType("command").filter(isNode)) {
      const command = getCommandParts(commandNode);
      if (!command) {
        return null;
      }

      commands.push(command);
    }

    return commands.length > 0 ? { commands, possiblePaths } : null;
  } finally {
    tree.delete();
  }
}

function hasPathSeparator(identifier: string): boolean {
  return /[\\/]/.test(identifier);
}

function isNode(node: Node | null): node is Node {
  return node !== null;
}

function hasUnsupportedShellSyntax(root: Node): boolean {
  if (root.descendantsOfType(SHELL_UNSUPPORTED_NODE_TYPES).some(isNode)) {
    return true;
  }

  if (hasExecutableParameterExpansion(root)) {
    return true;
  }

  return nodeAndDescendants(root).some((node) =>
    node.children.some((child) => SHELL_CONTROL_OPERATOR_TYPES.has(child.type)),
  );
}

function hasExecutableParameterExpansion(root: Node): boolean {
  return root
    .descendantsOfType("expansion")
    .filter(isNode)
    .some((node) => {
      const operators = node.childrenForFieldName("operator").map((operator) => operator.type);
      return operators.join("") === "@P";
    });
}

function nodeAndDescendants(root: Node): Node[] {
  return [root, ...root.namedChildren.flatMap(nodeAndDescendants)];
}

function getCommandParts(commandNode: Node): ShellPermissionCommand | null {
  const name = commandNode.childForFieldName("name");
  const identifier = getStaticShellNodeText(name);
  if (!identifier) {
    return null;
  }

  return {
    identifier,
    readOnly: false,
    args: commandNode
      .childrenForFieldName("argument")
      .filter(isNode)
      .map((arg) => getStaticShellNodeText(arg) ?? arg.text),
  };
}

function getWriteRedirectPaths(root: Node): string[] | null {
  const possiblePaths: string[] = [];

  for (const redirect of root.descendantsOfType("file_redirect").filter(isNode)) {
    const operator = getRedirectOperator(redirect);
    if (!operator || !SHELL_REDIRECT_OPERATORS.has(operator)) {
      return null;
    }

    if (SHELL_READ_REDIRECTS.has(operator) || isFileDescriptorRedirect(redirect, operator)) {
      continue;
    }

    if (!SHELL_WRITE_REDIRECTS.has(operator)) {
      return null;
    }

    const destinations = redirect.childrenForFieldName("destination").filter(isNode);
    if (destinations.length !== 1) {
      return null;
    }

    const destination = getStaticShellNodeText(destinations[0]);
    if (!destination || !isStaticShellPathToken(destination)) {
      return null;
    }

    possiblePaths.push(destination);
  }

  return possiblePaths;
}

function getRedirectOperator(redirect: Node): string | null {
  return (
    redirect.children.find((child) => !child.isNamed && SHELL_REDIRECT_OPERATORS.has(child.type))
      ?.type ?? null
  );
}

function isFileDescriptorRedirect(redirect: Node, operator: string): boolean {
  if (operator === ">&-") {
    return true;
  }

  if (operator !== ">&" && operator !== "<&") {
    return false;
  }

  const destination = redirect.childForFieldName("destination");
  return destination?.type === "number";
}

function getStaticShellNodeText(node: Node | null): string | null {
  if (!node) {
    return null;
  }

  switch (node.type) {
    case "command_name":
      return getSingleStaticNamedChildText(node);
    case "word":
      return node.namedChildCount === 0 ? unescapeShellWord(node.text) : null;
    case "raw_string":
      return unquoteRawString(node.text);
    case "string":
      return getStaticDoubleQuotedStringText(node);
    case "concatenation":
      return getStaticConcatenationText(node);
    default:
      return null;
  }
}

function getSingleStaticNamedChildText(node: Node): string | null {
  if (node.namedChildCount !== 1) {
    return null;
  }

  return getStaticShellNodeText(node.namedChild(0));
}

function unquoteRawString(text: string): string | null {
  return text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1) : null;
}

function getStaticDoubleQuotedStringText(node: Node): string | null {
  if (!node.text.startsWith('"') || !node.text.endsWith('"')) {
    return null;
  }

  if (node.namedChildren.some((child) => child.type !== "string_content")) {
    return null;
  }

  return unescapeDoubleQuotedString(node.text.slice(1, -1));
}

function getStaticConcatenationText(node: Node): string | null {
  let text = "";
  for (const child of node.namedChildren) {
    const childText = getStaticShellNodeText(child);
    if (childText === null) {
      return null;
    }

    text += childText;
  }

  return text;
}

function unescapeShellWord(text: string): string {
  return text.replace(/\\([\s\S])/g, "$1");
}

function unescapeDoubleQuotedString(text: string): string {
  return text.replace(/\\(["\\$`\n])/g, "$1");
}

function isStaticShellPathToken(token: string): boolean {
  return !/[~$*?\[\]{}]/.test(token);
}

function getCommandDecision(command: ShellPermissionCommand): ShellFastPathDecision {
  if (hasPathSeparator(command.identifier)) {
    return { kind: "no-result" };
  }

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

function getWriteRedirectionDecision(
  possiblePaths: string[],
  cwd: string | undefined,
): ShellFastPathDecision {
  if (possiblePaths.length === 0) {
    return { kind: "no-result" };
  }

  return possiblePaths.every((possiblePath) => isAutoApprovedWritePath(possiblePath, cwd))
    ? { kind: "approved" }
    : { kind: "no-result" };
}

function isAutoApprovedWritePath(possiblePath: string, cwd: string | undefined): boolean {
  const normalizedPath = normalizePossiblePath(possiblePath, cwd);
  if (!normalizedPath) {
    return false;
  }

  const normalizedCwd = normalizeCwd(cwd);
  if (normalizedCwd && isPathWithinDirectory(normalizedPath, normalizedCwd)) {
    return true;
  }

  return getTempDirectories().some((directory) => isPathWithinDirectory(normalizedPath, directory));
}

function normalizePossiblePath(possiblePath: string, cwd: string | undefined): string | null {
  const trimmedPath = possiblePath.trim();
  if (!trimmedPath || trimmedPath.startsWith("~")) {
    return null;
  }

  if (path.isAbsolute(trimmedPath)) {
    return path.normalize(trimmedPath);
  }

  const normalizedCwd = normalizeCwd(cwd);
  return normalizedCwd ? path.normalize(path.resolve(normalizedCwd, trimmedPath)) : null;
}

function normalizeCwd(cwd: string | undefined): string | null {
  if (cwd === undefined) {
    return path.resolve(process.cwd());
  }

  const trimmedCwd = cwd.trim();
  return trimmedCwd ? path.resolve(trimmedCwd) : null;
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
    case "push":
      return classifyGitPush(normalizedRestArgs);
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

function classifyGitPush(args: string[]): ShellFastPathDecision {
  if (
    hasFlag(args, ["-f", "-d", "--force", "--force-with-lease", "--delete", "--mirror", "--prune"]) ||
    args.some((arg) => arg.startsWith("--force-with-lease=") || arg.startsWith("+") || /^:[^/]/.test(arg))
  ) {
    return { kind: "denied", reason: "git push can force-update or delete remote refs." };
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
