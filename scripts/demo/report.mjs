#!/usr/bin/env node
/**
 * Renders two sections of the latest report into PNG stills, for the video.
 * Reuses the Markdown renderer so the stills match what the file actually says.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, open } from "./cdp.mjs";
import { mdToHtml } from "./markdown.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

const targetDir = value("--target-dir");
if (!targetDir) {
  console.error("Usage: node scripts/demo/report.mjs --target-dir <workspace target dir>");
  process.exit(1);
}
const reportsDir = path.join(targetDir, "reports");
const latest = fs
  .readdirSync(reportsDir)
  .filter((name) => name.endsWith(".md"))
  .map((name) => path.join(reportsDir, name))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!latest) {
  console.error(`No report in ${reportsDir}`);
  process.exit(1);
}

const markdown = fs.readFileSync(latest, "utf8");
const title = markdown.split("\n")[0].replace(/^#\s*/, "");
const sections = markdown.split(/\n## /).slice(1);
const summary = sections.find((section) => section.startsWith("Summary"));
if (!summary) {
  console.error("Report has no Summary section");
  process.exit(1);
}
// Routes live under "## Structured findings" as "### Routes (...)".
const subsections = markdown.split(/\n### /).slice(1);
const routes = subsections.find((section) => section.startsWith("Routes"));
// The inventory is a long table followed by a collapsed block; show the top.
const routesShort = (routes ?? "Routes\n\n(no route section in this report)")
  .split("\n")
  .slice(0, 16)
  .join("\n");

const page = (heading, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%}
  body{background:#0b0f14;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,"SF Pro Text","PingFang SC",sans-serif}
  .paper{width:1300px;max-height:820px;overflow:hidden;background:#fcfcfb;color:#1f2933;
    border-radius:10px;box-shadow:0 30px 70px rgba(0,0,0,.5);padding:52px 64px;
    font-size:22px;line-height:1.55}
  .kicker{font:600 15px/1 "SF Mono",Menlo,monospace;letter-spacing:.14em;
    text-transform:uppercase;color:#64748b;margin-bottom:10px}
  h1{font-size:34px;margin:0 0 26px}
  h2{font-size:26px;margin:0 0 18px;padding-bottom:10px;border-bottom:1px solid #e2e8f0}
  h3{font-size:20px;margin:22px 0 10px}
  p{margin:10px 0}
  code{background:#eef2f7;padding:1px 6px;border-radius:4px;font:16px "SF Mono",Menlo,monospace}
  table{border-collapse:collapse;width:100%;margin:14px 0;font-size:18px}
  th{text-align:left;background:#f1f5f9;padding:8px 12px;border-bottom:2px solid #e2e8f0}
  td{padding:8px 12px;border-bottom:1px solid #eef2f7}
  ul{margin:10px 0 10px 22px;padding:0}
  li{margin:4px 0}
  .muted{color:#94a3b8;font-style:italic}
</style></head><body><div class="paper">
  <div class="kicker">${heading}</div>
  ${body}
</div></body></html>`;

const files = [];
const { client, shutdown, dataDir } = await launch();
try {
  const view = await open(client, { width: 1600, height: 900, scale: 2, dir: dataDir });
  const shots = [
    { name: "report-1.png", heading: title, body: mdToHtml(`## ${summary}`) },
    { name: "report-2.png", heading: title, body: mdToHtml(`### ${routesShort}`) }
  ];
  for (const shot of shots) {
    await view.load(page(shot.heading, shot.body));
    const file = path.join(here, shot.name);
    await view.capture(file);
    files.push(file);
    process.stderr.write(`wrote ${file}\n`);
  }
} finally {
  await shutdown();
}
