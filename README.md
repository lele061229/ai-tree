# AI Tree · 个人知识树与学习卡片

把学习过程沉淀成一棵可持续生长的知识树：按能力分层、记录「已实践 / 仅讨论 / 尚未执行」的真实边界，
把原始资料与 AI 摘要分开保存，任何变更先进待审区，由你本人确认后才生成新版本。

本仓库是 **源码仓库**（应用 + Skill + 桌面客户端），不是发行版，也不代表已上线系统。

## 1. 项目用途

- 用一个自部署服务管理自己的学习资料、知识点、能力关系与项目进度。
- 记录「我到底做到哪一步」：讨论过的和亲手做过的分开标，推荐下一课不等于已经学过。
- 通过 `knowledge-os-sync` Skill，让智能体把一次学习整理成结构化更新包提交到待审区，
  由你在网页端逐条核对后确认应用。
- 桌面客户端（Electron）提供托盘常驻的学习卡片和完整知识树窗口。

## 1.5 本地优先桌面版（本轮新增，产品方向）

从 0.2.0 起，桌面端默认**本机独立运行**：

- 双击 `AI Tree.exe` 即可用：内置精简 Python 运行时与 SQLite 数据库，
  自动启动/就绪/退出本地服务，最终用户**不需要**安装 Python、MySQL 或 Docker。
- 数据保存在用户数据目录（`%APPDATA%\AI Tree\local\`：`ko.db`、本地账号凭据、`server.json`），
  不在程序目录，更新/替换程序不会覆盖数据。
- 本地服务只监听 `127.0.0.1`（端口从 18213 起自动分配并保持稳定），**鉴权体系完整保留**
  （会话 Cookie + CSRF + Origin 校验），不是靠关闭鉴权实现。
- 首次启动自动建库（Alembic 迁移）并创建本地账号 `local`；桌面壳自动登录。
- 托盘菜单提供「备份知识库…」（运行中一致性快照，VACUUM INTO）与「恢复知识库…」
  （需先退出应用，恢复前校验占用与完整性）。
- Skill 支持 `ko_sync.py config --local` 自动发现本机 AI Tree 并提交更新包；
  提交目标始终明确显示；**本地提交失败不会自动改道云端**。
- 账号登录与云同步是**可选能力**，本轮未实现：连到云服务器只加载页面；
  云账号绑定、选定知识库双向同步、退出云端删除本地数据等均为规划项，未做假成功。


## 2. 实际功能状态

图例：**已实现** = 代码在仓库里；**已验证** = 有可复现的测试或实机证据；**未验证** = 尚未跑通；
**未上线** = 没有对外提供服务的实例。

| 能力 | 状态 | 说明 |
|---|---|---|
| 账号登录 / 会话 / CSRF 与 Origin 校验 | 已实现 · 已验证 | 单账号自部署形态；测试覆盖登录、登出、越权写入拒绝 |
| 知识树快照、版本历史、节点关系 | 已实现 · 已验证 | 每次确认产生新版本，旧版本与原始资料保留 |
| 原文导入（文本 / Markdown） | 已实现 · 已验证 | 相同内容幂等去重，不覆盖原始资料 |
| 待审区 → 审阅 → 确认应用 | 已实现 · 已验证 | 确认前知识树一行不变；过期预览会被拒 |
| 智能体同步 API（`/api/sync/*`） | 已实现 · 已验证 | 凭据鉴权、幂等、并发保护、基线版本冲突检测 |
| `knowledge-os-sync` Skill 1.1.1 | 已实现 · 已验证 | 标准库 Python 脚本，无第三方依赖；提交进待审区，不自动应用 |
| 学习卡片（网页 + 桌面） | 已实现 · 已验证 | 目标 / 下一步 / 待审数 / 时间戳来自真实接口 |
| 桌面客户端（Electron 44） | 已实现 · 已验证（隔离环境） | 卡片显示、收起、拖动、打开知识树、托盘常驻已实机验证；本地优先 0.2.0 实机 35 通过 / 2 环境受阻 / 0 失败，见 §7 与 `ko-dev/reports/KO-004-local-first-acceptance.md` |
| 数据库迁移（Alembic 0001 / 0002） | 已实现 · 已验证 | 在本地 MySQL 8.4 实例上跑过完整链路 |
| Docker 镜像构建 | 已实现 · **未验证** | 开发环境无 Docker 引擎，镜像未实际构建 |
| 容器内 `/downloads/` 取 Skill 包 | 已实现 · **未验证** | 本地路由返回 200 且哈希一致；容器内未测 |
| 生产部署 / HTTPS / 真实模型调用 | 已实现 · **未验证** | 没有部署，也没有真实的模型供应商请求记录 |
| 备份 / 恢复到真实 MySQL | 已实现 · **未验证** | 脚本与沙箱演练有，生产库恢复未做 |
| 托盘右键「退出」 | 已实现 · 待人工确认 | Win11 对 UIA 屏蔽通知区，自动化点不到；需人手点一次 |
| 安装包 / 代码签名 | 未实现 | 当前是免安装目录（`win-unpacked`），未签名 |

**本版尚未上线**：没有任何生产实例、没有对外域名、没有正式 Release。
隔离测试结果的来源见 §6，未验证项不会被写成已通过。

## 3. 安装与运行

### 3.1 依赖

- Python 3.12（后端依赖精确锁定在 `backend/requirements.lock`）
- MySQL 8.4（默认字符集 utf8mb4）
- Node.js 18+（前端无第三方运行时依赖；只在跑测试和桌面客户端时需要）

### 3.2 本地起服务

```bash
python -m venv .venv
.venv/bin/pip install -r backend/requirements.lock

export DATABASE_URL='mysql+pymysql://<user>:<password>@127.0.0.1:3306/aitree'
export APP_ORIGIN='http://127.0.0.1:8000'
export COOKIE_SECURE=false          # 仅回环地址开发时
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD='<自己设一个>'

.venv/bin/python -m alembic -c backend/alembic.ini upgrade head
.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

前端是 `dist/` 下的静态文件，由后端直接托管；打开 `http://127.0.0.1:8000/` 即可。
首次启动会创建管理员账号（来自上面的环境变量），不会内置任何默认密码。

### 3.3 Docker / Compose

```bash
cp .env.example .env        # 首次：填数据库口令与站点地址
bash deploy/initialize.sh   # 生成密钥、初始化数据目录
bash deploy/compose.sh up -d --build
```

- 镜像名固定为 `aitree-sync:<版本>`（`APP_VERSION`），commit 写在 OCI label `org.opencontainers.image.revision` 里。
- 数据库不映射宿主端口；应用只映射回环。
- 升级、回退与「回退代码 ≠ 撤销数据」的说明见 `docs/SELF_HOSTING.md`。

> 本轮交付未实际构建镜像（环境无 Docker 引擎）。首次在有 Docker 的机器上构建时，
> 请按 `docs/SELF_HOSTING.md` 的顺序执行并记录结果，不要跳过验证步骤。

### 3.4 桌面客户端

桌面工程在本仓库的 `desktop/` 目录（独立功能分支，见 PR）：

```bash
cd desktop
npm ci
npm start           # 开发模式
npm run pack        # 生成免安装目录 dist/win-unpacked
```

客户端只连你配置的服务器地址（托盘右键「服务器地址…」），非回环地址强制 `https://`。

## 4. 测试

```bash
# 后端：49 条（含 Windows ACL 行为、同步协议、混装包来源标注）
.venv/bin/python -m pytest backend/tests -q

# 前端：10 条（图规则、导航、版本与计数）
npm test

# E2E（需要已起好的服务）：见 e2e/README.md
cd e2e && npm ci && npm run sync:review
```

E2E 脚本不含任何真实凭据，账号口令一律从环境变量读取；找不到变量就直接退出，不会用默认口令去试。

## 5. Skill 使用方法

`knowledge-os-sync` 把「一次学习」整理成 `ko.learning-update` 更新包并提交到待审区。
**提交 ≠ 应用**：确认前知识树不会有任何变化。

1. **拿到 Skill 包**：从运行中的实例下载 `GET /downloads/knowledge-os-sync-1.1.3.zip`
   （或自行打包 `skill/knowledge-os-sync/`，版本号写在 `SKILL.md` 的 `version:` 里）。
2. **装进宿主的技能目录**，例如 WorkBuddy：`%USERPROFILE%\.workbuddy\skills\knowledge-os-sync`。
3. **绑定一次凭据**：网页「导入 / 同步」→「生成同步凭据」→ 明文只显示一次 →
   通过标准输入写入 `~/.ko-sync/config.json`（不要放进命令行参数、聊天记录或仓库）：
   ```bash
   printf '%s\n' "$TOKEN" | python scripts/ko_sync.py config --url https://<你的实例> --token-stdin
   python scripts/ko_sync.py check     # 只读：ACL / 地址 / 连通性
   ```
4. **日常使用**：对智能体说「把这次学习同步到我的知识树」，它生成包、本地校验、提交，
   回报提交编号；你回网页审阅并点「确认应用」。

字段约束（为什么不能写 `level` / `verified`）：见 `skill/knowledge-os-sync/SKILL.md`
和 `skill/knowledge-os-sync/references/protocol.md`。服务端会以 `authority_violation` 拒收
模型自行声明的掌握等级。

## 6. 验证记录

来源：`docs/VALIDATION.md`（持续更新）。当前结果：

- 后端 `pytest` **49 passed**
- 前端 `node --test` **10 passed**
- 同步链路端到端 **56/56**（隔离环境，v12 → v13，18 → 21 节点；「已实践 / 仅讨论 / 尚未执行」边界断言全过）
- 桌面客户端实机 **14/14**（卡片 / 收起 / 展开 / 打开知识树）+ 托盘常驻 **4/4**
- 本地优先桌面端 0.2.0 实机 **35 通过 / 2 环境受阻 / 0 失败**（首启建库、Skill 提交→待审→确认、
  重启持久化、运行中备份与恢复、回环断网等价）；受阻项是托盘右键退出的自动化点击，
  本会话任务栏未暴露给 UI Automation，需人工点一次，详见 `ko-dev/reports/KO-004-local-first-acceptance.md`
- 上述结果均来自**隔离测试环境**（本机回环后端 + 本地 MySQL 8.4 / 内置 SQLite），不是生产环境

未验证项已在 §2 逐条列出：Docker 镜像构建、容器内取包、生产部署、真实模型调用、备份恢复。

## 7. 目录结构

| 路径 | 职责 |
|---|---|
| `dist/` | 前端（无构建步骤，直接托管）；`dist/downloads/` 放 Skill 安装包 |
| `dist/modules/graph.js` | 知识树布局、连线、筛选与缩放 |
| `dist/modules/server-api.js` | 唯一的 HTTP 客户端入口 |
| `dist/modules/server-controller.js` / `server-ui.js` | 待审、审阅、确认等资料操作 |
| `backend/routers/` | 登录、知识空间、导入、同步、导师接口 |
| `backend/knowledge.py` | 服务端知识对齐、关系校验、版本事务 |
| `backend/ai_adapter.py` | 唯一的模型调用入口与提取 Prompt |
| `backend/migrations/` | Alembic 迁移（`0001_initial`、`0002_skill_sync`） |
| `skill/knowledge-os-sync/` | Skill 源码（`SKILL.md` + 标准库脚本） |
| `desktop/` | Electron 桌面客户端（独立分支） |
| `e2e/` | 端到端脚本（无凭据，环境变量驱动） |
| `deploy/` | 初始化、启动、备份与恢复、交付打包 |

## 8. 安全与数据

- 原始资料不被 AI 摘要覆盖；混装包（原文 + 摘要）会逐段标注来源，不会被标成「纯摘要」。
- 任务勾选不改变能力等级；讨论不会被提升为「已掌握」或「已上线」。
- 仓库不含真实 `.env`、凭据、数据库或聊天记录；示例配置是虚构值。
- Windows 上凭据文件用 `icacls` 断继承并只授权当前用户，写文件前先收紧临时文件 ACL，
  收紧失败就放弃写入；`check` 只报告被列出的那几个路径的实况。

## 9. 许可证

当前为 `UNLICENSED`（保留所有权利），尚未选择开源许可证。
公开开源前需要先确定许可证与第三方声明口径，详见 `docs/LICENSE-DECISIONS.md`。
第三方依赖清单见 `docs/DEPENDENCIES.md`，各包保持其自身许可。
