# Windows 认证与任务恢复

## 凭据与登录

上游 ipatool 2.7.0 的后端白名单没有 Windows 原生凭据后端，因此回退到需要独立口令的文件库。交互进程解锁后，后台 `--non-interactive` 进程仍需口令，导致登录成功却不能下载。

Windows 安装器通过固定源码与校验和构建 `ipatool-dpapi-v1.exe`，保留上游 Apple 认证和下载实现，仅替换 Windows keyring。DPAPI 使用当前 Windows 用户保护凭据，交互窗口与后台进程可跨进程读取，不需要把解锁口令传给 Agent。大凭据不受 Credential Manager 单条容量限制。密文保存在 ipatool 状态目录的 `apptrace-dpapi-v1` 子目录，损坏或解密失败明确报错，不自动覆盖。

旧文件凭据保持原位。升级后需在本地窗口重新登录一次。原托管路径自动选择新二进制；自定义 `APPTRACE_IPATOOL_PATH` 或 `REA_IPATOOL_PATH` 必须指向带 `apptrace-dpapi-v1` 版本标识的适配版本，否则返回 `IPATOOL_UPDATE_REQUIRED`，不会静默退回旧版。

登录窗口先完成 Apple 认证，再启动独立的非交互账号读取。后台读取成功才显示可继续。账号、密码和验证码仅在本地窗口输入；MCP 不接收登录终端输出。

## 任务生命周期

`analyze_app` 首先把原请求写入工作区 `analysis-tasks.sqlite`，返回稳定 `runId`。独立 CLI Worker 执行：

```text
queued → preparing → awaiting_auth → running → completed / failed
```

没有安装工具时 Worker 调用固定安装程序；需要认证时只自动打开一次登录窗口，随后持续检查后台账号读取。用户取消或关闭窗口后保留原任务并安静等待明确重试。用户完成认证后，同一个任务自动继续下载和分析。Agent 用 `get_analysis_run` 等待，无需用户发送“登录完成了”。

等待认证期间退出 MCP 不会停止 Worker。等待超过 30 分钟则释放 Worker、保留请求；下次 MCP 启动、查询任务或明确打开登录窗口时尝试恢复。进程退出后的恢复需要应用再次启动，不是操作系统自启动服务。

相同有效请求在活动期间返回同一个任务。SQLite 事务、所有权 token 和心跳控制领取；旧 Worker 或登记的下载/引擎子进程仍存活时不重领。PID 重用可能保守地延迟恢复，不会以过期心跳为由重叠执行。结果更新检查所有权，已取消任务不能被旧 Worker 写回成功。取消保留已登记的 artifact 和 Evidence。

下载中断后可能重新下载临时文件；已登记 artifact 按现有分析流程复用。业务许可不足、Apple 服务错误及真实分析失败不会被伪装成成功。

## 验证

- `pnpm test`：认证分类、能力探测、队列去重、所有权、取消与认证后恢复。
- `powershell -NoProfile -File scripts/build-ipatool.ps1 -ToolsRoot <工具目录>`：校验固定源码与 Go 工具链，执行真实 Windows DPAPI 跨进程、大凭据、并发读取和损坏拒绝测试，构建适配版本。
- `pnpm test:auth-resume`：需要 Go；可用 `APPTRACE_TEST_GO` 指定路径。使用隔离账号状态和合成下载/引擎进程，验证等待认证、断开 MCP、自动恢复下载分析、仅下载一次和重连读取结果。不会访问真实 Apple 账号。

以上受控检查不能代替用户账号的首次登录、验证码送达、真实商店下载与真实应用分析验收。
