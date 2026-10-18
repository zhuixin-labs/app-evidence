import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineClient } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("EngineClient", () => {
  it("speaks the versioned engine protocol over stdio", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace-engine-"));
    tempDirs.push(dir);
    const executable = path.join(dir, "fake-engine.js");
    fs.writeFileSync(
      executable,
      `const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  const result = request.capability === "inspect:ipa"
    ? { bundleId: "com.example.fixture" }
    : { ok: true };
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\\n");
});
`,
      { mode: 0o755 }
    );
    const client = new EngineClient(executable);
    const result = await client.execute(dir, "inspect:ipa");
    expect(result.bundleId).toBe("com.example.fixture");
    client.close();
  });
});
