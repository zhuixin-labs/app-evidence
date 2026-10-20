---
name: apptrace
description: Analyze a locally authorized application package with the AppTrace MCP server. Use for App Store metadata, IPA acquisition, application integrity, technology-stack discovery, route maps, network/storage findings, native inspection, function search, decompilation, version comparison, and evidence reports. Do not use for ordinary source-repository architecture analysis.
---

# AppTrace

AppTrace is an agent-native local application analysis workspace. The product
surface is Target -> Artifact -> Finding -> Evidence -> Report. Analysis engines
are implementation details.

## Start here

If AppTrace tools are not available yet and the user asks to set up AppTrace,
use the available shell to install `@zhuixin/cli` and run
`apptrace setup --write-config <Codex config.toml path> --install-skill`.
Use the client's actual configuration path (normally `~/.codex/config.toml`).
The fixed installer/config writer handles paths and merging; do not invent
installation scripts. Explain once that the client must reload its MCP servers.
Do not claim tools are available until they are discovered. Other clients can
use their normal JSON configuration path without `--install-skill`.

When the user provides an App Store URL or App ID and asks what the app uses,
what it contains, or for a report:

1. Call `analyze_app` with the source and the smallest useful set of goals.
   Retain its `runId` from the first response, including `queued`, `preparing`
   and `awaiting_auth`. A persistent local worker installs missing tools, opens
   Windows sign-in once and resumes the original task after background account
   verification. Poll `get_analysis_run(run_id=runId, wait_seconds=20)` until
   completed or failed. Do not end the turn just because login is pending and
   do not ask the user to confirm completion or resend `analyze_app`.
   Report meaningful stage changes; credentials belong only in the local window.
   If `stage=login_cancelled`, explain that the task is saved and wait for an
   explicit retry; do not reopen the window automatically.
2. Use `get_analysis_run` to wait for or retrieve the completed result.
3. Prefer goals `tech_stack`, `feature_map`, and `report` for a first pass.
4. Add `network` when the user asks about APIs or data flow.
5. Add `native_risk` when the user asks about native code, encryption, or
   decompilation.
6. Answer from the returned structured summary first. Only inspect raw
   Evidence when the user asks a specific follow-up question.

## Authentication

If a tool returns `AUTH_REQUIRED` or `KEYCHAIN_LOCKED`:

1. Call `open_login`. Tell the user to enter credentials only in the local window.
2. For an existing analysis task, poll `get_analysis_run` with its saved ID;
   the worker resumes automatically. For standalone setup, poll
   `get_setup_status(wait_seconds=20, require_account=true)`. Do not open repeated
   windows or ask the user to repeat their goal.
3. Never ask for, capture, screenshot, log, or relay passwords, verification
   codes, keychain passphrases, cookies, or tokens. Only the user handles them.
4. If a login attempt is cancelled or fails, explain the state and wait for the
   user to request another attempt. Do not repeatedly reopen a dismissed window.
5. On hosts without automatic login windows, give the fallback command
   `apptrace auth login` and keep querying the saved task. Confirmation in chat
   is not a substitute for background account verification.

Windows requires the AppTrace DPAPI adapter. `IPATOOL_UPDATE_REQUIRED` means the
managed tool needs an update or a custom tool path points to an old version.
An update preserves the old file keyring but requires one local sign-in into
the new Windows-user-protected store. `CREDENTIAL_ACCESS_FAILED` means the store
cannot be read/decrypted; do not overwrite it or treat that as logged out.
Use `cancel_analysis_run` only when the user requests cancellation. Waiting
tasks survive MCP disconnection; after 30 idle minutes a worker stops waiting
and retains the task, resumed by the next MCP connection or explicit login.

For `failed`, distinguish account-check failure from installation failure.
Do not infer that the user is logged out from a timeout or unknown response.
Inspect the installation log only for tool-install failures, then retry
`prepare_environment(retry=true)` at most once after addressing the cause.
Never read or send login terminal output to an analysis tool.

If a tool returns `LICENSE_REQUIRED`, explain that the Apple account needs to
obtain the app from the iPhone App Store first. Do not attempt to bypass it.

## Evidence rules

- Treat static observations as observations, not proof of runtime behavior.
- Keep source paths, line/column ranges, hashes, and Evidence IDs.
- Do not dump complete semantic graphs or raw JSON into chat.
- Page large Evidence results and cite the Evidence ID.
- Clearly separate observed facts, inference, unknown coverage, and limitations.
- A bounded search is a bounded negative result, not proof of absence.

## Native analysis

- Check the encryption state before suggesting decompilation.
- `cryptid != 0` means the code region is declared encrypted. Do not treat
  pseudocode from that region as trustworthy original implementation.
- Never ask the user to guess a function name. Call `search_native` first.
- Select an exact procedure name from the search result, then call
  `decompile_function`.
- Pseudocode is reconstructed analysis output, not original source.

## Structured findings

Use `search_findings` for routes, modules, assets, network endpoints, storage,
native symbols, risks, and limitations. It reads the persisted index and returns
source locations and Evidence IDs.

Prefer a narrow query and type filter. If the result is incomplete, use `limit`
and `offset`; do not assume a bounded search proves absence.

## Version comparison

Use `compare_versions` with two artifact IDs from the same target. Compare
technology, routes, modules, assets and network candidates as static findings.
Added/removed coverage is only complete when both artifacts have complete
Evidence for that finding type.

## Safety

- Analyze only apps the user owns or is authorized to inspect.
- Do not execute the target app, installer, or extracted scripts.
- Do not access services discovered in the app.
- Do not reproduce third-party credentials, unlicensed assets, or private code.
- Do not claim FairPlay decryption or complete source recovery.

## Useful tools

- `prepare_environment`
- `get_setup_status`
- `open_login`
- `analyze_app`
- `get_analysis_run`
- `auth_status`
- `list_targets`
- `get_job`
- `search_findings`
- `search_native`
- `decompile_function`
- `list_evidence`
- `compare_versions`
- `generate_report`
- `list_capabilities`

Use low-level capabilities only when the user's question requires a focused
follow-up.
