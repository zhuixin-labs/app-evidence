# Windows x64 Verification

## Scope

This checklist validates the Windows **Host** path:

- Node/CLI/MCP
- Workspace and SQLite
- `.cmd` and ConPTY paths
- JDK/Ghidra/ipatool discovery
- iOS Target acquisition and analysis

Windows Target Provider (PE/MSIX/MSI/Authenticode) remains v1.1 and is not
included in this checklist.

## 1. Install prerequisites

```powershell
node --version
pnpm --version
```

Node must be 22.19 or newer.

## 2. Bootstrap tools

```powershell
cd apptrace
pnpm install
pnpm build

$env:APPTRACE_WORKSPACE_ROOT="$env:APPDATA\AppTrace\workspace"
 # Optional: APPTRACE_IPATOOL_SHA256 overrides the pinned official hash.
node packages\cli\dist\index.js setup --install
```

Expected:

- JDK, Ghidra, and ipatool under `%APPDATA%\AppTrace\workspace\tools`.
- `rea.cmd` generated under `tools\bin`.
- No interactive Windows service or global PATH change.

The Windows installer builds the pinned ipatool 2.7.0 source with the AppTrace
DPAPI credential backend. Source and portable Go SDK SHA-256 values are pinned;
the build runs real cross-process DPAPI tests before installing the executable.
See [Windows authentication and task recovery](Windows认证与任务恢复.md).

## 3. Doctor

```powershell
node packages\cli\dist\index.js doctor --json
```

Expected:

- `hostPlatform: win32`
- `store: sqlite`
- Analysis engine and ipatool paths exist
- 11 capabilities load

## 4. MCP registration

```powershell
node packages\cli\dist\index.js setup --write-config .\mcp.json
```

Use the generated `mcpServers.apptrace` entry in the Agent client. Restart or
reload the client once. Verify all 12 tools appear.

## 5. Authentication

```powershell
node packages\cli\dist\index.js auth login
node packages\cli\dist\index.js auth status
```

Passwords, 2FA codes, and keychain passphrases must stay in the interactive
terminal and must not appear in logs or MCP results.

## 6. Full iOS Target smoke

```powershell
node packages\cli\dist\index.js analyze https://apps.apple.com/cn/app/id1616124777 `
  --goals tech_stack,feature_map,native_risk,report
```

Expected:

- Target and artifact created
- SHA-256 recorded
- Routes/modules/native findings persisted
- Report generated
- No `posix_spawnp`, `ENOENT`, or `.cmd` quoting failures

## 7. MCP async smoke

From the Agent client:

1. Call `analyze_app` with `wait_seconds: 0`.
2. Verify `run_id` is returned.
3. Close the MCP process or reload the Agent client.
4. Call `get_analysis_run` with the same `run_id`.
5. Verify completed or interrupted status is returned from SQLite.

## 8. Result to report

Please record:

- Windows version and architecture
- Node/pnpm versions
- Doctor output
- MCP tool count
- Whether interactive login worked
- Any stderr or stack trace
- Whether analysis completed and the report path
