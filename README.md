# AI Knowledge OS · 个人平台 V1 基础版

此仓库同时包含两种运行方式：

- **静态交互演示**：当前私密 Sites 地址，使用内置虚构资料与浏览器进度，盘点和导师回答是预置演示。
- **自部署个人平台**：FastAPI + MySQL，独立账号登录、服务器保存原文与版本、真实模型接口、待审变更、知识树和学习进度。新账号从空白知识空间开始。

## 先读什么

- [阿里云自部署与备份恢复](docs/SELF_HOSTING.md)
- [接口说明](docs/API.md)
- [验证结果与未验证项目](docs/VALIDATION.md)
- [第三方依赖与许可证元数据](docs/DEPENDENCIES.md)

真实版尚需目标服务器环境与模型配置才能完成部署验收。此仓库不是已上线生产系统的证明。

## 架构与代码

采用模块化单体。前端、应用路由、领域规则、模型适配与数据库分别维护。

| 路径 | 职责 |
|---|---|
| dist/app.js | 页面状态与操作编排 |
| dist/modules/graph.js | 科技树布局、连线、筛选与缩放 |
| dist/modules/panels.js / navigation.js | 学习空间、清单与项目入口 |
| dist/modules/server-api.js | 真实版唯一 HTTP 客户端入口 |
| dist/modules/server-controller.js / server-ui.js | 真实资料操作及界面 |
| dist/modules/domain.js / seed.js | 静态演示的图规则与虚构资料 |
| backend/routers/ | 登录、知识空间、导入、导师接口 |
| backend/knowledge.py | 服务端知识对齐、关系校验、版本事务 |
| backend/ai_adapter.py | 唯一模型调用入口与提取 Prompt |
| backend/database.py / migrations/ | 数据表与可追踪迁移 |
| deploy/ | 初始化配置、启动、备份与恢复、交付打包 |

原始资料不被 AI 总结覆盖；每次确认的导入创建新版本；相同批次重复确认不会创建重复版本；过期预览不能覆盖最新路线。任务勾选不会改变能力等级。模型不能自动把讨论推进成掌握、测试通过或已上线。

## 测试

需要 Python 3.12 与 Node.js 18+；前端无第三方运行时依赖。后端依赖精确锁定。

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.lock
.venv/bin/python -m pytest backend/tests -q
npm test
```

自动测试使用临时 SQLite、真实迁移与测试专用模型适配器，不访问私人资料或计费接口。MySQL 容器、真实模型、生产 HTTPS 与备份恢复需在目标服务器独立验收。

静态演示可用任意静态 HTTP 服务托管 dist/。生产部署读取 docs/SELF_HOSTING.md，不要用临时开发服务器替代登录与 HTTPS 配置。

## 完整软件资产

保留 Git 仓库与历史、源码、依赖锁、数据库迁移、AI Prompt 和适配器、接口说明、运行文档、测试与验证记录，以及备份恢复脚本。交付包另附 Git bundle，可恢复完整提交历史。代码不能依赖作者机器上的私有路径或真实密钥。

当前 V1 支持授权文本 / Markdown 手动导入；直接读取 ChatGPT 历史、真正的 Skill 同步插件、PDF / Word 解析、完整节点编辑与独立能力验证、多用户注册与计费均未实现。

项目为私人软件，UNLICENSED。第三方包各自的许可声明保持独立；不在仓库中附带第三方包二进制或任何密钥。
