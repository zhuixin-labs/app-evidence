import { defineConfig } from "tsup";
import { mkdirSync, copyFileSync, cpSync } from "node:fs";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  clean: true,
  onSuccess: async () => {
    mkdirSync("dist/scripts", { recursive: true });
    for (const name of ["bootstrap-tools.ps1", "bootstrap-tools.sh", "build-ipatool.ps1"]) {
      copyFileSync(`../../scripts/${name}`, `dist/scripts/${name}`);
    }
    cpSync("../../scripts/ipatool-overlay", "dist/scripts/ipatool-overlay", { recursive: true });
    mkdirSync("dist/skills/apptrace", { recursive: true });
    copyFileSync("../../skills/apptrace/SKILL.md", "dist/skills/apptrace/SKILL.md");
  }
});
