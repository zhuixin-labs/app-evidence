# MCP setup

AppTrace runs as a local MCP server over stdio. No port, no tunnel, no account:
the client starts the process, and the process talks to the same local workspace the
CLI uses.

## Connect a client

`apptrace setup --write-config <path>` writes the correct absolute paths and the
environment the server needs. Pick the path your client reads:

| Client | Path |
| --- | --- |
| Codex | `~/.codex/config.toml` |
| Claude Code | `.mcp.json` (project) or `~/.mcp.json` |
| Cursor | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |

```bash
apptrace setup --write-config ~/.codex/config.toml
```

TOML paths get `[mcp_servers.apptrace]`; JSON paths get an `mcpServers` object.
Restart the client afterwards, then ask it for its tool list — `/mcp` in Claude Code —
and you should see sixteen `apptrace` tools.

For Codex, add `--install-skill` to install the accompanying agent instructions.
`analyze_app` persists the request and returns a stable `runId` immediately.
A detached worker prepares tools, waits for authentication and continues the
same analysis after background account verification. Poll `get_analysis_run`
with that ID through `preparing`, `awaiting_auth` and `running`; do not resend
the request or ask the user to confirm completion. `cancel_analysis_run` cancels
the saved task. The worker survives MCP disconnects. After 30 idle minutes it
releases its execution slot while retaining the request; a new MCP connection,
task query or explicit login starts recovery.
Worker startup is acknowledged through the saved task before returning. An early
exit or missing CLI entry fails the task with `WORKER_START_FAILED` or
`WORKER_ENTRY_MISSING`, preserving its `runId`. `WORKER_START_TIMEOUT` includes
the saved `runId` in error details; query it to check or recover the worker.
An account-check failure terminates the task with the original error code;
sign-in cancellation remains saved and never automatically reopens the window.
`prepare_environment` starts/reuses installation;
`get_setup_status(wait_seconds=20)` waits for tools. For Apple sign-in, `open_login`
opens a separate Windows terminal and
`get_setup_status(wait_seconds=20, require_account=true)` checks readiness.
Only the user enters credentials in that terminal; MCP never receives its output.

Existing configuration is merged, with a sibling `.<id>.bak` backup. Other servers
and AppTrace-specific options are retained. TOML comments and formatting remain
in the backup; malformed configuration is rejected without overwriting it.

### What gets written

Codex (`config.toml`):

```toml
[mcp_servers.apptrace]
command = "/opt/homebrew/bin/node"
args = ["/Users/you/.apptrace/mcp/dist/index.js"]
env = { APPTRACE_WORKSPACE_ROOT = "/Users/you/Library/Application Support/AppTrace/workspace", APPTRACE_CLI_PATH = "/path/to/@zhuixin/cli/dist/index.js" }
```

Claude Code, Cursor, Claude Desktop (`.mcp.json` / `mcp.json`):

```json
{
  "mcpServers": {
    "apptrace": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/you/.apptrace/mcp/dist/index.js"],
      "env": {
        "APPTRACE_WORKSPACE_ROOT": "/Users/you/Library/Application Support/AppTrace/workspace",
        "APPTRACE_CLI_PATH": "/path/to/@zhuixin/cli/dist/index.js"
      }
    }
  }
}
```

The `args` path is the MCP entry inside the installed package; it differs between npm,
pnpm, and a source checkout, which is why you should let `setup` write it rather than
copying an example.

### Claude Code alternative

If you prefer the built-in command instead of a file:

```bash
claude mcp add apptrace -- node /path/to/@zhuixin/mcp/dist/index.js
```

Add the workspace with `-e APPTRACE_WORKSPACE_ROOT=...` if you do not want the default
location.

## Environment

`setup` only writes values that exist. You can override any of them by editing the entry:

| Variable | Meaning |
| --- | --- |
| `APPTRACE_WORKSPACE_ROOT` | Where targets, artifacts, and evidence live |
| `APPTRACE_ENGINE_PATH` | The licensed analysis engine |
| `APPTRACE_ANALYSIS_ENGINE_PATH` | REA binary used for JavaScript analysis |
| `APPTRACE_IPATOOL_PATH` | ipatool binary used to download store apps |
| `APPTRACE_LICENSE` | Signed entitlement for native analysis and comparison |

## Tools

| Tool | Purpose |
| --- | --- |
| `analyze_app` | Resolve, acquire, inspect, and analyze an application |
| `get_analysis_run` | Read or wait for an asynchronous analysis run |
| `list_targets` | List local Targets |
| `auth_status` | Read Apple login state without exposing credentials |
| `get_job` | Read a job and its recent events |
| `search_findings` | Search routes, modules, assets, endpoints, and native findings |
| `search_native` | Search native procedures or strings |
| `decompile_function` | Decompile an exact symbol returned by search |
| `list_evidence` | List evidence stored for a Target |
| `generate_report` | Create a Markdown evidence report |
| `compare_versions` | Compare two analyzed artifacts |
| `list_capabilities` | Show capabilities available for the current Target |

## Large results

Tool results default to compact summaries. Full semantic graphs and raw analysis documents
stay in the local workspace and are referenced by `evidence_id`, so a long session does
not exhaust the context window.

## Agent guidance

The bundled [AppTrace Skill](../skills/apptrace/SKILL.md) teaches an agent when to search,
when to ask the user to sign in, and when a finding is blocked by encryption or licensing.
Install it alongside the MCP entry for the best results.

## Troubleshooting

- **Source changes do not appear in MCP** — rebuild the workspace packages, then
  reload the client's MCP server. An already running server retains loaded code.
  Confirm the configured MCP and `APPTRACE_CLI_PATH` entries point to the same
  installation. Updating a checkout does not update a separate global install.
- **Client approval fails before a tool executes** — that call did not create
  an AppTrace task; check for an existing run before retrying. Resolve the client
  approval error before diagnosing Apple sign-in;
  signing in cannot repair an upstream approval failure.

- **Server starts and exits with no output** — the client is pointing at the package root
  instead of the MCP entry. Re-run `apptrace setup --write-config` and use its `args` path.
- **Tools appear but analysis fails with `CAPABILITY_UNAVAILABLE`** — the engine is not
  installed, or the license does not cover that capability. Run `apptrace doctor`.
- **`LICENSE_REQUIRED`** — the Apple account does not own the app, or it is unavailable in
  that storefront.
