// IPC / 导航校验的实机验证（打包程序 + 隔离 stub）。
//
// 覆盖：
//   G1 主 frame 能拿到受限 API；同源 iframe（非主 frame）拿不到任何 preload 能力
//   G2 同前缀恶意域名（127.0.0.1:18080.evil.example）导航被拦截
//   G3 不同端口（127.0.0.1:18081）导航被拦截
//   G4 userinfo 混淆（127.0.0.1:18080@evil.example）导航被拦截
//   G5 本地错误页只保留“收起卡片”：setCollapsed / openTree 不发 IPC；hideCard 生效
//
// 用法：KO_EXE=<打包 exe> node test/ipc-guard.cjs
const { chromium } = require('playwright-core');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const EXE = process.env.KO_EXE;
const PY = process.env.KO_PYTHON || 'python';
const CDP = process.env.KO_CDP || 'http://127.0.0.1:9222';
const OUT = process.env.KO_OUT || path.join(__dirname, 'out-ipc');
const PORT = Number(process.env.KO_PORT || 18080);
const BASE = `http://127.0.0.1:${PORT}`;
const EXE_DIR = path.dirname(EXE);
const LOG = path.join(process.env.APPDATA || '', 'AI Tree', 'logs', 'main.log');

if (!EXE) { console.error('缺少 KO_EXE'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const results = { checks: [] };
function check(name, pass, detail) {
  results.checks.push({ name, pass: !!pass, detail: detail === undefined ? null : detail });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + '  ' + JSON.stringify(detail === undefined ? null : detail));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.http_proxy; delete env.https_proxy;
  execFileSync('cmd.exe', ['/c', 'start', '', EXE, '--remote-debugging-port=9222'], { env, stdio: 'ignore', cwd: EXE_DIR });
}

function aiTreeMainPids() {
  const cmd = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'AI Tree.exe' } | "
    + "ForEach-Object { [string]$_.ProcessId + '|' + [string]$_.ExecutablePath + '|' + [string]$_.CommandLine }";
  let out = '';
  try { out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; }
  return out.split(/\r?\n/).filter(l => l.includes('|')).map(l => {
    const [pid, exePath, cmdline] = l.split('|');
    return { pid: Number(pid), exePath, main: !/ --type=/.test(cmdline || '') };
  }).filter(p => p.pid > 0 && p.main && p.exePath && path.relative(EXE_DIR, p.exePath).split('..').length === 1);
}

function killOurProcesses() {
  for (const p of aiTreeMainPids()) {
    try { execFileSync('taskkill', ['/F', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch {}
  }
}

function osVisible() {
  try {
    const out = execFileSync(PY, [path.join(__dirname, '..', '..', 'source', 'e2e', 'desktop', 'window_state.py'), 'AI Tree'], { encoding: 'utf8' });
    return JSON.parse(out).any_visible === true;
  } catch { return false; }
}

function logSince(offset) {
  try { return fs.readFileSync(LOG, 'utf8').slice(offset); } catch { return ''; }
}
function logSize() {
  try { return fs.statSync(LOG).size; } catch { return 0; }
}

const CARD_HTML = `<!doctype html><html><body>
<div id="card" data-conn="stub"></div>
<iframe id="f" src="/frame.html" width="100" height="40"></iframe>
<script>window.__stubCardReady = true;</script>
</body></html>`;
const FRAME_HTML = '<!doctype html><html><body>frame</body></html>';

const server = http.createServer((req, res) => {
  const url = String(req.url);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (url.startsWith('/card.html')) return res.end(CARD_HTML);
  if (url.startsWith('/frame.html')) return res.end(FRAME_HTML);
  return res.end('<!doctype html><html><body><h1>stub-main</h1></body></html>');
});
const listen = () => new Promise(r => server.listen(PORT, '127.0.0.1', r));
const close = () => new Promise(r => server.close(r));

async function connectCDP(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await chromium.connectOverCDP(CDP); } catch (e) {
      if (Date.now() > deadline) throw e;
      await sleep(400);
    }
  }
}
const pagesOf = b => b.contexts().flatMap(c => c.pages());

async function main() {
  killOurProcesses();
  await sleep(500);
  await listen();
  launch();

  const browser = await connectCDP();
  let card = null;
  const deadline = Date.now() + 25000;
  while (!card && Date.now() < deadline) {
    card = pagesOf(browser).find(p => p.url().includes('/card.html')) || null;
    if (!card) await sleep(300);
  }
  check('G0 卡片页面已加载', !!card, card && card.url());
  if (!card) throw new Error('没有卡片页面');

  // G1 主 frame vs iframe
  await card.waitForFunction(() => {
    const f = document.getElementById('f');
    return !!(f && f.contentWindow && f.contentWindow.document && f.contentWindow.document.body);
  }, null, { timeout: 15000 }).catch(() => {});
  const api = await card.evaluate(() => {
    const f = document.getElementById('f');
    const keys = w => { try { return Object.keys(w.koDesktop || {}); } catch { return ['<cross-origin>']; } };
    return {
      main: typeof window.koDesktop === 'object' ? keys(window) : null,
      frame: keys(f && f.contentWindow),
      frameHas: !!(f && f.contentWindow && f.contentWindow.koDesktop),
    };
  });
  check('G1 主 frame 具备受限 API', !!api.main && api.main.includes('hideCard'), api.main);
  check('G1 同源 iframe 不具备任何 preload 能力', api.frameHas === false && api.frame.length === 0, api.frame);

  // G2/G3/G4 导航拦截
  const before = card.url();
  const navOffset = logSize();
  const attempts = [
    ['G2 不同端口 18081', 'http://127.0.0.1:18081/card.html', true],
    ['G3 userinfo 混淆', 'http://127.0.0.1:18080@evil.example/card.html', true],
    // 端口里带字母的 URL 本身不合法（端口必须是数字），浏览器不会发起导航；
    // 同前缀主机名（https://120.25.151.128.evil.example）的判定由单测 sameOrigin 覆盖。
    ['G4 同前缀恶意域名（非法 URL，仅确认不加载）', 'http://127.0.0.1:18080.evil.example/card.html', false],
  ];
  for (const [name, target, expectLog] of attempts) {
    await card.evaluate(u => { location.href = u; }, target).catch(() => {});
    await sleep(1200);
    let now = card.url();
    if (card.isClosed()) now = '(closed)';
    check(name + ' 未发生导航', now === before, { before, now, target });
    if (expectLog) {
      const tail = logSince(navOffset);
      check(name + ' 主进程记录了 navigation blocked', tail.includes('navigation blocked') && tail.includes(target), null);
    }
    if (now !== before) break;
  }

  // G5 错误页能力收敛
  await close();
  await card.reload().catch(() => {});
  const dl = Date.now() + 15000;
  while (Date.now() < dl && !card.url().includes('error.html')) await sleep(300);
  check('G5 服务器不可达时进入本地错误页', card.url().includes('error.html'), card.url());
  if (card.url().includes('error.html')) {
    const offset = logSize();
    const res = await card.evaluate(() => {
      const out = {};
      try { window.koDesktop.setCollapsed(true); out.collapsed = 'called'; } catch (e) { out.collapsed = String(e); }
      try { window.koDesktop.openTree(); out.openTree = 'called'; } catch (e) { out.openTree = String(e); }
      out.hasHide = typeof window.koDesktop.hideCard === 'function';
      return out;
    });
    await sleep(800);
    const tail = logSince(offset);
    check('G5 错误页仍可取到 hideCard', res.hasHide === true, res);
    check('G5 错误页调用 setCollapsed 被前置拦截（无 IPC 到达主进程）', !tail.includes('"card:set-collapsed"'), tail.split('\n').filter(Boolean).slice(-4));
    check('G5 错误页调用 openTree 被前置拦截（无 IPC 到达主进程）', !tail.includes('"shell:open-tree"'), null);
    await card.evaluate(() => window.koDesktop.hideCard()).catch(() => {});
    await sleep(800);
    check('G5 错误页“收起卡片”仍生效', osVisible() === false, { visible: osVisible() });
  }

  // 日志里应能看到被拦截的导航
  const all = logSince(0);
  check('G6 主进程记录了 navigation blocked', all.includes('navigation blocked'), null);

  try { await browser.close(); } catch {}
  killOurProcesses();
  const failed = results.checks.filter(c => !c.pass);
  fs.writeFileSync(path.join(OUT, 'guard.json'), JSON.stringify(results, null, 2));
  console.log(`TOTAL: ${results.checks.length - failed.length}/${results.checks.length} pass`);
  process.exit(failed.length ? 2 : 0);
}

main().catch(async e => {
  console.error('FATAL', e && e.stack || e);
  try { await close(); } catch {}
  killOurProcesses();
  process.exit(1);
});
