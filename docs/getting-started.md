# Getting Started

## Requirements

- Node.js 22.19+
- macOS arm64 or Windows x64 for automatic toolchain installation
- An Apple account with a license for the app you intend to analyze
- pnpm, only when building from source

## Install

```bash
npm install -g @zhuixin/cli
```

Then use `apptrace` for every command below. To work from source instead, clone the
repository, run `pnpm install && pnpm build`, and replace `apptrace` with
`node packages/cli/dist/index.js`.

## Initialize

Generate an MCP configuration and install the agent instructions before preparing tools:

```bash
apptrace setup --write-config ~/.codex/config.toml --install-skill
```

Reload or restart the agent client after the configuration is written.
Ask the agent to analyze an app. It calls `analyze_app`, installs missing tools,
polls progress, and opens a local Windows login window when needed. It preserves
the original request and resumes after readiness. Only enter credentials in the
local window.

## First run downloads a toolchain

`apptrace setup --install` fetches JDK 21, Ghidra 12.1.4 and ipatool into the
workspace — roughly 1 GB. On macOS arm64 the Ghidra release has no decompiler
binary for this platform, so AppTrace compiles it from the source tree inside the
Ghidra archive. That step needs Xcode Command Line Tools (`xcode-select --install`)
and takes a few minutes. Downloads are verified against the pinned SHA-256; the
official GitHub host is tried first and `https://gh-proxy.com/` is used only as a
fallback transport when GitHub is unreachable.

Configuration writing merges the AppTrace entry and preserves other servers and
settings. Existing files are backed up next to the original as `.<id>.bak` before
writing. TOML formatting and comments are normalized; the backup preserves the
original text. Invalid configuration files are left untouched.

On Windows, run these commands from PowerShell. The installer downloads JDK,
Ghidra, and ipatool into the AppTrace workspace and creates `tools/bin/rea.cmd`.
Run `doctor` after installation to inspect the resolved paths. An available
analysis engine alone does not prove that every external tool or Apple login is ready.

The analysis engine ships as a dependency of the CLI, so a normal install needs nothing
else. To pin a specific build — offline installs, or an air-gapped machine — install an
artifact into the workspace with checksum verification:

```bash
apptrace engine install /path/to/engine-main.js --sha256 <artifact-sha256>
```

A workspace engine takes precedence over the packaged one and is discovered
automatically.

## Manual terminal fallback

```bash
apptrace auth login
apptrace auth status
```

Use your own terminal for the password, 2FA code, and keychain passphrase. AppTrace
does not send those values to the agent.

## Run the first analysis

```bash
apptrace analyze \
  https://apps.apple.com/cn/app/id1616124777 \
  --goals tech_stack,feature_map,report
```

Artifacts, Evidence, jobs, and reports are stored in the local workspace.

## Ask a follow-up question

```bash
apptrace search <target-id> thread --type route
apptrace evidence <target-id>
```

With MCP configured, use natural language in the agent instead of running these
commands manually.

## Troubleshooting

```bash
apptrace doctor --json
```

If authentication is missing, run `auth login`. If the analysis engine is missing,
verify the engine artifact and `APPTRACE_ENGINE_PATH`.
