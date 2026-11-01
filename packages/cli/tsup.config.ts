import { defineConfig } from "tsup";
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

const repoScripts = "../../scripts";
const shipped = [
  "bootstrap-tools.ps1",
  "bootstrap-tools.sh",
  "build-ipatool.ps1",
  "build-ghidra-arm64.sh"
];

/**
 * Every installer path referenced from the bootstrap scripts must ship inside
 * dist/scripts. 0.2.6 shipped bootstrap-tools.sh without build-ghidra-arm64.sh,
 * so `setup --install` downloaded 570 MB of Ghidra on macOS arm64 and then
 * failed. Tests cannot catch that: it only exists after packing.
 */
export function requiredInstallerFiles(): string[] {
  const names = new Set(shipped);
  const patterns = [
    /\$ROOT\/scripts\/([\w.-]+)/g,
    /Join-Path\s+\$PSScriptRoot\s+'([^']+)'/g
  ];
  for (const script of ["bootstrap-tools.sh", "bootstrap-tools.ps1"]) {
    const text = readFileSync(`${repoScripts}/${script}`, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) names.add(match[1]);
    }
  }
  return [...names].sort();
}

export function assertInstallersShipped(outDir = "dist"): void {
  const missing = requiredInstallerFiles().filter(
    (name) => !existsSync(`${outDir}/scripts/${name}`)
  );
  if (missing.length) {
    throw new Error(
      `Installer scripts missing from ${outDir}/scripts: ${missing.join(", ")}. ` +
        "A bootstrap script references them, so `setup --install` would fail after downloading the toolchain."
    );
  }
}

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
    for (const name of requiredInstallerFiles()) {
      if (!existsSync(`${repoScripts}/${name}`)) {
        throw new Error(`bootstrap references ${name}, but ${repoScripts}/${name} does not exist`);
      }
      copyFileSync(`${repoScripts}/${name}`, `dist/scripts/${name}`);
    }
    cpSync(`${repoScripts}/ipatool-overlay`, "dist/scripts/ipatool-overlay", { recursive: true });
    mkdirSync("dist/skills/apptrace", { recursive: true });
    copyFileSync("../../skills/apptrace/SKILL.md", "dist/skills/apptrace/SKILL.md");
    assertInstallersShipped("dist");
  }
});
