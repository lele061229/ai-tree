# 端到端脚本

这些脚本驱动**真实服务**和**真实 Electron 窗口**，不是单元测试。
所有账号口令都从环境变量读取，脚本里没有任何真实凭据；缺变量就直接退出，不会退回默认口令。

## 准备

```bash
cd e2e
npm ci
npx playwright install chromium   # 若要用 bundled chromium；用系统 Chrome 则只需装依赖
```

服务端按仓库根 `README.md` §3 起好（`http://127.0.0.1:18080`），并且**已有数据**：
同步链路需要一份待审提交，桌面链路需要至少一个节点。

## 1. 同步审阅链路（`sync/review-flow.cjs`）

验证：登录 → 待审列表出现提交编号 → 审阅页逐条 diff → 确认应用 → 版本与节点变化 →
来源标注与等级边界。

```bash
cp sync/manifest.example.json sync/manifest.json   # 改成你自己那次提交的真实数据
KO_PASSWORD='<管理员密码>' npm run sync:review
```

| 变量 | 必填 | 说明 |
|---|---|---|
| `KO_PASSWORD` | 是 | 管理员密码 |
| `KO_MANIFEST` | 否 | 清单路径，默认 `sync/manifest.json` |
| `KO_BASE` | 否 | 默认 `http://127.0.0.1:18080` |
| `KO_USER` | 否 | 默认 `admin` |
| `KO_OUT` | 否 | 截图与 `results.json` 输出目录，默认 `sync/out` |
| `KO_CHANNEL` | 否 | Playwright 的浏览器通道，默认 `chrome` |

清单字段见 `sync/manifest.example.json` 里的 `_字段`。**清单里的基线版本与节点数必须和当前库一致**，
否则断言会（正确地）失败——那说明数据不是你以为的那份，不是脚本有问题。

## 2. 桌面卡片（`desktop/card.cjs`）

验证：卡片数据来自真实接口、收起/展开尺寸、打开完整知识树。

```bash
# 先带调试端口启动客户端
"<安装目录>/AI Tree.exe" --remote-debugging-port=9222

KO_PASSWORD='<管理员密码>' npm run desktop:card
```

| 变量 | 必填 | 说明 |
|---|---|---|
| `KO_CDP` | 否 | 默认 `http://127.0.0.1:9222` |
| `KO_BASE` | 否 | 默认 `http://127.0.0.1:18080`，用于断言连的是哪个环境 |
| `KO_PASSWORD` | 视情况 | 只在会话过期、需要脚本重新登录时用到 |
| `KO_CARD_W` / `KO_CARD_H` / `KO_CARD_H_COLLAPSED` | 否 | 尺寸断言值，默认 376 / 228 / 52 |

尺寸默认值是无框窗口的**实测值**，比设计稿（360×220）大，因为 `window.outer*` 含系统不可见边框。
换机器或改缩放后不要硬改断言来「让它过」，先确认实际尺寸再改。

## 3. 托盘常驻（`desktop/tray.cjs`，Windows only）

验证「关窗口 ≠ 退出」：关卡片后 OS 层窗口隐藏、进程存活；再次启动触发单实例锁并恢复卡片。

```bash
KO_EXE="<安装目录>/AI Tree.exe" KO_PASSWORD='<密码>' npm run desktop:tray
```

| 变量 | 必填 | 说明 |
|---|---|---|
| `KO_EXE` | 是 | `AI Tree.exe` 绝对路径 |
| `KO_PYTHON` | 否 | 跑 `window_state.py` 的 Python，默认 `python` |
| `KO_PROCESS` | 否 | 进程名，默认 `AI Tree.exe` |

**托盘右键菜单「退出」不在自动化范围**：Windows 11 对 UIA 屏蔽了通知区细节，
拿不到托盘图标的可点击元素。这一项需要人工点一次，脚本不假装验证过。

### 两个容易踩的坑

1. **`ELECTRON_RUN_AS_NODE`**：如果从 Electron 宿主（某些 IDE/编辑器）里启动脚本，
   子进程会继承 `ELECTRON_RUN_AS_NODE=1`，exe 变成 node 模式、秒退、不请求单实例锁。
   脚本启动前会清掉它；你自己手动起客户端时也要注意。
2. **渲染器 `visibilityState` 不可信**：CDP 连着的时候焦点仿真会让它恒为 `visible`。
   窗口显隐一律以 `desktop/window_state.py`（`IsWindowVisible`）为准。

## 结果

每次运行会在 `KO_OUT` 写 `*.json`（逐条断言）和截图。这些是运行产物，不进仓库。
仓库里引用的数字来自 `docs/VALIDATION.md` 记录的那次隔离环境运行。
