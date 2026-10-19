# Windows 首次使用验收

验收对象是新用户按 README 安装后的行为。开发目录的构建、单元测试、MCP 冒烟测试只能作为补充，不能代替本流程。

## 必须隔离的状态

- 全新的 npm 全局前缀、npm 缓存、APPDATA、LOCALAPPDATA、USERPROFILE、HOME。
- 从带空格的普通用户目录启动新的 Windows PowerShell 进程，不在源码目录运行 CLI。
- 清除 AppTrace/REA 环境覆盖，不复用已有工具、启动器或 AppTrace 工作区。
- 只安装 @zhuixin/cli 这一个入口包，关联包必须通过依赖解析获得。不得先手动安装多个关联包后把结果算作首次安装通过。
- 不覆盖真实 Codex 配置，不使用真实 Apple 登录状态来掩盖首次登录问题。

## 顺序

1. npm install -g @zhuixin/cli。
2. 未准备工具时运行 auth login：必须明确指出缺失依赖和下一步，不应暴露 ENOENT 堆栈。
3. setup --write-config --install-skill：在尚未安装工具时写入隔离的 Codex TOML 和 Skill，用实际配置启动 MCP。
4. analyze_app 自动触发安装，必须返回 awaiting_setup 和完整 resume.arguments；prepare_environment 重复调用复用安装任务。get_setup_status 查询进度，真实下载、校验和解压，不预先复制工具。
5. 新开 PowerShell：doctor 找到本次安装的工具。MCP 发现 15 个工具，基本调用正常。
6. 交互登录入口：到达 ipatool 的输入提示即可证明入口启动；Apple 凭据、2FA 和登录成功由用户验证。
7. Codex 桌面重新加载后的工具发现和完整应用分析，单独标记为人工验收。

每一步保留退出码、日志和使用的包来源。失败后修复，最终必须从另一份全新目录重跑，不把中途手工补救算作通过。

## 执行

公开 npm 版：

```powershell
node scripts/verify-windows-first-use.mjs
```

未发布候选版先 build/pack，再通过本地临时 registry 模拟发布依赖解析；仍然只执行一次入口包安装：

```powershell
pnpm build
New-Item -ItemType Directory -Force "$env:TEMP/apptrace-packs" | Out-Null
pnpm -r pack --pack-destination "$env:TEMP/apptrace-packs"
node scripts/verify-windows-first-use.mjs --packages "$env:TEMP/apptrace-packs"
```

脚本在全新临时目录保存证据并打印路径，不自动删除；Windows CI 已加入候选包首次使用检查。
候选包通过不代表 GitHub/npm 公开版通过，也不代表真实 Apple 账号登录通过。

## 2026-10-19 已确认的公开版结果

@zhuixin/cli@0.2.0 从 npm 安装到独立前缀后：

- auth login：退出码 1，Error: spawn ipatool ENOENT，与用户截图一致。
- setup --install：退出码 1，TOOL_INSTALLER_MISSING。
- 结论：当前公开版 Windows 首次使用流程失败。

此前《Windows安装修复与验证》验证的是修复后的本机环境，不应被解释成公开版首次使用通过。

## 本轮新增的失败用例

- 首次安装后直接登录：旧版抛出 spawn ipatool ENOENT；候选版返回 TOOL_NOT_INSTALLED 并提示 setup --install。
- 工具目录采用 Windows 8.3 短路径：旧下载移动操作失败；候选版规范化工具目录并使用 .NET 文件移动。
- 验收脚本比较安装位置时必须解析真实路径，避免将短路径与对应长路径误判成跨目录。

交互入口实测：在隔离安装中启动 auth login，已显示 `enter Apple ID (email address or phone number):`。在输入任何账号前取消；不将此项记为 Apple 登录成功。

## 前一轮手动 setup 候选版结果（不代表 Agent 流程）

2026-10-19，另一全新目录 dmVlG9，入口只安装 @zhuixin/cli，候选关联包由临时 registry 自动解析：

| 步骤 | 结果 |
| --- | --- |
| 单入口 npm 安装 | 通过 |
| 安装工具前登录 | 正确提示安装依赖，退出码 1；无 ENOENT 堆栈 |
| 全新下载/校验/解包 | 通过，退出码 0 |
| 新开 PowerShell doctor | 通过，工具来自本轮隔离工作区 |
| 生成隔离 Codex TOML | 通过 |
| 读取 TOML 启动 MCP | 通过，12 个工具，list_targets/list_capabilities 调用通过 |

证据已复制到本机 D:/code/rea-test/evidence/apptrace-first-use/final/。
此结果属于本地候选版，不是 npm 公开版；未提交、推送或发布。

## Agent 驱动候选版验收（2026-10-19）

全新目录 `apptrace first use FYBXhc`：空白全局前缀、缓存、APPDATA、USERPROFILE 和 HOME，仅安装 CLI；未复制已有工具。

| 步骤 | 结果 |
| --- | --- |
| 单入口安装、缺依赖登录提示 | 通过 |
| 工具安装前写 Codex 配置并安装 Skill | 通过 |
| analyze_app 自动启动准备、完整保留 resume.arguments | 通过 |
| 重复 prepare_environment 复用运行中的安装 | 通过 |
| MCP 轮询真实下载安装至 ready | 通过 |
| 新 PowerShell doctor、MCP 基本调用 | 通过，15 个工具 |
| Node 22.19 最低版本 MCP 启动 | 通过，SQLite 仍有 Node 实验性提示 |
| typecheck / build / 26 项单元测试 / diff 检查 | 通过 |

证据：`D:/code/rea-test/evidence/apptrace-first-use/agent-final/`。
当前 Codex 配置和 Skill 已更新为 `D:/code/app-evidence` 的本地候选实现，原配置由写入器备份。需重载客户端 MCP 后做真实交互验收。

未验证边界：本轮没有输入 Apple 凭据，没有完成真实登录后的应用下载与分析；新开登录窗口的实际交互与 Codex 桌面发现仍需验收。前一轮手动终端到达登录提示不替代新入口验收。尚未提交、推送或发布，公开 npm 包不会因此自动更新。
