# Changelog

## 0.2.7 — unreleased

First release where a new user can install the toolchain and reach native analysis.

### Fixed

- `setup --install` on macOS arm64 failed after downloading 570 MB of Ghidra:
  `bootstrap-tools.sh` called `scripts/build-ghidra-arm64.sh`, which was never
  packed into the npm tarball.
- Packed scripts arrive with mode 0644, so the builder is now invoked through
  `bash` instead of being executed directly.
- Ghidra's decompiler failed to build with `'bfd.h' file not found`: building
  `ghidra_opt` and `sleigh_opt` in one `make` run selects the combined `com_*`
  dependency set. They are built in two runs now.
- Toolchain prerequisites are checked before the 1 GB download instead of after it.

### Changed

- Native symbol search, decompilation and version comparison are free. They
  previously required a signed license that had no issuance path, so the README
  promised capabilities no external user could use. Engine 0.2.5.
- The official GitHub host is tried first; `gh-proxy.com` is only a transport
  fallback. Pinned SHA-256 verification is unchanged.
- Getting started installs from npm (`npm install -g @zhuixin/cli`); building from
  source is documented as the fallback.

### Release gate

- Building the CLI fails if any script referenced by the bootstrap scripts is
  missing from `dist/scripts`.
- `scripts/release-smoke.mjs` checks the shipped installer scripts, not only the
  generated agent config.

### Known limits

- macOS: native Mach-O analysis of local `.app` bundles and `.dmg` acquisition are
  not implemented.
- Windows: native analysis, MSIX/MSI inspection and signature validation on a
  non-Windows host are not implemented.
- Encrypted App Store slices (`cryptid=1`) are reported as encrypted; JavaScript,
  route, module and metadata analysis is unaffected.
