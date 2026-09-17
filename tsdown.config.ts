import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/streams.ts", "src/providers/jev.ts"],
  format: "esm",
  platform: "neutral",
  target: "es2023",
  clean: true,
  sourcemap: true,
  // TypeScript 7 emits declarations directly; no dependency on the old compiler API.
  dts: false,
});
