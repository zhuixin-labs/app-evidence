import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { hashBundle, linkBundle } from "../src/jobs/acquire.js";
import { LocalMacAppProvider } from "../src/sources/localMacApp.js";
import { SourceRegistry } from "../src/sources/registry.js";

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.sample</string>
  <key>CFBundleDisplayName</key><string>Sample App</string>
  <key>CFBundleExecutable</key><string>Sample</string>
  <key>CFBundleShortVersionString</key><string>1.2.3</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>`;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace mac app "));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A minimal bundle: Contents/Info.plist, an executable stand-in and an Electron-style asar. */
function makeBundle(name = "Sample App.app", extra: Record<string, string> = {}): string {
  const bundle = path.join(root, name);
  const files: Record<string, string> = {
    "Contents/Info.plist": INFO_PLIST,
    "Contents/MacOS/Sample": "not a real Mach-O",
    "Contents/Resources/app.asar": "asar placeholder",
    ...extra
  };
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(bundle, ...relative.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return bundle;
}

test("resolves a local .app, including a path with spaces and quotes", async () => {
  const bundle = makeBundle();
  const provider = new LocalMacAppProvider();
  for (const input of [bundle, `"${bundle}"`, `'${bundle}'`]) {
    expect(provider.canHandle(input)).toBe(true);
  }
  const { target } = await provider.resolve(bundle);
  expect(target).toMatchObject({
    name: "Sample App",
    version: "1.2.3",
    bundleId: "com.example.sample",
    targetRef: { platform: "macos", sourceId: "local-file", sourceRef: bundle }
  });
  expect(target.metadata).toMatchObject({ executable: "Sample", minimumSystemVersion: "12.0" });
});

test("rejects inputs that are not an existing .app directory", async () => {
  const provider = new LocalMacAppProvider();
  const file = path.join(root, "Fake.app");
  fs.writeFileSync(file, "a file named like an app");
  expect(provider.canHandle(file)).toBe(false);
  expect(provider.canHandle(path.join(root, "Missing.app"))).toBe(false);
  expect(provider.canHandle(root)).toBe(false);
  expect(provider.canHandle("https://apps.apple.com/cn/app/id1616124777")).toBe(false);

  const empty = path.join(root, "Empty.app");
  fs.mkdirSync(empty);
  expect(provider.canHandle(empty)).toBe(true);
  await expect(provider.resolve(empty)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
});

test("the registry sends .app paths to the local provider, not the App Store", async () => {
  const bundle = makeBundle();
  const appStore = {
    descriptor: { id: "app-store" } as never,
    canHandle: (input: string) => /^https?:\/\/apps\.apple\.com\//.test(input),
    resolve: async () => {
      throw new Error("App Store must not be asked to resolve a local bundle");
    }
  };
  const registry = new SourceRegistry([new LocalMacAppProvider(), appStore]);
  const resolved = await registry.resolve(bundle);
  expect(resolved.output.target.targetRef.sourceId).toBe("local-file");
});

test("bundle digest is independent of the host's path separator ordering", async () => {
  // "Frameworks/A/b" and "Frameworks/A0" sort differently with "/" and "\".
  const bundle = makeBundle("Order.app", {
    "Contents/Frameworks/A/b": "one",
    "Contents/Frameworks/A0": "two"
  });
  const entries = [
    "Contents/Frameworks/A/b",
    "Contents/Frameworks/A0",
    "Contents/Info.plist",
    "Contents/MacOS/Sample",
    "Contents/Resources/app.asar"
  ];
  const expected = createHash("sha256");
  let size = 0;
  for (const relative of [...entries].sort()) {
    const bytes = fs.readFileSync(path.join(bundle, ...relative.split("/")));
    size += bytes.length;
    expected.update(
      `${relative}\0${bytes.length}\0${createHash("sha256").update(bytes).digest("hex")}\n`
    );
  }

  const digest = await hashBundle(bundle);
  expect(digest).toEqual({ sha256: expected.digest("hex"), sizeBytes: size, fileCount: entries.length });
  expect(await hashBundle(bundle)).toEqual(digest);
});

test("linking a bundle works without elevated rights and can be repeated", () => {
  const bundle = makeBundle();
  const link = path.join(root, "workspace", "1.2.3-abc.app");
  fs.mkdirSync(path.dirname(link), { recursive: true });

  linkBundle(bundle, link);
  expect(fs.readFileSync(path.join(link, "Contents", "Info.plist"), "utf8")).toBe(INFO_PLIST);

  linkBundle(bundle, link);
  expect(fs.existsSync(path.join(link, "Contents", "Info.plist"))).toBe(true);

  fs.rmSync(link, { force: true });
  expect(fs.existsSync(path.join(bundle, "Contents", "Info.plist"))).toBe(true);
});
