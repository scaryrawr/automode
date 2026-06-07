import { defineConfig } from "vitest/config";
import { loadWasmBinaryModule, virtualWasmModulePattern } from "./wasm-modules.js";

function wasmBinaryPlugin() {
  return {
    name: "wasm-binary",
    enforce: "pre" as const,
    resolveId(source: string) {
      if (!virtualWasmModulePattern.test(source)) {
        return null;
      }

      return `\0${source}`;
    },
    load(id: string) {
      if (!id.startsWith("\0")) {
        return null;
      }

      return loadWasmBinaryModule(id.slice(1));
    },
  };
}

export default defineConfig({
  plugins: [wasmBinaryPlugin()],
});
