/**
 * Minimal Chrome DevTools Protocol driver.
 *
 * One browser instance serves every frame: launching headless Chrome per
 * screenshot costs ~12s of startup, which makes a 70-frame video take 15
 * minutes. Reusing a single page over a WebSocket costs ~150ms per frame.
 *
 * No npm dependencies: Node 22 ships a global WebSocket and fetch.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function chromePath() {
  const configured = process.env.CHROME_PATH;
  if (configured) {
    if (fs.existsSync(configured)) return configured;
    // A stale CHROME_PATH breaks every tool that honours it; say so instead of
    // failing with a bare ENOENT later.
    process.stderr.write(
      `warning: CHROME_PATH points at a missing file (${configured}); falling back\n`
    );
  }
  const cache = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  for (const entry of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    if (!entry.startsWith("chromium-")) continue;
    const candidate = path.join(
      cache,
      entry,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing"
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const candidate of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.");
}

export async function launch() {
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "apptrace-demo-chrome-"));
  const child = spawn(
    chromePath(),
    [
      "--headless=new",
      // Port 0: the OS picks a free port and Chrome binds it to loopback only.
      "--remote-debugging-port=0",
      // Throwaway profile: no cookies, no saved logins, no history, deleted on exit.
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      // A screenshot tool has no business talking to Google.
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      // Without this, a fresh profile makes Chrome open "Chromium Safe Storage"
      // in the login keychain, which raises a password dialog on every Chromium
      // build (each version is a new code signature, so the ACL never sticks).
      // A screenshot run needs no cookie decryption at all.
      "--use-mock-keychain",
      "--no-pings",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  // An interrupted run must not leave a headless browser behind.
  const killChild = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  process.once("exit", killChild);
  process.once("SIGINT", () => {
    killChild();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    killChild();
    process.exit(143);
  });
  const watchdog = setTimeout(killChild, 15 * 60_000);
  watchdog.unref();

  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error("Chrome did not open a debugging port");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("No page target to attach to");

  const client = await connect(page.webSocketDebuggerUrl);
  const shutdown = async () => {
    clearTimeout(watchdog);
    try {
      client.close();
    } finally {
      killChild();
      await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  };
  return { client, shutdown, dataDir: userDataDir };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const { resolve: done, reject: fail, timer } = pending.get(message.id);
        clearTimeout(timer);
        pending.delete(message.id);
        message.error ? fail(new Error(JSON.stringify(message.error))) : done(message.result);
      }
    });
    socket.addEventListener("error", reject);
    socket.addEventListener("open", () => {
      const send = (method, params = {}) =>
        new Promise((done, fail) => {
          const id = nextId++;
          // A dropped reply must surface as an error, never as a silent hang.
          const timer = setTimeout(() => {
            pending.delete(id);
            fail(new Error(`CDP ${method} timed out after 30s`));
          }, 30_000);
          pending.set(id, { resolve: done, reject: fail, timer });
          socket.send(JSON.stringify({ id, method, params }));
        });
      resolve({
        send,
        close: () => socket.close()
      });
    });
  });
}

export async function open(client, { width, height, scale = 2, dir }) {
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false
  });
  await client.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 11, g: 15, b: 20, a: 1 }
  });
  // Keep the page next to the browser profile so shutdown() removes it too.
  const file = path.join(dir ?? os.tmpdir(), "page.html");
  return {
    async load(html) {
      await fsp.writeFile(file, html);
      await client.send("Page.navigate", { url: `file://${file}` });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await client.send("Runtime.evaluate", {
        expression: "document.fonts.ready.then(() => true)",
        awaitPromise: true
      });
    },
    async capture(outFile, expression) {
      if (expression) {
        await client.send("Runtime.evaluate", { expression, awaitPromise: false });
        // Wait for layout/paint outside the page: an in-page rAF promise can
        // never settle when the tab is not composited, which hangs the run.
        await new Promise((resolve) => setTimeout(resolve, 45));
      }
      const shot = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false
      });
      await fsp.writeFile(outFile, Buffer.from(shot.data, "base64"));
      return outFile;
    }
  };
}
