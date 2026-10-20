# Windows first-use verification

What this verifies: what a new user gets after installing from the README. Builds in the
source tree, unit tests and MCP smoke tests are supplementary and cannot replace this flow.

## State that must be isolated

- Fresh npm global prefix, npm cache, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE` and `HOME`.
- Start a new Windows PowerShell from a normal user directory that contains a space; do
  not run the CLI from the source directory.
- Clear AppTrace/REA environment overrides and reuse no existing tools, launchers or
  AppTrace workspace.
- Install only the `@zhuixin/cli` entry package. Related packages must arrive through
  dependency resolution; installing them by hand first does not count as a first-use pass.
- Do not overwrite a real Codex config, and do not hide first-login problems with an
  existing Apple session.

## Sequence

1. `npm install -g @zhuixin/cli`
2. Run `auth login` before tools exist: it must name the missing dependency and the next
   step, without an `ENOENT` stack.
3. `setup --write-config --install-skill`: write an isolated Codex TOML and Skill before
   tools exist, then start MCP with that config.
4. `analyze_app` saves the request and returns a stable `runId`; an independent worker
   starts installation automatically. Query progress with `get_analysis_run`. For this
   installation-only verification, cancel that analysis task, then use
   `prepare_environment` / `get_setup_status` to verify real downloads and extraction
   without triggering Apple sign-in. See [authentication and task recovery](Windows认证与任务恢复.md).
5. Open a new PowerShell: `doctor` finds the tools installed in this run. MCP lists the
   tools and basic calls succeed.
6. Interactive login entry: reaching the ipatool prompt proves the entry point starts.
   Apple credentials, 2FA and a successful login are verified by the user.
7. Tool discovery after reloading the Codex desktop app, and a full app analysis, are
   recorded as manual acceptance.

Keep exit codes, logs and the package source for every step. After a failure, fix it and
rerun from a different fresh directory; mid-run manual repairs do not count as a pass.

## Running it

Published npm build:

```powershell
node scripts/verify-windows-first-use.mjs
```

Unpublished candidate: build and pack first, then simulate published dependency
resolution through a temporary local registry. The entry package is still installed
exactly once:

```powershell
pnpm build
New-Item -ItemType Directory -Force "$env:TEMP/apptrace-packs" | Out-Null
pnpm -r pack --pack-destination "$env:TEMP/apptrace-packs"
node scripts/verify-windows-first-use.mjs --packages "$env:TEMP/apptrace-packs"
```

The script keeps evidence in a fresh temporary directory and prints the path; it does not
delete it. Windows CI runs the candidate first-use check.

A candidate pass does not mean the public GitHub/npm build passes, and it does not mean a
real Apple login succeeded.

## Public build results, 2026-10-19

After installing `@zhuixin/cli@0.2.0` from npm into an isolated prefix:

- `auth login`: exit code 1, `Error: spawn ipatool ENOENT`, matching the reported screenshot.
- `setup --install`: exit code 1, `TOOL_INSTALLER_MISSING`.
- Conclusion: the published Windows first-use flow failed.

[Windows setup fixes and verification](windows-setup-fixes.md) covers a repaired local
machine and must not be read as a public first-use pass.

## Failure cases added this round

- Login right after install: the old build threw `spawn ipatool ENOENT`; the candidate
  returns `TOOL_NOT_INSTALLED` and points at `setup --install`.
- Tool directory under a Windows 8.3 short path: the old download move failed; the
  candidate normalizes the tool directory and uses .NET file moves.
- The verification script must resolve real paths when comparing install locations, so a
  short path and its long form are not mistaken for different directories.

Interactive entry check: an isolated install showed
`enter Apple ID (email address or phone number):`. It was cancelled before entering an
account, so this is not recorded as a successful Apple login.

## Previous manual setup candidate (not the agent flow)

2026-10-19, another fresh directory: only `@zhuixin/cli` installed, related packages
resolved from a temporary registry.

| Step | Result |
| --- | --- |
| Single-entry npm install | Pass |
| Login before tools exist | Correct dependency hint, exit 1, no ENOENT stack |
| Fresh download / verify / extract | Pass, exit 0 |
| `doctor` in a new PowerShell | Pass, tools from this isolated workspace |
| Isolated Codex TOML written | Pass |
| MCP started from that TOML | Pass, 12 tools, `list_targets` / `list_capabilities` succeed |

Evidence was copied to a local `evidence/apptrace-first-use/final/` directory. This was a
local candidate, not the published npm build.

## Agent-driven candidate acceptance (2026-10-19)

Fresh directory: empty global prefix, cache, `APPDATA`, `USERPROFILE` and `HOME`; only the
CLI installed; no copied tools.

| Step | Result |
| --- | --- |
| Single-entry install, login hint when dependencies are missing | Pass |
| Codex config and Skill written before tools exist | Pass |
| Legacy `analyze_app` preparation and `resume.arguments` | Historical pass; the current persistent `runId` flow must be verified with the updated script |
| Repeated `prepare_environment` reuses the running install | Pass |
| MCP polling until the real download and install reach ready | Pass |
| New PowerShell `doctor`, basic MCP calls | Pass, 15 tools |
| MCP start on the Node 22.19 minimum | Pass; SQLite still emits the Node experimental warning |
| typecheck / build / 26 unit tests / diff check | Pass |

The local candidate Codex config and Skill were installed, with the previous config backed
up by the writer. A real interaction check needs the client's MCP reloaded.

Not verified: no Apple credentials were entered, so no real login, app download or
analysis ran. The new sign-in window and Codex desktop discovery still need acceptance;
reaching the old terminal prompt does not substitute for the new entry point.
