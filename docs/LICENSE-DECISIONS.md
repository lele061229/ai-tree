# 许可证与开源前待定事项

本文件只记录**现状与待决定项**，不构成法律意见，也不改变现有许可证。

## 1. 当前状态

| 位置 | 声明 |
|---|---|
| 仓库根目录 | **没有** `LICENSE` 文件 |
| `package.json` | `"license": "UNLICENSED"` |
| `desktop/package.json` | `"license": "UNLICENSED"` |
| 第三方依赖 | 各自保留原许可，未 vendor 进仓库（见 `docs/DEPENDENCIES.md`） |

即：**保留所有权利**。仓库私有期间内部协作不受影响；在此之前不要对外分发代码或数据。

## 2. 公开开源前必须先定的

1. **主许可证**：MIT / Apache-2.0 / AGPL-3.0 三选一（或其它）。
   - Apache-2.0 含专利授权与 NOTICE 机制，适合担心专利风险的项目；
   - AGPL-3.0 会影响「改成 SaaS 对外提供」的第三方；
   - MIT 最宽松，但与「个人数据平台」的预期使用者责任不匹配时需要再考虑免责声明。
2. **`package.json` 的 `license` 字段**要与根 `LICENSE` 一致（现在是 `UNLICENSED`，改许可证时两处一起改）。
3. **第三方声明口径**：
   - Python 依赖里存在 **MPL-2.0**（`certifi`）、**Apache-2.0**（`opentelemetry-api` 等）；
     分发二进制/镜像时需要保留其许可与 NOTICE，是否新增 `THIRD-PARTY-NOTICES.md` 需确认。
   - 桌面端打包了 **Electron / Chromium**：`win-unpacked/LICENSES.chromium.html` 必须随分发物一起提供，
     不能只发 exe；公开分发前要确认这一点写进了发行说明。
4. **名称与标识**：「AI Tree」是否作为商标保留、是否允许他人使用同名分发，需要明确。
5. **图标来源**：`desktop/icon.png` 目前是 32×32 占位图，来源与授权需确认后再对外发布（同时建议换成多尺寸 ico）。
6. **示例数据的版权**：`skill/knowledge-os-sync/references/example-package.json` 与文档里的虚构对话，
   需确认可随仓库以所选许可证发布。
7. **贡献者条款**：是否需要 DCO（`Signed-off-by`）或 CLA。`CONTRIBUTING.md` 目前只要求 PR 审核。
8. **安全披露渠道**：公开前需要有 `SECURITY.md`（联系方式与响应预期），避免漏洞被直接开 Issue。
9. **数据与隐私表述**：README 已声明「仓库不含真实用户数据」；开源后需复查示例、截图、Issue 模板，
   确保不会诱导用户上传真实学习记录或凭据。

## 3. 已核对、无需改动

- 仓库内**没有** vendored 第三方源码或二进制（`dist/downloads/*.zip` 是本项目自己的 Skill 包）。
- 迁移、脚本、前端代码均为本项目自有代码，未见复制自第三方的片段。
- `docs/DEPENDENCIES.md` 的清单来自已安装分发包的元数据，版本与 `backend/requirements.lock` 一致。
