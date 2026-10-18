# Getting Started

## Requirements

- Node.js 22.19+
- pnpm
- macOS arm64 for the current preview environment
- An Apple account with a license for the app you intend to analyze

## Install the preview

```bash
git clone git@github.com:zhuixin-labs/app-evidence.git
cd app-evidence
pnpm install
pnpm build
```

## Initialize

```bash
node packages/cli/dist/index.js setup
```

Generate an MCP configuration for your agent:

```bash
node packages/cli/dist/index.js setup --write-config ./.codex/config.toml
```

Reload or restart the agent client after the configuration is written.

If you have a separately distributed engine artifact, install it into the workspace
with checksum verification:

```bash
node packages/cli/dist/index.js engine install /path/to/engine-main.js \
  --sha256 <artifact-sha256>
```

The engine is stored under `tools/engine/current/` and is discovered automatically.

## Sign in to Apple

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
