const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pnpmDir = path.join(root, "node_modules", ".pnpm");
if (!fs.existsSync(pnpmDir)) process.exit(0);

for (const name of fs.readdirSync(pnpmDir)) {
  if (!name.startsWith("node-pty@")) continue;
  const packageRoot = path.join(pnpmDir, name, "node_modules", "node-pty");
  for (const relative of [
    "prebuilds/darwin-arm64/spawn-helper",
    "prebuilds/darwin-x64/spawn-helper",
    "build/Release/spawn-helper"
  ]) {
    const helper = path.join(packageRoot, relative);
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}
