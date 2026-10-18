import { z } from "zod";

export type TargetPlatform = "ios" | "windows" | "macos" | "android" | "linux";
export type HostPlatform = "darwin" | "win32" | "linux";
export type SourceId =
  | "app-store"
  | "local-file"
  | "direct-url"
  | "microsoft-store"
  | "winget";
export type PackageFormat =
  | "ipa"
  | "msix"
  | "appx"
  | "exe"
  | "msi"
  | "zip"
  | "dmg"
  | "apk";

export interface TargetRef {
  platform: TargetPlatform;
  sourceId: SourceId;
  sourceRef: string;
}

export interface ResolvedTarget {
  targetRef: TargetRef;
  name: string;
  publisher?: string;
  version?: string;
  bundleId?: string;
  packageId?: string;
  iconUrl?: string;
  storeUrl?: string;
  metadata: Record<string, unknown>;
}

export interface TargetRecord extends ResolvedTarget {
  id: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  targetId: string;
  platform: TargetPlatform;
  packageFormat: PackageFormat;
  architecture?: string;
  sha256: string;
  path: string;
  sizeBytes: number;
  version?: string;
  buildNumber?: string;
  signature?: Record<string, unknown>;
  inspection?: Record<string, unknown>;
  sourceUrl?: string;
  downloadedAt: string;
  isCurrent: boolean;
}

export type FindingType =
  | "technology"
  | "route"
  | "network_endpoint"
  | "module"
  | "asset"
  | "storage"
  | "native_procedure"
  | "native_string"
  | "risk"
  | "limitation";

export type FindingConfidence =
  | "exact"
  | "high"
  | "medium"
  | "low"
  | "unknown";

export interface FindingRecord {
  id: string;
  targetId: string;
  artifactId?: string;
  jobId: string;
  evidenceId: string;
  type: FindingType;
  value: string;
  group?: string;
  sourcePath?: string;
  start?: { line: number; column: number };
  end?: { line: number; column: number };
  confidence: FindingConfidence;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EvidenceRecord {
  id: string;
  targetId: string;
  artifactId?: string;
  jobId: string;
  kind: string;
  format: "json" | "markdown" | "text";
  path: string;
  sha256: string;
  summary: Record<string, unknown>;
  parentEvidenceId?: string;
  createdAt: string;
}

export interface FindingSearchResult {
  items: FindingRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface AnalysisRunRecord {
  id: string;
  targetId?: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
  updatedAt: string;
}

export type JobStatus =
  | "queued"
  | "resolving"
  | "awaiting_auth"
  | "awaiting_license"
  | "acquiring"
  | "inspecting"
  | "registering"
  | "ready"
  | "analyzing"
  | "analyzed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface JobRecord {
  id: string;
  targetId?: string;
  sourceId?: SourceId;
  capabilityId: string;
  status: JobStatus;
  progress: number;
  params: Record<string, unknown>;
  result?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobEvent {
  jobId: string;
  level: "info" | "warn" | "error";
  message: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface SourceDescriptor {
  id: SourceId;
  platform: TargetPlatform;
  displayName: string;
  requiresAuth: boolean;
  status: "ready" | "preview" | "evaluate";
  description: string;
}

export interface CapabilityDescriptor {
  id: string;
  label: string;
  description: string;
  targetPlatforms: TargetPlatform[];
  packageFormats?: PackageFormat[];
  hostPlatforms?: HostPlatform[];
  available: boolean;
  reason?: string;
  requiresArtifact?: boolean;
  requiresInput?: "function" | "query";
}

export interface ResolveResult {
  resolutionId: string;
  target: ResolvedTarget;
  provider: SourceDescriptor;
}

export interface TargetDetail {
  target: TargetRecord;
  artifacts: ArtifactRecord[];
  jobs: JobRecord[];
}

export interface CoreError {
  code: string;
  message: string;
  details?: unknown;
}

export interface HealthInfo {
  version: string;
  workspaceRoot: string;
  hostPlatform: HostPlatform;
  store: "sqlite" | "json";
  tools?: ToolInfo[];
}

export interface ToolInfo {
  id: string;
  label: string;
  path: string;
  available: boolean;
}

export interface AccountStatus {
  authenticated: boolean;
  email?: string;
  name?: string;
  keychain: "unlocked" | "locked" | "unknown";
  checkedAt: string;
  message?: string;
}

export interface EntitlementRecord {
  appId?: string | number;
  bundleId?: string;
  name: string;
  version?: string;
  platform?: string;
}

export interface AccountEntitlements {
  items: EntitlementRecord[];
  checkedAt: string;
  truncated: boolean;
  error?: string;
}

export interface EntitlementCheck {
  status: "owned" | "not_owned" | "unknown";
  checkedAt: string;
  message?: string;
  entitlement?: EntitlementRecord;
}

export interface CoreRequest<T = unknown> {
  id: string;
  channel: string;
  payload: T;
}

export type CoreResponse<T = unknown> =
  | { id: string; ok: true; data: T }
  | { id: string; ok: false; error: CoreError };

export type CoreEvent =
  | { type: "job.updated"; payload: JobRecord }
  | { type: "job.log"; payload: JobEvent }
  | { type: "target.updated"; payload: TargetRecord }
  | { type: "terminal.data"; payload: { sessionId: string; data: string } }
  | {
      type: "terminal.exit";
      payload: { sessionId: string; code: number | null; signal?: string | null };
    };

export const CHANNELS = {
  health: "health",
  sourcesList: "sources:list",
  targetsResolve: "targets:resolve",
  targetsCreate: "targets:create",
  targetsList: "targets:list",
  targetsGet: "targets:get",
  jobsCreate: "jobs:create",
  jobsGet: "jobs:get",
  jobsCancel: "jobs:cancel",
  capabilitiesList: "capabilities:list",
  findingsSearch: "findings:search",
  evidenceList: "evidence:list",
  terminalStart: "terminal:start",
  terminalInput: "terminal:input",
  terminalStop: "terminal:stop",
  accountStatus: "account:status",
  accountEntitlements: "account:entitlements",
  accountCheckEntitlement: "account:check-entitlement"
} as const;

export const resolveInputSchema = z.object({
  input: z.string().trim().min(1).max(4096)
});

export const createTargetSchema = z.object({
  resolutionId: z.string().min(1).max(128)
});

export const createJobSchema = z.object({
  targetId: z.string().uuid(),
  capabilityId: z.string().trim().min(1).max(128),
  artifactId: z.string().uuid().optional(),
  input: z
    .object({
      functionName: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z_$][A-Za-z0-9_$.@:-]{0,255}$/)
        .optional(),
      query: z.string().trim().min(1).max(512).optional(),
      kind: z.enum(["procedures", "strings"]).optional(),
      mode: z.enum(["literal", "regex"]).optional()
    })
    .strict()
    .optional()
});

export const findingsSearchSchema = z.object({
  targetId: z.string().uuid(),
  query: z.string().trim().max(512).optional(),
  types: z
    .array(
      z.enum([
        "technology",
        "route",
        "network_endpoint",
        "module",
        "asset",
        "storage",
        "native_procedure",
        "native_string",
        "risk",
        "limitation"
      ])
    )
    .optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional()
});

export const evidenceListSchema = z.object({
  targetId: z.string().uuid()
});

export const capabilitiesListSchema = z
  .object({
    targetId: z.string().uuid().optional()
  })
  .optional();

export const targetIdSchema = z.object({
  targetId: z.string().uuid()
});

export const jobIdSchema = z.object({
  jobId: z.string().uuid()
});

export const terminalStartSchema = z.object({
  kind: z.literal("ipatool-auth")
});

export const terminalInputSchema = z.object({
  sessionId: z.string().uuid(),
  data: z.string().max(16_384)
});

export const terminalStopSchema = z.object({
  sessionId: z.string().uuid()
});

export const accountStatusSchema = z.object({
  force: z.boolean().optional()
});

export const accountCheckSchema = z
  .object({
    appId: z.union([z.string(), z.number()]).optional(),
    bundleId: z.string().optional()
  })
  .refine((value) => value.appId !== undefined || value.bundleId !== undefined, {
    message: "appId or bundleId is required"
  });

export function parseAppStoreId(input: string): { appId: number; country: string } | null {
  const trimmed = input.trim();
  const numeric = trimmed.match(/^\d+$/);
  if (numeric) {
    return { appId: Number(numeric[0]), country: "cn" };
  }

  const idMatch = trimmed.match(/(?:\/id|\bid=)(\d+)/);
  if (!idMatch) return null;

  const countryMatch = trimmed.match(/apps\.apple\.com\/([a-z]{2})\//i);
  return {
    appId: Number(idMatch[1]),
    country: (countryMatch?.[1] ?? "cn").toLowerCase()
  };
}
