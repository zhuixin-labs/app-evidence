import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface InstalledEngine {
  path: string;
  sha256: string;
  manifestPath: string;
}

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function installEngineArtifact(
  workspaceRoot: string,
  sourcePath: string,
  expectedSha256?: string
): InstalledEngine {
  const source = path.resolve(sourcePath);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`Engine artifact not found: ${source}`);
  }
  const hash = sha256(source);
  if (expectedSha256 && hash !== expectedSha256.toLowerCase()) {
    throw new Error(
      `Engine SHA-256 mismatch: expected ${expectedSha256}, got ${hash}`
    );
  }
  const dir = path.join(workspaceRoot, "tools", "engine", "current");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destination = path.join(dir, "engine-main.js");
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o700);
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "apptrace-engine",
        path: "engine-main.js",
        sha256: hash,
        installedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return { path: destination, sha256: hash, manifestPath };
}
