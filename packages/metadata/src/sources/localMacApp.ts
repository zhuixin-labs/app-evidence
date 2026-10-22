import fs from "node:fs";
import path from "node:path";
import * as bplist from "bplist-parser";
import plist from "plist";
import type { ResolvedTarget } from "@zhuixin/shared";
import { fail } from "../errors.js";
import { inspectAppZip } from "./appArchive.js";
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

function parsePlist(buffer: Buffer): Record<string, unknown> {
  if (buffer.subarray(0, 6).toString("utf8") === "bplist") {
    const [parsed] = bplist.parseBuffer(buffer);
    return (parsed ?? {}) as Record<string, unknown>;
  }
  return plist.parse(buffer.toString("utf8")) as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isZip(appPath: string): boolean {
  return appPath.toLowerCase().endsWith(".zip");
}

/**
 * Resolves a local macOS app into a Target: an `.app` directory, or a `.zip`
 * holding exactly one top-level `.app`. No store account, no download: the
 * file on disk is the artifact.
 */
export class LocalMacAppProvider implements SourceProvider {
  readonly descriptor = descriptor(
    "local-file",
    "macos",
    "Local macOS app",
    false,
    "preview",
    "Local .app bundle or .zip · read-only"
  );

  canHandle(input: string): boolean {
    try {
      // Normalize first: a pasted path is often quoted, so the quote would
      // otherwise hide the ".app" suffix.
      const appPath = normalizePath(input);
      const lower = appPath.toLowerCase();
      if (lower.endsWith(".app")) return fs.statSync(appPath).isDirectory();
      // The archive layout is checked in resolve(), which can read it.
      if (isZip(appPath)) return fs.statSync(appPath).isFile();
      return false;
    } catch {
      return false;
    }
  }

  async resolve(input: string): Promise<ResolveOutput> {
    const sourcePath = normalizePath(input);
    if (isZip(sourcePath)) {
      const { appName, infoPlist } = await inspectAppZip(sourcePath);
      return this.build(parsePlist(infoPlist), sourcePath, path.basename(appName, ".app"), {
        archivePath: sourcePath,
        bundleName: appName
      });
    }

    const infoPath = path.join(sourcePath, "Contents", "Info.plist");
    if (!fs.existsSync(infoPath)) {
      fail(
        "UNSUPPORTED_SOURCE",
        "Not a macOS app bundle: Contents/Info.plist is missing."
      );
    }
    return this.build(parsePlist(fs.readFileSync(infoPath)), sourcePath, path.basename(sourcePath, ".app"), {
      bundlePath: sourcePath
    });
  }

  private build(
    info: Record<string, unknown>,
    sourceRef: string,
    fallbackName: string,
    location: Record<string, unknown>
  ): ResolveOutput {
    const bundleId = text(info.CFBundleIdentifier);
    const target: ResolvedTarget = {
      targetRef: { platform: "macos", sourceId: "local-file", sourceRef },
      name: text(info.CFBundleDisplayName) ?? text(info.CFBundleName) ?? fallbackName,
      publisher: text(info.CFBundleExecutable) ?? bundleId,
      version: text(info.CFBundleShortVersionString),
      bundleId,
      metadata: {
        ...location,
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
