import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { OnboardingService, runInstallation } from "../src/onboarding/service.js";
import { OperationStore } from "../src/onboarding/operation.js";
import { AccountService } from "../src/account/service.js";
import * as command from "../src/process/run.js";
import { loginStore, loginWindowStatus } from "../src/onboarding/login-window.js";

const roots: string[] = [];
function workspace(ready = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace onboarding "));
  roots.push(root);
  vi.stubEnv("APPTRACE_WORKSPACE_ROOT", root);
  vi.stubEnv("APPTRACE_IPATOOL_PATH", path.join(root, "ipatool.exe"));
  vi.stubEnv("APPTRACE_ANALYSIS_ENGINE_PATH", path.join(root, "rea.exe"));
  vi.stubEnv("APPTRACE_ENGINE_PATH", path.join(root, "engine.js"));
  if (ready) for (const name of ["ipatool.exe", "rea.exe", "engine.js"]) fs.writeFileSync(path.join(root, name), "", { mode: 0o700 });
  // General account parsing tests are independent of the Windows adapter probe.
  return loadConfig(process.env, "linux");
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("missing tools never trigger an account check", async () => {
  const account = vi.spyOn(AccountService.prototype, "status");
  expect(await new OnboardingService(workspace()).status()).toMatchObject({ state: "tools_missing", next_tool: "prepare_environment" });
  expect(account).not.toHaveBeenCalled();
});

test.each([
  [true, "unlocked", undefined, "ready"],
  [false, "unknown", undefined, "login_required"],
  [false, "locked", undefined, "keychain_locked"],
  [false, "unknown", "AUTH_CHECK_TIMEOUT", "failed"]
] as const)("readiness respects authenticated=%s keychain=%s error=%s", async (authenticated, keychain, errorCode, state) => {
  vi.spyOn(AccountService.prototype, "status").mockResolvedValue({ authenticated, keychain, errorCode, checkedAt: new Date().toISOString() });
  // Do not consult an actual user's login-window state in unit tests.
  vi.spyOn(os, "homedir").mockReturnValue(workspace(true).workspaceRoot);
  expect((await new OnboardingService(loadConfig(process.env, "linux")).status()).state).toBe(state);
});

test("local analysis does not require an Apple account", async () => {
  const account = vi.spyOn(AccountService.prototype, "status");
  expect((await new OnboardingService(workspace(true)).status(false)).state).toBe("ready");
  expect(account).not.toHaveBeenCalled();
});

test.each([
  [0, "", "", false, "AUTH_CHECK_FAILED", "unknown"],
  [0, "not JSON", "", false, "AUTH_CHECK_FAILED", "unknown"],
  [1, "", "connection reset", false, "AUTH_CHECK_FAILED", "unknown"],
  [1, "", "keyring passphrase required", false, undefined, "locked"],
  [1, "", "not logged in", false, undefined, "unknown"],
  [null, "", "", true, "AUTH_CHECK_TIMEOUT", "unknown"]
] as const)("account check rejects invalid response %#", async (code, stdout, stderr, timedOut, errorCode, keychain) => {
  vi.spyOn(command, "runCommand").mockResolvedValue({ code, stdout, stderr, timedOut });
  expect(await new AccountService(workspace(true)).status(true)).toMatchObject({ authenticated: false, errorCode, keychain });
});

test("account readiness requires a recognizable account response", async () => {
  vi.spyOn(command, "runCommand").mockResolvedValue({ code: 0, stdout: JSON.stringify({ success: true, email: "test@example.org" }), stderr: "", timedOut: false });
  expect(await new AccountService(workspace(true)).status(true)).toMatchObject({ authenticated: true, email: "t***@example.org" });
});

test("CLI installation and other callers share ownership and failure recovery", async () => {
  const config = workspace();
  const store = new OperationStore(path.join(config.workspaceRoot, ".onboarding", "install"));
  await runInstallation(config, async () => {
    await expect(runInstallation(config, async () => {})).rejects.toMatchObject({ code: "SETUP_BUSY" });
    const token = store.current()!.token;
    store.finish("not-the-owner", "completed");
    expect(store.current()?.token).toBe(token);
  });
  expect(store.current()).toBeUndefined();
  expect(store.last()?.state).toBe("completed");
  await expect(runInstallation(config, async () => { throw new Error("failure"); })).rejects.toThrow("failure");
  expect(store.last()?.state).toBe("failed");
  await runInstallation(config, async () => {});
  expect(store.last()?.state).toBe("completed");
});

test("legacy unresolved default does not hide newly installed workspace ipatool", async () => {
  const config = workspace();
  vi.stubEnv("APPTRACE_IPATOOL_PATH", "ipatool");
  vi.stubEnv("PATH", "");
  const file = path.join(config.workspaceRoot, "tools", "ipatool", "bin", config.hostPlatform === "win32" ? "ipatool.exe" : "ipatool");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "", { mode: 0o700 });
  await new OnboardingService(config).status(false);
  expect(config.ipatoolPath).toBe(file);
});

test("a live installer child retains ownership after worker exit", () => {
  const store = new OperationStore(path.join(workspace().workspaceRoot, "operation"));
  const operation = store.acquire()!;
  store.addChild(operation.token, process.pid);
  store.adopt(operation.token, 2147483647);
  expect(store.acquire()).toBeUndefined();
  store.finish(operation.token, "completed");
  const stale = store.acquire()!;
  store.adopt(stale.token, 2147483647);
  expect(store.acquire()?.token).not.toBe(stale.token);
});

test("login completion can be polled repeatedly without deleting its result", () => {
  vi.spyOn(os, "homedir").mockReturnValue(workspace().workspaceRoot);
  const store = loginStore();
  const operation = store.acquire()!;
  const result = path.join(store.root, `${operation.token}.exit`);
  fs.writeFileSync(result, "0");
  expect(loginWindowStatus()).toEqual({ pending: false, exitCode: 0 });
  expect(loginWindowStatus().pending).toBe(false);
  expect(fs.readFileSync(result, "utf8")).toBe("0");
  expect(store.last()?.state).toBe("completed");
});

test("credential access failure is not masked by a failed login-window verification", async () => {
  const config = workspace(true);
  vi.spyOn(os, "homedir").mockReturnValue(config.workspaceRoot);
  const store = loginStore();
  const operation = store.acquire()!;
  fs.writeFileSync(path.join(store.root, `${operation.token}.exit`), "1");
  vi.spyOn(AccountService.prototype, "status").mockResolvedValue({ authenticated: false, keychain: "unknown", errorCode: "CREDENTIAL_ACCESS_FAILED", message: "credential cannot be decrypted", checkedAt: new Date().toISOString() });
  expect(await new OnboardingService(config).status()).toMatchObject({ state: "failed", errorCode: "CREDENTIAL_ACCESS_FAILED" });
});
