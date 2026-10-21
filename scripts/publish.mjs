#!/usr/bin/env node
/**
 * Publishes the public Open Core packages in dependency order.
 *
 * Behaviour:
 *  - Skips a package when the exact version already exists on npm,
 *    so a partially failed release can be re-run safely.
 *  - Refuses to publish when workspace package versions drift apart.
 *  - Refuses to publish on a `vX.Y.Z` tag that does not match the package version.
 *  - Prints a per-package summary at the end.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distTag = process.env.PUBLISH_DIST_TAG || "latest";
const provenance = process.env.PUBLISH_PROVENANCE !== "0";
const dryRun = process.env.PUBLISH_DRY_RUN === "1";

// Dependency order: a package must never be published before its workspace deps.
const packages = [
  "protocol",
  "shared",
  "engine-client",
  "metadata",
  "mcp",
  "cli",
];

const readJson = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));

const rootManifest = readJson("package.json");
const summary = [];
const versions = new Set();

for (const dir of packages) {
  const manifest = readJson(join("packages", dir, "package.json"));
  if (manifest.private) {
    throw new Error(`${manifest.name} is marked private but is listed for publishing`);
  }
  versions.add(manifest.version);

  const pkgRoot = join(root, "packages", dir);
  for (const entry of manifest.files || []) {
    if (!existsSync(join(pkgRoot, entry))) {
      throw new Error(`${manifest.name} declares "${entry}" but it is missing. Run pnpm build.`);
    }
  }
  if (manifest.main && !existsSync(join(pkgRoot, manifest.main))) {
    throw new Error(`${manifest.name} entry "${manifest.main}" is missing. Run pnpm build.`);
  }
}

if (versions.size !== 1) {
  throw new Error(`Workspace package versions drifted apart: ${[...versions].join(", ")}`);
}

const version = [...versions][0];
const ref = process.env.GITHUB_REF || "";
const tagMatch = /^refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(ref);
if (tagMatch && tagMatch[1] !== version) {
  throw new Error(
    `Tag v${tagMatch[1]} does not match package version ${version}. ` +
      `Bump the version or use workflow_dispatch.`,
  );
}

console.log(`Publishing ${packages.length} packages at v${version} with dist-tag "${distTag}"`);
console.log(`Repository version: ${rootManifest.version}`);

/**
 * Registry reads lag behind writes, so `npm view` is not a reliable
 * "already published" check. Publish, then classify the npm rejection.
 */
const alreadyPublished = (output) =>
  /EPUBLISHCONFLICT|cannot publish over|previously published|already published|cannot be republished/i.test(
    output,
  );

for (const dir of packages) {
  const manifest = readJson(join("packages", dir, "package.json"));
  const name = manifest.name;

  const args = [
    "--filter",
    name,
    "publish",
    "--tag",
    distTag,
    "--no-git-checks",
    "--access",
    "public",
  ];
  if (provenance) args.push("--provenance");
  if (dryRun) args.push("--dry-run");

  console.log(`\n== Publishing ${name}@${version}`);
  const result = spawnSync("pnpm", args, { cwd: root, encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status === 0) {
    summary.push([name, dryRun ? "dry run ok" : "published"]);
    continue;
  }
  if (alreadyPublished(`${result.stdout}\n${result.stderr}`)) {
    summary.push([name, "already published"]);
    continue;
  }
  summary.push([name, "FAILED"]);
  console.error(`\nFailed to publish ${name}@${version}`);
  printSummary();
  throw new Error(`pnpm publish failed for ${name}@${version}`);
}

printSummary();

function printSummary() {
  console.log("\n== Publish summary");
  for (const [name, state] of summary) {
    console.log(`  ${name.padEnd(24)} ${state}`);
  }
}
