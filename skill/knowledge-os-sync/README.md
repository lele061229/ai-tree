# knowledge-os-sync 1.1.1 · 安装、绑定与首次使用

把一次学习整理成 `ko.learning-update` 更新包，提交到你自己部署的 **AI Tree** 待审区。
提交只进待审区，**你在网页端点确认后才生成新版本**。

## 1. 宿主支持状态

| 宿主 | 状态 | 技能目录 |
|---|---|---|
| WorkBuddy | **已实测**（本版本的主要目标） | `%USERPROFILE%\.workbuddy\skills\knowledge-os-sync` |
| Claude Code / Codex / Cursor 等 | **未实测** | 各自技能目录（如 `~/.claude/skills/`、`~/.codex/skills/`），需允许执行本地命令 |

- 未实测不等于不可用：只要宿主能把 `SKILL.md` 放进技能目录并允许运行 `python scripts/ko_sync.py`，原则上可用。
- 未实测前不要对外声称「支持某宿主」。本文件只对 WorkBuddy 给出实测结论。

## 2. 安装（一次）

Windows（PowerShell）：

```powershell
Expand-Archive knowledge-os-sync-1.1.3.zip -DestinationPath "$env:USERPROFILE\.workbuddy\skills" -Force
```

macOS / Linux：

```bash
unzip knowledge-os-sync-1.1.3.zip -d ~/.workbuddy/skills/
```

安装后重开会话，技能列表里应出现 `knowledge-os-sync`。

**安装 ≠ 自动监听**：它不会读其他聊天、不会定时提交，只有你明确说「同步这次学习」时才动。

## 3. 绑定（一次）

1. 打开 AI Tree → 右上「导入 / 同步」→「① 生成同步凭据」→ 填个名字 → 生成。
2. 明文只显示一次。复制它，通过**标准输入**写入配置（不要放进命令行参数、聊天记录或仓库）：

```powershell
$env:KO="粘到这里"; $env:KO | python "$env:USERPROFILE\.workbuddy\skills\knowledge-os-sync\scripts\ko_sync.py" config --url http://127.0.0.1:8000 --token-stdin; Remove-Item Env:\KO
```

3. 复核实效：

```powershell
python "$env:USERPROFILE\.workbuddy\skills\knowledge-os-sync\scripts\ko_sync.py" check
```

`check` 是只读的，检查三件事：**这几个具体路径的实际 ACL（含是否仍继承、所有者）**、平台地址、连通性（账号 / 当前版本 / 待审数量）。
三项都应为「通过」。若显示「未加固」，说明 ACL 没落到当前用户 SID 上，按提示排查。

- 配置文件位置：`%USERPROFILE%\.ko-sync\config.json`。
- Windows 上 `chmod 0600` **不会**改 ACL，脚本用 `icacls /inheritance:r /grant:r *<SID>:(F)` 断继承并只授权当前用户，
  再用 `icacls` 读回实际受托人列表校验，而不是假设成功。
- **写入顺序**：先建空临时文件 → 把它的 ACL 收紧到当前用户 → 再写内容 → 原子替换。这样即使目录本身
  没能断继承，令牌也不会以继承权限落盘；收紧失败时**放弃写入凭据**（不会退而求其次地写一个可被他人读的文件）。
- `config` / `check` 报的是**被列出的那几个路径**的实况，不是「本机所有凭据路径都已安全」的结论。
  目录仍在继承时，目录级操作（列目录、替换文件）仍受继承主体影响——通常只是 `SYSTEM` 与 `Administrators`；
  这一点会在输出里如实写明，需要你在普通终端再复核一次。
- 非回环地址必须 `https://`；只有 `127.0.0.1` / `localhost` / `::1` 允许 `http://`。

## 4. 首次使用

对智能体说一句就够，不需要写 JSON，也不需要自己跑上传命令：

> 把这次学习同步到我的知识树（就是刚才那段关于 XX 的讨论）

智能体会：确定范围 → 生成更新包 → 本地校验 → 提交 → 回报**提交编号**与变更条数。
然后你回到 AI Tree 的「④ 待审的同步提交」→「审阅这次变更」→ 确认无误后「确认应用」。

**提交待审 ≠ 已应用。** 确认前知识树一行都没变；确认后才产生新版本，旧版本与原始资料都保留。

想手动验证一次链路（可选，仅排查用）：

```bash
python scripts/ko_package.py new --out /tmp/ko.json      # 生成骨架
python scripts/ko_package.py check --file /tmp/ko.json   # 本地校验，不上传
python scripts/ko_sync.py submit --file /tmp/ko.json     # 提交到待审区
```

## 5. 失败与重试

脚本失败时会把包留在 `%USERPROFILE%\.ko-sync\pending\<submissionId>.json`，并打印原因和重试命令。
**沿用同一个 `submissionId` 重试**，不要换新编号（换号会生成重复批次）：

```bash
python scripts/ko_sync.py retry --submission-id sub_xxx
python scripts/ko_sync.py pending
python scripts/ko_sync.py show --submission-id sub_xxx
```

| 退出码 | 含义 |
|---|---|
| 0 | 已提交（或幂等命中） |
| 1 | 配置 / 参数 / 本地格式问题，修了再跑 |
| 2 | 服务端拒收（可修），按打印的路径改 |
| 3 | 网络 / TLS / 凭据失效 |

`409 submission_busy` / `409 submission_in_flight` 是同一编号被并发写入，等一秒用**同一编号**重试即可，不会多建批次。

## 6. 依赖与环境

- Python 3.8+，**只用标准库**，不需要 `pip install`。
- HTTPS 使用系统根证书，不提供 `--insecure` 绕过（回环地址除外，用于本地调试）。

## 7. 边界

- 无后台进程、无定时任务、无自动应用（「人工确认」是当前版本策略，不是永久限制）。
- 不声明掌握等级 / 项目阶段 / 验证状态；服务端会以 `authority_violation` 拒收。
- 只提交你授权范围内的内容，不读其他会话、账号或无关文件。
- 这条路径**不需要平台配置模型**；需要模型的是「平台模型分析」和「站内 AI 导师」。
