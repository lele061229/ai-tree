# 参与开发

本仓库当前是**私有仓库**，采用「主分支受保护 + 功能分支 + PR 审核」的方式协作。
目标形态是开源，但许可证与第三方声明尚未最终确定（见 `docs/LICENSE-DECISIONS.md`），
在此之前请勿把代码或数据对外分发。

## 1. 获取代码

```bash
git clone git@github.com:lele061229/ai-tree.git
cd ai-tree
python -m venv .venv && .venv/bin/pip install -r backend/requirements.lock
npm ci --prefix e2e        # 只有跑 E2E 时才需要
```

先确认本地能跑通：

```bash
.venv/bin/python -m pytest backend/tests -q     # 49 passed
npm test                                        # 10 passed
```

跑不通先修环境，不要改测试来迁就环境。

## 2. 按任务创建分支

从最新的 `main` 切出来，一条分支只做一件事：

```bash
git switch main && git pull --ff-only
git switch -c feat/card-timeout        # 新功能
git switch -c fix/sync-409-message     # 修缺陷
git switch -c docs/self-hosting-note   # 只改文档
```

分支名前缀统一用 `feat/` `fix/` `docs/` `test/` `chore/`。
不要在 `main` 上直接提交；不要 force push 已有分支。

## 3. 修改并测试

- **改后端**：补 `backend/tests/` 下的用例，跑 `pytest backend/tests -q`。
- **改前端**：补 `tests/*.test.js`，跑 `npm test`。
- **改同步协议/Skill**：同步更新 `skill/knowledge-os-sync/SKILL.md` 的版本号与
  `references/protocol.md`，并跑 `backend/tests/test_skill_sync.py`。
- **改数据库结构**：新增 Alembic 迁移，不要改历史迁移；确认 `downgrade` 的行为是有意为之。
- **改部署脚本/compose**：同步更新 `docs/SELF_HOSTING.md`，并在 PR 里说明验证方式。

提交信息用「类型(范围): 一句话」：

```
fix(sync): return 409 instead of 500 when the same submission is in flight
```

## 4. 提交 PR

1. 推送分支：`git push -u origin feat/card-timeout`
2. 开 PR（草稿也行），按模板填：改了什么、为什么、怎么验的、影响面。
3. PR 描述里如实区分：**已实现** / **已在本地或隔离环境验证** / **尚未验证**。
   没跑过的检查不要写成通过。
4. 不要提交真实 `.env`、`.secrets/`、凭据、数据库、备份、`node_modules/`、
   运行日志或含个人信息的截图。

## 5. 审核与合并

- 至少一位 reviewer 通过；有行为变更的 PR 需要贴测试输出。
- 涉及凭据、部署、迁移的 PR 需要额外说明回退方式。
- 合并用 squash，保持 `main` 的历史可读。
- 合并后删除远端分支。

## 6. 拉取最新代码

```bash
git switch main && git pull --ff-only
git branch -d feat/card-timeout        # 本地分支已合并可删
```

## 报告问题

用 Issue 模板：缺陷请带上复现步骤、期望/实际、版本（`/api/health` 返回的版本号）、
是否隔离环境；功能建议请先描述使用场景，而不是直接给实现方案。
