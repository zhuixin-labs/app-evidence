# Windows setup fixes and verification

Date: 2026-10-19. Environment: Windows x64, Node 24.18.0, pnpm 11.5.1.

## Fixes

- The CLI build copies the Windows/macOS bootstrap scripts into `dist/scripts`; the
  installer locates them inside the package.
- Windows PowerShell child processes use PowerShell's own module path, fixing
  `Get-FileHash` being unavailable under PowerShell 7.
- ipatool 2.7.0 for Windows uses the official tar.gz with a pinned SHA-256, extracts the
  versioned EXE and normalizes it to `bin/ipatool.exe`.
- Directory removal and moves verify the path stays inside the workspace tools directory;
  ipatool extraction and copy logic were corrected.
- Configuration is reloaded after install; `workspace/tools/bin/rea.cmd` is preferred;
  repeated installs refresh the managed launcher so it no longer points at a stale source
  directory.
- Health checks resolve `PATH`/`PATHEXT`; missing commands are no longer reported as
  available, and the REA command has its own status line.
- Config writes merge the AppTrace entry into JSON/TOML, preserving other settings,
  servers and custom environment variables; a backup is written first and invalid config
  is never overwritten.
- CLI, metadata health and MCP server versions read their own `package.json`.
- Install docs updated; six regression tests were added to the root test command.

## Verification

| Check | Result |
| --- | --- |
| `pnpm build` | Pass; later CLI/MCP edits rebuilt cleanly |
| `pnpm typecheck` | Pass on the final version |
| `pnpm exec vitest run` | 7/7 pass, six added this round |
| `pnpm test:mcp` | Tools discovered |
| `pnpm pack` | CLI contains both bootstrap scripts |
| Real `setup --install` | Pass; JDK, Ghidra and ipatool installed |
| `setup --install` after installing local tarballs globally | Pass; tools reused, launcher refreshed |
| `ipatool --version` / `java -version` / `rea --help` | Pass |
| MCP from the installed build | Tools listed; basic calls pass |
| Codex config | apptrace enabled; diff against the pre-install backup shows other values unchanged |
| `git diff --check` | Pass |

The local global install used all six `@zhuixin` tarballs generated in that round. The
version was not bumped and the fix was not published; reinstalling the published CLI alone
can reintroduce the old dependencies.

## Not verified

- Apple login returned `authenticated=false`, `keychain=locked`; the user must run
  `apptrace auth login` in a terminal.
- No real IPA download, full analysis, decompilation or report ran; capability
  declarations are not an end-to-end acceptance.
- The macOS installer is packaged but was not executed on a macOS host.
- npm warned about the node-pty install script; login went through interactive ipatool and
  basic MCP calls passed, but the embedded PTY login was not verified.
- Tool discovery in a new Codex desktop chat needs a restart; that round verified through a
  real MCP stdio client and `codex mcp get`.

## User verification

In your own PowerShell:

```powershell
apptrace doctor
apptrace auth login
apptrace auth status
```

Then restart Codex and ask it to call `list_targets`, `list_capabilities` and
`auth_status`. Once signed in, provide an App Store link you are entitled to analyze.

Local logs and tarballs stayed in a local evidence directory (`setup-fixed.log`,
`setup-installed.log`, `doctor-installed.json`, `mcp-installed.log`). Config backups
contain this machine's original configuration and are kept locally only.
