import { builtinModules } from "node:module";
import { defineConfig } from "rolldown";

const builtinModuleSet = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

function isExternal(id: string): boolean {
  return (
    builtinModuleSet.has(id) ||
    id === "@github/copilot-sdk" ||
    id.startsWith("@github/copilot-sdk/") ||
    id === "tree-sitter-bash" ||
    id.startsWith("tree-sitter-bash/") ||
    id === "web-tree-sitter" ||
    id.startsWith("web-tree-sitter/")
  );
}

export default defineConfig({
  input: "./src/extension.ts",
  external: isExternal,
  output: {
    codeSplitting: false,
    file: "./extension.mjs",
    format: "esm",
  },
});
