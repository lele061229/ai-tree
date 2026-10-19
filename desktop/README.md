# AI Tree 桌面客户端

托盘常驻的学习卡片 + 按需打开的完整知识树窗口。Electron 44，Windows 优先。

## 状态

| 项 | 状态 |
|---|---|
| 卡片显示 / 收起 / 展开 | 已实机验证（Windows 11，隔离环境） |
| 拖动 + 位置持久化 | 已实机验证（OS 级鼠标事件） |
| 打开完整知识树（复用主窗口） | 已实机验证 |
| 托盘常驻（关窗不退进程、再次启动恢复卡片） | 已实机验证 |
| 托盘右键「退出」 | **待人工确认**（Win11 屏蔽了通知区自动化，脚本点不到） |
| 安装包 / 代码签名 | 未实现；当前只有免安装目录，未签名 |
| macOS / Linux | 未构建、未验证 |

详细结果见仓库根 `docs/VALIDATION.md`。

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
- 渲染进程只能通过 preload 暴露的窄接口操作窗口；主进程对每个 IPC 校验发送方是否为卡片/主窗口。
- 打开外部链接走系统浏览器，不在应用内导航。

## 已知问题

- 图标是 32×32 占位图，正式分发前要换成多尺寸 `.ico`。
- 无自动更新、无崩溃上报、无单点登录刷新（会话过期时卡片提示重新登录）。
- 卡片窗口高度按「展开 220 / 收起 44」计算，加上无框窗口边框后实测为 228 / 52；
  多显示器或高 DPI 缩放下若位置异常，客户端会在下次启动时把卡片拉回可见工作区。
