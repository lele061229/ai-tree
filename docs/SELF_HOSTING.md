# AI Knowledge OS · 阿里云个人平台 V1

当前交付是可自部署的个人平台基础版：FastAPI、MySQL 8.4 LTS、现有模块化前端。一个账号一个知识空间，管理员通过命令创建账号，不开放注册。与原静态演示共用前端，检测到 `/api/runtime` 后使用真实后端；静态演示仍使用虚构数据。本部署包不包含真实用户数据或任何密钥。

## 已实现与范围

- 数据库保存账号、会话、原始资料、知识节点、依赖关系、版本、导入批次和任务进度。
- 密码使用 Argon2；登录使用服务端可撤销会话和 HttpOnly / Secure / SameSite Cookie；写请求校验 CSRF。所有数据 API 校验账号归属。
- 支持 UTF-8 Markdown / 纯文本，单份最多 50000 字符；可上传本地文件或粘贴文本。导入不会自动读取其他资料。
- 资料分析经配置的模型接口实际请求，结构校验、名称/别名对齐、循环校验后才生成待审计划。确认后原子创建新版本，旧版本与原文保留。
- 完全相同的原文重复导入复用来源；相同批次重复确认不会产生新版本。并发产生的过期预览不能覆盖最新路线。
- 新知识只标记“讨论过”，新项目只标记“讨论”；已有证据等级、项目阶段不按模型声称或勾选自动提升。
- AI 导师发送当前节点、目标及至多四条关联来源，回答与来源一起展示。未配置模型时明确报错，无示例回答兜底。
- V1 采用单进程应用和同步分析请求，模型请求上限约100秒；无独立任务队列。失败后可基于保存的原文重新分析。

当前不包含：直接读取 ChatGPT 历史、已安装的真实同步 Skill、PDF/Word 解析、多用户注册、支付、独立能力评估、人工修改节点的完整编辑器或自动化每日备份调度。模型提取最多20个节点，个人空间最多200个节点。名称/别名与模型上下文对齐不是完善的语义实体消歧系统。

## 部署前需要确认

确认阿里云实例操作系统、CPU/内存/磁盘、现有 Docker / Nginx / 数据库、现有域名与网站、可用端口。先核对 `18080` 与 Compose 项目名 `knowledge-os` 是否已占用。以下命令不应在环境未知时直接整体执行。

MySQL 不映射公网端口；应用只绑定服务器回环地址 `127.0.0.1:18080`。可以通过 SSH 隧道私密试运行，或由独立 HTTPS 入口转发。HTTPS 入口可使用域名或受信任证书覆盖的公网 IP。此方案不需要自动购买阿里云 RDS；如后续选用 RDS，可通过服务器配置中的连接参数替换数据库地址。

部署命令统一使用 `bash deploy/compose.sh`：自动选择 Compose V2 或现有 `docker-compose`，固定项目名 `knowledge-os`、源码目录和配置文件。Compose 文件保留 `version: "3.8"` 以兼容旧版。Compose V2 可能提示该字段已过时；不影响解析。旧版兼容仅用于受控试运行，不代表老操作系统已获得生产支持。备份与恢复使用同一入口，避免切换命令或当前目录时误选其他项目。

## 首次运行

准备 Docker Engine 与 Compose，将完整仓库放入独立目录，例如 `/opt/knowledge-os`。HTTPS 方式需要先准备覆盖访问域名或 IP 的证书；私密试运行可以先使用下文的 SSH 隧道。

```sh
bash deploy/initialize.sh --origin https://knowledge.example.com
bash deploy/compose.sh config -q
bash deploy/compose.sh up -d --build
bash deploy/compose.sh ps
curl --fail http://127.0.0.1:18080/api/health
```

将示例地址替换为实际 HTTPS 地址；初始化脚本拒绝覆盖已有 `.env` 或 `.secrets`。`initialize.sh` 使用 Dockerfile 中相同的 Python 基础镜像运行独立初始化脚本，不需要升级服务器上的 Python。容器不联网，只将本项目独立目录挂载为可写；镜像首次获取由 Docker 执行。`:z` 仅共享标记本项目目录，兼容启用 SELinux 的主机，勿在混有其他项目的目录内运行。

配置与密钥不进入 Git。初始化产生 admin 账号的随机初始密码，密码保存在服务器 `.secrets/admin_password`。在服务器本地读取后登录，不要将文件上传到仓库。`.secrets` 父目录仅所属用户可访问，文件以只读 Docker secrets 挂载给非 root 应用容器。

容器启动先执行 Alembic 迁移，再首次创建 admin；已有账号不会被重建或自动改密码。使用 `deploy/nginx.example.conf` 新增一个站点配置，按实际证书与端口修改，先运行 `nginx -t`，通过后再重载。已有 Nginx 网站配置不应被整体替换。

首次登录为空知识空间，导入一份小资料建立自己的能力树；不会把原型里的虚构个人项目当作你的真实知识。

## 无域名的私密试运行

只在尚未初始化的新目录中执行。应用仍绑定回环地址，不新增公网 HTTP 入口，不需要修改原 Nginx 网站配置：

```sh
bash deploy/initialize.sh --local-tunnel --origin http://127.0.0.1:18080
bash deploy/compose.sh config -q
bash deploy/compose.sh up -d --build
curl --fail http://127.0.0.1:18080/api/health
```

`--local-tunnel` 只接受精确的 `http://127.0.0.1:18080`。此模式 Cookie 不带 Secure；浏览器到服务器的连接必须经 SSH 加密隧道。初始化和后端均拒绝以该选项启用公网 HTTP。

在自己电脑的 PowerShell 中建立隧道，替换服务器登录名、SSH 端口和 IP：

```powershell
ssh -p SSH端口 -N -L 127.0.0.1:18080:127.0.0.1:18080 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 登录名@公网IP
```

隧道窗口保持打开，在同一台电脑浏览器访问 `http://127.0.0.1:18080`。密码在本机终端交互输入，不贴到聊天或命令参数。SSH 主机指纹通过可信渠道核对，不关闭主机校验。首次连接应使用当前可用的 SSH 登录方式，不修改系统 SSH 配置来强制使用此示例。

从隧道切换到 IP HTTPS 时，先准备证书与自动续期，添加独立入口，再将服务器 `.env` 的 `APP_ORIGIN` 改成最终 HTTPS 地址、`COOKIE_SECURE` 改为 `true`，重建 app 容器。旧的回环 Cookie 不会发送到公网 IP，需重新登录。IP 证书可参考 [Let's Encrypt 官方说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)；短期证书必须自动续期并重载 Web 服务器。不要为申请证书而直接停掉现有 Nginx。

## 配置模型

当前适配支持 `/chat/completions` 与 `response_format: {type: json_object}` 的兼容接口。具体供应商、模型名与套餐应以供应商当前文档和用户账号为准，未预选收费套餐。

在服务器编辑 `.env` 中的 `AI_BASE_URL`（包含 `/v1` 等供应商要求的路径）和 `AI_MODEL`。在服务器本地将密钥写入 `.secrets/ai_api_key`，不要把密钥写进页面或 Git。配置后重建应用容器以重新读取环境：

```sh
bash deploy/compose.sh up -d --force-recreate app
```

数据库使用独立持久卷，不会因为重建应用容器丢失。不要执行 `bash deploy/compose.sh down -v`，它会删除数据库卷。

## 备份与恢复演练

```sh
bash deploy/backup.sh
bash deploy/restore_sandbox.sh backups/实际备份文件.sql.gz
```

备份使用事务一致性转储并校验 gzip 完整性，输出到权限受限的 backups 目录。恢复演练始终创建单独的 `restore_时间戳` 数据库，绝不覆盖当前 `knowledge_os`。演练完成后人工核对来源、版本和节点数量。生产回退应先备份现状并明确目标版本，再按维护窗口执行。

请额外保留仓库版本、`.env` 和 `.secrets` 的受控备份；SQL 文件与登录/模型密钥不要分享给不需要访问的人。定时与异地备份需要在服务器确认存储位置后配置。

## 本地开发与测试

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.lock
.venv/bin/python -m pytest backend/tests -q
npm test
```

自动测试使用独立临时 SQLite 数据库验证路由、权限与领域逻辑；模型请求使用测试专用假适配器或 HTTP MockTransport，不调用计费接口。迁移脚本与生产驱动面向 MySQL。当前构建环境没有 Docker/MySQL 服务，MySQL 容器启动、真实模型联调和备份恢复仍需在目标服务器验收，不能把这些测试记为生产通过。

## 代码职责

`backend/config.py` 配置；`database.py` 表模型；`schemas.py` 输入与模型结果契约；`security.py` 会话与写请求校验；`knowledge.py` 知识对齐、关系验证和版本事务；`ai_adapter.py` 唯一模型调用入口；`routers/` 按业务分组接口；`migrations/` 数据迁移。前端 `server-api.js` 是唯一 HTTP 入口，`server-controller.js` 编排真实操作，`server-ui.js` 展示真实资料流程。

不得将 AI 调用直接塞进节点 DOM 事件或让页面访问数据库。数据库迁移是独立版本文件；初始迁移禁止直接降级删表。以后交给另一位开发者，应连同此文档、测试、版本历史和部署配置移交，并执行一次重新安装与恢复演练。
