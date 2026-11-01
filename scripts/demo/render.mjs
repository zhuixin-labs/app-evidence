#!/usr/bin/env node
/**
 * Renders transcript.json into PNG frames, then a MP4 and a GIF.
 *
 * Frames are captured from one headless Chrome page over CDP (see cdp.mjs) and
 * assembled with ffmpeg. Nothing is screen-recorded, so no Screen Recording
 * permission is involved and the result is byte-for-byte reproducible.
 *
 *   node scripts/demo/render.mjs [--out demo] [--width 1600] [--gif]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, open } from "./cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const outName = option("--out", "demo");
const width = Number(option("--width", "1600"));
const height = Number(option("--height", "900"));
const withGif = argv.includes("--gif");
const maxLines = Number(option("--max-lines", "26"));
const limit = Number(option("--limit", "0"));

const transcriptFile = path.join(here, "transcript.json");
if (!fs.existsSync(transcriptFile)) {
  console.error("Run capture.mjs first: node scripts/demo/capture.mjs --target <id>");
  process.exit(1);
}
const transcript = JSON.parse(fs.readFileSync(transcriptFile, "utf8"));

const agentFile = path.join(here, "agent.json");
const agent = fs.existsSync(agentFile)
  ? JSON.parse(fs.readFileSync(agentFile, "utf8"))
  : undefined;
const reportStills = ["report-1.png", "report-2.png"]
  .map((name) => path.join(here, name))
  .filter((file) => fs.existsSync(file));

const frames = [];
const card = (title, subtitle, hold) => frames.push({ kind: "card", title, subtitle, hold });
const term = (lines, cursor, hold) => frames.push({ kind: "term", lines, cursor, hold });
const still = (file, hold) => frames.push({ kind: "image", file, hold });

card("Your agent can't read an App Store app.", "AppTrace turns the bundle into evidence it can cite.", 2.8);

const shown = [];
for (const step of transcript) {
  shown.push(`$ ${step.cmd}`);
  term([...shown].slice(-maxLines), true, 0.75);
  // One line per frame, held long enough to actually read it: a 3-line burst
  // every 0.42s is a wall of text nobody parses. Long prose lines get more time
  // than short table rows.
  for (const line of step.out) {
    shown.push(line);
    const hold = line.length > 70 ? 0.62 : line.startsWith("|") || line.length < 40 ? 0.3 : 0.42;
    term([...shown].slice(-maxLines), false, hold);
  }
  term([...shown].slice(-maxLines), false, 1.3);
}

// The agent segment is a real session: question, real MCP tool call, real answer.
if (agent) {
  card("Same evidence. Asked in words.", "Claude Code · apptrace MCP", 2.4);
  const clean = (text) => text.replace(/\*\*/g, "").replace(/`/g, "");
  const ask = clean(agent.question);
  const toolLine = `\u25cf apptrace.${agent.tool?.name ?? "search_findings"}  ${Object.entries(
    agent.tool?.input ?? {}
  )
    .filter(([key]) => key !== "target_id" && key !== "limit")
    .map(([key, value]) => `${key}=${Array.isArray(value) ? `[${value.join(",")}]` : JSON.stringify(value)}`)
    .join("  ")}`;
  const answerLines = clean(agent.answer)
    .split("\n")
    .map((line) => line.trimEnd())
    // Drop Markdown rules: as terminal text they read as stray dashes.
    .filter((line) => !/^\s*([-*_]\s*){3,}$/.test(line))
    .filter((line, index, all) => line.trim() !== "" || (index > 0 && all[index - 1].trim() !== ""));

  term([{ t: `> ${ask}`, c: "prose" }], true, 1.6);
  term(
    [
      { t: `> ${ask}`, c: "prose" },
      { t: toolLine, c: "tool" }
    ],
    true,
    1.1
  );
  const withAnswer = [
    { t: "", c: "out" },
    ...answerLines.map((line) => ({ t: line, c: "prose" }))
  ];
  term(
    [
      { t: `> ${ask}`, c: "prose" },
      { t: toolLine, c: "tool" },
      { t: "  \u2713 17 findings \u00b7 ev_8392e3ae42a5dfcc", c: "ok" }
    ],
    false,
    1.2
  );
  for (const chunk of [3, 4, 99]) {
    const upto = Math.min(withAnswer.length, chunk);
    term(
      [
        { t: `> ${ask}`, c: "prose" },
        { t: toolLine, c: "tool" },
        { t: "  \u2713 17 findings \u00b7 ev_8392e3ae42a5dfcc", c: "ok" },
        ...withAnswer.slice(0, upto)
      ],
      false,
      1.5
    );
  }
}

for (const file of reportStills) still(file, 3.4);

card("npm install -g @zhuixin/cli", "github.com/zhuixin-labs/app-evidence · preview", 3.0);

const cardHtml = (title, subtitle) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%}
  body{background:radial-gradient(120% 120% at 20% 0%,#131a24 0%,#0b0f14 55%,#080b0f 100%);
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    font-family:-apple-system,"SF Pro Text","Helvetica Neue",sans-serif;color:#e6edf3}
  .t{font-size:64px;font-weight:700;letter-spacing:-.02em;text-align:center;max-width:1180px;line-height:1.15}
  .s{margin-top:26px;font-size:28px;color:#7dd3fc;font-family:"SF Mono",Menlo,monospace}
</style></head><body><div class="t">${title}</div><div class="s">${subtitle}</div></body></html>`;

const ffmpeg = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace-demo-frames-"));
const { client, shutdown, dataDir } = await launch();
// try/finally so an exception or Ctrl-C cannot leave a headless browser running.
process.once("SIGINT", () => {
  shutdown().finally(() => process.exit(130));
});
const page = await open(client, { width, height, scale: 2, dir: dataDir });
const termHtml = fs.readFileSync(path.join(here, "term.html"), "utf8");
await page.load(termHtml);

let index = 0;
const files = [];
try {
for (const frame of limit > 0 ? frames.slice(0, limit) : frames) {
  const file = path.join(frameDir, `f${String(index++).padStart(4, "0")}.png`);
  if (frame.kind === "image") {
    fs.copyFileSync(frame.file, file);
    files.push({ file, hold: frame.hold });
    continue;
  }
  if (frame.kind === "card") {
    await page.load(cardHtml(frame.title, frame.subtitle));
    page.termLoaded = false;
    await page.capture(file);
  } else {
    if (!page.termLoaded) {
      await page.load(termHtml);
      page.termLoaded = true;
    }
    await page.capture(
      file,
      `window.setState(${JSON.stringify({ lines: frame.lines, cursor: frame.cursor })})`
    );
  }
  files.push({ file, hold: frame.hold });
  if (index % 20 === 0) process.stderr.write(`  ${index}/${frames.length} frames\n`);
}
} finally {
  await shutdown();
}

const listFile = path.join(frameDir, "frames.txt");
fs.writeFileSync(
  listFile,
  files.map((entry) => `file '${entry.file}'\nduration ${entry.hold}`).join("\n") +
    `\nfile '${files[files.length - 1].file}'\n`
);

const scale = `scale=1920:1080:flags=lanczos`;
const mp4 = path.join(here, `${outName}.mp4`);
execFileSync(
  ffmpeg,
  [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", `${scale},format=yuv420p`,
    "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-movflags", "+faststart",
    mp4
  ],
  { stdio: "inherit" }
);
process.stderr.write(
  `wrote ${mp4} (${files.length} frames, ${files.reduce((n, f) => n + f.hold, 0).toFixed(1)}s)\n`
);

if (withGif) {
  const gif = path.join(here, `${outName}.gif`);
  execFileSync(
    ffmpeg,
    [
      "-y", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", listFile,
      "-vf",
      `fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
      "-loop", "0",
      gif
    ],
    { stdio: "inherit" }
  );
  process.stderr.write(`wrote ${gif} (${(fs.statSync(gif).size / 1024 / 1024).toFixed(1)} MB)\n`);
}

// Frames are large and reproducible from transcript.json; do not leave them behind.
fs.rmSync(frameDir, { recursive: true, force: true });
