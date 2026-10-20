import type {
  AccountEntitlements,
  AccountStatus,
  EntitlementCheck,
  EntitlementRecord
} from "@zhuixin/shared";
import type { CoreConfig } from "../config.js";
import { resolveTool } from "../tools.js";
import { runIpatool, credentialFailure } from "./ipatool.js";

const STATUS_TTL_MS = 5_000;
const ENTITLEMENTS_TTL_MS = 30_000;
const PAGE_SIZE = 100;

function now(): string {
  return new Date().toISOString();
}

function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["items", "results", "apps", "purchases", "list"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  const data = asRecord(record.data);
  if (data) return extractItems(data);
  return [];
}

function normalizeEntitlement(value: unknown): EntitlementRecord | null {
  if (typeof value === "string") {
    return value ? { name: value } : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const appId =
    record.appId ??
    record.trackId ??
    record.id ??
    record.adamId ??
    record.applicationId ??
    record.appleId;
  const bundleId =
    record.bundleId ?? record.bundleIdentifier ?? record.bundle_id;
  const name =
    record.name ??
    record.trackName ??
    record.title ??
    record.displayName ??
    (bundleId ? String(bundleId) : undefined) ??
    (appId ? `App ${String(appId)}` : undefined);
  if (!name) return null;
  const version = record.version ?? record.bundleShortVersionString;
  return {
    appId: typeof appId === "number" || typeof appId === "string" ? appId : undefined,
    bundleId: typeof bundleId === "string" ? bundleId : undefined,
    name: String(name),
    version: typeof version === "string" ? version : undefined,
    platform: typeof record.platform === "string" ? record.platform : "ios"
  };
}

function accountFromPayload(payload: unknown): { email?: string; name?: string } {
  const record = asRecord(payload);
  if (!record) return {};
  const account = asRecord(record.account);
  const email =
    record.email ??
    record.appleId ??
    account?.email ??
    account?.appleId ??
    record.username;
  const firstName = record.firstName ?? account?.firstName;
  const lastName = record.lastName ?? account?.lastName;
  const name =
    record.name ??
    account?.name ??
    (firstName || lastName
      ? [firstName, lastName].filter(Boolean).join(" ")
      : undefined);
  return {
    email: typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? maskEmail(email) : undefined,
    name: typeof name === "string" ? name : undefined
  };
}

export class AccountService {
  private statusCache?: { value: AccountStatus; at: number };
  private entitlementsCache?: { value: AccountEntitlements; at: number };

  constructor(private readonly config: CoreConfig) {}

  invalidate(): void {
    this.statusCache = undefined;
    this.entitlementsCache = undefined;
  }

  async status(force = false, timeoutMs = 60_000): Promise<AccountStatus> {
    if (!force && this.statusCache && Date.now() - this.statusCache.at < STATUS_TTL_MS) {
      return this.statusCache.value;
    }

    const executable = resolveTool(this.config.ipatoolPath);
    if (!executable) return this.cacheStatus({ authenticated: false, keychain: "unknown", checkedAt: now(), errorCode: "TOOL_NOT_INSTALLED", message: "ipatool must be installed first." });
    const result = await runIpatool(
      this.config,
      ["auth", "info", "--format", "json", "--non-interactive"],
      { timeoutMs }
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    if (result.timedOut) {
      return this.cacheStatus({
        authenticated: false,
        keychain: "unknown",
        checkedAt: now(),
        errorCode: "AUTH_CHECK_TIMEOUT",
        message: "Timed out while checking the Apple account."
      });
    }
    if (result.code !== 0) {
      const failure = credentialFailure(combined);
      const locked = failure === "locked";
      const missingAccount = failure === "missing";
      return this.cacheStatus({
        authenticated: false,
        keychain: locked ? "locked" : "unknown",
        checkedAt: now(),
        errorCode: failure === "access_failed" ? "CREDENTIAL_ACCESS_FAILED" : locked || missingAccount ? undefined : "AUTH_CHECK_FAILED",
        message: locked
          ? "The local keychain is locked; unlock it in the sign-in terminal."
          : missingAccount ? "No Apple account is signed in." : failure === "access_failed" ? "Windows credentials cannot be read or decrypted. Check the current Windows user and store; credentials will not be overwritten." : "Account status check failed; retry. This does not prove the account is signed out."
      });
    }

    const payload = parseJson(result.stdout);
    const record = asRecord(payload);
    const account = accountFromPayload(payload);
    if (!record || record.success === false || !account.email) {
      return this.cacheStatus({
        authenticated: false,
        keychain: "unknown",
        checkedAt: now(),
        errorCode: "AUTH_CHECK_FAILED",
        message: "ipatool did not return a valid account state."
      });
    }
    return this.cacheStatus({
      authenticated: true,
      email: account.email,
      name: account.name,
      keychain: "unlocked",
      checkedAt: now(),
      message: "Apple account connected."
    });
  }

  async entitlements(force = false): Promise<AccountEntitlements> {
    if (
      !force &&
      this.entitlementsCache &&
      Date.now() - this.entitlementsCache.at < ENTITLEMENTS_TTL_MS
    ) {
      return this.entitlementsCache.value;
    }

    const result = await runIpatool(
      this.config,
      [
        "list-purchases",
        "--platform",
        "iphone",
        "--max-results",
        String(PAGE_SIZE),
        "--format",
        "json",
        "--non-interactive"
      ],
      { timeoutMs: 60_000 }
    );
    if (result.code !== 0 || result.timedOut) {
      const failure = credentialFailure(`${result.stdout}\n${result.stderr}`);
      const locked = failure === "locked";
      const value: AccountEntitlements = {
        items: [],
        checkedAt: now(),
        truncated: false,
        error: result.timedOut
          ? "Timed out reading store entitlements."
          : failure === "access_failed" ? "Windows credentials cannot be read or decrypted." : locked
            ? "The local keychain is locked; sign in or unlock first."
            : "Could not read owned apps; sign in to an Apple account first."
      };
      this.entitlementsCache = { value, at: Date.now() };
      return value;
    }

    const items = extractItems(parseJson(result.stdout))
      .map(normalizeEntitlement)
      .filter((item): item is EntitlementRecord => item !== null);
    const value: AccountEntitlements = {
      items,
      checkedAt: now(),
      truncated: items.length >= PAGE_SIZE
    };
    this.entitlementsCache = { value, at: Date.now() };
    return value;
  }

  async checkEntitlement(input: {
    appId?: string | number;
    bundleId?: string;
  }): Promise<EntitlementCheck> {
    const status = await this.status();
    if (!status.authenticated) {
      return {
        status: "unknown",
        checkedAt: now(),
        message: status.message ?? "Sign in to an Apple account first."
      };
    }

    const list = await this.entitlements();
    if (list.error) {
      return { status: "unknown", checkedAt: now(), message: list.error };
    }
    const appId = input.appId !== undefined ? String(input.appId) : undefined;
    const bundleId = input.bundleId?.toLowerCase();
    const entitlement = list.items.find(
      (item) =>
        (appId !== undefined && item.appId !== undefined && String(item.appId) === appId) ||
        (bundleId !== undefined &&
          item.bundleId !== undefined &&
          item.bundleId.toLowerCase() === bundleId)
    );
    if (entitlement) {
      return {
        status: "owned",
        checkedAt: now(),
        entitlement,
        message: "This Apple account owns a store license for the app."
      };
    }
    if (list.truncated) {
      return {
        status: "unknown",
        checkedAt: now(),
        message: `Checked the first ${PAGE_SIZE} apps; there may be more. Confirm in the App Store on your iPhone.`
      };
    }
    return {
      status: "not_owned",
      checkedAt: now(),
      message: "No store license for this app was found on the current account."
    };
  }

  private cacheStatus(value: AccountStatus): AccountStatus {
    this.statusCache = { value, at: Date.now() };
    return value;
  }
}
