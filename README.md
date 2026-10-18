# AppTrace

> 工作名：AppTrace / 应用脉络

本仓库采用 Open Core：公开 MCP、CLI、协议和 metadata 层；分析引擎作为
独立私有制品分发，不包含在此公开仓库中。公开部分使用 Apache-2.0。

Agent 原生的本地应用分析工作台。主入口是 CLI 和 MCP Server，Electron
只作为可选的登录、人工确认和 Evidence 浏览控制台。

当前仓库正在从原型迁移到 headless-first 架构。底层分析引擎通过 Provider
接入，产品层不依赖单一逆向工具。

## 目录

```text
packages/
  shared/   共享领域类型和 IPC schema
  protocol/     私有引擎协议
  engine-client/ 公开引擎调用层
  metadata/     Target / Artifact / Job / Capability / Evidence
  cli/      setup / doctor / auth / analyze / mcp
  mcp/      Agent MCP Server
skills/
  apptrace/ Agent 工作流说明
```

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm test:mcp
```

## 本地试运行

当前产品目录直接复用已经准备好的分析环境。开发阶段可以这样运行：

```bash
export APPTRACE_WORKSPACE_ROOT=/Users/daipeng/github/rea-test/workbench-data/dev
export APPTRACE_ENGINE_PATH=/Users/daipeng/github/rea-test/apptrace-private/packages/engine/dist/engine-main.js
export APPTRACE_IPATOOL_PATH=/Users/daipeng/github/rea-test/tools/ipatool/bin/ipatool

node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js auth status
node packages/cli/dist/index.js analyze \
  --target 4171b794-11b4-4c24-9840-c8626c18a448 \
  --goals tech_stack,feature_map,native_risk,report
node packages/cli/dist/index.js search \
  4171b794-11b4-4c24-9840-c8626c18a448 thread --type route
node packages/cli/dist/index.js native search \
  4171b794-11b4-4c24-9840-c8626c18a448 main --kind procedures
node packages/cli/dist/index.js compare \
  4171b794-11b4-4c24-9840-c8626c18a448 <left-artifact> <right-artifact>
```

生成 MCP 配置：

```bash
node packages/cli/dist/index.js setup --write-config /path/to/mcp.json
node packages/cli/dist/index.js setup --install
```

## MCP

构建后直接运行：

```bash
node packages/mcp/dist/index.js
```

也可以从 CLI 启动：

```bash
node packages/cli/dist/index.js mcp
```

当前暴露的工具：

- `analyze_app`
- `get_analysis_run`
- `list_targets`
- `auth_status`
- `get_job`
- `search_findings`
- `search_native`
- `decompile_function`
- `list_evidence`
- `generate_report`
- `compare_versions`
- `list_capabilities`

Codex / 兼容 MCP 客户端配置：

```toml
[mcp_servers.apptrace]
command = "node"
args = ["/absolute/path/to/apptrace/packages/mcp/dist/index.js"]
```

## 当前状态

已完成：

- 独立 `apptrace/` 产品根目录。
- `@zhuixin/shared`、`@zhuixin/protocol`、`@zhuixin/engine-client`、`@zhuixin/metadata`。
- 高层 `AppAnalysisService`。
- CLI 的 `doctor`、`auth`、`targets`、`analyze`、`report`、`jobs`、`mcp`。
- MCP Server 和 12 个基础工具。
- JS 路由、模块、资源、接口、存储与原生统计的紧凑结果。
- Finding 与 Evidence 的 SQLite / JSON 持久化索引。
- 路由、模块、原生符号搜索。
- 原生搜索到反编译的工具闭环。
- 异步 `analyze_app` / `get_analysis_run` 任务。
- Artifact 版本对比。
- 相邻工具自动发现、setup 检查和 JSON/TOML MCP 配置生成。
- macOS arm64 的 JDK/Ghidra/ipatool 自动下载、校验、解压和 Workspace 启动器生成。
- npm 打包检查流程。
- 真实 IPA 验证。
- MCP 工具发现 smoke test。

尚未完成：

- 自动安装器目前只覆盖 macOS arm64；Windows/Linux 仍使用外部工具路径。
- Desktop 控制台迁移。
- Windows Target Provider。

详细实施方案见：
[AppTrace Agent 原生实施方案](../docs/apptrace-agent-first-implementation.md)

发行与打包步骤见 [RELEASE.md](RELEASE.md)。
Windows x64 验收步骤见
[docs/windows-verification.md](docs/windows-verification.md)。
