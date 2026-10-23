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
import { requireBackgroundCredentials, credentialFailure } from "../account/ipatool.js";
import { trackChild } from "../process/children.js";
import { extractAppZip, type ExtractResult } from "../sources/appArchive.js";

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
  if (credentialFailure(output) === "access_failed") return new CoreFailure("CREDENTIAL_ACCESS_FAILED", "Windows credentials cannot be read or decrypted. Check the current user and credential store; existing credentials will not be overwritten.");
  if (credentialFailure(output) === "locked") {
    return new CoreFailure("KEYCHAIN_LOCKED", "The local keychain is locked.");
  }
  if (text.includes("license is required") || text.includes("license required")) {
    return new CoreFailure("LICENSE_REQUIRED", "This Apple account has no store license for the app.");
  }
  if (
    text.includes("credential") ||
    text.includes("auth") ||
    text.includes("login") ||
    text.includes("unauthorized")
  ) {
    return new CoreFailure("AUTH_REQUIRED", "ipatool is not signed in, or the session expired.");
  }
  return new CoreFailure("STORE_AUTH_FAILED", "App Store request failed; check the account, terms and network.");
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
    if (!target) fail("TARGET_NOT_FOUND", "Target not found.");
    const capabilityId =
      target.targetRef.sourceId === "app-store"
        ? "acquire:app-store"
        : target.targetRef.sourceId === "local-file"
          ? "acquire:local-file"
          : undefined;
    if (!capabilityId) {
      fail("SOURCE_NOT_ENABLED", `No acquire job for source ${target.targetRef.sourceId}.`);
    }

    const job: JobRecord = {
      id: randomUUID(),
      targetId: target.id,
      sourceId: target.targetRef.sourceId,
      capabilityId,
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
      errorMessage: "Job cancelled.",
      finishedAt: now()
    });
    this.log(job, "warn", "Job cancelled.");
    return job;
  }

  private async runAcquire(job: JobRecord, target: TargetRecord): Promise<void> {
    try {
      if (job.capabilityId === "acquire:local-file") {
        await this.runLocalFile(job, target);
        return;
      }
      await requireBackgroundCredentials(this.config);
      this.patchJob(job, {
        status: "awaiting_auth",
        progress: 5,
        startedAt: now(),
        errorCode: undefined,
        errorMessage: undefined
      });
      this.log(job, "info", "Checking ipatool sign-in state.");
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
        throw new CoreFailure("AUTH_REQUIRED", "ipatool is not signed in.");
      }

      this.patchJob(job, {
        status: "acquiring",
        progress: 10,
        errorCode: undefined,
        errorMessage: undefined
      });
      this.log(job, "info", "Starting IPA acquisition.");
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
        throw new CoreFailure("ARTIFACT_INVALID", "ipatool did not produce a valid IPA file.");
      }

      this.patchJob(job, { status: "inspecting", progress: 80 });
      this.log(job, "info", "Hashing and registering the artifact.");

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
      this.log(job, "info", "IPA registered; analysis capabilities can run.", {
        sha256,
        sizeBytes
      });
    } catch (error) {
      this.handleFailure(job, error);
    }
  }

  /**
   * A local `.app` is referenced, not copied: a link inside the workspace keeps
   * `resolveStoredPath` working while the user's original bundle stays untouched.
   * A `.zip` is extracted into the workspace first, and the extracted bundle
   * becomes the artifact.
   */
  private async runLocalFile(job: JobRecord, target: TargetRecord): Promise<void> {
    if (target.targetRef.platform === "windows") {
      await this.runLocalWindowsApp(job, target);
      return;
    }
    const sourcePath = target.targetRef.sourceRef;
    try {
      const archive = /\.zip$/i.test(sourcePath);
      const stat = fs.statSync(sourcePath, { throwIfNoEntry: false });
      if (!stat || (archive ? !stat.isFile() : !stat.isDirectory())) {
        throw new CoreFailure("ARTIFACT_INVALID", `App bundle not found: ${sourcePath}`);
      }
      this.patchJob(job, { status: "inspecting", progress: 10, startedAt: now() });

      let bundlePath = sourcePath;
      const limitations: string[] = [];
      let archiveInfo: Record<string, unknown> | undefined;
      if (archive) {
        this.log(job, "info", "Extracting the app from the archive.");
        const zipSha256 = await hashFile(sourcePath);
        const extracted = await this.extractArchive(target, sourcePath, zipSha256);
        bundlePath = extracted.appPath;
        archiveInfo = { path: sourcePath, sha256: zipSha256 };
        if (extracted.skippedSymlinks > 0) {
          limitations.push(
            `${extracted.skippedSymlinks} symbolic links in the archive were not recreated; framework aliases may be missing.`
          );
        }
        if (extracted.skipped.length > 0) {
          limitations.push(
            `${extracted.skipped.length} archive entries cannot exist on this host and were skipped (for example ${extracted.skipped.slice(0, 3).join("; ")}).`
          );
        }
      }
      if (!fs.existsSync(path.join(bundlePath, "Contents", "Info.plist"))) {
        throw new CoreFailure("ARTIFACT_INVALID", "Contents/Info.plist is missing.");
      }
      this.patchJob(job, { progress: 20 });
      this.log(job, "info", "Hashing the app bundle.");
      const digest = await hashBundle(bundlePath);
      if (digest.unreadable.length > 0) {
        limitations.push(
          `${digest.unreadable.length} files or folders could not be read and are not part of the hash, for example ${digest.unreadable.slice(0, 3).join("; ")}.`
        );
      }

      let artifactPath = bundlePath;
      if (!archive) {
        const version = (target.version ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
        artifactPath = path.join(
          this.workspace.artifactDir(target),
          `${version}-${digest.sha256.slice(0, 12)}.app`
        );
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true, mode: 0o700 });
        linkBundle(bundlePath, artifactPath);
      }

      const artifact: ArtifactRecord = {
        id: randomUUID(),
        targetId: target.id,
        platform: "macos",
        packageFormat: "app",
        sha256: digest.sha256,
        path: this.workspace.artifactRelativePath(target, artifactPath),
        sizeBytes: digest.sizeBytes,
        version: target.version,
        sourceUrl: sourcePath,
        downloadedAt: now(),
        isCurrent: true
      };

      this.patchJob(job, { status: "registering", progress: 90 });
      this.store.insertArtifact(artifact);
      this.store.setCurrentArtifact(target.id, artifact.id);
      this.workspace.saveArtifactMetadata(target, artifact, {
        source: {
          provider: "local-file",
          bundlePath: archive ? undefined : sourcePath,
          archive: archiveInfo,
          fileCount: digest.fileCount
        }
      });
      this.patchJob(job, {
        status: "ready",
        progress: 100,
        result: {
          artifactId: artifact.id,
          sha256: digest.sha256,
          sizeBytes: digest.sizeBytes,
          fileCount: digest.fileCount,
          path: artifact.path,
          limitations
        },
        finishedAt: now()
      });
      this.log(job, "info", "Bundle registered; analysis capabilities can run.", {
        sha256: digest.sha256,
        fileCount: digest.fileCount
      });
    } catch (error) {
      this.handleFailure(job, error);
    }
  }

  /**
   * An installed Windows program is referenced the same way as a macOS bundle:
   * a junction in the workspace, the user's install directory untouched.
   */
  private async runLocalWindowsApp(job: JobRecord, target: TargetRecord): Promise<void> {
    const sourcePath = target.targetRef.sourceRef;
    try {
      const stat = fs.statSync(sourcePath, { throwIfNoEntry: false });
      if (!stat?.isDirectory()) {
        throw new CoreFailure("ARTIFACT_INVALID", `Install directory not found: ${sourcePath}`);
      }
      this.patchJob(job, { status: "inspecting", progress: 10, startedAt: now() });
      this.log(job, "info", "Hashing the install directory.");
      const digest = await hashBundle(sourcePath);
      const limitations: string[] = [];
      if (digest.unreadable.length > 0) {
        limitations.push(
          `${digest.unreadable.length} files or folders could not be read (locked by a running program or access denied) and are not part of the hash, for example ${digest.unreadable.slice(0, 3).join("; ")}.`
        );
      }

      const version = (target.version ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
      const artifactPath = path.join(
        this.workspace.artifactDir(target),
        `${version}-${digest.sha256.slice(0, 12)}.dir`
      );
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true, mode: 0o700 });
      linkBundle(sourcePath, artifactPath);

      const artifact: ArtifactRecord = {
        id: randomUUID(),
        targetId: target.id,
        platform: "windows",
        packageFormat: "exe",
        sha256: digest.sha256,
        path: this.workspace.artifactRelativePath(target, artifactPath),
        sizeBytes: digest.sizeBytes,
        version: target.version,
        sourceUrl: sourcePath,
        downloadedAt: now(),
        isCurrent: true
      };

      this.patchJob(job, { status: "registering", progress: 90 });
      this.store.insertArtifact(artifact);
      this.store.setCurrentArtifact(target.id, artifact.id);
      this.workspace.saveArtifactMetadata(target, artifact, {
        source: {
          provider: "local-file",
          installPath: sourcePath,
          fileCount: digest.fileCount
        }
      });
      this.patchJob(job, {
        status: "ready",
        progress: 100,
        result: {
          artifactId: artifact.id,
          sha256: digest.sha256,
          sizeBytes: digest.sizeBytes,
          fileCount: digest.fileCount,
          path: artifact.path,
          limitations
        },
        finishedAt: now()
      });
      this.log(job, "info", "Install directory registered; analysis capabilities can run.", {
        sha256: digest.sha256,
        fileCount: digest.fileCount
      });
    } catch (error) {
      this.handleFailure(job, error);
    }
  }

  /**
   * Extraction is keyed by the archive digest, so analyzing the same zip again
   * reuses the previous result instead of unpacking a large bundle twice.
   */
  private async extractArchive(
    target: TargetRecord,
    zipPath: string,
    zipSha256: string
  ): Promise<ExtractResult> {
    const dest = path.join(this.workspace.artifactDir(target), "extracted", zipSha256.slice(0, 12));
    const marker = path.join(dest, ".extracted.json");
    try {
      const previous = JSON.parse(fs.readFileSync(marker, "utf8")) as ExtractResult;
      if (fs.existsSync(path.join(previous.appPath, "Contents", "Info.plist"))) return previous;
    } catch {
      // Not extracted yet, or the marker is damaged: extract again.
    }
    const result = await extractAppZip(zipPath, dest);
    fs.writeFileSync(marker, JSON.stringify(result), { mode: 0o600 });
    return result;
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
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });
        trackChild(child);
      } catch (error) {
        reject(
          new CoreFailure(
            "TOOL_MISSING",
            `Could not start ipatool: ${error instanceof Error ? error.message : String(error)}`
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
            `Could not start ipatool: ${error.message}`
          )
        );
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(job.id);
        if (timedOut) {
          reject(new CoreFailure("PROCESS_TIMEOUT", "ipatool timed out."));
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

/**
 * Points the workspace at the bundle without copying it. Windows symlinks need
 * elevation or Developer Mode, while a junction works for any user.
 */
export function linkBundle(sourcePath: string, linkPath: string): void {
  if (fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
    fs.rmSync(linkPath, { force: true });
  }
  fs.symlinkSync(sourcePath, linkPath, process.platform === "win32" ? "junction" : "dir");
}

export async function hashBundle(root: string): Promise<{
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  /** Files or folders that could not be read, such as ones a running program holds open. */
  unreadable: string[];
}> {
  const files: Array<{ full: string; relative: string }> = [];
  const unreadable: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (dir !== root && (code === "EPERM" || code === "EACCES" || code === "ENOENT")) {
        unreadable.push(`${path.relative(root, dir).split(path.sep).join("/")}/`);
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files.push({ full, relative: path.relative(root, full).split(path.sep).join("/") });
      }
    }
  };
  walk(root);
  // Sort the "/"-normalized path: sorting native paths orders "A\b" and "A0"
  // differently on Windows and macOS, which would change the digest.
  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));

  const bundleHash = createHash("sha256");
  let sizeBytes = 0;
  const unreadableFiles: string[] = [];
  for (const { full, relative } of files) {
    try {
      const fileHash = await hashFile(full);
      const size = fs.statSync(full).size;
      sizeBytes += size;
      bundleHash.update(`${relative}\0${size}\0${fileHash}\n`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES" && code !== "ENOENT") {
        throw error;
      }
      unreadableFiles.push(relative);
    }
  }
  return {
    sha256: bundleHash.digest("hex"),
    sizeBytes,
    fileCount: files.length - unreadableFiles.length,
    unreadable: [...unreadable, ...unreadableFiles]
  };
}
