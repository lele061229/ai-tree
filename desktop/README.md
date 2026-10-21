# AI Tree 桌面客户端

托盘常驻的学习卡片 + 按需打开的完整知识树窗口。Electron 44，Windows 优先。

## 状态

| 项 | 状态 |
|---|---|
| 卡片显示 / 收起 / 展开 | 已实机验证（Windows 11，隔离环境） |
| 拖动 + 位置持久化 | 已实机验证（OS 级鼠标事件） |
| 打开完整知识树（复用主窗口） | 已实机验证 |
| 托盘常驻（关窗不退进程、再次启动恢复卡片） | 已实机验证 |
| 托盘右键「退出」 | 已用真实菜单项验证（UIA Invoke；Win11 托盘图标本身不对 UIA 暴露，菜单由 `--self-test-tray-menu` 弹出） |
| 服务器不可达 / 证书错误 / HTTP 4xx·5xx | 已实机验证：本地错误页 + 重试 |
| 安装包 / 代码签名 | 未实现；当前只有免安装目录，未签名 |
| macOS / Linux | 未构建、未验证 |

详细结果见仓库根 `docs/VALIDATION.md` 与 `reports/KO-DESKTOP-001-launch-fix.md`。

## 启动与退出行为

- **完全退出后双击**：启动主进程、建托盘、显示卡片；失败时窗口仍然可见（本地错误页），不会“双击没反应”。
- **已在运行时再次双击**：第二个实例把命令行交给主实例后退出，主实例只把卡片显示出来，**不会**把已显示的卡片误隐藏。
- **关闭主窗口**：只关主窗口，进程与卡片继续驻留托盘。
- **托盘「退出 AI Tree」**：走正常 `app.quit()`（`before-quit → will-quit → quit`），不强制 `app.exit()`，会话数据正常落盘。
- **服务器不可达 / 证书错误 / 页面 4xx·5xx**：卡片与主窗口显示本地 `error.html`，带“重试”；证书校验保持默认，不忽略证书错误。

## 诊断日志

`%APPDATA%\AI Tree\logs\main.log`（超过 512KB 轮转为 `main.log.old`），记录：

- `process start`（版本、Electron 版本、可执行路径）
- `single instance lock acquired / not acquired`
- `second-instance { ready, initDone, quitting }`
- `card/main did-fail-load`、`card/main http status error`、`show local error page`
- `navigation blocked`、`ipc rejected`
- `tray quit clicked → before-quit → will-quit → quit { exitCode }`

## 开发运行

```bash
npm ci
npm start
```

首次启动没有服务器地址，托盘右键 →「服务器地址…」填你的实例地址：

- 公网地址必须是 `https://`（客户端会拒绝明文 http）。
- `127.0.0.1` / `localhost` / `::1` 允许 `http://`，仅用于本地或 SSH 隧道。

配置写在 Electron 的 `userData/config.json`（`%APPDATA%\AI Tree\config.json`），
包含服务器地址、卡片位置、是否置顶等，不含任何凭据；登录态在独立的 session partition 里。

## 打包

```bash
npm run pack     # 免安装目录 -> dist/win-unpacked
npm run dist     # 单文件 portable exe
```

`dist/win-unpacked` 是**一整个文件夹**（exe + 全部运行时 DLL + resources/app.asar），
分发时必须整体拷贝，只复制 exe 打不开。

## 安全基线

- 所有远程页面 `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`。
- 不忽略证书错误、不关闭 `webSecurity`。
- 服务器地址只做**精确 origin** 比较（`security.js` 的 `sameOrigin`），不做字符串前缀匹配；
  同前缀域名、不同端口、`userinfo@` 混淆、`file:` / `data:` / `javascript:` 均不放行。
- IPC 三项同时校验：**主 frame**（`senderFrame.parent === null`）、**发送窗口**、**精确 origin 或精确文件路径**。
- 本地错误页只保留“收起卡片”一项能力（`setCollapsed` / `openTree` 在 `file://` 上不发送）。
- 打开外部链接走系统浏览器，不在应用内导航。

## 验收脚本

需要 `playwright-core`（CDP 连接，不下载浏览器）与 Python（`window_state.py` 读取 OS 层窗口可见性）。
启动类脚本会在 `127.0.0.1:18080` 起一个 stub，运行前先结束测试目录内的 AI Tree 进程。

| 脚本 | 覆盖 |
|---|---|
| `test/security.test.cjs` | `sameOrigin` / `isExactFile` 单测（`node --test test/security.test.cjs`） |
| `test/startup-matrix.cjs` | 冷启动、运行中双击、隐藏后双击、关主窗口后双击、服务器不可达、结束后重开（默认 3 轮） |
| `test/ipc-guard.cjs` | 主 frame vs iframe、不同端口、userinfo、错误页能力收敛 |
| `test/tray-quit.cjs` | 真实菜单项“退出 AI Tree” + 退出后立即重开（含不等退出的极端时序） |
| `test/prod-connect.cjs` | 用真实客户端只读试连正式站点；**会临时改 `config.json` 并在结束后还原** |

示例：

```bash
KO_EXE="C:\path\to\dist\win-unpacked\AI Tree.exe" node test/startup-matrix.cjs
KO_EXE="C:\path\to\dist\win-unpacked\AI Tree.exe" node test/ipc-guard.cjs
KO_EXE="C:\path\to\dist\win-unpacked\AI Tree.exe" node test/tray-quit.cjs
```

`--self-test-tray-menu` 只用于自动化验收：启动后把真实托盘菜单弹出，供 UIA 点击菜单项；
正常启动不触发。

## 已知问题

- 图标是 32×32 占位图，正式分发前要换成多尺寸 `.ico`。
- 无自动更新、无崩溃上报；系统级崩溃（0x80000003）没有 dump 时无法定位，需要时再启用 `crashReporter`。
- 卡片窗口高度按「展开 220 / 收起 44」计算，加上无框窗口边框后实测为 228 / 52；
  多显示器或高 DPI 缩放下若位置异常，客户端会在下次启动时把卡片拉回可见工作区。
