import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const bashWasmModule = "virtual:automode/tree-sitter-bash-wasm";
export const webTreeSitterWasmModule = "virtual:automode/web-tree-sitter-wasm";
export const virtualWasmModulePattern =
  /^virtual:automode\/(?:tree-sitter-bash-wasm|web-tree-sitter-wasm)$/;

const wasmBinaryModules = new Map([
  [bashWasmModule, "tree-sitter-bash/tree-sitter-bash.wasm"],
  [webTreeSitterWasmModule, "web-tree-sitter/web-tree-sitter.wasm"],
]);
const require = createRequire(import.meta.url);

export function loadWasmBinaryModule(source: string): string | null {
  const moduleId = wasmBinaryModules.get(source);
  if (!moduleId) {
    return null;
  }

  const wasmPath = require.resolve(moduleId);
  const wasmBase64 = readFileSync(wasmPath, "base64");
  return `import { Buffer } from "node:buffer";
export default Buffer.from(${JSON.stringify(wasmBase64)}, "base64");`;
}
