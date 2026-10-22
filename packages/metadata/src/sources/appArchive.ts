import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { CoreFailure, fail } from "../errors.js";

export interface ExtractLimits {
  /** Total uncompressed bytes of the bundle. */
  maxBytes: number;
  maxEntries: number;
}

export const DEFAULT_LIMITS: ExtractLimits = {
  maxBytes: 8 * 1024 ** 3,
  maxEntries: 500_000
};

export interface ExtractOptions {
  limits?: ExtractLimits;
  /** Overridable so the Windows file-name rules can be tested on any host. */
  platform?: NodeJS.Platform;
}

export interface ExtractResult {
  appPath: string;
  fileCount: number;
  sizeBytes: number;
  /** Symlinks are never recreated, so a bundle never points outside itself. */
  skippedSymlinks: number;
  /** Entries that cannot exist on this host's file system. */
  skipped: string[];
}

export interface ArchiveInspection {
  /** Directory name of the single top-level bundle, for example `Foo.app`. */
  appName: string;
  infoPlist: Buffer;
}

const MAX_INFO_PLIST_BYTES = 8 * 1024 * 1024;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const WINDOWS_INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // lazyEntries + manual close keep the file open for the later read streams.
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true },
      (error, zip) => (error || !zip ? reject(error ?? new Error("Cannot open zip.")) : resolve(zip))
    );
  });
}

async function readEntries(zip: yauzl.ZipFile, maxEntries: number): Promise<yauzl.Entry[]> {
  const entries: yauzl.Entry[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", resolve);
    zip.on("entry", (entry: yauzl.Entry) => {
      if (entries.length >= maxEntries) {
        reject(new Error(`The archive has more than ${maxEntries} entries.`));
        return;
      }
      entries.push(entry);
      zip.readEntry();
    });
    zip.readEntry();
  });
  return entries;
}

function openStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) =>
      error || !stream ? reject(error ?? new Error("Cannot read entry.")) : resolve(stream)
    );
  });
}

async function readSmallEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  if (entry.uncompressedSize > MAX_INFO_PLIST_BYTES) {
    fail("ARCHIVE_INVALID", "Contents/Info.plist is unreasonably large.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of await openStream(zip, entry)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function ignored(name: string): boolean {
  return name.startsWith("__MACOSX/") || name === ".DS_Store";
}

/** The single top-level `*.app` directory, or a precise reason it cannot be chosen. */
function locateApp(entries: yauzl.Entry[]): string {
  const apps = new Set<string>();
  for (const entry of entries) {
    if (ignored(entry.fileName)) continue;
    const top = entry.fileName.split("/")[0] ?? "";
    // A bare file named "X.app" is not a bundle; a directory has a trailing path.
    if (/\.app$/i.test(top) && entry.fileName.length > top.length) apps.add(top);
  }
  if (apps.size === 0) {
    fail("UNSUPPORTED_SOURCE", "The zip has no top-level .app bundle.");
  }
  if (apps.size > 1) {
    fail(
      "UNSUPPORTED_SOURCE",
      `The zip contains several apps (${[...apps].sort().join(", ")}); extract the one to analyze and pass it directly.`
    );
  }
  return [...apps][0]!;
}

function archiveError(error: unknown): never {
  if (error instanceof CoreFailure) throw error;
  const message = error instanceof Error ? error.message : String(error);
  return fail("ARCHIVE_INVALID", `The zip cannot be read safely: ${message}`);
}

/**
 * Reads only the central directory and `Contents/Info.plist`; nothing is
 * written to disk, so resolving a target stays cheap even for large bundles.
 */
export async function inspectAppZip(zipPath: string): Promise<ArchiveInspection> {
  let zip: yauzl.ZipFile | undefined;
  try {
    zip = await openZip(zipPath);
    const entries = await readEntries(zip, DEFAULT_LIMITS.maxEntries);
    const appName = locateApp(entries);
    const plist = entries.find((entry) => entry.fileName === `${appName}/Contents/Info.plist`);
    if (!plist) fail("UNSUPPORTED_SOURCE", "Not a macOS app bundle: Contents/Info.plist is missing.");
    return { appName, infoPlist: await readSmallEntry(zip, plist) };
  } catch (error) {
    return archiveError(error);
  } finally {
    zip?.close();
  }
}

function unixMode(entry: yauzl.Entry): number | undefined {
  // Only archives made on a Unix host carry permission bits.
  return entry.versionMadeBy >>> 8 === 3 ? entry.externalFileAttributes >>> 16 : undefined;
}

function windowsProblem(segments: string[]): string | undefined {
  for (const segment of segments) {
    if (WINDOWS_INVALID_CHARS.test(segment)) return "a character Windows does not allow";
    if (/[. ]$/.test(segment)) return "a trailing dot or space";
    if (WINDOWS_RESERVED.test(segment)) return "a reserved Windows device name";
  }
  return undefined;
}

/**
 * Extracts the single top-level `.app` of a zip into `destRoot`. The archive is
 * untrusted: paths are confined to `destRoot`, symlinks are dropped, sizes are
 * bounded up front and entries a host cannot represent are skipped and reported
 * instead of failing the whole extraction.
 */
export async function extractAppZip(
  zipPath: string,
  destRoot: string,
  options: ExtractOptions = {}
): Promise<ExtractResult> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const platform = options.platform ?? process.platform;
  const caseInsensitive = platform === "win32" || platform === "darwin";
  const staging = `${destRoot}.partial-${process.pid}`;
  let zip: yauzl.ZipFile | undefined;
  try {
    zip = await openZip(zipPath);
    const entries = await readEntries(zip, limits.maxEntries);
    const appName = locateApp(entries);
    const prefix = `${appName}/`;
    const members = entries.filter(
      (entry) => !ignored(entry.fileName) && (entry.fileName === prefix || entry.fileName.startsWith(prefix))
    );
    const declared = members.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    if (declared > limits.maxBytes) {
      fail(
        "ARCHIVE_TOO_LARGE",
        `The bundle expands to ${declared} bytes, above the ${limits.maxBytes} byte limit.`
      );
    }

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const root = path.resolve(staging);
    const seen = new Set<string>();
    const skipped: string[] = [];
    let skippedSymlinks = 0;
    let fileCount = 0;
    let sizeBytes = 0;

    for (const entry of members) {
      const name = entry.fileName;
      const isDirectory = name.endsWith("/");
      const segments = name.split("/").filter(Boolean);
      const mode = unixMode(entry);

      if (mode !== undefined && (mode & S_IFMT) === S_IFLNK) {
        skippedSymlinks += 1;
        continue;
      }
      if (entry.isEncrypted()) {
        skipped.push(`${name} (encrypted)`);
        continue;
      }
      if (platform === "win32") {
        const problem = windowsProblem(segments);
        if (problem) {
          skipped.push(`${name} (${problem})`);
          continue;
        }
      }
      const key = caseInsensitive ? segments.join("/").toLowerCase() : segments.join("/");
      if (!isDirectory && seen.has(key)) {
        skipped.push(`${name} (differs only by letter case from another entry)`);
        continue;
      }
      const target = path.resolve(root, ...segments);
      if (target !== root && !target.startsWith(root + path.sep)) {
        fail("ARCHIVE_INVALID", `The zip contains an entry outside the bundle: ${name}`);
      }

      if (isDirectory) {
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        continue;
      }
      seen.add(key);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      await pipeline(await openStream(zip, entry), fs.createWriteStream(target, { mode: 0o600 }));
      // Keep the execute bit for later tooling; never setuid/setgid/sticky.
      if (platform !== "win32" && mode !== undefined) fs.chmodSync(target, (mode & 0o777) | 0o600);
      fileCount += 1;
      sizeBytes += entry.uncompressedSize;
    }

    const appPath = path.join(destRoot, appName);
    zip.close();
    zip = undefined;
    fs.rmSync(destRoot, { recursive: true, force: true });
    fs.renameSync(staging, destRoot);
    return { appPath, fileCount, sizeBytes, skippedSymlinks, skipped };
  } catch (error) {
    return archiveError(error);
  } finally {
    zip?.close();
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
