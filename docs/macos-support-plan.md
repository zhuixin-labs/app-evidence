# macOS app support plan

Status: phases 1–3 shipped (0.2.4, 0.2.5). Phase 5 `.zip` is implemented; `.dmg` and
phase 4 are not started.

| Phase | State |
| --- | --- |
| 1 — local `.app` target | Shipped. Works on Windows and macOS hosts. |
| 2 — bundle inspection | Wired through `inspect:mac-app`; the inspector itself lives in the private engine. |
| 3 — JavaScript / Electron | Shipped. A timeout is recorded as a limitation instead of failing the run. |
| 4 — native analysis | Not started. Blocked on Ghidra headless; needs a macOS host for `lipo`. |
| 5 — `.zip` | Implemented. Extracts the single top-level `.app` into the workspace on any host. |
| 5 — `.dmg` | Not started. Needs `hdiutil`, so macOS only. |

Until phase 4 ships, `native_risk` on a macOS target is skipped and reported as a
limitation in the result and the report; it does not fail the run. Support is decided by
the target's platform and package format, so Windows and macOS hosts behave the same.

## Host differences

Bundle inspection needs `@zhuixin/engine` 0.2.3 or later. Some details depend on the
host and are never silently dropped:

- Code signature and entitlements are read with `codesign`, so only a macOS host
  produces them. Elsewhere the result carries the warning
  `Signature details require a macOS host.`
- `list_capabilities` marks `inspect:mac-app` as degraded with a `notes` entry on
  non-macOS hosts.
- `AnalyzeAppResult.hostPlatform` records which host produced the result. Engine
  warnings and skipped analyses appear in `limitations` and as `limitation` findings,
  so reports and agents can relay them.

## Goal

Analyze a macOS application the same way AppTrace analyzes an iOS app: resolve a target,
register an artifact, inspect it, search findings, and produce an evidence-backed report.

Non-goals for the first release: downloading Mac App Store apps, circumventing FairPlay,
or analyzing system-protected binaries that the host refuses to read.

## What already fits

- `TargetPlatform` already includes `macos`; `PackageFormat` already includes `dmg` and
  `zip`.
- The source layer is pluggable: `SourceProvider` needs only `canHandle` and `resolve`.
- Capabilities are data-driven by `targetPlatforms` and `packageFormats`.
- REA already parses Apple bundles and analyzes JavaScript/Electron applications.

## What is missing

1. No macOS source provider. Every resolved target is hard-coded to `ios`.
2. Every capability is restricted to `ios`.
3. Inspectors assume the IPA layout (`Payload/*.app/Info.plist`), not `Contents/`.
4. Acquisition is a single App Store job; there is no local-file path.
5. The native provider rejects universal Mach-O binaries and needs a thinned slice.

## Phases

### Phase 1 — local `.app` becomes a target

- Add `"app"` to `PackageFormat`.
- Add `LocalMacAppProvider`:
  - handles an existing `.app` directory;
  - reads `Contents/Info.plist` for bundle id, name, and version;
  - resolves `{ platform: "macos", sourceId: "local-file" }`.
- Add an `acquire:local-file` job that registers the bundle as an artifact: hash it,
  record its size and path, copy nothing unless the user asks.
- Expose it through `apptrace analyze /Applications/Foo.app` and `analyze_app`.

Acceptance: `doctor` reports a macOS target; `list_capabilities` returns macOS entries;
no Apple account is involved.

### Phase 2 — bundle inspection

- New `inspect:mac-app` capability, `targetPlatforms: ["macos"]`,
  `packageFormats: ["app"]`.
- Inspector reads:
  - `Contents/Info.plist` (identifier, version, minimum system, URL schemes);
  - bundle layout: `MacOS/`, `Frameworks/`, `PlugIns/`, `Resources/`;
  - architectures per Mach-O (`lipo -info` or a Mach-O parser);
  - code signature and entitlements (`codesign -d --entitlements :-`, macOS hosts);
  - encryption state and signing identity when available.
- Report gaps explicitly when the host cannot read a file.

Acceptance: a system app and a third-party app both produce structured facts with
limitations, without executing either.

### Phase 3 — JavaScript / Electron

- Detect `Contents/Resources/app.asar` or an unpacked `app/` directory.
- New `javascript:analyze` support for `packageFormats: ["app"]`, delegating to
  `rea analyze-javascript-application` with the ASAR or directory path.
- Map routes, modules, IPC channels and native add-ons into the existing finding model.

Acceptance: an Electron app yields a route/module map and at least one IPC finding.

### Phase 4 — native analysis

- Thin each Mach-O into the workspace with `lipo -thin` before analysis; prefer the host
  architecture, then `x86_64`.
- Reject `arm64e` slices with an explicit limitation instead of a provider crash.
- Enable `native:inspect`, `native:search`, `native:decompile` for `macos`.

Prerequisite: `rea analyze` must complete on a thinned slice. On the current machine the
Ghidra provider reports healthy but the headless launch fails, so this phase is blocked
until that is fixed.

### Phase 5 — `.dmg` and `.zip`

- macOS only: mount read-only with `hdiutil attach -nobrowse -readonly`, copy the `.app`,
  detach.
- `.zip`: extract and locate a single top-level `.app`.
- On other hosts, return a clear "unsupported on this platform" limitation.

## Data model changes

| Change | Where |
| --- | --- |
| `PackageFormat` adds `"app"` | `packages/shared/src/index.ts` |
| `SourceId` adds `local-file` (already used by a disabled descriptor) | `packages/shared/src/index.ts` |
| Capability definitions gain `macos` | `packages/metadata/src/capabilities/registry.ts` |
| New acquire job | `packages/metadata/src/jobs/` |
| New inspector | private engine `src/inspectors/` |

## Testing

- Unit: a synthetic `.app` fixture (`Contents/Info.plist` plus a tiny Mach-O) exercised on
  macOS CI.
- Integration: `apptrace analyze ./fixtures/Sample.app` with no Apple account.
- Release gate: extend `scripts/release-smoke.mjs` with a macOS-only bundle check, skipped
  on Linux runners.

## Risks

- Ghidra headless is currently broken on the development machine; native analysis cannot
  ship until it works.
- Universal binaries must be thinned; doubling analysis time and disk use for both slices.
- `codesign` and `hdiutil` are macOS-only, so parts of the feature degrade on Windows and
  Linux.
- Mac App Store binaries are often FairPlay-encrypted; results will be partial and must be
  reported as such.

## Estimate

| Phase | Effort |
| --- | --- |
| 1 — local `.app` target | 1–2 days |
| 2 — bundle inspection | 1–2 days |
| 3 — JavaScript / Electron | 2 days |
| 4 — native analysis | 1–2 days, after Ghidra is fixed |
| 5 — `.dmg` / `.zip` | 1 day |

Recommended order: 1 → 2 → 3, then fix Ghidra and ship 4; `.dmg` last.
