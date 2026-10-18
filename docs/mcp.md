# MCP Setup

AppTrace exposes a local MCP server. The server uses stdio and does not open a network
port.

## Codex-style TOML

```toml
[mcp_servers.apptrace]
command = "node"
args = ["/absolute/path/to/app-evidence/packages/mcp/dist/index.js"]
```

Use `setup --write-config` to generate the correct local paths, then reload the
client once.

## Tools

| Tool | Purpose |
| --- | --- |
| `analyze_app` | Resolve, acquire, inspect, and analyze an application |
| `get_analysis_run` | Read or wait for an asynchronous analysis run |
| `list_targets` | List local Targets |
| `auth_status` | Read Apple login state without exposing credentials |
| `get_job` | Read a job and recent events |
| `search_findings` | Search routes, modules, assets, endpoints, and native findings |
| `search_native` | Search native procedures or strings |
| `decompile_function` | Decompile an exact symbol returned by search |
| `list_evidence` | List evidence stored for a Target |
| `generate_report` | Create a Markdown evidence report |
| `compare_versions` | Compare two analyzed artifacts |
| `list_capabilities` | Show capabilities available for the current Target |

## Large results

Tool results default to compact summaries. Full semantic graphs and raw analysis documents
remain in the local workspace and are referenced by `evidence_id`.

## Agent guidance

Use the bundled [AppTrace Skill](../skills/apptrace/SKILL.md) so the agent knows when to
search, when to request login, and when native analysis must be blocked.
