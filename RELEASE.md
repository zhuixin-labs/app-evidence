# AppTrace Release Checklist

## Version

Keep these packages on the same version:

- `@zhuixin/shared`
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
pnpm --filter @zhuixin/shared pack --pack-destination dist-packages
pnpm --filter @zhuixin/metadata pack --pack-destination dist-packages
pnpm --filter @zhuixin/mcp pack --pack-destination dist-packages
pnpm --filter @zhuixin/cli pack --pack-destination dist-packages
```

Inspect each tarball before publishing:

```bash
tar -tzf dist-packages/apptrace-*.tgz | sort
```

## Publish order

1. `@zhuixin/shared`
2. `@zhuixin/metadata`
3. `@zhuixin/mcp`
4. `@zhuixin/cli`

Before publishing:

- Remove `private: true` from the packages being published.
- Replace remaining `workspace:*` dependency ranges with released versions if
  the registry client does not rewrite them.
- Verify the package name and trademark.
- Add npm provenance/signing.
- Test a clean install outside the monorepo.

## Release smoke

```bash
npx @zhuixin/cli setup --write-config /tmp/apptrace-mcp.json
npx @zhuixin/cli doctor
npx @zhuixin/cli auth status
```

The public packages do not contain the private engine. The engine artifact is
delivered separately and selected with `APPTRACE_ENGINE_PATH`.

Start a new Agent session with the generated config and run:

```text
分析这个 App Store 链接的技术栈和功能地图，最后生成报告。
```

## Platform status

- macOS arm64: development verification complete.
- Windows x64: code paths exist, but Windows Target Provider and real-device
  Electron/ConPTY/Ghidra validation remain v1.1 work.
- Linux x64: CLI/MCP best effort; not release-gated in v1.
