import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { JobRecord, ResolveResult, TargetDetail, TargetRecord } from "@zhuixin/shared";
import { AppAnalysisService } from "../src/app/analysis.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import { loadConfig } from "../src/config.js";
import { CoreServer } from "../src/server.js";
import { LocalWindowsAppProvider } from "../src/sources/localWindowsApp.js";

let root: string;
let server: CoreServer;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace windows "));
  server = new CoreServer({
    config: loadConfig({ APPTRACE_WORKSPACE_ROOT: path.join(root, "workspace") }),
    emit: () => {}
  });
});

afterEach(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content = "x"): string {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

test("the provider accepts install directories and rejects everything else", () => {
  const provider = new LocalWindowsAppProvider();
  write("Plain App/Plain.exe");
  write("Squirrel App/Update.exe");
  write("Squirrel App/app-1.0.0/Chat.exe");
  write("Data Only/readme.txt");
  write("Fake.app/Contents/Info.plist");
  write("Fake.app/tool.exe");

  expect(provider.canHandle(path.join(root, "Plain App"))).toBe(true);
  expect(provider.canHandle(`"${path.join(root, "Plain App")}"`)).toBe(true);
  expect(provider.canHandle(path.join(root, "Squirrel App"))).toBe(true);
  expect(provider.canHandle(path.join(root, "Data Only"))).toBe(false);
  expect(provider.canHandle(path.join(root, "Fake.app"))).toBe(false);
  expect(provider.canHandle(path.join(root, "Plain App", "Plain.exe"))).toBe(false);
  expect(provider.canHandle(path.join(root, "missing"))).toBe(false);
});

test("installer files get a pointer to the supported input", async () => {
  const installer = write("Setup.exe");
  const error = (await server.handle("targets:resolve", { input: installer }).catch((e) => e)) as {
    code?: string;
    message?: string;
  };
  expect(error.code).toBe("SOURCE_NOT_ENABLED");
  expect(error.message).toContain("installed program");
});

test("acquires an install directory by link and keeps the digest stable", async () => {
  const dir = path.join(root, "Notes");
  write("Notes/Notes.exe", "MZ-not-really");
  write("Notes/resources/app.asar", "asar");

  const run = async () => {
    const resolved = (await server.handle("targets:resolve", { input: dir })) as ResolveResult;
    expect(resolved.target.targetRef).toMatchObject({ platform: "windows", sourceId: "local-file" });
    expect(resolved.target.name).toBe("Notes");
    const target = (await server.handle("targets:create", {
      resolutionId: resolved.resolutionId
    })) as TargetRecord;
    const created = (await server.handle("jobs:create", {
      targetId: target.id,
      capabilityId: "acquire:local-file"
    })) as JobRecord;
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { job } = (await server.handle("jobs:get", { jobId: created.id })) as { job: JobRecord };
      if (["ready", "failed"].includes(job.status)) {
        const detail = (await server.handle("targets:get", { targetId: target.id })) as TargetDetail;
        return { job, detail };
      }
      if (Date.now() > deadline) throw new Error(`Timed out in status ${job.status}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const first = await run();
  expect(first.job.status).toBe("ready");
  const artifact = first.detail.artifacts[0]!;
  expect(artifact).toMatchObject({ platform: "windows", packageFormat: "exe", sourceUrl: dir });
  expect(fs.readFileSync(path.join(root, "workspace", artifact.path, "Notes.exe"), "utf8")).toBe("MZ-not-really");
  expect(first.job.result).toMatchObject({ fileCount: 2, limitations: [] });

  const second = await run();
  expect(second.detail.artifacts[0]!.sha256).toBe(artifact.sha256);
});

test("windows capabilities follow the target and say what a non-Windows host cannot verify", () => {
  const target = { targetRef: { platform: "windows" } } as never;
  const artifact = { packageFormat: "exe" } as never;
  const find = (host: "win32" | "darwin" | "linux", id = "inspect:pe") =>
    new CapabilityRegistry(loadConfig({}, host)).get(id, { target, artifact })!;

  expect(find("win32").available).toBe(true);
  expect(find("win32").notes).toBeUndefined();
  for (const host of ["darwin", "linux"] as const) {
    expect(find(host).available).toBe(true);
    expect(find(host).notes).toEqual([expect.stringContaining("Windows host")]);
  }
  expect(find("win32", "inspect:msix").available).toBe(false);

  const registry = new CapabilityRegistry(loadConfig({}, "win32"));
  expect(registry.supports("javascript:analyze", "windows", "exe")).toBe(true);
  expect(registry.supports("native:inspect", "windows", "exe")).toBe(false);
});

const now = "2026-01-01T00:00:00.000Z";

function flow(options: { inspection?: Record<string, unknown>; name?: string }) {
  const target = {
    id: "target-1",
    targetRef: { platform: "windows", sourceId: "local-file", sourceRef: "C:\\Program Files\\Folder" },
    name: options.name ?? "Folder",
    slug: "folder",
    metadata: {},
    createdAt: now,
    updatedAt: now
  };
  const artifact = {
    id: "artifact-1",
    targetId: target.id,
    platform: "windows",
    packageFormat: "exe",
    sha256: "0".repeat(64),
    path: "artifacts/dir",
    sizeBytes: 1,
    isCurrent: true,
    inspection: options.inspection,
    downloadedAt: now
  };
  const jobs: JobRecord[] = [];
  const created: string[] = [];
  const limitations: Array<{ key: string; message: string }> = [];
  const upserted: Array<{ name: string; version?: string; publisher?: string }> = [];
  const fake = {
    config: loadConfig({}, "win32"),
    capabilityRegistry: new CapabilityRegistry(loadConfig({}, "win32")),
    store: {
      listEvidence: () => [],
      upsertTarget: (value: { name: string; version?: string; publisher?: string }) => upserted.push(value)
    },
    addLimitation: (_target: string, key: string, message: string) => limitations.push({ key, message }),
    async handle(channel: string, payload: Record<string, unknown>) {
      if (channel === "targets:get") return { target, artifacts: [artifact], jobs } as unknown as TargetDetail;
      if (channel === "jobs:create") {
        const capabilityId = String(payload.capabilityId);
        created.push(capabilityId);
        const job = {
          id: `job-${created.length}`,
          targetId: target.id,
          sourceId: "local-file",
          capabilityId,
          status: "analyzed",
          progress: 100,
          params: { artifactId: artifact.id },
          result: capabilityId === "generate:report" ? { reportPath: "report.md" } : {},
          createdAt: now
        } as unknown as JobRecord;
        jobs.push(job);
        return job;
      }
      if (channel === "jobs:get") return { job: jobs.find((item) => item.id === payload.jobId) };
      throw new Error(`unexpected channel ${channel}`);
    }
  };
  return { service: new AppAnalysisService(fake as unknown as CoreServer), created, limitations, upserted };
}

const nativeApp = {
  kind: "windows-app",
  app: { name: "Real Product", version: "4.2.0", publisher: "Example Ltd" },
  layout: { electron: { asar: false, unpackedApp: false } },
  technology: { hints: ["Qt", ".NET"] },
  warnings: []
};

test("a program without Electron skips JavaScript analysis and still reports technology hints", async () => {
  const { service, created, limitations, upserted } = flow({ inspection: nativeApp });
  const result = await service.analyzeApp({
    targetId: "target-1",
    goals: ["tech_stack", "native_risk", "report"]
  });

  expect(created).toEqual(["generate:report"]);
  expect(result.technology).toEqual({ confidence: "static layout hints", hints: ["Qt", ".NET"] });
  expect(limitations.map((item) => item.key)).toEqual(["skipped-javascript", "skipped-native-inspect"]);
  expect(result.targetName).toBe("Real Product");
  expect(upserted).toEqual([expect.objectContaining({ name: "Real Product", version: "4.2.0", publisher: "Example Ltd" })]);
});

test("an Electron program runs JavaScript analysis", async () => {
  const { service, created } = flow({
    inspection: { ...nativeApp, layout: { electron: { asar: true, unpackedApp: false } } }
  });
  await service.analyzeApp({ targetId: "target-1", goals: ["tech_stack"] });
  expect(created).toEqual(["javascript:analyze"]);
});

test("a program that was never inspected gets the Windows inspection", async () => {
  const { service, created } = flow({});
  await service.analyzeApp({ targetId: "target-1", goals: ["report"] });
  expect(created[0]).toBe("inspect:pe");
});
