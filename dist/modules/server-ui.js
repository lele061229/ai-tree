import {esc,icon,panelHeader} from './ui.js';
import {platform} from './server-api.js';

const day = stamp => stamp ? new Date(stamp * 1000).toLocaleDateString('zh-CN') : '—';

function changeRows(changes) {
  return (changes || []).map(c => `<article class="change-row"><span class="change-type">${esc(c.type)}</span><div><h4>${esc(c.title)}</h4><p>${esc(c.detail || '补充来源与前置关系，保留已有内容。')}</p>${c.prerequisites?.length ? `<p>前置：${c.prerequisites.map(esc).join('、')}</p>` : ''}</div></article>`).join('');
}

function credentialBlock(ui, busy) {
  const created = ui.newToken ? `<div class="credential-box"><span class="tag">明文只显示这一次</span><h4>同步凭据已生成</h4><code class="credential-token">${esc(ui.newToken.token)}</code><p>平台地址 <code>${esc(ui.newToken.origin || location.origin)}</code>。把凭据通过标准输入写进 Skill 配置，不要放进命令参数、聊天或仓库。有效期至 ${day(ui.newToken.expiresAt)}。</p><button class="outline-button" data-server-action="dismiss-token">我已保存，隐藏</button></div>` : '';
  const rows = ui.syncTokens === undefined ? '<p class="muted">正在读取凭据…</p>' : (ui.syncTokens.length
    ? ui.syncTokens.map(t => `<article class="credential-row"><div><strong>${esc(t.label)}</strong><small>${esc(t.prefix)}… · ${t.active ? '有效' : '已失效'} · 创建 ${day(t.createdAt)}${t.lastUsedAt ? ' · 最近使用 ' + day(t.lastUsedAt) : ' · 尚未使用'}</small></div>${t.active ? `<button class="text-button" data-server-action="revoke-token" data-token="${esc(t.id)}">撤销</button>` : '<span class="tag">已撤销</span>'}</article>`).join('')
    : '<p class="muted">还没有同步凭据。生成一个，只绑定当前账号。</p>');
  return `<div class="section-heading"><span>① 生成同步凭据</span><small>可随时撤销</small></div>${created}<div class="credential-list">${rows}</div><div class="credential-create"><input class="wide-select" id="token-label" maxlength="60" placeholder="凭据名称，例如：家里的笔记本" ${busy ? 'disabled' : ''}><button class="outline-button" data-server-action="create-token" ${busy ? 'disabled' : ''}>生成凭据</button></div><p class="muted">凭据只绑定当前账号，只能提交学习更新包：不能读取你的知识树，不能代替你在浏览器里确认应用。</p>`;
}

function pendingBlock(ui) {
  if (ui.syncPending === undefined) return `<div class="section-heading"><span>④ 待审的同步提交</span></div><p class="muted">正在读取…</p>`;
  const items = ui.syncPending.filter(b => b.status === 'ready' || b.status === 'failed');
  if (!items.length) return `<div class="section-heading"><span>④ 待审的同步提交</span></div><p class="muted">还没有待审提交。智能体提交后会出现在这里，确认前不会改你的能力树。</p>`;
  return `<div class="section-heading"><span>④ 待审的同步提交</span><small>${items.length} 项</small></div>` + items.map(b => `<article class="sync-item"><div class="sync-item-head"><span class="tag ${b.status === 'failed' ? 'stale' : ''}">${b.status === 'ready' ? '待审（未进树）' : '提交失败'}</span><strong>${esc(b.sourceTitle || '智能体提交')}</strong></div><small class="muted">${esc(b.submissionId || '')} · 基于 v${b.baseVersion} · ${(b.changes || []).length} 项变更${b.attempts > 1 ? ' · 第 ' + b.attempts + ' 次尝试' : ''}</small>${b.error ? `<p class="answer-feedback incorrect">${esc(b.error)}</p>` : ''}${b.status === 'ready' ? `<button class="outline-button" data-server-action="sync-open" data-batch="${esc(b.id)}">审阅这次变更 ↗</button>` : `<p class="muted">包仍保留在你本机，修正后可用同一 submissionId 重试。</p>`}</article>`).join('');
}

function appliedBlock(ui) {
  const items = (ui.syncPending || []).filter(b => b.status === 'applied');
  if (!items.length) return '';
  return `<div class="section-heading"><span>已应用的同步提交</span><small>已进入能力树</small></div>` + items.slice(0, 3).map(b => `<div class="applied-item"><span class="tag">已应用</span><span>${esc(b.submissionId || '')} · ${(b.changes || []).length} 项变更已写入路线</span></div>`).join('');
}

function planBlock(ui, busy) {
  const p = ui.serverPlan, sync = p.sync;
  const questions = (sync?.items || []).flatMap(i => (i.openQuestions || []).map(q => ({ title: i.title, text: q })));
  const recs = (sync?.items || []).flatMap(i => (i.recommended || []).map(q => ({ title: i.title, text: q })));
  const meta = sync ? `<div class="notice"><strong>来自智能体同步</strong>${sync.agent ? '：' + esc(sync.agent.name) + (sync.agent.skill ? ' · ' + esc(sync.agent.skill) : '') : ''}<br>整理范围：${esc(sync.scope)}${sync.summaryOnly ? '<br>本包只提交了 AI 摘要，原文未随包上传，来源已标注为「AI 摘要」。' : sync.mixedFragments ? '<br>本包同时包含原文与 AI 摘要，来源里已逐段标注。' : ''}</div>` : '';
  return `<div class="section-heading"><span>请审阅本次变更</span><small>${(p.changes || []).length} 项</small></div>${meta}${changeRows(p.changes)}${questions.length ? `<div class="section-heading"><span>仍未解决的问题</span><small>只记录，不改变等级</small></div><ul class="open-list">${questions.map(q => `<li><strong>${esc(q.title)}</strong>${esc(q.text)}</li>`).join('')}</ul>` : ''}${recs.length ? `<div class="section-heading"><span>推荐学习内容</span><small>尚未发生</small></div><ul class="open-list">${recs.map(q => `<li><strong>${esc(q.title)}</strong>${esc(q.text)}</li>`).join('')}</ul>` : ''}<div class="notice">${esc(p.notice || '确认后才会生成新版本。能力等级与项目阶段不会自动提升。')}</div><button class="primary-button wide" data-server-action="apply" ${busy ? 'disabled' : ''}>确认应用，创建新版本</button><button class="text-button" data-server-action="sync-clear">稍后再看</button>`;
}

export function realSync(ui) {
  const busy = ui.serverBusy, tab = ui.syncTab || 'skill';
  const tabs = `<div class="segmented"><button data-sync-tab="skill" class="${tab === 'skill' ? 'active' : ''}">智能体同步</button><button data-sync-tab="source" class="${tab === 'source' ? 'active' : ''}">原始资料与模型分析</button></div>`;
  const error = ui.serverError ? `<div class="answer-feedback incorrect">${esc(ui.serverError)}</div>` : '';

  const skillTab = `<div class="notice"><strong>推荐入口：用你自己的智能体建树。</strong>你不用写 JSON，也不用自己跑上传命令——只需对智能体说一句「同步这次学习」。提交只进待审区，你在本页确认后才改树；这是当前版本的策略，不是架构上限。<br><strong>这条路径不需要平台配置模型。</strong>需要模型的只有「平台模型分析」和「站内 AI 导师」；它们没配置时只是各自不可用，不挡这条路。</div>
  ${credentialBlock(ui, busy)}
  <div class="section-heading"><span>② 安装并绑定 Skill</span><small>只在第一次做</small></div>
  <a class="outline-button skill-download" href="/downloads/knowledge-os-sync-1.1.3.zip" download>下载 Skill 安装包 knowledge-os-sync-1.1.3.zip</a>
  <ol class="setup-steps"><li>解压到智能体的 skills 目录。WorkBuddy 的路径是 <code>%USERPROFILE%\\.workbuddy\\skills\\knowledge-os-sync</code>。</li><li>把上面生成的凭据通过标准输入写入一次：<code>python ko_sync.py config --url ${esc(location.origin)} --token-stdin</code>。</li><li>跑一次 <code>python ko_sync.py check</code>：凭据权限、平台地址、连通性三项都应为「通过」。</li></ol>
  <div class="notice">宿主支持状态：<strong>WorkBuddy 已实测通过</strong>（本页的这些提交就来自它）。其他宿主（Claude Code、Codex、Cursor 等）只要能把 SKILL.md 放进技能目录并允许执行本地命令，原则上同样可用，但<strong>尚未逐项实测</strong>，以你的环境为准。安装 Skill 不等于它会自动监听聊天：只有你明确要求「同步这次学习」时才会提交。</div>
  <div class="section-heading"><span>③ 第一次使用</span></div>
  <ol class="setup-steps"><li>对智能体说「把这次学习同步到我的知识树」，并说清是哪一段内容。</li><li>它会整理成更新包并提交，回报提交编号与变更条数。</li><li>回到本页的「待审的同步提交」，点「审阅这次变更」，确认无误再点「确认应用」。</li></ol>
  ${pendingBlock(ui)}${appliedBlock(ui)}${error}${ui.serverPlan ? planBlock(ui, busy) : ''}`;

  const sourceTab = `<div class="notice">原文保存在你的服务器。点击分析时，选定资料会发送到服务器配置的模型接口；模型结果需审阅后才能更新能力树。</div>${!platform.aiReady ? '<div class="notice warning">模型接口尚未配置。可以先保存原始资料，配置后再分析；要现在产生知识变更，请用「智能体同步」。</div>' : ''}
  <label class="field-label" for="source-title-input">资料名称</label><input class="wide-select" id="source-title-input" maxlength="160" value="${esc(ui.sourceTitle || '')}" placeholder="例如：后端学习记录.md" ${busy ? 'disabled' : ''}>
  <label class="field-label" for="source-file">读取本地 Markdown / 文本</label><input id="source-file" type="file" accept=".md,.txt,text/plain,text/markdown" ${busy ? 'disabled' : ''}>
  <label class="field-label" for="source-body-input" style="margin-top:16px">或粘贴本次授权的资料</label><textarea class="source-input" id="source-body-input" maxlength="50000" placeholder="仅粘贴你决定导入的内容，10–50000 字符。" ${busy ? 'disabled' : ''}>${esc(ui.sourceBody || '')}</textarea>
  <button class="primary-button wide" data-server-action="save-source" ${busy ? 'disabled' : ''}>${busy ? '正在处理，请稍候…' : '保存原文到服务器'}</button>
  ${error}
  ${ui.serverSource ? `<article class="source-card" style="margin-top:20px"><span class="tag">原文已保存</span><h4>${esc(ui.sourceTitle)}</h4><p>资料 ID：${esc(ui.serverSource)}</p><button class="outline-button" data-server-action="analyze" ${busy || !platform.aiReady ? 'disabled' : ''}>${busy ? '模型分析中…' : '授权发送本份资料并分析'}</button></article>` : ''}
  ${ui.serverPlan && !ui.serverPlan.sync ? planBlock(ui, busy) : ''}
  <div class="section-heading"><span>已保存的资料</span></div>${(ui.serverSources || []).map(s => `<article class="source-card"><h4>${esc(s.title)}</h4><button class="text-button" data-reanalyze="${esc(s.id)}" ${busy || !platform.aiReady ? 'disabled' : ''}>基于当前路线分析 ↗</button></article>`).join('') || '<p class="muted">还没有资料。从一份小文档开始。</p>'}`;

  return `${panelHeader('IMPORT & INCREMENTAL SYNC','用自己的智能体建树；平台模型分析可选。')}<div class="panel-content">${tabs}${tab === 'skill' ? skillTab : sourceTab}</div>`;
}

export function realMentor(n,ui){const answer=ui.mentor[n.id];return`<div class="notice">回答使用当前节点、目标及其关联来源。点击发送后，这些内容会发送到已配置的模型接口。</div><label class="field-label" for="mentor-question">围绕这个节点继续问</label><textarea class="source-input" id="mentor-question" maxlength="2000" placeholder="例如：结合项目解释这个知识，并给我两个练习步骤。">${esc(ui.mentorQuestion||'')}</textarea><button class="primary-button wide" data-server-action="mentor" ${ui.serverBusy||!platform.aiReady||ui.version!==null?'disabled':''}>${ui.serverBusy?'正在请求导师…':'发送问题'}</button>${!platform.aiReady?'<p class="muted">请先在服务器配置模型接口。</p>':''}${ui.version!==null?'<p class="muted">历史快照只读，请返回当前路线后向导师提问。</p>':''}${ui.serverError?`<div class="answer-feedback incorrect">${esc(ui.serverError)}</div>`:''}${answer?.answer?`<article class="mentor-answer"><span class="overline">AI 导师 · 需结合来源核对</span><p style="white-space:pre-wrap">${esc(answer.answer)}</p>${answer.sources.map(s=>`<button class="source-link" data-source="${s.id}">${icon('source')}${esc(s.title)} ↗</button>`).join('')}</article>`:''}`}
export function realGoal(s,store){return`${panelHeader('YOUR GOAL','当前目标与项目')}<div class="panel-content"><label class="field-label" for="goal-text-input">长期学习目标</label><input class="wide-select" id="goal-text-input" maxlength="160" value="${esc(store.goalText||'')}"><label class="field-label" for="goal-select">关联目标项目</label><select class="wide-select" id="goal-select"><option value="">全部知识，先补基础</option>${s.nodes.filter(n=>n.kind==='project').map(n=>`<option value="${n.id}" ${store.target===n.id?'selected':''}>${esc(n.title)}</option>`).join('')}</select><button class="primary-button wide" data-server-action="goal">保存目标</button><div class="notice" style="margin-top:20px">能力树按前置关系与项目需求展示。讨论记录不等于独立掌握，先完成可验证的实践。</div></div>`}
export function realTasks(n,s,ui,store,taskKey){return`<p class="panel-intro">练习由导入资料分析产生。勾选只记录完成情况，不改变能力证据等级。</p>${n.tasks.map((t,i)=>`<label class="task-row"><input type="checkbox" data-task="${i}" ${store.tasks[taskKey(s.version,n.id,i)]?'checked':''} ${ui.version!==null?'disabled':''}><span>${esc(t)}</span></label>`).join('')}<div class="section-heading"><span>需注意的误区</span></div>${n.mistakes.map(([title,text])=>`<article class="mistake"><h3>${esc(title)}</h3><p>${esc(text)}</p></article>`).join('')}`}
