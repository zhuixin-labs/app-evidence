import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  AnalysisRunRecord,
  ArtifactRecord,
  EvidenceRecord,
  FindingConfidence,
  FindingRecord,
  FindingSearchResult,
  FindingType,
  JobEvent,
  JobRecord,
  SourceId,
  TargetPlatform,
  TargetRecord
} from "@zhuixin/shared";

export interface Store {
  readonly kind: "sqlite" | "json";
  listTargets(): TargetRecord[];
  findTarget(
    platform: TargetPlatform,
    sourceId: SourceId,
    sourceRef: string
  ): TargetRecord | undefined;
  getTarget(id: string): TargetRecord | undefined;
  upsertTarget(target: TargetRecord): void;
  listArtifacts(targetId: string): ArtifactRecord[];
  insertArtifact(artifact: ArtifactRecord): void;
  setCurrentArtifact(targetId: string, artifactId: string): void;
  listJobs(targetId?: string): JobRecord[];
  getJob(id: string): JobRecord | undefined;
  upsertJob(job: JobRecord): void;
  appendEvent(event: JobEvent): void;
  listEvents(jobId: string): JobEvent[];
  insertEvidence(evidence: EvidenceRecord): void;
  listEvidence(targetId: string): EvidenceRecord[];
  insertFindings(findings: FindingRecord[]): void;
  deleteFindings(
    targetId: string,
    artifactId: string | undefined,
    types: FindingType[]
  ): void;
  searchFindings(input: {
    targetId: string;
    artifactIds?: string[];
    query?: string;
    types?: FindingType[];
    limit?: number;
    offset?: number;
  }): FindingSearchResult;
  upsertAnalysisRun(run: AnalysisRunRecord): void;
  getAnalysisRun(id: string): AnalysisRunRecord | undefined;
  interruptRunningAnalysisRuns(): number;
  close(): void;
}

interface SqliteStatement {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): Record<string, unknown> | undefined;
  all(...args: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function openSqlite(databasePath: string): SqliteDatabase | null {
  try {
    const nodeRequire = createRequire(
      typeof __filename === "string" ? __filename : import.meta.url
    );
    // Keep the builtin specifier dynamic so bundlers do not rewrite it.
    const specifier = ["node", "sqlite"].join(":");
    const module = nodeRequire(specifier) as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    return new module.DatabaseSync(databasePath);
  } catch (error) {
    console.warn(
      `[core] node:sqlite unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  publisher TEXT,
  version TEXT,
  bundle_id TEXT,
  package_id TEXT,
  icon_url TEXT,
  store_url TEXT,
  slug TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(platform, source_id, source_ref)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  package_format TEXT NOT NULL,
  architecture TEXT,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  version TEXT,
  build_number TEXT,
  signature_json TEXT,
  inspection_json TEXT,
  source_url TEXT,
  downloaded_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  UNIQUE(target_id, sha256)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  target_id TEXT,
  source_id TEXT,
  capability_id TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  params_json TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  artifact_id TEXT,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  format TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  summary_json TEXT,
  parent_evidence_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  artifact_id TEXT,
  job_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  group_name TEXT,
  source_path TEXT,
  start_line INTEGER,
  start_column INTEGER,
  end_line INTEGER,
  end_column INTEGER,
  confidence TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  target_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result_json TEXT,
  error_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_target ON artifacts(target_id);
CREATE INDEX IF NOT EXISTS idx_jobs_target ON jobs(target_id);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_evidence_target ON evidence(target_id);
CREATE INDEX IF NOT EXISTS idx_findings_target_type ON findings(target_id, type);
CREATE INDEX IF NOT EXISTS idx_findings_evidence ON findings(evidence_id);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_status ON analysis_runs(status);
`;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function targetFromRow(row: Record<string, unknown>): TargetRecord {
  return {
    id: String(row.id),
    targetRef: {
      platform: row.platform as TargetPlatform,
      sourceId: row.source_id as SourceId,
      sourceRef: String(row.source_ref)
    },
    name: String(row.name),
    publisher: row.publisher ? String(row.publisher) : undefined,
    version: row.version ? String(row.version) : undefined,
    bundleId: row.bundle_id ? String(row.bundle_id) : undefined,
    packageId: row.package_id ? String(row.package_id) : undefined,
    iconUrl: row.icon_url ? String(row.icon_url) : undefined,
    storeUrl: row.store_url ? String(row.store_url) : undefined,
    slug: String(row.slug),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function artifactFromRow(row: Record<string, unknown>): ArtifactRecord {
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    platform: row.platform as TargetPlatform,
    packageFormat: row.package_format as ArtifactRecord["packageFormat"],
    architecture: row.architecture ? String(row.architecture) : undefined,
    sha256: String(row.sha256),
    path: String(row.path),
    sizeBytes: Number(row.size_bytes),
    version: row.version ? String(row.version) : undefined,
    buildNumber: row.build_number ? String(row.build_number) : undefined,
    signature: row.signature_json
      ? parseJson<Record<string, unknown>>(row.signature_json, {})
      : undefined,
    inspection: row.inspection_json
      ? parseJson<Record<string, unknown>>(row.inspection_json, {})
      : undefined,
    sourceUrl: row.source_url ? String(row.source_url) : undefined,
    downloadedAt: String(row.downloaded_at),
    isCurrent: Number(row.is_current) === 1
  };
}

function jobFromRow(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    targetId: row.target_id ? String(row.target_id) : undefined,
    sourceId: row.source_id ? (String(row.source_id) as SourceId) : undefined,
    capabilityId: String(row.capability_id),
    status: row.status as JobRecord["status"],
    progress: Number(row.progress),
    params: parseJson<Record<string, unknown>>(row.params_json, {}),
    result: row.result_json
      ? parseJson<Record<string, unknown>>(row.result_json, {})
      : undefined,
    errorCode: row.error_code ? String(row.error_code) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : undefined,
    finishedAt: row.finished_at ? String(row.finished_at) : undefined
  };
}

function evidenceFromRow(row: Record<string, unknown>): EvidenceRecord {
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    artifactId: row.artifact_id ? String(row.artifact_id) : undefined,
    jobId: String(row.job_id),
    kind: String(row.kind),
    format: row.format as EvidenceRecord["format"],
    path: String(row.path),
    sha256: String(row.sha256),
    summary: parseJson<Record<string, unknown>>(row.summary_json, {}),
    parentEvidenceId: row.parent_evidence_id
      ? String(row.parent_evidence_id)
      : undefined,
    createdAt: String(row.created_at)
  };
}

function findingFromRow(row: Record<string, unknown>): FindingRecord {
  const numberValue = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const startLine = numberValue(row.start_line);
  const startColumn = numberValue(row.start_column);
  const endLine = numberValue(row.end_line);
  const endColumn = numberValue(row.end_column);
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    artifactId: row.artifact_id ? String(row.artifact_id) : undefined,
    jobId: String(row.job_id),
    evidenceId: String(row.evidence_id),
    type: row.type as FindingType,
    value: String(row.value),
    group: row.group_name ? String(row.group_name) : undefined,
    sourcePath: row.source_path ? String(row.source_path) : undefined,
    start:
      startLine !== undefined && startColumn !== undefined
        ? { line: startLine, column: startColumn }
        : undefined,
    end:
      endLine !== undefined && endColumn !== undefined
        ? { line: endLine, column: endColumn }
        : undefined,
    confidence: row.confidence as FindingConfidence,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: String(row.created_at)
  };
}

function analysisRunFromRow(row: Record<string, unknown>): AnalysisRunRecord {
  return {
    id: String(row.id),
    targetId: row.target_id ? String(row.target_id) : undefined,
    status: row.status as AnalysisRunRecord["status"],
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : undefined,
    result: row.result_json
      ? parseJson<Record<string, unknown>>(row.result_json, {})
      : undefined,
    error: row.error_json
      ? parseJson<AnalysisRunRecord["error"]>(row.error_json, undefined)
      : undefined,
    updatedAt: String(row.updated_at)
  };
}

export class SqliteStore implements Store {
  readonly kind = "sqlite" as const;
  private readonly db: SqliteDatabase;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    const db = openSqlite(databasePath);
    if (!db) throw new Error("node:sqlite is not available");
    this.db = db;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  listTargets(): TargetRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM targets ORDER BY updated_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map(targetFromRow);
  }

  findTarget(
    platform: TargetPlatform,
    sourceId: SourceId,
    sourceRef: string
  ): TargetRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM targets WHERE platform = ? AND source_id = ? AND source_ref = ?"
      )
      .get(platform, sourceId, sourceRef) as Record<string, unknown> | undefined;
    return row ? targetFromRow(row) : undefined;
  }

  getTarget(id: string): TargetRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM targets WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? targetFromRow(row) : undefined;
  }

  upsertTarget(target: TargetRecord): void {
    this.db
      .prepare(
        `INSERT INTO targets
          (id, platform, source_id, source_ref, name, publisher, version,
           bundle_id, package_id, icon_url, store_url, slug, metadata_json,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           publisher=excluded.publisher,
           version=excluded.version,
           bundle_id=excluded.bundle_id,
           package_id=excluded.package_id,
           icon_url=excluded.icon_url,
           store_url=excluded.store_url,
           slug=excluded.slug,
           metadata_json=excluded.metadata_json,
           updated_at=excluded.updated_at`
      )
      .run(
        target.id,
        target.targetRef.platform,
        target.targetRef.sourceId,
        target.targetRef.sourceRef,
        target.name,
        target.publisher ?? null,
        target.version ?? null,
        target.bundleId ?? null,
        target.packageId ?? null,
        target.iconUrl ?? null,
        target.storeUrl ?? null,
        target.slug,
        JSON.stringify(target.metadata),
        target.createdAt,
        target.updatedAt
      );
  }

  listArtifacts(targetId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE target_id = ? ORDER BY downloaded_at DESC")
      .all(targetId) as Record<string, unknown>[];
    return rows.map(artifactFromRow);
  }

  insertArtifact(artifact: ArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO artifacts
          (id, target_id, platform, package_format, architecture, sha256, path,
           size_bytes, version, build_number, signature_json, inspection_json,
           source_url, downloaded_at, is_current)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_id, sha256) DO UPDATE SET
           path=excluded.path,
           size_bytes=excluded.size_bytes,
           version=excluded.version,
           build_number=excluded.build_number,
           signature_json=excluded.signature_json,
           inspection_json=excluded.inspection_json,
           source_url=excluded.source_url,
           downloaded_at=excluded.downloaded_at,
           is_current=excluded.is_current`
      )
      .run(
        artifact.id,
        artifact.targetId,
        artifact.platform,
        artifact.packageFormat,
        artifact.architecture ?? null,
        artifact.sha256,
        artifact.path,
        artifact.sizeBytes,
        artifact.version ?? null,
        artifact.buildNumber ?? null,
        artifact.signature ? JSON.stringify(artifact.signature) : null,
        artifact.inspection ? JSON.stringify(artifact.inspection) : null,
        artifact.sourceUrl ?? null,
        artifact.downloadedAt,
        artifact.isCurrent ? 1 : 0
      );
  }

  setCurrentArtifact(targetId: string, artifactId: string): void {
    this.db
      .prepare("UPDATE artifacts SET is_current = 0 WHERE target_id = ?")
      .run(targetId);
    this.db
      .prepare("UPDATE artifacts SET is_current = 1 WHERE id = ? AND target_id = ?")
      .run(artifactId, targetId);
  }

  listJobs(targetId?: string): JobRecord[] {
    const rows = targetId
      ? (this.db
          .prepare("SELECT * FROM jobs WHERE target_id = ? ORDER BY created_at DESC")
          .all(targetId) as Record<string, unknown>[])
      : (this.db
          .prepare("SELECT * FROM jobs ORDER BY created_at DESC")
          .all() as Record<string, unknown>[]);
    return rows.map(jobFromRow);
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? jobFromRow(row) : undefined;
  }

  upsertJob(job: JobRecord): void {
    this.db
      .prepare(
        `INSERT INTO jobs
          (id, target_id, source_id, capability_id, status, progress, params_json,
           result_json, error_code, error_message, created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status=excluded.status,
           progress=excluded.progress,
           result_json=excluded.result_json,
           error_code=excluded.error_code,
           error_message=excluded.error_message,
           started_at=excluded.started_at,
           finished_at=excluded.finished_at`
      )
      .run(
        job.id,
        job.targetId ?? null,
        job.sourceId ?? null,
        job.capabilityId,
        job.status,
        job.progress,
        JSON.stringify(job.params),
        job.result ? JSON.stringify(job.result) : null,
        job.errorCode ?? null,
        job.errorMessage ?? null,
        job.createdAt,
        job.startedAt ?? null,
        job.finishedAt ?? null
      );
  }

  appendEvent(event: JobEvent): void {
    this.db
      .prepare(
        `INSERT INTO job_events (job_id, level, message, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        event.jobId,
        event.level,
        event.message,
        event.payload ? JSON.stringify(event.payload) : null,
        event.createdAt
      );
  }

  listEvents(jobId: string): JobEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY id ASC")
      .all(jobId) as Record<string, unknown>[];
    return rows.map((row) => ({
      jobId: String(row.job_id),
      level: row.level as JobEvent["level"],
      message: String(row.message),
      payload: row.payload_json
        ? parseJson<Record<string, unknown>>(row.payload_json, {})
        : undefined,
      createdAt: String(row.created_at)
    }));
  }

  insertEvidence(evidence: EvidenceRecord): void {
    this.db
      .prepare(
        `INSERT INTO evidence
          (id, target_id, artifact_id, job_id, kind, format, path, sha256,
           summary_json, parent_evidence_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           summary_json=excluded.summary_json,
           path=excluded.path,
           sha256=excluded.sha256`
      )
      .run(
        evidence.id,
        evidence.targetId,
        evidence.artifactId ?? null,
        evidence.jobId,
        evidence.kind,
        evidence.format,
        evidence.path,
        evidence.sha256,
        JSON.stringify(evidence.summary),
        evidence.parentEvidenceId ?? null,
        evidence.createdAt
      );
  }

  listEvidence(targetId: string): EvidenceRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM evidence WHERE target_id = ? ORDER BY created_at DESC"
      )
      .all(targetId) as Record<string, unknown>[];
    return rows.map(evidenceFromRow);
  }

  insertFindings(findings: FindingRecord[]): void {
    if (findings.length === 0) return;
    const statement = this.db.prepare(
      `INSERT INTO findings
        (id, target_id, artifact_id, job_id, evidence_id, type, value,
         group_name, source_path, start_line, start_column, end_line,
         end_column, confidence, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         value=excluded.value,
         metadata_json=excluded.metadata_json`
    );
    this.db.exec("BEGIN");
    try {
      for (const finding of findings) {
        statement.run(
          finding.id,
          finding.targetId,
          finding.artifactId ?? null,
          finding.jobId,
          finding.evidenceId,
          finding.type,
          finding.value,
          finding.group ?? null,
          finding.sourcePath ?? null,
          finding.start?.line ?? null,
          finding.start?.column ?? null,
          finding.end?.line ?? null,
          finding.end?.column ?? null,
          finding.confidence,
          JSON.stringify(finding.metadata),
          finding.createdAt
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteFindings(
    targetId: string,
    artifactId: string | undefined,
    types: FindingType[]
  ): void {
    if (types.length === 0) return;
    const clauses = ["target_id = ?"];
    const params: unknown[] = [targetId];
    if (artifactId) {
      clauses.push("artifact_id = ?");
      params.push(artifactId);
    }
    clauses.push(`type IN (${types.map(() => "?").join(", ")})`);
    params.push(...types);
    this.db
      .prepare(`DELETE FROM findings WHERE ${clauses.join(" AND ")}`)
      .run(...params);
  }

  searchFindings(input: {
    targetId: string;
    artifactIds?: string[];
    query?: string;
    types?: FindingType[];
    limit?: number;
    offset?: number;
  }): FindingSearchResult {
    const limit = Math.min(1000, Math.max(1, input.limit ?? 50));
    const offset = Math.max(0, input.offset ?? 0);
    const query = input.query?.trim();
    const clauses = ["target_id = ?"];
    const params: unknown[] = [input.targetId];
    if (query) {
      clauses.push(
        "(value LIKE ? ESCAPE '\\' OR COALESCE(source_path, '') LIKE ? ESCAPE '\\')"
      );
      const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
      params.push(pattern, pattern);
    }
    if (input.artifactIds?.length) {
      clauses.push(
        `artifact_id IN (${input.artifactIds.map(() => "?").join(", ")})`
      );
      params.push(...input.artifactIds);
    }
    if (input.types?.length) {
      clauses.push(`type IN (${input.types.map(() => "?").join(", ")})`);
      params.push(...input.types);
    }
    const where = clauses.join(" AND ");
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM findings WHERE ${where}`)
      .get(...params) as Record<string, unknown> | undefined;
    const rows = this.db
      .prepare(
        `SELECT * FROM findings WHERE ${where}
         ORDER BY created_at DESC, type, value
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Record<string, unknown>[];
    return {
      items: rows.map(findingFromRow),
      total: Number(countRow?.total ?? 0),
      limit,
      offset
    };
  }

  upsertAnalysisRun(run: AnalysisRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO analysis_runs
          (id, target_id, status, started_at, finished_at, result_json,
           error_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status=excluded.status,
           finished_at=excluded.finished_at,
           result_json=excluded.result_json,
           error_json=excluded.error_json,
           updated_at=excluded.updated_at`
      )
      .run(
        run.id,
        run.targetId ?? null,
        run.status,
        run.startedAt,
        run.finishedAt ?? null,
        run.result ? JSON.stringify(run.result) : null,
        run.error ? JSON.stringify(run.error) : null,
        run.updatedAt
      );
  }

  getAnalysisRun(id: string): AnalysisRunRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM analysis_runs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? analysisRunFromRow(row) : undefined;
  }

  interruptRunningAnalysisRuns(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE analysis_runs
         SET status = 'interrupted', finished_at = ?, updated_at = ?,
             error_json = ?
         WHERE status = 'running'`
      )
      .run(
        now,
        now,
        JSON.stringify({
          code: "ANALYSIS_INTERRUPTED",
          message: "The MCP process exited before analysis completed."
        })
      );
    return Number((result as { changes?: number }).changes ?? 0);
  }

  close(): void {
    this.db.close();
  }
}

interface JsonData {
  targets: TargetRecord[];
  artifacts: ArtifactRecord[];
  jobs: JobRecord[];
  events: JobEvent[];
  evidence: EvidenceRecord[];
  findings: FindingRecord[];
  analysisRuns: AnalysisRunRecord[];
}

export class JsonStore implements Store {
  readonly kind = "json" as const;
  private readonly filePath: string;
  private data: JsonData;

  constructor(databasePath: string) {
    this.filePath = databasePath.replace(/\.sqlite$/i, "") + ".json";
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.data = this.load();
  }

  private load(): JsonData {
    if (!fs.existsSync(this.filePath)) {
      return {
        targets: [],
        artifacts: [],
        jobs: [],
        events: [],
        evidence: [],
        findings: [],
        analysisRuns: []
      };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<JsonData>;
      return {
        targets: parsed.targets ?? [],
        artifacts: parsed.artifacts ?? [],
        jobs: parsed.jobs ?? [],
        events: parsed.events ?? [],
        evidence: parsed.evidence ?? [],
        findings: parsed.findings ?? [],
        analysisRuns: parsed.analysisRuns ?? []
      };
    } catch {
      return {
        targets: [],
        artifacts: [],
        jobs: [],
        events: [],
        evidence: [],
        findings: [],
        analysisRuns: []
      };
    }
  }

  private save(): void {
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }

  listTargets(): TargetRecord[] {
    return [...this.data.targets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  findTarget(
    platform: TargetPlatform,
    sourceId: SourceId,
    sourceRef: string
  ): TargetRecord | undefined {
    return this.data.targets.find(
      (target) =>
        target.targetRef.platform === platform &&
        target.targetRef.sourceId === sourceId &&
        target.targetRef.sourceRef === sourceRef
    );
  }

  getTarget(id: string): TargetRecord | undefined {
    return this.data.targets.find((target) => target.id === id);
  }

  upsertTarget(target: TargetRecord): void {
    const index = this.data.targets.findIndex((item) => item.id === target.id);
    if (index >= 0) this.data.targets[index] = target;
    else this.data.targets.push(target);
    this.save();
  }

  listArtifacts(targetId: string): ArtifactRecord[] {
    return this.data.artifacts
      .filter((artifact) => artifact.targetId === targetId)
      .sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
  }

  insertArtifact(artifact: ArtifactRecord): void {
    const index = this.data.artifacts.findIndex(
      (item) => item.targetId === artifact.targetId && item.sha256 === artifact.sha256
    );
    if (index >= 0) this.data.artifacts[index] = artifact;
    else this.data.artifacts.push(artifact);
    this.save();
  }

  setCurrentArtifact(targetId: string, artifactId: string): void {
    for (const artifact of this.data.artifacts) {
      if (artifact.targetId === targetId) artifact.isCurrent = artifact.id === artifactId;
    }
    this.save();
  }

  listJobs(targetId?: string): JobRecord[] {
    return this.data.jobs
      .filter((job) => !targetId || job.targetId === targetId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getJob(id: string): JobRecord | undefined {
    return this.data.jobs.find((job) => job.id === id);
  }

  upsertJob(job: JobRecord): void {
    const index = this.data.jobs.findIndex((item) => item.id === job.id);
    if (index >= 0) this.data.jobs[index] = job;
    else this.data.jobs.push(job);
    this.save();
  }

  appendEvent(event: JobEvent): void {
    this.data.events.push(event);
    this.save();
  }

  listEvents(jobId: string): JobEvent[] {
    return this.data.events.filter((event) => event.jobId === jobId);
  }

  insertEvidence(evidence: EvidenceRecord): void {
    const index = this.data.evidence.findIndex((item) => item.id === evidence.id);
    if (index >= 0) this.data.evidence[index] = evidence;
    else this.data.evidence.push(evidence);
    this.save();
  }

  listEvidence(targetId: string): EvidenceRecord[] {
    return this.data.evidence
      .filter((item) => item.targetId === targetId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  insertFindings(findings: FindingRecord[]): void {
    for (const finding of findings) {
      const index = this.data.findings.findIndex((item) => item.id === finding.id);
      if (index >= 0) this.data.findings[index] = finding;
      else this.data.findings.push(finding);
    }
    if (findings.length > 0) this.save();
  }

  deleteFindings(
    targetId: string,
    artifactId: string | undefined,
    types: FindingType[]
  ): void {
    if (types.length === 0) return;
    this.data.findings = this.data.findings.filter(
      (finding) =>
        finding.targetId !== targetId ||
        (artifactId !== undefined && finding.artifactId !== artifactId) ||
        !types.includes(finding.type)
    );
    this.save();
  }

  searchFindings(input: {
    targetId: string;
    artifactIds?: string[];
    query?: string;
    types?: FindingType[];
    limit?: number;
    offset?: number;
  }): FindingSearchResult {
    const limit = Math.min(1000, Math.max(1, input.limit ?? 50));
    const offset = Math.max(0, input.offset ?? 0);
    const query = input.query?.trim().toLowerCase();
    const matching = this.data.findings
      .filter((finding) => finding.targetId === input.targetId)
      .filter(
        (finding) =>
          !input.artifactIds?.length ||
          (finding.artifactId !== undefined &&
            input.artifactIds.includes(finding.artifactId))
      )
      .filter(
        (finding) =>
          !input.types?.length || input.types.includes(finding.type)
      )
      .filter(
        (finding) =>
          !query ||
          finding.value.toLowerCase().includes(query) ||
          finding.sourcePath?.toLowerCase().includes(query)
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          a.type.localeCompare(b.type) ||
          a.value.localeCompare(b.value)
      );
    return {
      items: matching.slice(offset, offset + limit),
      total: matching.length,
      limit,
      offset
    };
  }

  upsertAnalysisRun(run: AnalysisRunRecord): void {
    const index = this.data.analysisRuns.findIndex((item) => item.id === run.id);
    if (index >= 0) this.data.analysisRuns[index] = run;
    else this.data.analysisRuns.push(run);
    this.save();
  }

  getAnalysisRun(id: string): AnalysisRunRecord | undefined {
    return this.data.analysisRuns.find((item) => item.id === id);
  }

  interruptRunningAnalysisRuns(): number {
    const now = new Date().toISOString();
    let count = 0;
    for (const run of this.data.analysisRuns) {
      if (run.status !== "running") continue;
      run.status = "interrupted";
      run.finishedAt = now;
      run.updatedAt = now;
      run.error = {
        code: "ANALYSIS_INTERRUPTED",
        message: "The MCP process exited before analysis completed."
      };
      count += 1;
    }
    if (count > 0) this.save();
    return count;
  }

  close(): void {
    this.save();
  }
}

export function createStore(databasePath: string): Store {
  try {
    return new SqliteStore(databasePath);
  } catch (error) {
    console.warn(
      `[core] SQLite unavailable, falling back to JSON store: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return new JsonStore(databasePath);
  }
}
