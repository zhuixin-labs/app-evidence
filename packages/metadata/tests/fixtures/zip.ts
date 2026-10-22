import zlib from "node:zlib";

export interface ZipEntry {
  name: string;
  data?: string | Buffer;
  /** Unix permission bits, for example 0o755. Omit to mimic an archive made on Windows. */
  mode?: number;
  /** Stores the entry as a symbolic link pointing at this path. */
  symlink?: string;
  /** Overrides the size recorded in the central directory (to test lying archives). */
  declaredSize?: number;
}

/** Minimal zip writer so tests can build hostile and Finder-style archives without a dependency. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const isDirectory = entry.name.endsWith("/");
    const payload = Buffer.from(entry.symlink ?? entry.data ?? "");
    const compressed = isDirectory ? Buffer.alloc(0) : zlib.deflateRawSync(payload);
    const method = isDirectory ? 0 : 8;
    const crc = isDirectory ? 0 : zlib.crc32(payload);
    const size = isDirectory ? 0 : payload.length;
    const unix = entry.mode !== undefined || entry.symlink !== undefined || isDirectory;
    const fileType = entry.symlink !== undefined ? 0o120000 : isDirectory ? 0o040000 : 0o100000;
    const mode = unix ? fileType | (entry.mode ?? (isDirectory ? 0o755 : 0o644)) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((unix ? 3 : 0) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.declaredSize ?? size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((mode << 16) >>> 0), 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

export const SAMPLE_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.sample</string>
  <key>CFBundleDisplayName</key><string>Sample App</string>
  <key>CFBundleExecutable</key><string>Sample</string>
  <key>CFBundleShortVersionString</key><string>1.2.3</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>`;

/** What Finder's "Compress" produces: the bundle at the top, plus resource-fork noise. */
export function finderStyleEntries(app = "Sample App.app"): ZipEntry[] {
  return [
    { name: `${app}/` },
    { name: `${app}/Contents/` },
    { name: `${app}/Contents/Info.plist`, data: SAMPLE_INFO_PLIST, mode: 0o644 },
    { name: `${app}/Contents/MacOS/` },
    { name: `${app}/Contents/MacOS/Sample`, data: "not a real Mach-O", mode: 0o755 },
    { name: `${app}/Contents/Resources/app.asar`, data: "asar placeholder", mode: 0o644 },
    { name: `${app}/Contents/Frameworks/X.framework/Versions/Current`, symlink: "A" },
    { name: `${app}/Contents/Frameworks/X.framework/Versions/A/X`, data: "framework binary", mode: 0o755 },
    { name: "__MACOSX/", },
    { name: `__MACOSX/${app}/._Info.plist`, data: "resource fork" },
    { name: ".DS_Store", data: "junk" }
  ];
}
