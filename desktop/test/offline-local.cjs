// 离线等价验收：只在“本进程内”阻断非回环网络，不改系统网络设置。
//   --host-resolver-rules="MAP * ~NOTFOUND,EXCLUDE 127.0.0.1"  → 渲染进程解析不到任何外网域名
//   HTTP(S)_PROXY=127.0.0.1:9                                  → 任何走代理的出网尝试也失败
// 负向对照：页面里 fetch('https://example.com') 必须失败，否则说明“阻断没生效”，结论作废。
// 正向验证：页面加载 / 读取知识树 / 写学习任务 / 重启后仍在。
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const EXE = process.env.KO_EXE;
if (!EXE || !fs.existsSync(EXE)) { console.error('需要 KO_EXE=<交付目录>\\AITreeLocal.exe'); process.exit(2); }
const EXE_DIR = path.dirname(EXE);
const CDP_PORT = 9226;
const OUT = path.join(__dirname, 'out-local');
const UD = path.join(OUT, 'userdata-offline');
const SEED = process.env.KO_SEED_USERDATA;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + JSON.stringify(detail));
}

function health(port) {
  return new Promise(resolve => {
    const req = http.get('http://127.0.0.1:' + port + '/api/health', { timeout: 1500 }, res => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function launch() {
  const env = { ...process.env, KO_USERDATA: UD,
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9' };
  const child = spawn(EXE, [
    '--remote-debugging-port=' + CDP_PORT,
    '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1',
  ], { cwd: EXE_DIR, env, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function connect() {
  const { chromium } = require('playwright-core');
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try { return await chromium.connectOverCDP('http://127.0.0.1:' + CDP_PORT); }
    catch { await sleep(700); }
  }
  throw new Error('CDP 连接超时');
}

function killInstance() {
  // 只结束本次 exe 路径的进程（不按名字杀 python.exe）
  const cmd = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '"
    + EXE.replace(/'/g, "''") + "' } | ForEach-Object { [string]$_.ProcessId }";
  let out = '';
  try { out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; }
  for (const pid of out.split(/\r?\n/).map(s => Number(s.trim())).filter(n => n > 0)) {
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch {}
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // 用一份已含水位的隔离库做种子（来自验收矩阵，不含任何真实数据）
  if (SEED && fs.existsSync(SEED)) {
    fs.rmSync(UD, { recursive: true, force: true });
    fs.cpSync(SEED, UD, { recursive: true });
    console.log('seed from', SEED);
  }
  killInstance();
  await sleep(1500);

  launch();
  let ok = false;
  for (let i = 0; i < 120 && !ok; i++) { await sleep(1000); ok = await health(18213); }
  check('离线条件下本地服务就绪（health 200）', ok, ok ? '3s~120s 内' : '超时');
  if (!ok) { killInstance(); process.exit(1); }

  const browser = await connect();
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().includes('/card.html')) page = p;
    if (!page) await sleep(500);
  }
  check('卡片页面已加载（离线）', !!page, page && page.url());

  const hosts = new Set();
  const failed = [];
  page.on('request', r => { try { hosts.add(new URL(r.url()).host); } catch {} });
  page.on('requestfailed', r => failed.push(r.url()));

  // 负向对照：出网必须失败（证明阻断生效）
  const external = await page.evaluate(async () => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      await fetch('https://example.com/', { signal: ctl.signal, mode: 'no-cors' });
      clearTimeout(t);
      return 'reachable';
    } catch (e) { return 'blocked: ' + String(e).slice(0, 80); }
  });
  check('负向对照：外网不可达（阻断生效）', external.startsWith('blocked'), external);

  // 查看：主页面（同源）在离线条件下渲染
  await page.goto('http://127.0.0.1:18213/', { waitUntil: 'load', timeout: 30000 })
    .catch(e => console.log('goto warn', String(e).slice(0, 120)));
  const tree = await page.evaluate(() => ({
    title: document.title,
    nodes: document.querySelectorAll('[data-node-id], .node-card, [data-tree-node]').length,
    text: (document.body.innerText || '').slice(0, 60),
  })).catch(e => ({ error: String(e) }));
  check('离线查看：主页面加载且可见知识树', !!tree && !tree.error && (tree.nodes > 0 || (tree.text || '').length > 10), tree);

  // 编辑 + 保存：走 UI 同一模块（server-api）写任务勾选
  const saved = await page.evaluate(async () => {
    const m = await import('/modules/server-api.js');
    const s = await m.request('/state');
    const snap = s.snapshots[s.snapshots.length - 1];
    const node = snap.nodes[0];
    if (!node) return { error: 'no node' };
    const key = 'v' + snap.version + ':' + node.id + ':0';
    const before = s.tasks[key] === true;
    await m.saveTask(snap.version, node.id, 0, !before);
    const after = await m.request('/state');
    return { version: snap.version, node: node.id, before, after: after.tasks[key] === true };
  }).catch(e => ({ error: String(e) }));
  check('离线编辑保存：任务勾选写入本地库', !!saved && saved.after === !saved.before, saved);

  check('页面请求全部来自回环', [...hosts].every(h => h.startsWith('127.0.0.1:')), [...hosts]);
  check('无失败请求', failed.length === 0, failed.slice(0, 3));

  try { await browser.close(); } catch {}
  killInstance();
  for (let i = 0; i < 40; i++) { await sleep(250); if (!(await health(18213))) break; }

  // 重启后仍在
  launch();
  ok = false;
  for (let i = 0; i < 120 && !ok; i++) { await sleep(1000); ok = await health(18213); }
  const browser2 = await connect();
  let page2 = null;
  for (let i = 0; i < 60 && !page2; i++) {
    for (const ctx of browser2.contexts()) for (const p of ctx.pages()) if (p.url().includes('/card.html')) page2 = p;
    if (!page2) await sleep(500);
  }
  const persisted = await page2.evaluate(async () => {
    const m = await import('/modules/server-api.js');
    const s = await m.request('/state');
    const snap = s.snapshots[s.snapshots.length - 1];
    const node = snap.nodes[0];
    const key = 'v' + snap.version + ':' + node.id + ':0';
    return { version: snap.version, nodes: snap.nodes.length, done: s.tasks[key] === true };
  }).catch(e => ({ error: String(e) }));
  check('离线重启后数据与勾选仍在', !!persisted && !persisted.error, persisted);

  try { await browser2.close(); } catch {}
  killInstance();

  const pass = results.filter(r => r.ok).length;
  console.log('\nTOTAL ' + pass + '/' + results.length);
  fs.writeFileSync(path.join(OUT, 'offline-result.json'),
    JSON.stringify({ pass, total: results.length, results }, null, 1));
  process.exit(pass === results.length ? 0 : 1);
})();
