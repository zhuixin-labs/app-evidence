# Contributing

Thank you for helping improve AppTrace.

## Public contribution scope

The public repository accepts contributions to:

- MCP tools and protocol
- CLI and setup experience
- metadata and storage
- documentation and examples
- Agent Skill
- test fixtures and release automation

The private analysis engine is not part of this repository.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Keep changes focused and include tests or a clear verification note. Do not submit real
IPA files, Apple credentials, personal reports, or tool downloads.

## Day-to-day loop

### Public packages (this repository)

```bash
pnpm typecheck && pnpm test    # fast loop
pnpm build
node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js analyze <App Store URL>
```

For the agent path, write a config and point your client at it:

```bash
node packages/cli/dist/index.js setup --write-config ./.mcp.json
```

### Engine changes (private repository)

The CLI prefers `APPTRACE_ENGINE_PATH` over the packaged engine, so you can test an
unreleased build without publishing:

```bash
cd ../apptrace-engine
pnpm build
cd ../apptrace
APPTRACE_ENGINE_PATH=../apptrace-engine/dist/engine-main.js \
  node packages/cli/dist/index.js analyze <App Store URL>
```

## Test layers

| Layer | Command | Catches |
| --- | --- | --- |
| Unit | `pnpm test` | protocol, registry and model logic |
| MCP surface | `node scripts/smoke-mcp.mjs` | tool registration and wiring |
| Release | `./scripts/verify-release.sh --tarballs` | packaging, path resolution, generated agent config |
| Published | `./scripts/verify-release.sh` | what users actually install from npm |

The release layer is the one that matters most: it installs the artifact the way a user
does, in a temporary directory with an empty npm cache. Two shipped bugs were invisible
locally and obvious there.

## Release checklist

1. Bump `version` in the root `package.json` and every `packages/*/package.json`.
2. Run `./scripts/verify-release.sh --tarballs` and fix anything it reports.
3. `git tag vX.Y.Z && git push origin main vX.Y.Z`.
4. Watch the publish workflow. The tarball smoke runs before `npm publish`; if it fails,
   nothing is published.
5. After the workflow is green, `./scripts/verify-release.sh` confirms the registry copy.

### Which repository gets the release

| Change | Where to release |
| --- | --- |
| Engine internals, inspectors, native analysis | `apptrace-engine` only |
| CLI, MCP tools, metadata, setup | this repository |
| Protocol or engine contract, breaking | both, minor version |

Public packages depend on `@zhuixin/engine` with a caret range, so an engine patch is
picked up without a public release.

## Pull requests

Describe:

1. The user-facing problem.
2. The chosen behavior.
3. The verification performed.
4. Any limitations or compatibility impact.
