import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { credentialFailure, requireBackgroundCredentials } from "../src/account/ipatool.js";
import { loadConfig } from "../src/config.js";
import * as command from "../src/process/run.js";
import { setupToolsReady } from "../src/onboarding/service.js";

afterEach(() => vi.restoreAllMocks());

test("credential failures distinguish corruption, missing account and actual unlock errors", () => {
  expect(credentialFailure("APPTRACE_CREDENTIAL_ACCESS_FAILED: invalid data")).toBe("access_failed");
  expect(credentialFailure("keychain passphrase is required when not running in interactive mode")).toBe("locked");
  expect(credentialFailure("The specified item could not be found in the keyring")).toBe("missing");
  expect(credentialFailure("failed to get account: network error")).toBeUndefined();
  expect(credentialFailure("failed to unlock remote feature")).toBeUndefined();
});

test("Windows rejects an existing unadapted ipatool instead of silently returning locked", async () => {
  vi.spyOn(command, "runCommand").mockResolvedValue({ code: 0, stdout: "ipatool version 2.7.0", stderr: "", timedOut: false });
  await expect(requireBackgroundCredentials(loadConfig({ APPTRACE_IPATOOL_PATH: "legacy.exe" }, "win32"))).rejects.toMatchObject({ code: "IPATOOL_UPDATE_REQUIRED" });
});

test("Windows accepts the explicit capability marker", async () => {
  vi.spyOn(command, "runCommand").mockResolvedValue({ code: 0, stdout: "ipatool version 2.7.0-apptrace-dpapi-v1", stderr: "", timedOut: false });
  await expect(requireBackgroundCredentials(loadConfig({ APPTRACE_IPATOOL_PATH: "adapted.exe" }, "win32"))).resolves.toBeUndefined();
});

test("old managed path upgrades without replacing a custom path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace upgrade "));
  const dir = path.join(root, "tools", "ipatool", "bin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ipatool-dpapi-v1.exe"), "test-only");
  try {
    expect(loadConfig({ APPTRACE_WORKSPACE_ROOT: root, APPTRACE_IPATOOL_PATH: path.join(dir, "ipatool.exe") }, "win32").ipatoolPath).toBe(path.join(dir, "ipatool-dpapi-v1.exe"));
    expect(loadConfig({ APPTRACE_WORKSPACE_ROOT: root, APPTRACE_IPATOOL_PATH: "custom.exe" }, "win32").ipatoolPath).toBe("custom.exe");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("installer must upgrade an existing managed legacy binary even when all paths exist", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace legacy install "));
  const ipatool = path.join(root, "tools", "ipatool", "bin", "ipatool.exe");
  fs.mkdirSync(path.dirname(ipatool), { recursive: true });
  const engine = path.join(root, "engine.js");
  const rea = path.join(root, "rea.exe");
  for (const file of [ipatool, engine, rea]) fs.writeFileSync(file, "fixture");
  const version = vi.spyOn(command, "runCommand").mockResolvedValue({ code: 0, stdout: "ipatool version 2.7.0", stderr: "", timedOut: false });
  try {
    const config = loadConfig({ APPTRACE_WORKSPACE_ROOT: root, APPTRACE_IPATOOL_PATH: ipatool, APPTRACE_ENGINE_PATH: engine, APPTRACE_ANALYSIS_ENGINE_PATH: rea }, "win32");
    await expect(setupToolsReady(config)).resolves.toBe(false);
    version.mockResolvedValue({ code: 0, stdout: "ipatool version 2.7.0-apptrace-dpapi-v1", stderr: "", timedOut: false });
    await expect(setupToolsReady(config)).resolves.toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("auto-discovered legacy tools are upgradeable while explicit custom tools stay explicit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace discovered legacy "));
  const ipatool = path.join(root, "tools", "ipatool", "bin", "ipatool.exe");
  fs.mkdirSync(path.dirname(ipatool), { recursive: true });
  const engine = path.join(root, "engine.js");
  const rea = path.join(root, "rea.exe");
  for (const file of [ipatool, engine, rea]) fs.writeFileSync(file, "fixture");
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(command, "runCommand").mockResolvedValue({ code: 0, stdout: "ipatool version 2.7.0", stderr: "", timedOut: false });
  const env = { APPTRACE_WORKSPACE_ROOT: path.join(root, "workspace"), APPTRACE_ENGINE_PATH: engine, APPTRACE_ANALYSIS_ENGINE_PATH: rea };
  try {
    const automatic = loadConfig(env, "win32");
    expect(automatic.ipatoolPath).toBe(ipatool);
    await expect(setupToolsReady(automatic)).resolves.toBe(false);
    await expect(setupToolsReady(loadConfig({ ...env, APPTRACE_IPATOOL_PATH: ipatool }, "win32"))).rejects.toMatchObject({ code: "IPATOOL_UPDATE_REQUIRED" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
