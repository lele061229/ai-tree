---
name: knowledge-os-sync
description: 把一次学习整理成结构化的「学习更新包」，提交到自部署的 AI Knowledge OS（AI Tree）待审区，由用户在网页端确认后生成新版本。适用于用户说「同步这次学习」「把这个整理进知识树」「提交学习更新」「knowledge os sync」。不扫描其他聊天、不自动应用、不声明掌握等级。
agent_created: true
version: 1.1.3
---

# Knowledge OS 学习更新同步

把**用户明确授权的那一段内容**整理成 `ko.learning-update` v1 更新包，提交到用户自己的
Knowledge OS。提交只进入待审区，**用户在网页端点确认后才生成新版本**。

## 什么时候用

用户说出类似的话时才用：
- 「把这次学习同步到我的知识树」
- 「整理今天的收获，提交到 Knowledge OS」
- 「用 Skill 提交一次学习更新」

**不要**因为安装了这个 Skill 就自动提交。它不是监听器，也不读其他会话、账号或无关文件。
用户没有明确指范围时，先问一句「这次整理哪一段？」再动手。

## 宿主支持

| 宿主 | 状态 | 说明 |
|---|---|---|
| WorkBuddy | **已实测** | 本 Skill 的主要目标宿主。用户说一句话，智能体自己生成包、提交并回报 |
| Claude Code / Codex / Cursor 等 | **未实测** | 只要能把本目录放进技能目录、并允许执行本地命令，原则上可用；尚未逐项验证，以实际环境为准 |

用户只需要表达同步意图。**写字段、跑命令、上传都是智能体的事**；用户只负责在浏览器里审阅并确认。

## 前置：一次性配置（每个用户一次）

提交目标二选一：**本机 AI Tree 桌面端**（本地优先，默认推荐）或**云端平台**。配置里记录目标，
`status`/`submit` 每次都会显示当前目标；本地提交失败**不会**自动改道云端。

**方式 A · 本机桌面端（本地优先）**：桌面端正在运行时执行

```bash
python <skill>/scripts/ko_sync.py config --local --token-stdin
```

地址自动从本机 AI Tree 的运行信息（`server.json`）发现，无需手动填写。
同步凭据仍由用户生成：桌面端「导入 / 同步」→「智能体同步」→「生成凭据」，明文只显示一次。

**方式 B · 云端平台**：凭据由用户在平台网页生成 →

```bash
python <skill>/scripts/ko_sync.py config --url https://<平台地址> --token-stdin
# 然后把凭据通过标准输入喂进去（例如 printf '%s\n' "$TOKEN" | ... 或交互粘贴）
```

```bash
python <skill>/scripts/ko_sync.py status
```

`status` 打印当前提交目标、账号、当前版本、待审数量。这是唯一推荐的连通性验证方式。
若配置目标是本机而桌面端未运行，`status` 会明确报「本机 AI Tree 不可达」，不会回退云端。

规则（硬性）：
- 凭据只写进 `~/.ko-sync/config.json`（0600）。**不要**写进仓库、Skill 目录、命令行参数或日志。
- 明文回环地址可以 `http://`，其他地址必须 `https://`。**不要**用 `--insecure` 绕过 TLS 校验。
- 被撤销的凭据会立刻 401，直接让用户重新生成，不要试图复用。

## 流程

1. **确定范围**：用户授权了哪些内容（一段对话 / 一个文件 / 一次练习）。范围写进 `scope`。
2. **只看授权内容**。不读其他项目、其他聊天、私人文件。
3. **生成包**：
   ```bash
   python <skill>/scripts/ko_package.py new --out /tmp/ko-update.json
   ```
   填 `scope`、`fragments`、`items`。填完先本地校验：
   ```bash
   python <skill>/scripts/ko_package.py check --file /tmp/ko-update.json
   ```
4. **提交**：
   ```bash
   python <skill>/scripts/ko_sync.py submit --file /tmp/ko-update.json
   ```
5. **回报用户**：提交编号、状态（待审）、变更条数、审阅地址。不要说「已更新知识树」，
   因为还没有应用。

失败时脚本会把包留在 `~/.ko-sync/pending/<submissionId>.json`，并打印原因与重试命令。
**沿用同一 `submissionId` 重试**，不要为了重试换新编号：

```bash
python <skill>/scripts/ko_sync.py retry --submission-id sub_xxx
python <skill>/scripts/ko_sync.py pending
python <skill>/scripts/ko_sync.py show --submission-id sub_xxx
```

## 写包的规矩

**可以写**
- `scope`：这次整理的范围，一句话说清边界。
- `fragments[]`：必要来源片段。有原文就 `kind: "user_original"` 并放原文；
  只剩摘要时 `kind: "ai_summary"`，`note` 写明「原文未随包提交」，**不要**把摘要伪装成原文。
- `items[]`：知识点或项目。`summary` 是这个节点是什么，`concepts` 是要点，`tasks` 是练习，
  `prerequisites` 写本包内的 `key` 或已有节点的准确标题。
- `understanding[]`：后来补充的理解（会追加到原节点，不覆盖旧内容）。
- `openQuestions[]`：还没解决的问题。**宁可留问题，不要编答案**。
- `recommended[]`：推荐接下来学什么。它和「已经学过」分开记录。
- `project.statement`：用户对项目状态的原话，平台会标为「用户陈述（未独立验证）」。

**绝对不要写**
- `level` / `stage` / `mastery` / `verified` 等任何等级或状态字段。服务端会以
  `authority_violation` 直接拒收。掌握与上线只能由用户自己在平台里确认。
- 用户没授权的内容，或你自己的推测当成用户的经历。
- 未知信息不要编，留空或不写这个字段。

## 返回码

| 退出码 | 含义 | 你要做的 |
|---|---|---|
| 0 | 已提交（或幂等命中） | 报告提交编号与审阅地址 |
| 1 | 配置 / 参数 / 本地格式问题 | 修包或修配置，不要重试网络 |
| 2 | 服务端拒收（可修） | 按打印的路径改包，用同一 submissionId 重试 |
| 3 | 网络 / TLS / 凭据失效 | 检查地址与凭据；撤销了就让用户重新生成 |

常见服务端拒收：
- `invalid_relations`：前置能力没有对应节点，或前置成环。补节点或改前置，**不要**试图绕过。
- `stale_base_version`：用户在你提交前又应用了别的变更。先 `status` 看当前版本，重新整理后
  用**新的** submissionId 提交。
- `submission_id_conflict`：这个编号已经成功提交过别的内容。生成新的 submissionId。
- `invalid_package`：字段缺失或超限，按 `problems` 逐条修。

## 边界

- 当前版本策略是「自动提交、人工确认」：提交只进待审区，应用必须由用户本人在浏览器点确认。**这是本版本的策略选择，不是产品永久不能支持自动更新**；受控的自动更新属于后续可单独评估的项，需要先有审批与回滚设计。
- 本版本不做自动应用、后台监听、定时同步。
- 安装 Skill 不等于获得自动触发能力：每次都需要用户明确提出。
- 不调用平台的模型接口；这条路径不依赖服务器配置模型。只有「把原文交给平台分析」那条路径才需要配置模型。
