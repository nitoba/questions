import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/streams.ts",
    "src/schema.ts",
    "src/duration.ts",
    "src/providers/jev.ts",
    "src/providers/typesafe.ts",
    "src/providers/system-one.ts",
    "src/providers/ai-sdk.ts",
    "src/providers/vercel.ts",
    "src/providers/generative.ts",
  ],
  format: "esm",
  platform: "neutral",
  target: "es2023",
  clean: true,
  sourcemap: true,
  // TypeScript 7 emits declarations directly; no dependency on the old compiler API.
  dts: false,
});
