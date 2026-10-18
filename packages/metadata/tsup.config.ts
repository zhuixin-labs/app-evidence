import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["node-pty"]
});
