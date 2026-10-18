import { randomUUID } from "node:crypto";
import type {
  ArtifactRecord,
  JobRecord,
  ResolveResult,
  TargetDetail,
  TargetRecord
} from "@zhuixin/shared";
import { CoreFailure } from "../errors.js";
import type { CoreServer } from "../server.js";

export type AnalysisGoal =
  | "tech_stack"
  | "feature_map"
  | "network"
  | "native_risk"
  | "report";

export interface AnalyzeAppOptions {
  source?: string;
  targetId?: string;
  goals?: AnalysisGoal[];
  force?: boolean;
  timeoutMs?: number;
  onProgress?: (progress: AnalysisProgress) => void;
}

export interface AnalysisProgress {
  step: string;
  status: "started" | "completed" | "failed";
  jobId?: string;
  message?: string;
}

export interface AnalyzeAppResult {
  targetId: string;
  targetName: string;
  sourceId: string;
  sourceRef: string;
  artifact: {
    id: string;
    packageFormat: string;
    sha256: string;
    path: string;
    sizeBytes: number;
    version?: string;
    buildNumber?: string;
  };
  technology?: {
    confidence: string;
    hints: string[];
  };
  routes?: {
    count: number;
    sample: Array<Record<string, unknown>>;
  };
  modules?: {
    count: number;
    sample: string[];
  };
  networkEndpoints?: {
    count: number;
    sample: Array<Record<string, unknown>>;
  };
  storage?: {
    count: number;
    sample: string[];
  };
  native?: {
    procedureCount?: number;
    stringCount?: number;
    encryption?: Record<string, unknown>;
    warning?: string;
    evidencePath?: string;
  };
  evidencePaths: string[];
  limitations: string[];
  reportPath?: string;
  jobs: Array<{
    id: string;
    capabilityId: string;
    status: string;
    errorCode?: string;
  }>;
  completedSteps: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function artifactOf(detail: TargetDetail): ArtifactRecord | undefined {
  return detail.artifacts.find((item) => item.isCurrent) ?? detail.artifacts[0];
}

function jobResult(job: JobRecord | undefined): Record<string, unknown> {
  return record(job?.result) ?? {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class AppAnalysisService {
  constructor(private readonly server: CoreServer) {}

  async analyzeApp(options: AnalyzeAppOptions): Promise<AnalyzeAppResult> {
    const goals = options.goals?.length
      ? [...new Set(options.goals)]
      : (["tech_stack", "feature_map", "report"] satisfies AnalysisGoal[]);
    const timeoutMs = options.timeoutMs ?? 20 * 60_000;
    const completedSteps: string[] = [];
    const progress = (event: AnalysisProgress) => options.onProgress?.(event);

    let target = await this.resolveTarget(options);
    progress({ step: "resolve", status: "completed", message: target.name });

    let detail = await this.detail(target.id);
    let artifact = artifactOf(detail);
    if (!artifact) {
      progress({ step: "acquire", status: "started" });
      const acquire = await this.createJob(target.id, "acquire:app-store");
      const acquired = await this.waitForJob(acquire.id, timeoutMs);
      if (acquired.status !== "ready") {
        throw new CoreFailure(
          acquired.errorCode ?? "ACQUIRE_FAILED",
          acquired.errorMessage ?? "应用获取失败。",
          { jobId: acquired.id }
        );
      }
      completedSteps.push("acquire");
      progress({
        step: "acquire",
        status: "completed",
        jobId: acquired.id
      });
      detail = await this.detail(target.id);
      artifact = artifactOf(detail);
    }
    if (!artifact) {
      throw new CoreFailure("ARTIFACT_REQUIRED", "获取完成后没有找到 artifact。");
    }

    if (!artifact.inspection || artifact.inspection.error) {
      progress({ step: "inspect", status: "started" });
      const inspect = await this.createJob(target.id, "inspect:ipa");
      const inspected = await this.waitForJob(inspect.id, timeoutMs);
      this.requireSuccess(inspected);
      completedSteps.push("inspect");
      progress({
        step: "inspect",
        status: "completed",
        jobId: inspected.id
      });
      detail = await this.detail(target.id);
      artifact = artifactOf(detail) ?? artifact;
    }

    const wantsJavascript = goals.some((goal) =>
      ["tech_stack", "feature_map", "network"].includes(goal)
    );
    if (wantsJavascript) {
      const existing = options.force ? undefined : this.findAnalyzed(
        detail,
        ["javascript:analyze", "rea:js"],
        artifact.id,
        (result) => Boolean(result.routes && result.technology)
      );
      if (existing) {
        completedSteps.push("analyze_javascript");
        progress({
          step: "analyze_javascript",
          status: "completed",
          jobId: existing.id,
          message: "reused existing evidence"
        });
      } else {
        progress({ step: "analyze_javascript", status: "started" });
        const job = await this.createJob(target.id, "javascript:analyze");
        const completed = await this.waitForJob(job.id, timeoutMs);
        this.requireSuccess(completed);
        completedSteps.push("analyze_javascript");
        progress({
          step: "analyze_javascript",
          status: "completed",
          jobId: completed.id
        });
      }
    }

    if (goals.includes("native_risk")) {
      const existing = options.force ? undefined : this.findAnalyzed(
        detail,
        ["native:inspect", "rea:inspect"],
        artifact.id
      );
      if (existing) {
        completedSteps.push("inspect_native");
        progress({
          step: "inspect_native",
          status: "completed",
          jobId: existing.id,
          message: "reused existing evidence"
        });
      } else {
        progress({ step: "inspect_native", status: "started" });
        const job = await this.createJob(target.id, "native:inspect");
        const completed = await this.waitForJob(job.id, timeoutMs);
        this.requireSuccess(completed);
        completedSteps.push("inspect_native");
        progress({
          step: "inspect_native",
          status: "completed",
          jobId: completed.id
        });
      }
    }

    if (goals.includes("report")) {
      progress({ step: "report", status: "started" });
      const job = await this.createJob(target.id, "generate:report");
      const completed = await this.waitForJob(job.id, timeoutMs);
      this.requireSuccess(completed);
      completedSteps.push("report");
      progress({
        step: "report",
        status: "completed",
        jobId: completed.id
      });
    }

    detail = await this.detail(target.id);
    artifact = artifactOf(detail) ?? artifact;
    const javascript = jobResult(
      detail.jobs.find(
        (job) =>
          ["javascript:analyze", "rea:js"].includes(job.capabilityId) &&
          job.status === "analyzed"
      )
    );
    const native = jobResult(
      detail.jobs.find(
        (job) =>
          ["native:inspect", "rea:inspect"].includes(job.capabilityId) &&
          job.status === "analyzed"
      )
    );
    const report = jobResult(
      detail.jobs.find(
        (job) =>
          job.capabilityId === "generate:report" && job.status === "analyzed"
      )
    );
    const nativeCounts = record(native.counts) ?? {};
    const routes = record(javascript.routes);
    const modules = record(javascript.modules);
    const network = record(javascript.networkEndpoints);
    const storage = record(javascript.storage);
    const technology = record(javascript.technology);
    const limitations = Array.isArray(javascript.limitations)
      ? javascript.limitations.map(String)
      : [];
    const evidencePaths = [
      typeof javascript.evidencePath === "string"
        ? javascript.evidencePath
        : undefined,
      typeof native.evidencePath === "string" ? native.evidencePath : undefined
    ].filter((value): value is string => Boolean(value));

    return {
      targetId: target.id,
      targetName: target.name,
      sourceId: target.targetRef.sourceId,
      sourceRef: target.targetRef.sourceRef,
      artifact: {
        id: artifact.id,
        packageFormat: artifact.packageFormat,
        sha256: artifact.sha256,
        path: artifact.path,
        sizeBytes: artifact.sizeBytes,
        version: artifact.version,
        buildNumber: artifact.buildNumber
      },
      technology: technology
        ? {
            confidence: String(technology.confidence ?? "unknown"),
            hints: Array.isArray(technology.hints)
              ? technology.hints.map(String)
              : []
          }
        : undefined,
      routes: routes
        ? {
            count: numberValue(routes.count) ?? 0,
            sample: Array.isArray(routes.sample)
              ? routes.sample.map((item) => record(item) ?? {})
              : []
          }
        : undefined,
      modules: modules
        ? {
            count: numberValue(modules.count) ?? 0,
            sample: Array.isArray(modules.sample)
              ? modules.sample.map(String)
              : []
          }
        : undefined,
      networkEndpoints: network
        ? {
            count: numberValue(network.count) ?? 0,
            sample: Array.isArray(network.sample)
              ? network.sample.map((item) => record(item) ?? {})
              : []
          }
        : undefined,
      storage: storage
        ? {
            count: numberValue(storage.count) ?? 0,
            sample: Array.isArray(storage.sample)
              ? storage.sample.map(String)
              : []
          }
        : undefined,
      native:
        native.encryption || native.evidencePath
          ? {
              procedureCount: numberValue(nativeCounts.procedure_count),
              stringCount: numberValue(nativeCounts.string_count),
              encryption: record(native.encryption),
              warning:
                typeof native.warning === "string" ? native.warning : undefined,
              evidencePath:
                typeof native.evidencePath === "string"
                  ? native.evidencePath
                  : undefined
            }
          : undefined,
      evidencePaths: [...new Set(evidencePaths)],
      limitations,
      reportPath:
        typeof report.reportPath === "string" ? report.reportPath : undefined,
      jobs: detail.jobs.slice(0, 20).map((job) => ({
        id: job.id,
        capabilityId: job.capabilityId,
        status: job.status,
        errorCode: job.errorCode
      })),
      completedSteps
    };
  }

  async runCapability(
    targetId: string,
    capabilityId: string,
    input?: Record<string, unknown>,
    artifactId?: string
  ): Promise<JobRecord> {
    const job = await this.createJob(
      targetId,
      capabilityId,
      input,
      artifactId
    );
    return this.waitForJob(job.id);
  }

  async detail(targetId: string): Promise<TargetDetail> {
    return (await this.server.handle("targets:get", {
      targetId
    })) as TargetDetail;
  }

  private async resolveTarget(
    options: AnalyzeAppOptions
  ): Promise<TargetRecord> {
    if (options.targetId) {
      return (await this.detail(options.targetId)).target;
    }
    if (!options.source?.trim()) {
      throw new CoreFailure(
        "SOURCE_REQUIRED",
        "请提供 App Store 链接、App ID 或已有 targetId。"
      );
    }
    const resolved = (await this.server.handle("targets:resolve", {
      input: options.source
    })) as ResolveResult;
    return (await this.server.handle("targets:create", {
      resolutionId: resolved.resolutionId
    })) as TargetRecord;
  }

  private findAnalyzed(
    detail: TargetDetail,
    capabilityIds: string[],
    artifactId: string,
    validate: (result: Record<string, unknown>) => boolean = () => true
  ): JobRecord | undefined {
    const persistedJobs = new Set(
      this.server.store
        .listEvidence(detail.target.id)
        .map((evidence) => evidence.jobId)
    );
    return detail.jobs.find(
      (job) =>
        capabilityIds.includes(job.capabilityId) &&
        job.status === "analyzed" &&
        job.params.artifactId === artifactId &&
        persistedJobs.has(job.id) &&
        Boolean(job.result && validate(job.result))
    );
  }

  private async createJob(
    targetId: string,
    capabilityId: string,
    input?: Record<string, unknown>,
    artifactId?: string
  ): Promise<JobRecord> {
    return (await this.server.handle("jobs:create", {
      targetId,
      capabilityId,
      ...(artifactId ? { artifactId } : {}),
      ...(input ? { input } : {})
    })) as JobRecord;
  }

  private async waitForJob(
    jobId: string,
    timeoutMs = 20 * 60_000
  ): Promise<JobRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = (await this.server.handle("jobs:get", {
        jobId
      })) as { job: JobRecord };
      const job = result.job;
      if (
        ["ready", "analyzed", "failed", "cancelled", "interrupted"].includes(
          job.status
        )
      ) {
        return job;
      }
      if (
        ["awaiting_auth", "awaiting_license"].includes(job.status) &&
        job.errorCode
      ) {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new CoreFailure("JOB_TIMEOUT", "任务等待超时。", { jobId });
  }

  private requireSuccess(job: JobRecord): void {
    if (job.status === "analyzed" || job.status === "ready") return;
    throw new CoreFailure(
      job.errorCode ?? "CAPABILITY_FAILED",
      job.errorMessage ?? `能力没有完成：${job.capabilityId}`,
      { jobId: job.id }
    );
  }
}
