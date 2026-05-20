import { readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { defineConfig } from "rolldown";

const bashWasmModule = "virtual:automode/tree-sitter-bash-wasm";
const webTreeSitterWasmModule = "virtual:automode/web-tree-sitter-wasm";
const wasmBinaryModules = new Map([
  [bashWasmModule, "tree-sitter-bash/tree-sitter-bash.wasm"],
  [webTreeSitterWasmModule, "web-tree-sitter/web-tree-sitter.wasm"],
]);
const builtinModuleSet = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);
const require = createRequire(import.meta.url);

export function wasmBinaryPlugin() {
  return {
    name: "wasm-binary",
    enforce: "pre" as const,
    resolveId(source: string) {
      if (!wasmBinaryModules.has(source)) {
        return null;
      }

      return `\0${source}`;
    },
    load(id: string) {
      if (!id.startsWith("\0")) {
        return null;
      }

      const source = id.slice(1);
      const moduleId = wasmBinaryModules.get(source);
      if (!moduleId) {
        return null;
      }

      const wasmPath = require.resolve(moduleId);
      const wasmBase64 = readFileSync(wasmPath, "base64");
      return `import { Buffer } from "node:buffer";
export default Buffer.from(${JSON.stringify(wasmBase64)}, "base64");`;
    },
  };
}

function isExternal(id: string): boolean {
  return (
    builtinModuleSet.has(id) ||
    id === "@github/copilot-sdk" ||
    id.startsWith("@github/copilot-sdk/")
  );
}

export default defineConfig({
  input: "./src/extension.ts",
  external: isExternal,
  plugins: [wasmBinaryPlugin()],
  output: {
    codeSplitting: false,
    file: "./extension.mjs",
    format: "esm",
  },
});
