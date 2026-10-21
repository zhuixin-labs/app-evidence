import fs from "node:fs";
import path from "node:path";
import * as bplist from "bplist-parser";
import plist from "plist";
import type { ResolvedTarget } from "@zhuixin/shared";
import { fail } from "../errors.js";
import { descriptor, type ResolveOutput, type SourceProvider } from "./types.js";

function normalizePath(input: string): string {
  const trimmed = input.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return path.resolve(unquoted);
}

function readPlist(filePath: string): Record<string, unknown> {
  const buffer = fs.readFileSync(filePath);
  if (buffer.subarray(0, 6).toString("utf8") === "bplist") {
    const [parsed] = bplist.parseBuffer(buffer);
    return (parsed ?? {}) as Record<string, unknown>;
  }
  return plist.parse(buffer.toString("utf8")) as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolves a local macOS `.app` bundle into a Target. No store account, no download:
 * the bundle on disk is the artifact.
 */
export class LocalMacAppProvider implements SourceProvider {
  readonly descriptor = descriptor(
    "local-file",
    "macos",
    "Local macOS app",
    false,
    "preview",
    "Local .app bundle · read-only"
  );

  canHandle(input: string): boolean {
    if (!input.trim().toLowerCase().endsWith(".app")) return false;
    try {
      const appPath = normalizePath(input);
      return fs.statSync(appPath).isDirectory();
    } catch {
      return false;
    }
  }

  async resolve(input: string): Promise<ResolveOutput> {
    const appPath = normalizePath(input);
    const infoPath = path.join(appPath, "Contents", "Info.plist");
    if (!fs.existsSync(infoPath)) {
      fail(
        "UNSUPPORTED_SOURCE",
        "Not a macOS app bundle: Contents/Info.plist is missing."
      );
    }
    const info = readPlist(infoPath);
    const bundleId = text(info.CFBundleIdentifier);
    const name =
      text(info.CFBundleDisplayName) ??
      text(info.CFBundleName) ??
      path.basename(appPath, ".app");
    const target: ResolvedTarget = {
      targetRef: {
        platform: "macos",
        sourceId: "local-file",
        sourceRef: appPath
      },
      name,
      publisher: text(info.CFBundleExecutable) ?? bundleId,
      version: text(info.CFBundleShortVersionString),
      bundleId,
      metadata: {
        bundlePath: appPath,
        executable: text(info.CFBundleExecutable),
        minimumSystemVersion: text(info.LSMinimumSystemVersion),
        urlSchemes: Array.isArray(info.CFBundleURLTypes)
          ? info.CFBundleURLTypes
          : []
      }
    };
    return { target, raw: info };
  }
}
