import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { extractAppZip, inspectAppZip } from "../src/sources/appArchive.js";
import { LocalMacAppProvider } from "../src/sources/localMacApp.js";
import { buildZip, finderStyleEntries, SAMPLE_INFO_PLIST, type ZipEntry } from "./fixtures/zip.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace zip "));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeZip(entries: ZipEntry[], name = "Sample App.zip"): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, buildZip(entries));
  return file;
}

test("finds the single top-level app and ignores Finder noise", async () => {
  const inspected = await inspectAppZip(writeZip(finderStyleEntries()));
  expect(inspected.appName).toBe("Sample App.app");
  expect(inspected.infoPlist.toString("utf8")).toBe(SAMPLE_INFO_PLIST);
});

test("explains why a zip is not a usable app archive", async () => {
  const none = writeZip([{ name: "readme.txt", data: "hi" }], "none.zip");
  await expect(inspectAppZip(none)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });

  const fileNamedApp = writeZip([{ name: "Fake.app", data: "a file, not a bundle" }], "file.zip");
  await expect(inspectAppZip(fileNamedApp)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });

  const two = writeZip([...finderStyleEntries("A.app"), ...finderStyleEntries("B.app")], "two.zip");
  await expect(inspectAppZip(two)).rejects.toMatchObject({
    code: "UNSUPPORTED_SOURCE",
    message: expect.stringContaining("A.app, B.app")
  });

  const noPlist = writeZip([{ name: "Empty.app/Contents/MacOS/x", data: "x" }], "noplist.zip");
  await expect(inspectAppZip(noPlist)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });

  const notZip = path.join(root, "broken.zip");
  fs.writeFileSync(notZip, "this is not a zip file");
  await expect(inspectAppZip(notZip)).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
});

test("extracts the bundle, drops symlinks and Finder noise, and reuses the destination", async () => {
  const zip = writeZip(finderStyleEntries());
  const dest = path.join(root, "out", "extracted");
  const result = await extractAppZip(zip, dest);

  expect(result.appPath).toBe(path.join(dest, "Sample App.app"));
  expect(result.skippedSymlinks).toBe(1);
  expect(result.skipped).toEqual([]);
  expect(result.fileCount).toBe(4);
  expect(fs.readFileSync(path.join(result.appPath, "Contents", "Info.plist"), "utf8")).toBe(SAMPLE_INFO_PLIST);
  expect(fs.readFileSync(path.join(result.appPath, "Contents", "Frameworks", "X.framework", "Versions", "A", "X"), "utf8")).toBe("framework binary");
  expect(fs.existsSync(path.join(result.appPath, "Contents", "Frameworks", "X.framework", "Versions", "Current"))).toBe(false);
  expect(fs.existsSync(path.join(dest, "__MACOSX"))).toBe(false);
  expect(fs.existsSync(path.join(dest, ".DS_Store"))).toBe(false);
  expect(fs.readdirSync(path.dirname(dest)).filter((name) => name.includes(".partial-"))).toEqual([]);

  if (process.platform !== "win32") {
    const mode = fs.statSync(path.join(result.appPath, "Contents", "MacOS", "Sample")).mode & 0o777;
    expect(mode & 0o100).toBe(0o100);
  }

  // Extracting again replaces the previous copy rather than failing or merging.
  const again = await extractAppZip(zip, dest);
  expect(again.fileCount).toBe(4);
});

test("refuses entries that would escape the destination", async () => {
  for (const evil of ["../evil.txt", "Sample App.app/../../evil.txt", "/abs/evil.txt"]) {
    const zip = writeZip([...finderStyleEntries(), { name: evil, data: "pwned" }], "evil.zip");
    const dest = path.join(root, "safe", "extracted");
    await expect(extractAppZip(zip, dest)).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(path.join(root, "evil.txt"))).toBe(false);
    expect(fs.existsSync(path.join(root, "safe", "evil.txt"))).toBe(false);
  }
});

test("enforces size and entry limits before writing anything", async () => {
  const zip = writeZip(finderStyleEntries());
  const dest = path.join(root, "limited");
  await expect(extractAppZip(zip, dest, { limits: { maxBytes: 10, maxEntries: 1000 } })).rejects.toMatchObject({
    code: "ARCHIVE_TOO_LARGE"
  });
  await expect(extractAppZip(zip, dest, { limits: { maxBytes: 1 << 30, maxEntries: 3 } })).rejects.toMatchObject({
    code: "ARCHIVE_INVALID"
  });
  expect(fs.existsSync(dest)).toBe(false);
  expect(fs.readdirSync(root).filter((name) => name.includes(".partial-"))).toEqual([]);
});

test("rejects an archive whose recorded sizes are false", async () => {
  const entries = finderStyleEntries();
  const plist = entries.find((entry) => entry.name.endsWith("Info.plist"))!;
  plist.declaredSize = 3;
  const zip = writeZip(entries, "lying.zip");
  const dest = path.join(root, "lying");
  await expect(extractAppZip(zip, dest)).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
  expect(fs.existsSync(dest)).toBe(false);
});

test("skips entries Windows cannot represent instead of failing the bundle", async () => {
  const zip = writeZip([
    ...finderStyleEntries(),
    { name: "Sample App.app/Contents/Resources/bad:name.txt", data: "x" },
    { name: "Sample App.app/Contents/Resources/CON.txt", data: "x" },
    { name: "Sample App.app/Contents/Resources/trailing.", data: "x" }
  ]);
  const result = await extractAppZip(zip, path.join(root, "win"), { platform: "win32" });
  expect(result.skipped).toHaveLength(3);
  expect(result.skipped.join("\n")).toContain("bad:name.txt");
  expect(result.fileCount).toBe(4);
});

test("skips entries that collide on case-insensitive hosts", async () => {
  const zip = writeZip([
    ...finderStyleEntries(),
    { name: "Sample App.app/Contents/Resources/a.txt", data: "first" },
    { name: "Sample App.app/Contents/Resources/A.txt", data: "second" }
  ]);
  const result = await extractAppZip(zip, path.join(root, "case"), { platform: "darwin" });
  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0]).toContain("A.txt");
  expect(result.fileCount).toBe(5);
});

test("the local provider accepts a zip and builds the same target as the folder", async () => {
  const zip = writeZip(finderStyleEntries());
  const provider = new LocalMacAppProvider();
  expect(provider.canHandle(zip)).toBe(true);
  expect(provider.canHandle(`"${zip}"`)).toBe(true);
  expect(provider.canHandle(path.join(root, "missing.zip"))).toBe(false);

  const { target } = await provider.resolve(zip);
  expect(target).toMatchObject({
    name: "Sample App",
    version: "1.2.3",
    bundleId: "com.example.sample",
    targetRef: { platform: "macos", sourceId: "local-file", sourceRef: zip }
  });
  expect(target.metadata).toMatchObject({ archivePath: zip, bundleName: "Sample App.app" });

  const plain = writeZip([{ name: "x.txt", data: "x" }], "plain.zip");
  expect(provider.canHandle(plain)).toBe(true);
  await expect(provider.resolve(plain)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
});
