/**
 * Human-readable rendering for CLI commands.
 *
 * These are pure functions over the JSON that the core already returns, so the
 * `--json` path stays the source of truth and the text path cannot drift from
 * it silently. Every renderer degrades to an explicit line when its input is
 * empty or the job failed, instead of printing "undefined" or an empty table.
 */

export interface TargetRow {
  id: string;
  name?: string;
  version?: string;
  publisher?: string;
  targetRef?: { platform?: string; sourceId?: string; sourceRef?: string };
}

export interface FindingRow {
  type: string;
  value: string;
  sourcePath?: string;
  start?: { line: number; column: number };
  evidenceId?: string;
  confidence?: string;
}

export interface CapabilityRow {
  id: string;
  label?: string;
  available?: boolean;
  reason?: string;
}

export interface EvidenceRow {
  kind?: string;
  path?: string;
  sha256?: string;
  format?: string;
}

export interface JobLike {
  id?: string;
  targetId?: string;
  capabilityId?: string;
  status?: string;
  progress?: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: Record<string, unknown>;
  events?: unknown[];
}

export interface CompareDiff {
  [category: string]: { added?: string[]; removed?: string[]; unchanged?: string[] };
}

function chars(value: string): string[] {
  return [...value];
}

function clip(value: string, width: number): string {
  const list = chars(value);
  if (list.length <= width) return value;
  return `${list.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function padEnd(value: string, width: number): string {
  const length = chars(value).length;
  return length >= width ? value : value + " ".repeat(width - length);
}

/** Column widths are a cap, not a promise: narrow content stays narrow. */
export function table(
  headers: string[],
  rows: string[][],
  widths: number[]
): string[] {
  // The last column is not clipped: it is usually the payload (name, path,
  // symbol) and truncating it hides the thing the user came for.
  const limit = (index: number) =>
    index === headers.length - 1 ? Number.POSITIVE_INFINITY : (widths[index] ?? 40);
  const head = headers.map((header, index) => clip(header, limit(index)));
  const body = rows.map((row) =>
    row.map((cell, index) => clip(cell ?? "", limit(index)))
  );
  const measured = headers.map((_, index) =>
    Math.min(
      widths[index] ?? 40,
      Math.max(...[head, ...body].map((row) => chars(row[index] ?? "").length))
    )
  );
  return [head, ...body].map((row) =>
    row
      .map((cell, index) => padEnd(cell, measured[index]))
      .join("  ")
      .trimEnd()
  );
}

function shortEvidence(value: string | undefined): string {
  if (!value) return "—";
  return value.length > 18 ? `${value.slice(0, 18)}…` : value;
}

function baseName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

function location(finding: FindingRow): string {
  if (!finding.sourcePath) return "—";
  const name = baseName(finding.sourcePath);
  return finding.start ? `${name}:${finding.start.line}:${finding.start.column}` : name;
}

function resultOf(job: JobLike): Record<string, unknown> {
  return job.result ?? {};
}

export function failureOf(job: JobLike): string | undefined {
  if (job.errorMessage) return `${job.errorCode ?? "error"}: ${job.errorMessage}`;
  if (job.errorCode) return job.errorCode;
  if (job.status && job.status !== "analyzed") {
    return `job ${job.status}${job.progress !== undefined ? ` (${job.progress}%)` : ""}`;
  }
  return undefined;
}

export function renderTargets(targets: TargetRow[]): string {
  if (targets.length === 0) {
    return [
      "No targets yet.",
      "Analyze one first: apptrace analyze <app-store-url>",
      "or a local bundle:  apptrace analyze /Applications/Foo.app"
    ].join("\n");
  }
  const rows = targets.map((target) => [
    target.id,
    target.targetRef?.platform ?? "—",
    target.version ?? "—",
    target.name ?? "—"
  ]);
  return [
    ...table(["TARGET ID", "PLATFORM", "VERSION", "NAME"], rows, [36, 8, 14, 48]),
    "",
    `${targets.length} target(s) in the local workspace`
  ].join("\n");
}

export function renderFindings(input: {
  items?: FindingRow[];
  total?: number;
  query?: string;
}): string {
  const items = input.items ?? [];
  if (items.length === 0) {
    return input.query
      ? `No findings matched "${input.query}".`
      : "No findings recorded for this target yet.";
  }
  const total = input.total ?? items.length;
  const header =
    total > items.length
      ? `${total} finding(s), ${items.length} shown${input.query ? ` for "${input.query}"` : ""}`
      : `${total} finding(s)${input.query ? ` for "${input.query}"` : ""}`;
  const rows = items.map((item) => [
    item.type,
    item.value,
    location(item),
    shortEvidence(item.evidenceId)
  ]);
  return [
    header,
    "",
    ...table(["TYPE", "VALUE", "LOCATION", "EVIDENCE"], rows, [20, 64, 40, 20])
  ].join("\n");
}

export function renderNativeSearch(job: JobLike): string {
  const failure = failureOf(job);
  if (failure) return `native search failed — ${failure}`;
  const result = resultOf(job);
  const query = String(result.query ?? "");
  const kind = String(result.kind ?? "procedures");
  const mode = String(result.mode ?? "literal");
  const matches = Array.isArray(result.matches)
    ? (result.matches as Array<{ address?: string; value?: string }>)
    : [];
  const count = typeof result.matchCount === "number" ? result.matchCount : matches.length;
  if (matches.length === 0) {
    return `native:search "${query}" (${kind}, ${mode}) — no match.`;
  }
  const rows = matches.map((match) => [
    String(match.address ?? "—"),
    String(match.value ?? "")
  ]);
  const shown =
    count > matches.length ? `${count} matches, ${matches.length} shown` : `${count} matches`;
  return [
    `native:search "${query}" (${kind}, ${mode}) — ${shown}`,
    "",
    ...table(["ADDRESS", "SYMBOL"], rows, [24, 96])
  ].join("\n");
}

export function renderDecompile(job: JobLike): string {
  const failure = failureOf(job);
  if (failure) return `native decompile failed — ${failure}`;
  const result = resultOf(job);
  const name = String(result.functionName ?? "");
  const pseudocode =
    typeof result.pseudocodePreview === "string" ? result.pseudocodePreview : undefined;
  if (!pseudocode) {
    const path = typeof result.evidencePath === "string" ? result.evidencePath : undefined;
    return [
      `native:decompile ${name}`,
      "",
      "The provider returned no pseudocode preview.",
      path ? `Evidence: ${path}` : "",
      "Run with --json for the full result."
    ]
      .filter(Boolean)
      .join("\n");
  }
  const path = typeof result.evidencePath === "string" ? result.evidencePath : undefined;
  return [
    `native:decompile ${name}`,
    "",
    pseudocode.trimEnd(),
    "",
    path ? `Evidence: ${path}` : ""
  ]
    .filter((line, index, all) => line !== "" || all[index + 1] !== "")
    .join("\n")
    .trimEnd();
}

export function renderReportJob(job: JobLike): string {
  const failure = failureOf(job);
  if (failure) return `report failed — ${failure}`;
  const path = resultOf(job).reportPath;
  if (typeof path !== "string") return "Report generated, but the job returned no path.";
  return [`Report: ${path}`, "Evidence: every section links to a finding evidence ID."].join("\n");
}

export function renderCapabilities(items: CapabilityRow[]): string {
  if (items.length === 0) return "No capabilities reported.";
  const available = items.filter((item) => item.available);
  const missing = items.filter((item) => !item.available);
  const lines = [
    `Available (${available.length})`,
    ...table(
      ["", "CAPABILITY", "WHAT IT DOES"],
      available.map((item) => ["OK", item.id, item.label ?? ""]),
      [2, 22, 96]
    )
  ];
  if (missing.length > 0) {
    lines.push(
      "",
      `Unavailable (${missing.length})`,
      ...table(
        ["", "CAPABILITY", "REASON"],
        missing.map((item) => ["--", item.id, item.reason ?? "not available on this host"]),
        [2, 22, 96]
      )
    );
  }
  return lines.join("\n");
}

export function renderEvidence(items: EvidenceRow[]): string {
  if (items.length === 0) return "No evidence recorded for this target yet.";
  const rows = items.map((item) => [
    item.kind ?? "—",
    item.format ?? "—",
    shortEvidence(item.sha256),
    item.path ?? "—"
  ]);
  return [
    `${items.length} evidence file(s)`,
    "",
    ...table(["KIND", "FORMAT", "SHA-256", "PATH"], rows, [20, 8, 20, 88])
  ].join("\n");
}

export function renderCompare(diff: CompareDiff): string {
  const categories = Object.keys(diff);
  if (categories.length === 0) return "No comparison data returned.";
  const rows = categories.map((category) => {
    const entry = diff[category] ?? {};
    return [
      category,
      String(entry.added?.length ?? 0),
      String(entry.removed?.length ?? 0),
      String(entry.unchanged?.length ?? 0)
    ];
  });
  const lines = [
    ...table(["CATEGORY", "ADDED", "REMOVED", "UNCHANGED"], rows, [22, 8, 8, 10])
  ];
  for (const category of categories) {
    const entry = diff[category] ?? {};
    const added = entry.added ?? [];
    const removed = entry.removed ?? [];
    if (added.length === 0 && removed.length === 0) continue;
    lines.push("", `${category}`);
    for (const value of added.slice(0, 20)) lines.push(`  + ${value}`);
    for (const value of removed.slice(0, 20)) lines.push(`  - ${value}`);
    const hidden = Math.max(0, added.length - 20) + Math.max(0, removed.length - 20);
    if (hidden > 0) lines.push(`  … ${hidden} more (use --json for the full diff)`);
  }
  return lines.join("\n");
}

export function renderJob(job: JobLike): string {
  const lines = [
    `Job: ${job.id ?? "—"}`,
    `Capability: ${job.capabilityId ?? "—"}`,
    `Status: ${job.status ?? "—"}${job.progress !== undefined ? ` (${job.progress}%)` : ""}`
  ];
  const failure = failureOf(job);
  if (failure && job.errorMessage) lines.push(`Failure: ${failure}`);
  if (job.startedAt) lines.push(`Started: ${job.startedAt}`);
  if (job.finishedAt) lines.push(`Finished: ${job.finishedAt}`);
  const events = Array.isArray(job.events) ? job.events : [];
  if (events.length > 0) {
    lines.push("", `Events (last ${Math.min(events.length, 20)})`);
    for (const raw of events.slice(-20)) {
      const event = (raw ?? {}) as Record<string, unknown>;
      const at =
        typeof event.createdAt === "string"
          ? event.createdAt.replace("T", " ").slice(0, 19)
          : "";
      const level = typeof event.level === "string" ? event.level : "info";
      const message = typeof event.message === "string" ? event.message : "";
      lines.push(`  ${at} [${level}] ${message}`.trimEnd());
    }
  }
  return lines.join("\n");
}
