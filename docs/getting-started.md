# Getting Started

## Requirements

- Node.js 22.19+
- pnpm
- macOS arm64 or Windows x64 for automatic toolchain installation
- An Apple account with a license for the app you intend to analyze

## Install the preview

```bash
git clone git@github.com:zhuixin-labs/app-evidence.git
cd app-evidence
pnpm install
pnpm build
```

## Initialize

Generate an MCP configuration and install the agent instructions before preparing tools:

```bash
node packages/cli/dist/index.js setup --write-config ~/.codex/config.toml --install-skill
```

Reload or restart the agent client after the configuration is written.
Ask the agent to analyze an app. It calls `analyze_app`, installs missing tools,
polls progress, and opens a local Windows login window when needed. It preserves
the original request and resumes after readiness. Only enter credentials in the
local window. These changes are an unpublished candidate, not the npm 0.2.0 release.

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
node packages/cli/dist/index.js engine install /path/to/engine-main.js \
  --sha256 <artifact-sha256>
```

A workspace engine takes precedence over the packaged one and is discovered
automatically.

## Manual terminal fallback

```bash
node packages/cli/dist/index.js auth login
node packages/cli/dist/index.js auth status
```

Use your own terminal for the password, 2FA code, and keychain passphrase. AppTrace
does not send those values to the agent.

## Run the first analysis

```bash
node packages/cli/dist/index.js analyze \
  https://apps.apple.com/cn/app/id1616124777 \
  --goals tech_stack,feature_map,report
```

Artifacts, Evidence, jobs, and reports are stored in the local workspace.

## Ask a follow-up question

```bash
node packages/cli/dist/index.js search <target-id> thread --type route
node packages/cli/dist/index.js evidence <target-id>
```

With MCP configured, use natural language in the agent instead of running these
commands manually.

## Troubleshooting

```bash
node packages/cli/dist/index.js doctor --json
```

If authentication is missing, run `auth login`. If the analysis engine is missing,
verify the engine artifact and `APPTRACE_ENGINE_PATH`.
