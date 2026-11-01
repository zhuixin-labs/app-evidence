# AppTrace Release Checklist

## Version

Keep these packages on the same version:

- `@zhuixin/shared`
- `@zhuixin/protocol`
- `@zhuixin/engine-client`
- `@zhuixin/metadata`
- `@zhuixin/mcp`
- `@zhuixin/cli`

## Build and test

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm test:mcp
```

## Pack check

```bash
mkdir -p dist-packages
pnpm -r pack --pack-destination dist-packages
```

Inspect each tarball before publishing:

```bash
tar -tzf dist-packages/apptrace-*.tgz | sort
```

## Publish order

1. `@zhuixin/shared`
2. `@zhuixin/protocol`
3. `@zhuixin/engine-client`
4. `@zhuixin/metadata`
5. `@zhuixin/mcp`
6. `@zhuixin/cli`

## Automated publishing

Do not enter an OTP for every release. Create an npm automation token with
publish access for `@zhuixin`, store it as the GitHub repository secret
`NPM_TOKEN`, bump versions together, and push a tag such as `v0.1.0`.

The `Publish` workflow runs tests and publishes only the public packages.
The private engine is never included.

The local alternative is npm 2FA in `auth-only` mode, but an automation token
restricted to publishing is preferred.

Before publishing:

- Remove `private: true` from the packages being published.
- Replace remaining `workspace:*` dependency ranges with released versions if
  the registry client does not rewrite them.
- Verify the package name and trademark.
- Add npm provenance/signing.
- Test a clean install outside the monorepo.

## Release smoke

```bash
node scripts/release-smoke.mjs --source tarballs
node scripts/release-smoke.mjs --source registry
```

The smoke installs the packed tarballs the way a user does and checks doctor, the
engine, the REA backend, the **installer scripts referenced by the bootstrap**
(0.2.6 shipped `bootstrap-tools.sh` without `build-ghidra-arm64.sh`, so
`setup --install` died after downloading 570 MB), the generated agent config, and
one MCP tool call.

Then, on a clean machine with an empty workspace:

```bash
npx @zhuixin/cli setup --install
npx @zhuixin/cli setup --write-config /tmp/apptrace-mcp.json
npx @zhuixin/cli doctor
npx @zhuixin/cli auth status
```

`setup --install` is not covered by CI: it downloads about 1 GB and, on macOS
arm64, compiles Ghidra's C++ decompiler. Verify it by hand whenever the installer,
the toolchain versions or the packaging change, and confirm `doctor` reports
`native:inspect`, `native:search` and `native:decompile`.

macOS arm64 note: the Ghidra 12.1.4 release has no `os/mac_arm_64` binaries, so the
decompiler is compiled from the source tree inside the archive. Build `ghidra_opt`
and `sleigh_opt` in two separate `make` runs — passing both to one run selects the
combined `com_*` dependency set, which needs binutils' `bfd.h`.

The public packages do not contain the private engine. The engine artifact is
delivered separately and selected with `APPTRACE_ENGINE_PATH`.

Start a new Agent session with the generated config and run:

```text
Analyze the tech stack and feature map of this App Store link, then generate a report.
```

## Platform status

- macOS arm64: development verification complete on 2026-10-25 for local `.app` and
  `.zip` targets, bundle inspection (including signature authority, team identifier and
  entitlement keys), Electron/JavaScript analysis and report generation. Native Mach-O
  analysis and `.dmg` acquisition are not implemented and are reported as unsupported.
- macOS arm64 install: 0.2.7 fixes `setup --install` end to end — Ghidra natives
  compile, JDK and ipatool install, `doctor` reports every capability, and an iOS App
  Store target yields 1,485 native procedures and 6,203 strings on a stock encrypted
  IPA.
- Windows x64: host path and local Windows app targets (install folder, PE and
  Authenticode inspection, Electron JavaScript analysis) are verified. MSIX/MSI
  packages and native (Ghidra) analysis of Windows apps are not supported yet.
- Linux x64: CLI/MCP best effort; not release-gated in v1.
