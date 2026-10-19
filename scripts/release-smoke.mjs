#!/usr/bin/env node
/**
 * Release smoke test: install the shipped artifact the way a user would, then
 * verify the parts that only break outside the monorepo.
 *
 *   node scripts/release-smoke.mjs --source tarballs   # pre-publish gate
 *   node scripts/release-smoke.mjs --source registry   # post-publish check
 *
 * Exit code 1 means the release must not go out (or must be fixed forward).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = option("--source", "registry");
const registry = option("--registry", "https://registry.npmjs.org/");
const version = option(
  "--version",
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version
);
const retries = Number(option("--retries", source === "registry" ? "8" : "1"));
const retryDelay = Number(option("--retry-delay", "30"));
const keep = argv.includes("--keep");
const analyzeUrl = option("--analyze", undefined);

const packages = ["protocol", "shared", "engine-client", "metadata", "mcp", "cli"];
const results = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace-smoke-"));

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    ...options
  });

const check = (name, fn) => {
  try {
    const detail = fn();
    results.push([name, "ok", detail ?? ""]);
  } catch (error) {
    results.push([name, "FAIL", error instanceof Error ? error.message : String(error)]);
  }
};

function installFromTarballs() {
  const packed = path.join(tmp, "packages");
  fs.mkdirSync(packed, { recursive: true });
  for (const name of packages) {
    run("pnpm", ["pack", "--pack-destination", packed], {
      cwd: path.join(root, "packages", name)
    });
  }
  const project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), '{"name":"smoke","private":true}\n');
  const tarballs = fs
    .readdirSync(packed)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => path.join(packed, file));
  run("npm", [
    "install",
    ...tarballs,
    "--registry",
    registry,
    "--cache",
    path.join(tmp, "cache"),
    "--no-audit",
    "--no-fund"
  ], { cwd: project, capture: true });
  return path.join(project, "node_modules", "@zhuixin", "cli", "dist", "index.js");
}

function installFromRegistry() {
  const prefix = path.join(tmp, "prefix");
  run("npm", [
    "install",
    "-g",
    `@zhuixin/cli@${version}`,
    "--prefix",
    prefix,
    "--cache",
    path.join(tmp, "cache"),
    "--registry",
    registry,
    "--no-audit",
    "--no-fund"
  ], { capture: true });
  return path.join(
    prefix,
    "lib",
    "node_modules",
    "@zhuixin",
    "cli",
    "dist",
    "index.js"
  );
}

function installWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return source === "tarballs" ? installFromTarballs() : installFromRegistry();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      process.stderr.write(
        `install attempt ${attempt}/${retries} failed, retrying in ${retryDelay}s ` +
          "(registry propagation)\n"
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelay * 1000);
    }
  }
  throw lastError;
}

function callMcp(entry, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let buffer = "";
    let settled = false;
    const pending = new Map();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      child.kill();
      error ? reject(error) : resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
          }
        } catch {
          // Servers may log to stdout; ignore non-JSON lines.
        }
      }
    });
    child.stderr.on("data", () => {});
    child.on("exit", () => finish(new Error("MCP server exited early")));
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (id, method, params) =>
      new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`${method} timed out`)), 30000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          message.error ? rej(new Error(JSON.stringify(message.error))) : res(message.result);
        });
        send({ jsonrpc: "2.0", id, method, params });
      });

    (async () => {
      const init = await request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "release-smoke", version: "0.0.0" }
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools = await request(2, "tools/list", {});
      const call = await request(3, "tools/call", {
        name: "list_targets",
        arguments: {}
      });
      finish(null, { init, tools: tools.tools ?? [], call });
    })().catch((error) => finish(error));
  });
}

async function main() {
  const cli = installWithRetry();
  process.stdout.write(`installed cli: ${cli}\n`);
  const workspace = path.join(tmp, "workspace");
  const env = { ...process.env, APPTRACE_WORKSPACE_ROOT: workspace };

  let doctor;
  check("doctor reports a working install", () => {
    doctor = JSON.parse(
      run(process.execPath, [cli, "doctor", "--json"], { env, capture: true })
    );
    if (doctor.health?.version !== version) {
      throw new Error(
        `version mismatch: doctor=${doctor.health?.version} package=${version}`
      );
    }
    return `v${doctor.health.version}`;
  });

  check("analysis engine is installed with the CLI", () => {
    const engine = doctor.health.tools.find((tool) => tool.id === "rea");
    if (!engine?.available) throw new Error("engine tool missing or unavailable");
    if (!fs.existsSync(engine.path)) throw new Error(`engine path missing: ${engine.path}`);
    return engine.path;
  });

  check("REA analysis backend is installed with the CLI", () => {
    const rea = doctor.health.tools.find((tool) => tool.id === "analysis-cli");
    if (!rea?.available) throw new Error("REA command missing or unavailable");
    if (!fs.existsSync(rea.path)) throw new Error(`REA path missing: ${rea.path}`);
    return rea.path;
  });

  check("IPA inspection and JavaScript analysis are available", () => {
    const ids = ["inspect:ipa", "javascript:analyze"];
    const missing = ids.filter(
      (id) => !doctor.capabilities.find((cap) => cap.id === id && cap.available)
    );
    if (missing.length) throw new Error(`unavailable: ${missing.join(", ")}`);
    return ids.join(", ");
  });

  const configPath = path.join(tmp, "mcp.json");
  check("agent config points at files that exist", () => {
    run(process.execPath, [cli, "setup", "--write-config", configPath, "--json"], {
      env,
      capture: true
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const entry = config.mcpServers.apptrace;
    const files = [
      entry.args[0],
      entry.env.APPTRACE_ENGINE_PATH,
      entry.env.APPTRACE_ANALYSIS_ENGINE_PATH
    ].filter(Boolean);
    if (files.length < 3) throw new Error("config is missing engine or REA");
    for (const file of files) {
      if (!fs.existsSync(file)) throw new Error(`missing: ${file}`);
    }
    return entry.args[0];
  });

  await checkAsync("agent sees the MCP surface and can call a tool", async () => {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const entry = config.mcpServers.apptrace;
    const result = await callMcp(entry.args[0], entry.env);
    const required = [
      "prepare_environment",
      "get_setup_status",
      "open_login",
      "analyze_app",
      "get_analysis_run",
      "list_targets",
      "auth_status",
      "get_job",
      "search_findings",
      "search_native",
      "decompile_function",
      "compare_versions",
      "generate_report",
      "list_evidence",
      "list_capabilities"
    ];
    const names = new Set(result.tools.map((tool) => tool.name));
    const missing = required.filter((name) => !names.has(name));
    if (missing.length) {
      throw new Error(`missing tools: ${missing.join(", ")}`);
    }
    return `${result.tools.length} tools`;
  });

  if (analyzeUrl) {
    check("real analysis completes", () => {
      run(process.execPath, [cli, "analyze", analyzeUrl, "--goals", "tech_stack,feature_map"], {
        env
      });
    });
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push([name, "ok", detail ?? ""]);
  } catch (error) {
    results.push([name, "FAIL", error instanceof Error ? error.message : String(error)]);
  }
}

function report() {
  process.stdout.write("\n== release smoke\n");
  for (const [name, state, detail] of results) {
    process.stdout.write(
      `  ${state === "ok" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}\n`
    );
  }
  const failed = results.filter(([, state]) => state === "FAIL");
  if (failed.length) {
    process.stderr.write(`\n${failed.length} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("\nall checks passed\n");
  }
}

main()
  .catch((error) => {
    results.push(["install", "FAIL", error instanceof Error ? error.message : String(error)]);
  })
  .finally(() => {
    if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
    else process.stdout.write(`kept: ${tmp}\n`);
    report();
  });
