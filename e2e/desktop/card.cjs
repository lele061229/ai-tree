// 桌面卡片验收：状态、收起/展开、打开完整知识树。
//
// 前置：客户端带调试端口启动，例如
//   "AI Tree.exe" --remote-debugging-port=9222
// 环境变量：
//   KO_CDP      调试端点（默认 http://127.0.0.1:9222）
//   KO_BASE     服务器地址（默认 http://127.0.0.1:18080，用于断言连的是哪个环境）
//   KO_USER / KO_PASSWORD   会话过期需要重新登录时才用到；密码不写死
//   KO_OUT      截图与结果目录（默认 ./out）
//   KO_CARD_W / KO_CARD_H / KO_CARD_H_COLLAPSED   卡片尺寸断言值
//
// 说明：卡片是无框窗口，window.outerWidth/Height 会包含系统不可见边框，
// 所以断言值比设计尺寸（360x220）大，按实测值配置，不要照抄设计稿。
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const CDP = process.env.KO_CDP || 'http://127.0.0.1:9222';
const BASE = process.env.KO_BASE || 'http://127.0.0.1:18080';
const USER = process.env.KO_USER || 'admin';
const PASSWORD = process.env.KO_PASSWORD || '';
const OUT = process.env.KO_OUT || path.join(__dirname, 'out');
const W = Number(process.env.KO_CARD_W || 376);
const H = Number(process.env.KO_CARD_H || 228);
const H_COLLAPSED = Number(process.env.KO_CARD_H_COLLAPSED || 52);

fs.mkdirSync(OUT, { recursive: true });
const results = { phase: 'card', checks: [] };
function check(name, pass, detail) {
  results.checks.push({ name, pass: !!pass, detail: detail === undefined ? null : detail });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + '  ' + JSON.stringify(detail === undefined ? null : detail));
}

async function cardInfo(card) {
  return card.evaluate(() => {
    const c = document.getElementById('card').dataset;
    return {
      conn: c.conn, auth: c.auth, collapsed: c.collapsed, stale: c.stale,
      goal: document.getElementById('goal').textContent,
      next: document.getElementById('next').textContent,
      sync: document.getElementById('sync').textContent,
      stamp: document.getElementById('stamp').textContent,
      outer: [window.outerWidth, window.outerHeight],
    };
  });
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const pages = browser.contexts().flatMap(c => c.pages());
  const card = pages.find(p => p.url().includes('/card.html'));
  if (!card) throw new Error('没找到 card.html：客户端是否带 --remote-debugging-port 启动？');

  const info = await cardInfo(card);
  check('V1 卡片页面存在（真实 Electron 窗口）', true, card.url());
  check('V2 连接的是预期的服务器', card.url().startsWith(BASE), card.url());
  check('V3 卡片尺寸符合预期（含无框窗口边框）',
    info.outer[0] === W && [H, H_COLLAPSED].includes(info.outer[1]), { expect: [W, H, H_COLLAPSED], got: info.outer });
  check('V4 卡片已连上后端（conn=ok）', info.conn === 'ok', { conn: info.conn, auth: info.auth });

  if (info.auth !== 'ok') {
    if (!PASSWORD) {
      throw new Error('会话已过期且未设置 KO_PASSWORD：请先在完整窗口里登录，或提供 KO_PASSWORD');
    }
    console.log('INFO  auth=' + info.auth + '，先走完整窗口登录');
    const context = browser.contexts()[0];
    const pagePromise = context.waitForEvent('page', { timeout: 15000 });
    await card.click('#banner-action');
    const main = await pagePromise;
    await main.waitForLoadState('domcontentloaded');
    if (main.url().includes('login')) {
      await main.fill('#username', USER);
      await main.fill('#password', PASSWORD);
      await Promise.all([
        main.waitForURL(u => !String(u).includes('login'), { timeout: 20000 }),
        main.click('#login-form button[type="submit"]'),
      ]);
    }
    await card.click('[data-act="refresh"]');
    await card.waitForFunction(() => document.getElementById('card').dataset.auth === 'ok', null, { timeout: 20000 });
  }

  const loaded = await cardInfo(card);
  check('V5 登录有效且数据已加载', loaded.auth === 'ok' && loaded.conn === 'ok', { auth: loaded.auth, conn: loaded.conn });
  check('V6 卡片显示目标文字', loaded.goal.length > 0 && loaded.goal !== '—', loaded.goal);
  check('V7 卡片显示下一步（任务或推荐，不冒充已发生）', loaded.next.length > 0 && loaded.next !== '—', loaded.next);
  check('V8 同步行显示真实待审数', /同步：/.test(loaded.sync), loaded.sync);
  check('V9 数据时间戳来自真实字段', /\d{2}:\d{2}/.test(loaded.stamp), loaded.stamp);

  // 上次会话可能把卡片留在收起态，先归位再做双向验证。
  if ((await cardInfo(card)).collapsed === 'true') {
    await card.click('[data-act="expand"]');
    await card.waitForTimeout(1200);
  }
  check('V10 展开态高度正确', (await cardInfo(card)).outer[1] === H, (await cardInfo(card)).outer);
  await card.screenshot({ path: path.join(OUT, '01-card.png') });

  await card.click('[data-act="collapse"]');
  await card.waitForTimeout(1200);
  const collapsed = await cardInfo(card);
  check('V11 收起为胶囊态', collapsed.collapsed === 'true' && collapsed.outer[1] === H_COLLAPSED,
    { collapsed: collapsed.collapsed, outer: collapsed.outer });
  await card.screenshot({ path: path.join(OUT, '02-collapsed.png') });

  await card.click('[data-act="expand"]');
  await card.waitForTimeout(1200);
  const expanded = await cardInfo(card);
  check('V12 再展开恢复原高度', expanded.collapsed === 'false' && expanded.outer[1] === H,
    { collapsed: expanded.collapsed, outer: expanded.outer });

  // 打开完整知识树。主进程会复用已有窗口，此时没有 page 事件，先找一遍。
  const context = browser.contexts()[0];
  let main = context.pages().find(p => !p.url().includes('card.html')
    && p.url().startsWith(BASE) && !p.url().includes('login'));
  if (!main) {
    const pagePromise = context.waitForEvent('page', { timeout: 15000 });
    await card.click('[data-act="tree"]');
    main = await pagePromise;
  }
  await main.waitForLoadState('domcontentloaded');
  await main.waitForTimeout(1200);
  check('V13 完整知识树窗口已打开', main.url().startsWith(BASE) && !main.url().includes('login'), main.url());
  const nodeCount = await main.evaluate(() => document.querySelectorAll('#nodes [data-node]').length);
  check('V14 完整窗口渲染出节点', nodeCount > 0, { nodes: nodeCount });
  await main.screenshot({ path: path.join(OUT, '03-tree.png') });

  fs.writeFileSync(path.join(OUT, 'card.json'), JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(results.checks.every(c => c.pass) ? 0 : 2);
})().catch(error => { console.error('FAILED', error); process.exit(1); });
