---
name: apptrace
description: Analyze a locally authorized application package with the AppTrace MCP server. Use for App Store metadata, IPA acquisition, application integrity, technology-stack discovery, route maps, network/storage findings, native inspection, function search, decompilation, version comparison, and evidence reports. Do not use for ordinary source-repository architecture analysis.
---

# AppTrace

AppTrace is an agent-native local application analysis workspace. The product
surface is Target -> Artifact -> Finding -> Evidence -> Report. Analysis engines
are implementation details.

## Start here

When the user provides an App Store URL or App ID and asks what the app uses,
what it contains, or for a report:

1. Call `analyze_app` with the source and the smallest useful set of goals.
   It returns `run_id` when the analysis is still running.
2. Use `get_analysis_run` to wait for or retrieve the completed result.
3. Prefer goals `tech_stack`, `feature_map`, and `report` for a first pass.
4. Add `network` when the user asks about APIs or data flow.
5. Add `native_risk` when the user asks about native code, encryption, or
   decompilation.
6. Answer from the returned structured summary first. Only inspect raw
   Evidence when the user asks a specific follow-up question.

## Authentication

If a tool returns `AUTH_REQUIRED` or `KEYCHAIN_LOCKED`:

1. Stop the workflow.
2. Tell the user to run `apptrace auth login` in their own terminal.
3. Never ask for the password, 2FA code, keychain passphrase, Cookie, or token.
4. After the user confirms login, retry the original action once.

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
