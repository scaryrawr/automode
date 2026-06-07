import { builtinModules } from "node:module";
import type { BunPlugin } from "bun";
import { loadWasmBinaryModule, virtualWasmModulePattern } from "./wasm-modules.js";

const wasmNamespace = "automode-wasm";
const externalModules = [
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
  "@github/copilot-sdk",
  "@github/copilot-sdk/*",
];

const wasmBinaryPlugin: BunPlugin = {
  name: "wasm-binary",
  setup(build) {
    build.onResolve({ filter: virtualWasmModulePattern }, (args) => ({
      path: args.path,
      namespace: wasmNamespace,
    }));

    build.onLoad({ filter: /.*/, namespace: wasmNamespace }, (args) => {
      const contents = loadWasmBinaryModule(args.path);
      if (!contents) {
        return;
      }

      return {
        contents,
        loader: "js",
      };
    });
  },
};

const result = await Bun.build({
  entrypoints: ["./src/extension.ts"],
  outdir: ".",
  naming: {
    entry: "extension.mjs",
  },
  format: "esm",
  target: "node",
  splitting: false,
  env: "disable",
  external: externalModules,
  plugins: [wasmBinaryPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
