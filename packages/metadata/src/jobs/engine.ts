import { randomUUID } from "node:crypto";
import type { CoreEvent, JobRecord, TargetRecord } from "@zhuixin/shared";
import { EngineClient } from "@zhuixin/engine-client";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { CoreConfig } from "../config.js";
import { fail } from "../errors.js";
import type { Store } from "../store.js";
import type { WorkspaceService } from "../workspace.js";

export class EngineCapabilityRunner {
  constructor(
    private readonly store: Store,
    private readonly workspace: WorkspaceService,
    private readonly config: CoreConfig,
    private readonly registry: CapabilityRegistry,
    private readonly emit: (event: CoreEvent) => void
  ) {}

  create(
    targetId: string,
    requestedCapabilityId: string,
    input: Record<string, unknown> = {},
    artifactId?: string
  ): JobRecord {
    const target = this.store.getTarget(targetId);
    if (!target) fail("TARGET_NOT_FOUND", "Target 不存在。");
    const artifacts = this.store.listArtifacts(targetId);
    const artifact = artifactId
      ? artifacts.find((item) => item.id === artifactId)
      : artifacts.find((item) => item.isCurrent) ?? artifacts[0];
    if (!artifact) fail("ARTIFACT_REQUIRED", "请先获取 artifact。");
    const capability = this.registry.get(requestedCapabilityId, {
      target,
      artifact
    });
    if (!capability) fail("CAPABILITY_NOT_FOUND", requestedCapabilityId);
    if (!capability.available) {
      fail("CAPABILITY_UNAVAILABLE", capability.reason ?? "能力不可用。");
    }
    const job: JobRecord = {
      id: randomUUID(),
      targetId,
      sourceId: target.targetRef.sourceId,
      capabilityId: capability.id,
      status: "queued",
      progress: 0,
      params: { artifactId: artifact.id, input },
      createdAt: new Date().toISOString()
    };
    this.store.upsertJob(job);
    this.emit({ type: "job.updated", payload: job });
    void this.run(job, target, artifact.id, input);
    return job;
  }

  private async run(
    job: JobRecord,
    target: TargetRecord,
    artifactId: string,
    input: Record<string, unknown>
  ): Promise<void> {
    const client = new EngineClient(this.config.enginePath);
    try {
      this.patch(job, { status: "analyzing", progress: 5, startedAt: new Date().toISOString() });
      await client.execute(this.workspace.root, job.capabilityId as never, {
        targetId: target.id,
        artifactId,
        values: { ...input, jobId: job.id },
        licenseToken: this.config.licenseToken
      });
      // The engine writes the completed job and evidence into the shared workspace.
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.patch(job, {
          status: "failed",
          errorCode: "ENGINE_FAILED",
          errorMessage: message,
          finishedAt: new Date().toISOString()
        });
      } catch {
        // The metadata process may already be shutting down after observing the
        // engine result. The engine's persisted job is authoritative.
      }
    } finally {
      client.close();
    }
  }

  cancel(jobId: string): JobRecord | undefined {
    const job = this.store.getJob(jobId);
    if (!job) return undefined;
    this.patch(job, {
      status: "cancelled",
      errorCode: "JOB_CANCELLED",
      errorMessage: "任务已取消。",
      finishedAt: new Date().toISOString()
    });
    return job;
  }

  private patch(job: JobRecord, patch: Partial<JobRecord>): void {
    Object.assign(job, patch);
    this.store.upsertJob(job);
    this.emit({ type: "job.updated", payload: { ...job } });
  }
}
