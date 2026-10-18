import { createHash, randomUUID } from "node:crypto";
import {
  spawn,
  type ChildProcessByStdio
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Readable } from "node:stream";
import type {
  ArtifactRecord,
  CoreEvent,
  JobEvent,
  JobRecord,
  TargetRecord
} from "@zhuixin/shared";
import { CoreFailure, fail } from "../errors.js";
import type { CoreConfig } from "../config.js";
import type { Store } from "../store.js";
import type { WorkspaceService } from "../workspace.js";

type LogLevel = JobEvent["level"];
type LineHandler = (stream: "stdout" | "stderr", line: string) => void;

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function now(): string {
  return new Date().toISOString();
}

function redact(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "***@***")
    .replace(/(passphrase|password|token|cookie|authorization)\s*[:=]\s*\S+/gi, "$1=***");
}

function classifyIpatoolFailure(output: string): CoreFailure {
  const text = output.toLowerCase();
  if (text.includes("passphrase") || text.includes("unlock")) {
    return new CoreFailure("KEYCHAIN_LOCKED", "本地 keychain 需要解锁。");
  }
  if (text.includes("license is required") || text.includes("license required")) {
    return new CoreFailure("LICENSE_REQUIRED", "当前 Apple 账号没有这个应用的商店许可。");
  }
  if (
    text.includes("credential") ||
    text.includes("auth") ||
    text.includes("login") ||
    text.includes("unauthorized")
  ) {
    return new CoreFailure("AUTH_REQUIRED", "ipatool 尚未登录，或登录态已失效。");
  }
  return new CoreFailure("STORE_AUTH_FAILED", "App Store 请求失败，请检查账号、条款和网络。");
}

export class AcquireJobRunner {
  private readonly active = new Map<string, ChildProcessByStdio<null, Readable, Readable>>();

  constructor(
    private readonly store: Store,
    private readonly workspace: WorkspaceService,
    private readonly config: CoreConfig,
    private readonly emit: (event: CoreEvent) => void
  ) {}

  createAcquireJob(targetId: string): JobRecord {
    const target = this.store.getTarget(targetId);
    if (!target) fail("TARGET_NOT_FOUND", "Target 不存在。");
    if (target.targetRef.sourceId !== "app-store") {
      fail("SOURCE_NOT_ENABLED", "当前只实现 App Store 的 acquire job。");
    }

    const job: JobRecord = {
      id: randomUUID(),
      targetId: target.id,
      sourceId: target.targetRef.sourceId,
      capabilityId: "acquire:app-store",
      status: "queued",
      progress: 0,
      params: { sourceRef: target.targetRef.sourceRef },
      createdAt: now()
    };
    this.store.upsertJob(job);
    this.emit({ type: "job.updated", payload: job });
    void this.runAcquire(job, target);
    return job;
  }

  cancel(jobId: string): JobRecord | undefined {
    const job = this.store.getJob(jobId);
    if (!job) return undefined;
    if (job.status === "ready" || job.status === "failed" || job.status === "cancelled") {
      return job;
    }

    const child = this.active.get(jobId);
    if (child) child.kill("SIGTERM");
    this.patchJob(job, {
      status: "cancelled",
      errorCode: "JOB_CANCELLED",
      errorMessage: "任务已取消。",
      finishedAt: now()
    });
    this.log(job, "warn", "任务已取消。");
    return job;
  }

  private async runAcquire(job: JobRecord, target: TargetRecord): Promise<void> {
    try {
      this.patchJob(job, {
        status: "awaiting_auth",
        progress: 5,
        startedAt: now(),
        errorCode: undefined,
        errorMessage: undefined
      });
      this.log(job, "info", "检查 ipatool 登录状态。");
      if (String(job.status) === "cancelled") return;

      const auth = await this.runProcess(
        job,
        this.config.ipatoolPath,
        ["auth", "info", "--format", "json", "--non-interactive"],
        60_000
      );
      if (String(job.status) === "cancelled") return;
      if (auth.code !== 0) {
        throw classifyIpatoolFailure(`${auth.stdout}\n${auth.stderr}`);
      }
      const authJson = safeJson(auth.stdout);
      if (authJson && authJson.success === false) {
        throw new CoreFailure("AUTH_REQUIRED", "ipatool 尚未登录。");
      }

      this.patchJob(job, {
        status: "acquiring",
        progress: 10,
        errorCode: undefined,
        errorMessage: undefined
      });
      this.log(job, "info", "开始获取 IPA。");
      if (String(job.status) === "cancelled") return;

      const tempPath = path.join(this.workspace.root, "tmp", `${job.id}.ipa`);
      fs.mkdirSync(path.dirname(tempPath), { recursive: true, mode: 0o700 });
      fs.rmSync(tempPath, { force: true });

      const download = await this.runProcess(
        job,
        this.config.ipatoolPath,
        [
          "download",
          "--app-id",
          target.targetRef.sourceRef,
          "--platform",
          "iphone",
          "--output",
          tempPath,
          "--non-interactive"
        ],
        30 * 60_000,
        (_stream, line) => {
          const clean = redact(line.trim());
          if (!clean) return;
          this.log(job, "info", clean);
          const percent = clean.match(/(\d{1,3})%/);
          if (percent) {
            const value = Math.min(75, 10 + Math.floor(Number(percent[1]) * 0.65));
            this.patchJob(job, { progress: value });
          }
        }
      );
      if (String(job.status) === "cancelled") return;
      if (download.code !== 0) {
        throw classifyIpatoolFailure(`${download.stdout}\n${download.stderr}`);
      }
      if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size === 0) {
        throw new CoreFailure("ARTIFACT_INVALID", "ipatool 没有产出有效的 IPA 文件。");
      }

      this.patchJob(job, { status: "inspecting", progress: 80 });
      this.log(job, "info", "计算哈希并登记 artifact。");

      const sha256 = await hashFile(tempPath);
      const sizeBytes = fs.statSync(tempPath).size;
      const version = (target.version ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${version}-${sha256.slice(0, 12)}.ipa`;
      const artifactPath = path.join(this.workspace.artifactDir(target), filename);
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(artifactPath)) {
        fs.rmSync(tempPath, { force: true });
      } else {
        fs.renameSync(tempPath, artifactPath);
      }

      const artifact: ArtifactRecord = {
        id: randomUUID(),
        targetId: target.id,
        platform: "ios",
        packageFormat: "ipa",
        sha256,
        path: this.workspace.artifactRelativePath(target, artifactPath),
        sizeBytes,
        version: target.version,
        sourceUrl: target.storeUrl,
        downloadedAt: now(),
        isCurrent: true
      };

      this.patchJob(job, { status: "registering", progress: 92 });
      this.store.insertArtifact(artifact);
      this.store.setCurrentArtifact(target.id, artifact.id);
      this.workspace.saveArtifactMetadata(target, artifact, {
        source: {
          storeUrl: target.storeUrl,
          downloadedAt: artifact.downloadedAt,
          provider: "app-store"
        }
      });

      this.patchJob(job, {
        status: "ready",
        progress: 100,
        result: {
          artifactId: artifact.id,
          sha256,
          sizeBytes,
          path: artifact.path
        },
        finishedAt: now()
      });
      this.log(job, "info", "IPA 已登记，可以继续运行分析能力。", {
        sha256,
        sizeBytes
      });
    } catch (error) {
      this.handleFailure(job, error);
    }
  }

  private handleFailure(job: JobRecord, error: unknown): void {
    if (job.status === "cancelled") return;
    const failure =
      error instanceof CoreFailure
        ? error
        : new CoreFailure(
            "ACQUIRE_FAILED",
            error instanceof Error ? error.message : String(error)
          );
    const waiting =
      failure.code === "AUTH_REQUIRED" ||
      failure.code === "KEYCHAIN_LOCKED" ||
      failure.code === "LICENSE_REQUIRED";
    this.patchJob(job, {
      status:
        failure.code === "AUTH_REQUIRED" || failure.code === "KEYCHAIN_LOCKED"
          ? "awaiting_auth"
          : failure.code === "LICENSE_REQUIRED"
            ? "awaiting_license"
            : "failed",
      errorCode: failure.code,
      errorMessage: failure.message,
      finishedAt: waiting ? undefined : now()
    });
    this.log(job, waiting ? "warn" : "error", failure.message, {
      code: failure.code,
      ...(failure.details ? { details: failure.details } : {})
    });
  }

  private patchJob(job: JobRecord, patch: Partial<JobRecord>): void {
    Object.assign(job, patch);
    this.store.upsertJob(job);
    this.emit({ type: "job.updated", payload: { ...job } });
  }

  private log(
    job: JobRecord,
    level: LogLevel,
    message: string,
    payload?: Record<string, unknown>
  ): void {
    const event: JobEvent = {
      jobId: job.id,
      level,
      message: redact(message),
      payload,
      createdAt: now()
    };
    this.store.appendEvent(event);
    this.emit({ type: "job.log", payload: event });
  }

  private runProcess(
    job: JobRecord,
    command: string,
    args: string[],
    timeoutMs: number,
    onLine?: LineHandler
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(command, args, {
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        reject(
          new CoreFailure(
            "TOOL_MISSING",
            `无法启动 ipatool：${error instanceof Error ? error.message : String(error)}`
          )
        );
        return;
      }

      this.active.set(job.id, child);
      const stdout: string[] = [];
      const stderr: string[] = [];
      let settled = false;
      let timedOut = false;

      const outReader = readline.createInterface({ input: child.stdout });
      const errReader = readline.createInterface({ input: child.stderr });
      outReader.on("line", (line) => {
        stdout.push(line);
        onLine?.("stdout", line);
      });
      errReader.on("line", (line) => {
        stderr.push(line);
        onLine?.("stderr", line);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(job.id);
        reject(
          new CoreFailure(
            "TOOL_MISSING",
            `无法启动 ipatool：${error.message}`
          )
        );
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(job.id);
        if (timedOut) {
          reject(new CoreFailure("PROCESS_TIMEOUT", "ipatool 执行超时。"));
          return;
        }
        resolve({
          code,
          stdout: stdout.join("\n"),
          stderr: stderr.join("\n")
        });
      });
    });
  }
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
