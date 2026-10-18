import fs from "node:fs";
import path from "node:path";
import type { ArtifactRecord, ResolvedTarget, TargetRecord } from "@zhuixin/shared";

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function targetSlug(name: string, sourceRef: string): string {
  const readable = slugify(name);
  if (readable) return readable;
  const fallback = sourceRef.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  return fallback ? `app-${fallback}` : "target";
}

export class WorkspaceService {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.root, "targets"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.root, "tmp"), { recursive: true, mode: 0o700 });
  }

  targetDir(target: TargetRecord): string {
    return path.join(
      this.root,
      "targets",
      `${target.targetRef.platform}-${target.targetRef.sourceId}-${target.slug}-${target.id.slice(0, 8)}`
    );
  }

  artifactDir(target: TargetRecord): string {
    return path.join(this.targetDir(target), "artifacts");
  }

  analysisDir(target: TargetRecord): string {
    return path.join(this.targetDir(target), "analysis");
  }

  ensureTarget(target: TargetRecord): void {
    const dir = this.targetDir(target);
    for (const subdir of ["", "artifacts", "analysis", "reports"]) {
      fs.mkdirSync(path.join(dir, subdir), { recursive: true, mode: 0o700 });
    }
  }

  saveResolvedTarget(target: TargetRecord, rawSource: unknown): void {
    this.ensureTarget(target);
    const dir = this.targetDir(target);
    this.writeJson(path.join(dir, "meta.json"), target);
    this.writeJson(path.join(dir, "source.json"), rawSource);
  }

  saveArtifactMetadata(
    target: TargetRecord,
    artifact: ArtifactRecord,
    extra: Record<string, unknown> = {}
  ): void {
    const dir = this.targetDir(target);
    this.writeJson(path.join(dir, "artifact.json"), {
      schemaVersion: 1,
      target: {
        id: target.id,
        platform: target.targetRef.platform,
        sourceId: target.targetRef.sourceId,
        sourceRef: target.targetRef.sourceRef,
        name: target.name,
        publisher: target.publisher,
        bundleId: target.bundleId,
        packageId: target.packageId
      },
      artifact: {
        packageFormat: artifact.packageFormat,
        version: artifact.version,
        build: artifact.buildNumber,
        sha256: artifact.sha256,
        size: artifact.sizeBytes,
        architectures: artifact.architecture ? [artifact.architecture] : [],
        signature: artifact.signature ?? null,
        inspection: artifact.inspection ?? null
      },
      ...extra
    });
    this.writeJson(path.join(dir, "current.json"), {
      artifactId: artifact.id,
      path: artifact.path,
      sha256: artifact.sha256,
      downloadedAt: artifact.downloadedAt
    });
  }

  artifactRelativePath(target: TargetRecord, filePath: string): string {
    return path.relative(this.root, filePath);
  }

  resolveStoredPath(relativePath: string): string {
    const resolved = path.resolve(this.root, relativePath);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error(`Path escapes workspace: ${relativePath}`);
    }
    return resolved;
  }

  writeJson(filePath: string, value: unknown): void {
    this.writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  writeText(filePath: string, value: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, value, { mode: 0o600 });
    fs.renameSync(temp, filePath);
  }
}
