import { expect, test } from "vitest";
import type { JobRecord, TargetDetail } from "@zhuixin/shared";
import { AppAnalysisService } from "../src/app/analysis.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import { loadConfig } from "../src/config.js";
import type { CoreServer } from "../src/server.js";

const now = "2026-01-01T00:00:00.000Z";

function fixture(
  platform: "macos" | "ios",
  options: { host?: "win32" | "darwin"; inspection?: Record<string, unknown> } = {}
) {
  const host = options.host ?? "win32";
  const mac = platform === "macos";
  const target = {
    id: "target-1",
    targetRef: {
      platform,
      sourceId: mac ? "local-file" : "app-store",
      sourceRef: mac ? "/Applications/Sample.app" : "123"
    },
    name: "Sample",
    slug: "sample",
    metadata: {},
    createdAt: now,
    updatedAt: now
  };
  const artifact = {
    id: "artifact-1",
    targetId: target.id,
    packageFormat: mac ? "app" : "ipa",
    sha256: "0".repeat(64),
    path: mac ? "/Applications/Sample.app" : "sample.ipa",
    sizeBytes: 1,
    isCurrent: true,
    inspection: options.inspection ?? { ok: true },
    createdAt: now
  };
  const jobs: JobRecord[] = [];
  const created: string[] = [];
  const limitations: Array<{ key: string; message: string; artifactId?: string }> = [];
  const config = loadConfig({}, host);
  const registry = new CapabilityRegistry(config);
  const server = {
    config,
    capabilityRegistry: registry,
    store: { listEvidence: () => [] },
    addLimitation: (_target: string, key: string, message: string, artifactId?: string) => {
      limitations.push({ key, message, artifactId });
    },
    async handle(channel: string, payload: Record<string, unknown>) {
      if (channel === "targets:get") {
        return { target, artifacts: [artifact], jobs } as unknown as TargetDetail;
      }
      if (channel === "jobs:create") {
        const capabilityId = String(payload.capabilityId);
        created.push(capabilityId);
        const job = {
          id: `job-${created.length}`,
          targetId: target.id,
          sourceId: target.targetRef.sourceId,
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
      if (channel === "jobs:get") {
        return { job: jobs.find((item) => item.id === payload.jobId) };
      }
      throw new Error(`unexpected channel ${channel}`);
    }
  };
  return { server: server as unknown as CoreServer, created, limitations, target };
}

test("macOS targets skip native_risk with a limitation instead of failing the run", async () => {
  const { server, created, limitations, target } = fixture("macos");
  const result = await new AppAnalysisService(server).analyzeApp({
    targetId: target.id,
    goals: ["native_risk", "report"]
  });

  expect(created).toEqual(["generate:report"]);
  expect(result.completedSteps).toEqual(["report"]);
  expect(result.limitations).toHaveLength(1);
  expect(result.limitations[0]).toContain("macos app");
  expect(limitations).toEqual([
    expect.objectContaining({ key: "skipped-native-inspect", artifactId: "artifact-1" })
  ]);
});

test("iOS targets still run native analysis", async () => {
  const { server, created, limitations, target } = fixture("ios");
  const result = await new AppAnalysisService(server).analyzeApp({
    targetId: target.id,
    goals: ["native_risk"]
  });

  expect(created).toEqual(["native:inspect"]);
  expect(result.completedSteps).toEqual(["inspect_native"]);
  expect(limitations).toEqual([]);
});

test("native support depends on the target, not on the host OS", () => {
  for (const host of ["win32", "darwin", "linux"] as const) {
    const registry = new CapabilityRegistry(loadConfig({}, host));
    expect(registry.supports("native:inspect", "ios", "ipa")).toBe(true);
    expect(registry.supports("native:inspect", "macos", "app")).toBe(false);
    expect(registry.supports("javascript:analyze", "macos", "app")).toBe(true);
    expect(registry.supports("rea:inspect", "ios", "ipa")).toBe(true);
    expect(registry.supports("no-such-capability", "ios", "ipa")).toBe(false);
  }
});

test("inspector warnings reach the result and the report, and the host is stated", async () => {
  const { server, limitations, target } = fixture("macos", {
    host: "win32",
    inspection: { kind: "mac-app", warnings: ["Signature details require a macOS host."] }
  });
  const result = await new AppAnalysisService(server).analyzeApp({
    targetId: target.id,
    goals: ["report"]
  });

  expect(result.hostPlatform).toBe("win32");
  expect(result.limitations).toEqual(["Signature details require a macOS host."]);
  expect(limitations).toEqual([
    expect.objectContaining({ key: "inspect-warning-0", message: "Signature details require a macOS host." })
  ]);
});

test("capabilities announce reduced coverage on hosts that cannot do the whole job", () => {
  const target = { targetRef: { platform: "macos" } } as never;
  const artifact = { packageFormat: "app" } as never;
  const find = (host: "win32" | "darwin" | "linux") =>
    new CapabilityRegistry(loadConfig({}, host)).get("inspect:mac-app", { target, artifact })!;

  for (const host of ["win32", "linux"] as const) {
    const descriptor = find(host);
    expect(descriptor.available).toBe(true);
    expect(descriptor.notes).toEqual([expect.stringContaining("macOS host")]);
  }
  expect(find("darwin").notes).toBeUndefined();

  const ios = new CapabilityRegistry(loadConfig({}, "win32")).get("inspect:ipa", {
    target: { targetRef: { platform: "ios" } } as never,
    artifact: { packageFormat: "ipa" } as never
  })!;
  expect(ios.notes).toBeUndefined();
});
