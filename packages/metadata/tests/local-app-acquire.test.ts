import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { JobRecord, ResolveResult, TargetDetail, TargetRecord } from "@zhuixin/shared";
import { loadConfig } from "../src/config.js";
import { CoreServer } from "../src/server.js";
import { buildZip, finderStyleEntries, SAMPLE_INFO_PLIST } from "./fixtures/zip.js";

let root: string;
let server: CoreServer;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace acquire "));
  server = new CoreServer({
    config: loadConfig({ APPTRACE_WORKSPACE_ROOT: path.join(root, "workspace") }),
    emit: () => {}
  });
});

afterEach(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function acquire(source: string): Promise<{ target: TargetRecord; job: JobRecord; detail: TargetDetail }> {
  const resolved = (await server.handle("targets:resolve", { input: source })) as ResolveResult;
  const target = (await server.handle("targets:create", { resolutionId: resolved.resolutionId })) as TargetRecord;
  const created = (await server.handle("jobs:create", {
    targetId: target.id,
    capabilityId: "acquire:local-file"
  })) as JobRecord;
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { job } = (await server.handle("jobs:get", { jobId: created.id })) as { job: JobRecord };
    if (["ready", "failed", "cancelled"].includes(job.status)) {
      const detail = (await server.handle("targets:get", { targetId: target.id })) as TargetDetail;
      return { target, job, detail };
    }
    if (Date.now() > deadline) throw new Error(`Timed out in status ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function makeApp(): string {
  const bundle = path.join(root, "Sample App.app");
  fs.mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), SAMPLE_INFO_PLIST);
  fs.writeFileSync(path.join(bundle, "Contents", "MacOS", "Sample"), "not a real Mach-O");
  return bundle;
}

test("acquires a local .app directory without copying it", async () => {
  const bundle = makeApp();
  const { job, detail } = await acquire(bundle);

  expect(job.status).toBe("ready");
  const artifact = detail.artifacts[0]!;
  expect(artifact).toMatchObject({ packageFormat: "app", platform: "macos", sourceUrl: bundle });
  const stored = path.join(root, "workspace", artifact.path);
  expect(fs.readFileSync(path.join(stored, "Contents", "Info.plist"), "utf8")).toBe(SAMPLE_INFO_PLIST);
  expect(fs.existsSync(path.join(bundle, "Contents", "Info.plist"))).toBe(true);
  expect(job.result).toMatchObject({ limitations: [] });
});

test("acquires a zip by extracting the bundle and reports what it could not keep", async () => {
  const zip = path.join(root, "Sample App.zip");
  fs.writeFileSync(zip, buildZip(finderStyleEntries()));
  const { job, detail } = await acquire(zip);

  expect(job.status).toBe("ready");
  const artifact = detail.artifacts[0]!;
  expect(artifact).toMatchObject({ packageFormat: "app", platform: "macos", sourceUrl: zip });
  const stored = path.join(root, "workspace", artifact.path);
  expect(stored.endsWith("Sample App.app")).toBe(true);
  expect(fs.readFileSync(path.join(stored, "Contents", "Info.plist"), "utf8")).toBe(SAMPLE_INFO_PLIST);
  expect(job.result).toMatchObject({
    fileCount: 4,
    limitations: [expect.stringContaining("1 symbolic links")]
  });
});

test("the same zip is extracted once and the bundle digest stays stable", async () => {
  const zip = path.join(root, "Sample App.zip");
  fs.writeFileSync(zip, buildZip(finderStyleEntries()));
  const first = await acquire(zip);
  const marker = path.join(
    path.dirname(path.join(root, "workspace", first.detail.artifacts[0]!.path)),
    ".extracted.json"
  );
  const extractedAt = fs.statSync(marker).mtimeMs;

  const second = await acquire(zip);
  expect(second.job.status).toBe("ready");
  expect(second.detail.artifacts[0]!.sha256).toBe(first.detail.artifacts[0]!.sha256);
  expect(fs.statSync(marker).mtimeMs).toBe(extractedAt);
});

test("a hostile zip fails the job with a clear error and leaves no artifact", async () => {
  const zip = path.join(root, "Evil.zip");
  fs.writeFileSync(zip, buildZip([...finderStyleEntries(), { name: "../escape.txt", data: "x" }]));
  const resolved = (await server.handle("targets:resolve", { input: zip }).catch((error) => error)) as { code?: string };
  expect(resolved.code).toBe("ARCHIVE_INVALID");
  expect(fs.existsSync(path.join(root, "escape.txt"))).toBe(false);
});
