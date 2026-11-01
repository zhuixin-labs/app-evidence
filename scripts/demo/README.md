# Demo recording

Turns real CLI output into a 1080p MP4 and a GIF, without screen recording.

```bash
node scripts/demo/capture.mjs --target <target-id>          # 1. real CLI output
node scripts/demo/report.mjs --target-dir <target dir>      # 2. report stills
node scripts/demo/render.mjs --gif                          # 3. frames → mp4 + gif
```

Output: `demo.mp4` (1920×1080, 30fps, ~43 s), `demo.gif` (~2 MB), `report-1.png` /
`report-2.png` (report sections), `transcript.json` and `agent.json` (the captured
data every frame replays).

## How it works

`capture.mjs` runs the commands and stores their real stdout+stderr in
`transcript.json`. `render.mjs` renders that transcript into a terminal-looking
page, screenshots one frame per reveal step with headless Chromium, and hands the
frames to ffmpeg. The video is a replay of real output, not a live capture.

The middle segment comes from `agent.json`: one real Claude Code session with the
apptrace MCP server, captured as

```bash
claude -p "<question>" --mcp-config <mcp.json> --strict-mcp-config \
  --allowedTools "mcp__apptrace__search_findings" \
  --disallowedTools "Bash,Edit,Write" --output-format stream-json --verbose
```

Storing the result in `agent.json` keeps the video reproducible, but the agent's
wording is not: two runs of the same question give different answers. Re-running
the capture changes the segment, so read it before publishing.

Ask for facts, not interpretation. Asked "what are these pages for", two runs
answered "geometry learning" and "oil-drilling equipment" for a lathe calculator —
plausible, contradictory, and unverifiable from route names alone. The committed
prompt asks only for routes, files and line numbers, which the evidence supports.

Changing the CLI does not change the video until `capture.mjs` runs again — that
is deliberate, so the demo cannot drift away from the product.

## What it touches

- **No screen recording.** Nothing calls `screencapture`, so no Screen Recording
  permission is requested and no other window can be captured.
- **No keychain.** Chromium runs with `--use-mock-keychain`, a throwaway
  `--user-data-dir` and background networking off, so it never asks for the
  `Chromium Safe Storage` password.
- **Loopback only.** The debugging port is auto-assigned and bound to localhost;
  the page loads `file://` URLs and makes no requests.
- **No sudo, no daemons, no login items.** Only files under `scripts/demo/`
  change, plus temp directories that are deleted on exit.
- Credentials never appear: `capture.mjs` only runs `targets`, `analyze`,
  `search`, `native search` and `report`. It never runs `auth login` and never
  records an interactive prompt. Do not point it at a scenario that does.

`capture.mjs` runs analysis against your real workspace. To keep the demo out of
it, pass `--workspace`:

```bash
node scripts/demo/capture.mjs --target <id> --workspace /tmp/demo-workspace
```

## Options

| Flag | Effect |
| --- | --- |
| `--target <id>` | required; use a target whose artifact is already acquired |
| `--force` | re-run analysis instead of reusing cached evidence (slower, honest) |
| `--workspace <dir>` | isolate the run from your real workspace |
| `--out <name>` | output basename, default `demo` |
| `--limit <n>` | render only the first n frames, for a smoke test |
| `--gif` | also write a GIF |
| `CHROME_PATH` | override the Chromium binary; an invalid path falls back |

## Recording the agent window by hand

The part that cannot be generated here is the agent answering a question. If you
want it in the same video:

1. `Cmd+Shift+5` → Record Selected Portion → the agent window.
2. Ask one question that needs the evidence, e.g. "which routes handle 螺纹 and
   where are they defined".
3. Trim to under 30 s and append it after the terminal segment.

Never record a step that asks for an Apple password, 2FA code or keychain
passphrase. `apptrace auth login` must stay out of frame.
