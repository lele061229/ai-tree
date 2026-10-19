# 协议：ko.learning-update v1

一个更新包 = 一次提交 = 一个待审批次。服务端只做三件事：校验、对齐到现有路线、等你确认。

## 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `format` | 是 | 固定 `ko.learning-update` |
| `formatVersion` | 是 | 固定 `1` |
| `submissionId` | 是 | 8–80 位 `[A-Za-z0-9_-]`，幂等键。失败重试必须沿用 |
| `baseVersion` | 否 | 你读取路线时的版本号。与服务器当前版本不一致会返回 `409 stale_base_version` |
| `createdAt` | 否 | ISO 8601 字符串，仅记录 |
| `sourceType` | 否 | `agent_skill` / `manual` / `import`，默认 `agent_skill` |
| `scope` | 是 | 1–500 字，本次整理的范围边界 |
| `agent` | 否 | `{name, skill, skillVersion}` |
| `fragments` | 是 | 1–5 段来源片段 |
| `items` | 是 | 1–20 条知识点 / 项目（与图校验上限一致；超过 20 条会直接 `422 invalid_package`） |

未知字段一律拒绝（`extra=forbid`）。

## fragments[]

| 字段 | 说明 |
|---|---|
| `title` | 来源名称，会作为「原始资料」标题显示 |
| `kind` | `user_original`（必须带 ≥10 字原文）或 `ai_summary` |
| `text` | 原文或摘要正文，≤50000 字 |
| `note` | `ai_summary` 时说明为什么没有原文 |

`ai_summary` 会让整个来源在平台上标记为「AI 摘要（非原文）」，存储正文以
`### [AI 摘要 · 非原文]` 开头，前端 `derived: true`。**不要把摘要写成 `user_original`。**

## items[]

| 字段 | 必填 | 说明 |
|---|---|---|
| `key` | 是 | 包内引用名，唯一 |
| `title` | 是 | 节点标题，归一化后必须唯一 |
| `aliases` | 否 | ≤8 个，用于对齐已有节点 |
| `kind` | 否 | `knowledge`（默认）/ `project` |
| `layer` | 否 | 1–4，结构层级，**不是掌握等级** |
| `summary` | 是 | ≤1600 字 |
| `concepts` | 是 | `[[标题, 解释]]`，1–8 组 |
| `tasks` | 是 | 1–8 个可执行练习 |
| `mistakes` | 否 | `[[误区, 说明]]` |
| `prerequisites` | 否 | 本包 `key` 或已有节点标题 |
| `understanding` | 否 | 理解补充，追加到节点 notes |
| `openQuestions` | 否 | 未解决问题，追加到节点 `open` |
| `recommended` | 否 | 推荐学习内容，追加到 `recommendedNext`，与已学内容分开展示 |
| `project` | 否 | `{title, statement}`；`statement` 会作为「用户陈述（未独立验证）」写入项目证据 |

**禁止字段**：`level`、`stage`、`mastery`、`verified`、`verification`、`confidence`、
`autoApply`、`applyNow`、`delivered`、`online`、`progress`、`passed`。
出现任意一个 → `422 authority_violation`，并返回违规路径。

## 服务端处理顺序

1. 扫描禁止字段 → 拒绝。
2. Pydantic 校验（`extra=forbid`）→ 拒绝并返回 `problems[]`。
3. 计算规范化 payload 摘要，按 `(user, submissionId)` 查重：
   - 已成功且摘要相同 → 返回原批次，`duplicate: true`，不建新版本；
   - 已成功但摘要不同 → `409 submission_id_conflict`；
   - 上次失败 → 允许改写后重试（`attempts` +1，上限 5）。
4. `baseVersion` 与当前版本不一致 → `409 stale_base_version`，不写任何东西。
5. 来源按正文 SHA-256 去重：同样正文复用同一条 `Source`。
6. 调用**同一套** `build_plan`：标题 / 别名归一化对齐，命中已有节点走「补充」，否则「新增」。
7. 图校验：别名冲突、类型冲突、前置缺失、成环 → `422 invalid_relations`，批次记 `failed`，
   路线不动。
8. 生成 `ready` 批次。**此时知识树未变。**

并发说明：两个进程同时处理同一 `submissionId` 时，唯一约束或行锁会命中，服务端返回
`409 submission_busy` / `409 submission_in_flight`（都带 `retryable: true`），不会产生 500，
也不会重复建批次。**沿用同一 `submissionId` 重试即可**，重试会命中幂等或被正常受理。

应用仍走原有 `POST /api/imports/{batchId}/apply`（需要浏览器 Cookie + CSRF），
由 `commit_plan` 生成新版本、复制学习进度、保留全部历史版本。

## 端点

| 方法 | 路径 | 鉴权 |
|---|---|---|
| POST | `/api/sync/tokens` | Cookie + CSRF |
| GET | `/api/sync/tokens` | Cookie + CSRF |
| POST | `/api/sync/tokens/{id}/revoke` | Cookie + CSRF |
| GET | `/api/sync/status` | Bearer |
| POST | `/api/sync/submissions` | Bearer |
| GET | `/api/sync/submissions/{submissionId}` | Bearer |
| GET | `/api/imports` | Cookie（含 `channel`/`submissionId`/`sync`） |
| POST | `/api/imports/{id}/apply` | Cookie + CSRF |

Bearer 凭据**不能**读 `/api/state`、`/api/sources`，**不能**调用 apply，也不能签发新凭据。

## 幂等语义总结

- 同一个 `submissionId` + 同一份内容 → 永远只有 1 个批次、0 个新版本（重复提交）。
- 同一个批次 apply 两次 → 第二次 `duplicate: true`，版本不增加。
- 失败 → 复用同一批次重跑，不堆积批次；超过 5 次要求换编号。
