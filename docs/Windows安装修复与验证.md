# Windows 安装修复与验证

验证日期：2026-10-19。环境：Windows x64、Node 24.18.0、pnpm 11.5.1。

## 本轮修复

- CLI 构建时将 Windows/macOS bootstrap 脚本复制至 dist/scripts，安装器从包内定位。
- Windows PowerShell 子进程使用 Windows PowerShell 自身的模块路径，解决 PowerShell 7 环境中 Get-FileHash 无法识别。
- ipatool 2.7.0 Windows 发布包改用官方 tar.gz，校验固定 SHA-256，提取带版本号的 EXE 后归一为 bin/ipatool.exe。
- 工具目录删除和移动前验证路径位于工作区 tools 内；修正 ipatool 解包复制逻辑。
- 安装完成重新加载配置；优先发现 workspace/tools/bin/rea.cmd；重复安装刷新托管启动器，以免引用旧源码目录。
- 健康检查解析 PATH/PATHEXT，缺失命令不再显示可用；单独报告 REA 命令状态。
- 配置写入合并 JSON/TOML 中的 AppTrace 条目，保留其他设置、服务器及自定义环境变量；写入前备份，非法配置不覆盖。
- CLI、metadata health 和 MCP 服务版本读取各自 package.json。
- 更新安装文档并增加 6 项回归测试，纳入根 test 命令。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| pnpm build | 通过；后续 CLI/MCP 修改分别重建通过 |
| pnpm typecheck | 最终版本通过 |
| pnpm exec vitest run | 7/7 通过，其中 6 项为本轮新增 |
| pnpm test:mcp | 12 个工具发现通过 |
| pnpm pack | CLI 包含两个 bootstrap 脚本 |
| 真实 setup --install | 通过，JDK/Ghidra/ipatool 已安装 |
| 全局安装本地 tarball 后 setup --install | 通过，复用工具并刷新启动器 |
| ipatool --version / java -version / rea --help | 通过 |
| 已安装版 MCP | 版本 0.2.0；12 个工具；基础调用通过 |
| Codex 配置 | apptrace 启用；比较安装前备份确认其他配置值完全相同 |
| git diff --check | 通过 |

本地全局安装使用本次生成的全部六个 @zhuixin 包 tarball 一起安装。
版本号尚未递增，修复尚未发布到 npm；单独重新安装线上 CLI 可能重新引入旧依赖。
正式发布时应按项目发布流程统一更新这些关联包。

## 尚未验证

- Apple 登录状态返回 authenticated=false、keychain=locked；需要用户在终端执行 apptrace auth login。
- 未完成真实 IPA 下载、完整分析、反编译和报告链路，不能以 capabilities 声明代替端到端验收。
- macOS 安装脚本已随包打包，但没有在 macOS 主机执行。
- npm 对 node-pty 安装脚本给出了未批准提示；本次 CLI 登录走交互 ipatool，MCP 基础调用通过，内嵌 PTY 登录未验证。
- Codex 桌面新聊天的工具发现需要重启后验证，本轮通过真实 MCP stdio 客户端及 codex mcp get 检查。

## 用户验证

在自己的 PowerShell 终端执行：

```powershell
apptrace doctor
apptrace auth login
apptrace auth status
```

随后重启 Codex，要求调用 AppTrace 的 list_targets、list_capabilities 和 auth_status。
登录成功后再提供有权分析的 App Store 链接执行分析。

本机日志和 tarball 位于 D:/code/rea-test/evidence/apptrace-windows/：
setup-fixed.log、setup-installed.log、doctor-installed.json、mcp-installed.log。
配置备份包含原有本机配置，仅本地保留，不提交仓库。
