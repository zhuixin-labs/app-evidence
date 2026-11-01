#!/usr/bin/env node
/**
 * Runs the demo commands for real and writes transcript.json.
 *
 * The video is a replay of this file, so nothing in it is invented: every line
 * came out of the CLI. Re-run this after changing the CLI and the video follows.
 *
 *   node scripts/demo/capture.mjs --target <target-id> [--force]
 *
 * It never runs `auth login` and never records interactive prompts: a demo that
 * captured a password prompt would put credentials in the video.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const target = value("--target") ?? process.argv[2];
if (!target || target.startsWith("--")) {
  console.error("Usage: node scripts/demo/capture.mjs --target <target-id> [--force]");
  process.exit(1);
}
const force = argv.includes("--force");
// Point this at a throwaway workspace to keep the demo away from real targets.
const workspace = value("--workspace");
const cli = path.join(root, "packages", "cli", "dist", "index.js");
if (!fs.existsSync(cli)) {
  console.error(`Build the CLI first: pnpm build (missing ${cli})`);
  process.exit(1);
}

const NOISE = [
  /^\(node:\d+\) ExperimentalWarning/,
  /^\(Use `node --trace-warnings/,
  /^\s*$/
];

const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

function run(args) {
  // Merge stderr into stdout through the shell so progress lines keep their real
  // order relative to the summary instead of arriving as a separate block.
  const command = [process.execPath, cli, ...args].map(quote).join(" ");
  const result = spawnSync("/bin/sh", ["-c", `${command} 2>&1`], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      ...(workspace ? { APPTRACE_WORKSPACE_ROOT: workspace } : {})
    },
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed: apptrace ${args.join(" ")}\n${String(result.stdout).slice(-2000)}`
    );
  }
  return String(result.stdout).split("\n");
}

function clean(lines) {
  return lines.filter((line) => !NOISE.some((pattern) => pattern.test(line)));
}

function firstBlock(lines, limit) {
  return lines.slice(0, limit);
}

const steps = [
  {
    cmd: "apptrace targets list",
    args: ["targets", "list"],
    pick: (lines) => {
      const body = clean(lines);
      const count = body.findIndex((line) => /target\(s\) in the local workspace/.test(line));
      const table = body.slice(0, 5);
      return count >= 0 ? [...table, "", body[count]] : table;
    }
  },
  {
    cmd: `apptrace analyze --target ${target.slice(0, 8)}…${force ? " --force" : ""}`,
    args: ["analyze", "--target", target, ...(force ? ["--force"] : [])],
    pick: (lines) => {
      const body = clean(lines);
      const progress = body.filter((line) => line.startsWith("["));
      const start = body.findIndex((line) => line && !line.startsWith("["));
      const summaryEnd = body.findIndex((line) => line.startsWith("Limitations:"));
      const summary = body.slice(start, summaryEnd > 0 ? summaryEnd : undefined);
      const kept = summary.filter(
        (line) =>
          !line.startsWith("Evidence:") &&
          !line.startsWith("Target:") &&
          !line.startsWith("Artifact:") &&
          !line.startsWith("Host:")
      );
      while (kept.length > 0 && kept[0] === "") kept.shift();
      return [...progress, "", ...kept];
    }
  },
  {
    cmd: `apptrace search ${target.slice(0, 8)}… hong --limit 4`,
    args: ["search", target, "hong", "--limit", "4"],
    pick: (lines) => firstBlock(clean(lines), 7)
  },
  {
    cmd: `apptrace native search ${target.slice(0, 8)}… main`,
    args: ["native", "search", target, "main", "--kind", "procedures"],
    pick: (lines) => {
      const body = clean(lines);
      const header = body.slice(0, 2);
      const rows = body.slice(2).filter((line) => line.trim().length > 0);
      const real = rows.filter((line) => line.startsWith("0x"));
      return [...header, ...(real.length >= 3 ? real : rows).slice(0, 5)];
    }
  },
  {
    cmd: `apptrace report ${target.slice(0, 8)}…`,
    args: ["report", target],
    pick: (lines) => {
      const body = clean(lines);
      return body
        .filter((line) => !line.startsWith("Evidence: every section"))
        .slice(0, 2);
    }
  }
];

const transcript = [];
for (const step of steps) {
  process.stderr.write(`capturing: ${step.cmd}\n`);
  const lines = step.pick(run(step.args));
  transcript.push({ cmd: step.cmd, out: lines });
}

const outFile = path.join(here, "transcript.json");
fs.writeFileSync(outFile, `${JSON.stringify(transcript, null, 2)}\n`);
process.stderr.write(`wrote ${outFile} (${transcript.reduce((n, s) => n + s.out.length, 0)} lines)\n`);
