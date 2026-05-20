import { defineConfig } from "vitest/config";
import { wasmBinaryPlugin } from "./rolldown.config.js";

export default defineConfig({
  plugins: [wasmBinaryPlugin()],
});
