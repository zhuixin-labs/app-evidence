# Releasing

Every release passes the same gate: build, pack, install what will actually ship, and
verify it from the outside. A release that fails the gate does not go out.

## The gate

```text
pnpm build
  → pnpm pack (six packages)
  → install the tarballs in a clean directory
  → doctor: engine present, REA present, core capabilities available
  → setup: generated agent config points at files that exist
  → MCP: required tools listed and one tool call succeeds
  → npm publish
  → repeat the same checks against the registry
```

The first four steps run before `npm publish` in
[`publish.yml`](../.github/workflows/publish.yml), so a packaging regression blocks the
release. The last step runs after publishing, with retries, because registry metadata
propagates unevenly.

## Running it locally

```bash
./scripts/verify-release.sh              # published version, official registry
./scripts/verify-release.sh --tarballs   # what the next release would ship
./scripts/verify-release.sh --analyze https://apps.apple.com/cn/app/id1616124777
```

`--tarballs` builds first. The other modes never touch the working tree: each run
installs into a temporary prefix with an empty npm cache.

## What the gate catches

It exists because two bugs shipped while the local environment looked fine:

1. `setup` wrote an MCP path that only existed inside the monorepo — npm nests workspace
   packages differently, so the generated config pointed at nothing.
2. The CLI did not resolve the bundled REA backend outside the repository, so analysis
   failed for every user even though `doctor` passed locally.

Both are invisible in a checkout and obvious to a smoke test that installs the artifact.

## What it does not cover

Full App Store analysis needs an Apple ID, so CI cannot run it. Use `--analyze` locally
before a release that touches acquisition, inspection, or the analysis engine.

Native decompilation additionally needs Ghidra and a JDK; see the platform table.

## Platform support

| Host | Engine + REA | ipatool / Ghidra / JDK |
| --- | --- | --- |
| macOS arm64 | bundled | `apptrace setup --install` |
| Windows x64 | bundled | `apptrace setup --install` |
| Linux | bundled | manual, via `APPTRACE_IPATOOL_PATH` and the Ghidra/JDK paths |
| macOS x64 | bundled | manual |

The engine and REA are pure JavaScript and ship with the CLI on every platform. Only the
native toolchain is platform-specific, which is why `doctor` is meaningful everywhere
while `setup --install` is not.

## Versioning

`@zhuixin/engine` and the public packages version independently. The public packages
depend on a caret range of the engine, so an engine fix ships as its own patch release.
