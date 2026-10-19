// 同步链路端到端：登录 → 待审 → 审阅 → 确认应用 → 版本/来源/等级核验。
//
// 运行前置：
//   1. 服务已起好，且已有一个**待审**的同步提交（submissionId 见 manifest）
//   2. 环境变量：KO_PASSWORD（管理员密码）、KO_MANIFEST（清单路径，默认 ./manifest.json）
// 可选：KO_BASE（默认 http://127.0.0.1:18080）、KO_USER（默认 admin）、KO_OUT（输出目录）
//
// 断言参数化：版本号、节点数、标题、关键词全部来自 manifest，脚本里不写死。
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.KO_BASE || 'http://127.0.0.1:18080';
const USER = process.env.KO_USER || 'admin';
const PASSWORD = process.env.KO_PASSWORD;
const MANIFEST = JSON.parse(fs.readFileSync(
  process.env.KO_MANIFEST || path.join(__dirname, 'manifest.json'), 'utf8'));
const OUT = process.env.KO_OUT || path.join(__dirname, 'out');
const SUB = process.env.KO_SUBMISSION || MANIFEST.submissionId;
const AGENT = MANIFEST.agentName || 'workbuddy';
const BASE_VERSION = MANIFEST.baseVersion;
const NEXT_VERSION = MANIFEST.expectedVersion || BASE_VERSION + 1;
const NODES_BEFORE = MANIFEST.nodesBefore;
const NODES_AFTER = MANIFEST.nodesAfter;
const TITLES = [MANIFEST.titles.practiced, MANIFEST.titles.discussed, MANIFEST.titles.project];
const PROJECT = MANIFEST.titles.project;

fs.mkdirSync(OUT, { recursive: true });
const results = [];
const log = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const must = (name, cond, detail = '') => {
  log(name, cond, detail);
  if (!cond) throw new Error('assertion failed: ' + name + ' ' + detail);
};

(async () => {
  if (!PASSWORD) throw new Error('KO_PASSWORD 未设置（不要在脚本里写密码）');
  const browser = await chromium.launch({ channel: process.env.KO_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', m => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(m.text());
  });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  const state = () => page.evaluate(async () => (await (await fetch('/api/state')).json()));

  try {
    // ---------- 1. 登录与待审列表 ----------
    await page.goto(BASE + '/login');
    await page.fill('#username', USER);
    await page.fill('#password', PASSWORD);
    await Promise.all([page.waitForURL(BASE + '/'), page.click('button[type=submit]')]);
    await page.waitForSelector('#build-entry:not([hidden])');
    must('登录后版本为 v' + BASE_VERSION, (await page.textContent('#version-pill')) === 'v' + BASE_VERSION,
      await page.textContent('#version-pill'));
    await page.screenshot({ path: path.join(OUT, '01-home.png') });

    await page.click('#build-entry .primary-button');
    await page.waitForSelector('#side-panel:not([hidden])');
    await page.waitForSelector('[data-server-action="sync-open"]', { timeout: 20000 });
    const own = page.locator(`#side-panel article.sync-item:has-text("${SUB}")`);
    must('待审列表里能找到本次提交编号', (await own.count()) === 1, await own.count());
    const ownText = await own.first().textContent();
    must('待审条目标注「待审（未进树）」', ownText.includes('待审（未进树）'), ownText.slice(0, 80));
    must('待审条目显示基线 v' + BASE_VERSION, ownText.includes('基于 v' + BASE_VERSION), ownText.slice(0, 80));
    must('待审条目显示 3 项变更', ownText.includes('3 项变更'), ownText.slice(0, 120));
    await page.screenshot({ path: path.join(OUT, '02-pending.png') });

    const before = await state();
    must('确认前路线没有变化', before.snapshots.at(-1).version === BASE_VERSION,
      'v=' + before.snapshots.at(-1).version);
    must('确认前节点数没有变化', before.snapshots.at(-1).nodes.length === NODES_BEFORE,
      'nodes=' + before.snapshots.at(-1).nodes.length);

    // ---------- 2. 审阅视图 ----------
    await own.locator('[data-server-action="sync-open"]').click();
    await page.waitForSelector('[data-server-action="apply"]');
    const review = await page.textContent('#side-panel');
    for (const title of TITLES) must('审阅视图列出「' + title + '」', review.includes(title));
    must('来源标题是整次提交的范围，不是片段标题', review.includes(MANIFEST.scopeKeyword));
    must('写明来自智能体同步', review.includes('来自智能体同步'));
    must('显示智能体与 Skill 版本', review.includes(AGENT) && review.includes('knowledge-os-sync'),
      review.slice(0, 160));
    if (MANIFEST.mixed) must('混装来源如实标注（原文 + AI 摘要）', review.includes('同时包含原文与 AI 摘要'));
    must('仍未解决的问题单独展示', review.includes('仍未解决的问题'));
    must('讨论类内容保留「仍未实测」的问题', review.includes(MANIFEST.openKeyword),
      'open questions: ' + MANIFEST.openKeyword);
    must('推荐内容标注尚未发生', review.includes('推荐学习内容') && review.includes('尚未发生'));
    must('提示等级不会自动提升', review.includes('能力等级与项目阶段不会自动提升'));
    await page.screenshot({ path: path.join(OUT, '03-review.png') });

    // ---------- 3. 确认应用 ----------
    await page.click('[data-server-action="apply"]');
    await page.waitForSelector('.toast.visible', { timeout: 25000 });
    const toast = await page.textContent('.toast');
    must('应用提示带新版本号 v' + NEXT_VERSION, toast.includes('已应用为 v' + NEXT_VERSION), toast);
    must('提示说明这批变更「现在才进入能力树」', toast.includes('现在才进入能力树'), toast);
    await page.screenshot({ path: path.join(OUT, '04-applied-toast.png') });

    // ---------- 4. 版本与节点 ----------
    const after = await state();
    const snap = after.snapshots.at(-1);
    must('版本推进到 v' + NEXT_VERSION, snap.version === NEXT_VERSION, 'v=' + snap.version);
    must('节点数从 ' + NODES_BEFORE + ' 增加到 ' + NODES_AFTER, snap.nodes.length === NODES_AFTER,
      'nodes=' + snap.nodes.length);
    const byTitle = Object.fromEntries(snap.nodes.map(n => [n.title, n]));
    for (const title of TITLES) must('树中存在节点「' + title + '」', !!byTitle[title]);

    const practiced = byTitle[TITLES[0]];
    const discussed = byTitle[TITLES[1]];
    const project = byTitle[PROJECT];
    must('已实践条目未被自动提级（仍为「讨论过」）', practiced.level === 1, 'level=' + practiced.level);
    must('仅讨论条目是「讨论过」', discussed.level === 1, 'level=' + discussed.level);
    must('尚未执行的项目是「未接触」', project.level === 0, 'level=' + project.level);
    must('项目阶段仍为「讨论」', project.stage === '讨论', 'stage=' + project.stage);
    must('已实践内容以「用户自述」入笔记', (practiced.notes || []).some(n => n.text.includes('用户自述')),
      JSON.stringify((practiced.notes || []).map(n => n.text.slice(0, 30))));
    must('讨论类条目保留未实测问题', (discussed.open || []).some(q => q.text.includes('没有实测') || q.text.includes('只停留在讨论')),
      JSON.stringify((discussed.open || []).map(q => q.text.slice(0, 40))));

    const recTexts = (discussed.recommendedNext || []).map(r => r.text);
    must('推荐下一步单独存放（不计入笔记）', recTexts.length >= 1, JSON.stringify(recTexts));
    const notesText = [...(discussed.notes || []), ...(discussed.evidence || [])].map(x => x.text || x[2] || '').join(' | ');
    must('推荐内容没有被当成已发生经历', recTexts.every(t => !notesText.includes(t)), notesText.slice(0, 120));

    const statement = (project.evidence || []).find(e => e[0] === '用户陈述（未独立验证）');
    must('项目陈述标注「用户陈述（未独立验证）」', !!statement,
      JSON.stringify((project.evidence || []).map(e => e[0])));
    must('项目陈述是用户原话', statement && statement[2].includes(MANIFEST.projectStatement), statement && statement[2]);
    must('项目没有被打成已上线', !JSON.stringify(project).includes('已上线'));

    const source = snap.sources.find(s => s.title.includes(MANIFEST.scopeKeyword));
    must('来源记录存在且标题为整次提交范围', !!source, snap.sources.length);
    must('来源标注为「原文 + 智能体摘要」', source.locator === '用户授权内容（原文 + 智能体摘要，逐段标注）', source.locator);
    must('来源未被标成纯摘要', source.derived === false, source.derived);
    must('来源正文保留原文与摘要两种标记',
      source.text.includes('### [原文]') && source.text.includes('### [AI 摘要 · 非原文]'));

    const imports = await page.evaluate(async () => (await (await fetch('/api/imports')).json()));
    const batch = imports.find(row => row.submissionId === SUB);
    must('批次状态为 applied', batch && batch.status === 'applied', batch && batch.status);
    must('批次记录的来源类型与预期一致',
      batch.sync.summaryOnly === false && batch.sync.mixedFragments === MANIFEST.mixed,
      JSON.stringify({ s: batch.sync.summaryOnly, m: batch.sync.mixedFragments }));

    // ---------- 5. 节点详情（UI 层） ----------
    const firstClose = page.locator('#side-panel [data-action="close-panel"]');
    if (await firstClose.count()) await firstClose.first().click();
    await page.waitForSelector('#nodes [data-node]');
    await page.locator(`#nodes [data-node]:has-text("${TITLES[0]}")`).first().click();
    await page.waitForSelector('#side-panel .node-summary');
    must('知识点详情显示「讨论过」', (await page.textContent('#side-panel .state-badge')).trim() === '讨论过',
      (await page.textContent('#side-panel .state-badge')).trim());
    const nodePanel = await page.textContent('#side-panel');
    must('详情显示「推荐下一步 · 尚未发生」', nodePanel.includes('推荐下一步') && nodePanel.includes('尚未发生'));
    must('详情显示「后来补充的理解」', nodePanel.includes('后来补充的理解'));
    await page.screenshot({ path: path.join(OUT, '05-node-practiced.png') });

    const closeButton = page.locator('#side-panel [data-action="close-panel"]').first();
    if (await closeButton.count()) await closeButton.click();
    await page.locator(`#nodes [data-node]:has-text("${PROJECT}")`).first().click();
    await page.waitForSelector('#side-panel .node-summary');
    const projPanel = await page.textContent('#side-panel');
    must('项目详情显示「项目状态 · 讨论」', projPanel.includes('项目状态 · 讨论'), projPanel.slice(0, 120));
    must('项目详情没有「已上线」', !projPanel.includes('已上线'));
    const practiceTab = page.locator('#side-panel [data-tab="practice"]');
    if (await practiceTab.count()) await practiceTab.first().click();
    await page.waitForSelector('#side-panel .project-evidence', { timeout: 10000 });
    const practicePanel = await page.textContent('#side-panel');
    must('项目实践页保留「用户陈述（未独立验证）」', practicePanel.includes('用户陈述（未独立验证）'),
      practicePanel.slice(0, 120));
    must('项目实践页的陈述是用户原话', practicePanel.includes(MANIFEST.projectStatement),
      MANIFEST.projectStatement);
    await page.screenshot({ path: path.join(OUT, '06-project.png') });

    // ---------- 6. 待审 → 已应用 ----------
    await page.click('[data-action="sync"]');
    await page.waitForSelector('#side-panel:not([hidden])');
    await page.waitForTimeout(900);
    must('本提交已不在待审列表', (await page.locator(`#side-panel article.sync-item:has-text("${SUB}")`).count()) === 0);
    const appliedRow = page.locator(`#side-panel .applied-item:has-text("${SUB}")`);
    must('出现在「已应用的同步提交」', (await appliedRow.count()) === 1, await appliedRow.count());
    must('已应用行写明「已写入路线」', (await appliedRow.first().textContent()).includes('已写入路线'));
    must('保留「提交待审 ≠ 已应用」的说明', (await page.textContent('#side-panel')).includes('提交只进待审区'));
    await page.screenshot({ path: path.join(OUT, '07-applied-list.png') });

    // ---------- 7. 刷新持久化 ----------
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#nodes [data-node]');
    must('刷新后版本仍为 v' + NEXT_VERSION,
      (await page.textContent('#version-pill')) === 'v' + NEXT_VERSION,
      await page.textContent('#version-pill'));
    must('刷新后节点仍为 ' + NODES_AFTER + ' 个', (await page.locator('#nodes [data-node]').count()) === NODES_AFTER,
      'nodes=' + (await page.locator('#nodes [data-node]').count()));
    await page.screenshot({ path: path.join(OUT, '08-after-reload.png') });

    must('页面没有 JS 报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } catch (error) {
    log('EXECUTION', false, error.message);
    try { await page.screenshot({ path: path.join(OUT, '99-failure.png') }); } catch {}
  } finally {
    await browser.close();
  }

  const failed = results.filter(r => !r.ok);
  fs.writeFileSync(path.join(OUT, 'results.json'),
    JSON.stringify({ base: BASE, submission: SUB, baseVersion: BASE_VERSION, results, failed: failed.length }, null, 1));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
