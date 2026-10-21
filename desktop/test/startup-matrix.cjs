// AI Tree 桌面端启动问题修复验证矩阵（打包程序，多轮）。
//
// 覆盖场景（每轮一轮，共 N 轮，默认 3）：
//   S1 完全退出后双击启动        → 进程存活 + OS 层窗口可见 + 卡片页面加载
//   S2 运行中再次双击            → 第二实例自动退出，窗口不被误触隐藏
//   S3 隐藏卡片后双击            → 卡片恢复显示（second-instance → showCard）
//   S4 关闭主窗口后双击          → 卡片仍在，主窗口不意外重建
//   S5 服务器不可达              → 卡片显示本地错误页；恢复后点"重试"回到卡片
//   S6 进程结束后双击重开        → 锁随进程退出释放，能再次启动
//     （托盘菜单点击在 Win11 无法自动化，见 tray.cjs 注释；这里用
//      taskkill 硬结束作等效证据，托盘"退出"本身留人工确认。）
//
// 环境变量：KO_EXE（必填）、KO_PYTHON、KO_CDP、KO_OUT、KO_ROUNDS、KO_PORT
// 卡片/主窗口以 --remote-debugging-port 启动便于断言，等价于验收脚本既有做法。
const { chromium } = require('playwright-core');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const EXE = process.env.KO_EXE;
const PY = process.env.KO_PYTHON || 'python';
const CDP = process.env.KO_CDP || 'http://127.0.0.1:9222';
const OUT = process.env.KO_OUT || path.join(__dirname, 'out-matrix');
const ROUNDS = Number(process.env.KO_ROUNDS || 3);
const PORT = Number(process.env.KO_PORT || 18080);
const BASE = `http://127.0.0.1:${PORT}`;
const EXE_DIR = path.dirname(EXE);

if (!EXE) { console.error('缺少 KO_EXE'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const results = { rounds: ROUNDS, scenarios: [] };
function check(list, name, pass, detail) {
  list.push({ name, pass: !!pass, detail: detail === undefined ? null : detail });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + '  ' + JSON.stringify(detail === undefined ? null : detail));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function launchNormally() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync('cmd.exe', ['/c', 'start', '', EXE, '--remote-debugging-port=9222'], { env, stdio: 'ignore', cwd: EXE_DIR });
}

function aiTreePids() {
  // 注意：-Command 的参数里不能出现内嵌双引号（Node 的 Windows 参数转义与 PS 5.1 解析不兼容），
  // 一律用单引号与字符串拼接。
  // Electron 一个实例有 4 个同名子进程（--type=renderer/gpu/utility），只有主进程没有 --type=。
  const cmd = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'AI Tree.exe' } | "
    + "ForEach-Object { [string]$_.ProcessId + '|' + [string]$_.ExecutablePath + '|' + [string]$_.CommandLine }";
  let out = '';
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
  } catch (e) { out = (e.stdout || ''); }
  return out.split(/\r?\n/).filter(l => l.includes('|')).map(l => {
    const [pid, exePath, cmdline] = l.split('|');
    return { pid: Number(pid), exePath, main: !/ --type=/.test(cmdline || '') };
  }).filter(p => p.pid > 0 && p.exePath && path.relative(EXE_DIR, p.exePath).split('..').length === 1);
}

function mainPids() { return aiTreePids().filter(p => p.main); }

async function killAll(checks) {
  // 只按绝对路径确认过的 AI Tree 进程操作；杀主进程后子进程自动退出，
  // 子进程 PID 再 taskkill 会报"进程不存在"，属正常，逐个容错。
  for (const p of aiTreePids()) {
    console.log('KILL', p.pid, p.exePath, p.main ? '(main)' : '(child)');
    try { execFileSync('taskkill', ['/F', '/PID', String(p.pid)], { stdio: 'ignore' }); }
    catch (e) { console.log('  (already gone:', p.pid, ')'); }
  }
  for (let i = 0; i < 40 && mainPids().length > 0; i++) await sleep(250);
  if (checks) check(checks, '前置：测试目录内的 AI Tree 进程已全部结束', mainPids().length === 0, mainPids());
}

function osWindowVisible() {
  try {
    const out = execFileSync(PY, [path.join(__dirname, '..', '..', 'source', 'e2e', 'desktop', 'window_state.py'), 'AI Tree'], { encoding: 'utf8' });
    return JSON.parse(out).any_visible === true;
  } catch { return false; }
}

async function connectCDP(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await chromium.connectOverCDP(CDP); } catch (e) {
      if (Date.now() > deadline) throw e;
      await sleep(400);
    }
  }
}

function pagesOf(browser) { return browser.contexts().flatMap(c => c.pages()); }

function makeStub() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (String(req.url).startsWith('/card.html')) {
      res.end('<!doctype html><html><body><div id="card" data-conn="stub"></div></body></html>');
    } else {
      res.end('<!doctype html><html><body><h1>stub-main</h1></body></html>');
    }
  });
  return {
    on: () => new Promise(resolve => srv.listen(PORT, '127.0.0.1', resolve)),
    off: () => new Promise(resolve => srv.close(resolve)),
  };
}

async function withCDP(browser, fn) {
  try { return await fn(browser); }
  finally { try { await browser.close(); } catch {} }
}

// —— 各场景单轮 ——

async function s1_coldStart(checks) {
  await killAll(checks);
  launchNormally();
  const browser = await connectCDP();
  await withCDP(browser, async b => {
    const card = await waitCardPage(b, checks);
    check(checks, 'S1 卡片页面已加载', !!card && (await card.url()).includes('/card.html'), card && (await card.url()));
    await sleep(1200);
    check(checks, 'S1 OS 层窗口可见', osWindowVisible());
    check(checks, 'S1 进程存活', aiTreePids().length >= 1, aiTreePids().map(p => p.pid));
  });
}

async function waitCardPage(browser, checks, want = '/card.html') {
  const deadline = Date.now() + 20000;
  for (;;) {
    const page = pagesOf(browser).find(p => (p.url()).includes(want));
    if (page) return page;
    if (Date.now() > deadline) return null;
    await sleep(300);
  }
}

async function s2_secondClick(checks) {
  // 前置：S1 已在运行；"实例数"按主进程数算（Electron 每实例有 4 个同名子进程）
  const before = mainPids().length;
  launchNormally();
  const browser = await connectCDP();
  await withCDP(browser, async b => {
    const deadline = Date.now() + 15000;
    while (mainPids().length > 1 && Date.now() < deadline) await sleep(300);
    check(checks, 'S2 第二实例已退出（回到单实例）', mainPids().length === 1 && before >= 1, { before, now: mainPids().map(p => p.pid) });
    await sleep(800);
    check(checks, 'S2 双击后窗口未被误隐藏', osWindowVisible());
    const card = pagesOf(b).find(p => p.url().includes('/card.html'));
    check(checks, 'S2 卡片页面保持加载', !!card, card && (await card.url()));
  });
}

async function s3_hiddenThenClick(checks) {
  const browser = await connectCDP();
  await withCDP(browser, async b => {
    const card = pagesOf(b).find(p => p.url().includes('/card.html'));
    if (!card) { check(checks, 'S3 前置：找到卡片页面', false); return; }
    await card.evaluate(() => window.koDesktop.hideCard());
    const deadline = Date.now() + 8000;
    while (osWindowVisible() && Date.now() < deadline) await sleep(300);
    check(checks, 'S3 卡片已隐藏', !osWindowVisible());
    launchNormally();
    const dl = Date.now() + 15000;
    while (!osWindowVisible() && Date.now() < dl) await sleep(300);
    check(checks, 'S3 隐藏后双击恢复显示', osWindowVisible());
    const card2 = pagesOf(b).find(p => p.url().includes('/card.html'));
    check(checks, 'S3 卡片页面仍在', !!card2, card2 && (await card2.url()));
  });
}

async function s4_closeMainThenClick(checks) {
  const browser = await connectCDP();
  await withCDP(browser, async b => {
    const card = pagesOf(b).find(p => p.url().includes('/card.html'));
    if (!card) { check(checks, 'S4 前置：找到卡片页面', false); return; }
    await card.evaluate(() => window.koDesktop.openTree());
    const dl = Date.now() + 15000;
    let main = null;
    while (Date.now() < dl) {
      main = pagesOf(b).find(p => p.url() === BASE + '/' || p.url() === BASE);
      if (main) break;
      await sleep(300);
    }
    check(checks, 'S4 主窗口已打开', !!main, main && (await main.url()));
    if (!main) return;
    await main.close();
    const dl2 = Date.now() + 10000;
    while (Date.now() < dl2) {
      if (!pagesOf(b).some(p => p.url() === BASE + '/' || p.url() === BASE)) break;
      await sleep(300);
    }
    check(checks, 'S4 主窗口已关闭', !pagesOf(b).some(p => p.url() === BASE + '/' || p.url() === BASE));
    check(checks, 'S4 关闭主窗口后进程仍在（托盘常驻）', aiTreePids().length >= 1);
    check(checks, 'S4 关闭主窗口后卡片仍可见', osWindowVisible());
    launchNormally();
    await sleep(2500);
    check(checks, 'S4 双击后卡片仍可见（未误隐藏）', osWindowVisible());
    check(checks, 'S4 双击未重建主窗口', !pagesOf(b).some(p => p.url() === BASE + '/' || p.url() === BASE));
  });
}

async function s5_serverDown(checks) {
  await killAll(checks);
  launchNormally();
  const browser = await connectCDP();
  await withCDP(browser, async b => {
    const err = await waitCardPage(b, checks, 'error.html');
    check(checks, 'S5 服务器不可达时显示本地错误页', !!err, err && (await err.url()));
    await sleep(600);
    check(checks, 'S5 错误状态下窗口可见（不是无界面）', osWindowVisible());
    if (!err) return;
    // 服务器恢复后点"重试"
    await stubOn();
    await err.click('#retry');
    const dl = Date.now() + 15000;
    while (Date.now() < dl) {
      if ((await err.url()).includes('/card.html')) break;
      await sleep(300);
    }
    check(checks, 'S5 点重试后回到卡片页面', (await err.url()).includes('/card.html'), await err.url());
    await sleep(800);
    check(checks, 'S5 重试后窗口可见', osWindowVisible());
  });
}

async function s5b_mainWindowError(checks) {
  // 主窗口加载失败也要有本地错误页：先开着 stub 打开主窗口，再拔掉服务器刷新。
  const browser = await connectCDP();
  await withCDP(browser, async b => {
    const card = pagesOf(b).find(p => p.url().includes('/card.html'));
    if (!card) { check(checks, 'S5b 前置：找到卡片页面', false); return; }
    await card.evaluate(() => window.koDesktop.openTree());
    const dl = Date.now() + 15000;
    let main = null;
    while (Date.now() < dl) {
      main = pagesOf(b).find(p => p.url() === BASE + '/' || p.url() === BASE);
      if (main) break;
      await sleep(300);
    }
    check(checks, 'S5b 主窗口已打开', !!main);
    if (!main) return;
    await stubOff();
    await main.reload().catch(() => {});
    const dl2 = Date.now() + 15000;
    while (Date.now() < dl2) {
      if ((await main.url()).includes('error.html')) break;
      await sleep(300);
    }
    check(checks, 'S5b 主窗口加载失败显示本地错误页', (await main.url()).includes('error.html'), await main.url());
    await sleep(500);
    check(checks, 'S5b 错误状态下主窗口可见', osWindowVisible());
    await stubOn();
    await main.click('#retry');
    const dl3 = Date.now() + 15000;
    while (Date.now() < dl3) {
      const u = await main.url();
      if (u === BASE + '/' || u === BASE) break;
      await sleep(300);
    }
    const u = await main.url();
    check(checks, 'S5b 主窗口重试成功', u === BASE + '/' || u === BASE, u);
  });
}

async function s6_reopenAfterKill(checks) {
  await stubOn(); // S6 统一在 stub 可达状态下做"结束后重开"，卡片应回到 card.html
  const pids = mainPids();
  check(checks, 'S6 前置：进程运行中', pids.length >= 1, pids.map(p => p.pid));
  for (const p of pids) {
    console.log('KILL', p.pid, p.exePath);
    try { execFileSync('taskkill', ['/F', '/PID', String(p.pid)], { stdio: 'ignore' }); }
    catch (e) { console.log('  (already gone:', p.pid, ')'); }
  }
  const dl = Date.now() + 10000;
  while (mainPids().length > 0 && Date.now() < dl) await sleep(250);
  check(checks, 'S6 进程已结束', mainPids().length === 0);
  launchNormally();
  const browser = await connectCDP();
  await withCDP(browser, async b => {
    const deadline = Date.now() + 20000;
    let url = '';
    while (Date.now() < deadline) {
      const page = pagesOf(b).find(p => p.url().includes('/card.html') || p.url().includes('error.html'));
      if (page) { url = await page.url(); break; }
      await sleep(300);
    }
    check(checks, 'S6 结束后双击能再次启动并加载卡片页面', url.includes('/card.html'), url || '(timeout)');
    await sleep(800);
    check(checks, 'S6 窗口可见', osWindowVisible());
  });
}

// —— 主流程 ——
const stub = makeStub();
let stubUp = false;
async function stubOn() { if (!stubUp) { await stub.on(); stubUp = true; console.log('stub ON', BASE); } }
async function stubOff() { if (stubUp) { await stub.off(); stubUp = false; console.log('stub OFF'); } }

(async () => {
  await killAll(null);
  await stubOn();
  for (let r = 1; r <= ROUNDS; r++) {
    const round = { round: r, checks: [] };
    console.log(`===== ROUND ${r} =====`);
    try {
      await s1_coldStart(round.checks);
      await s2_secondClick(round.checks);
      await s3_hiddenThenClick(round.checks);
      await s4_closeMainThenClick(round.checks);
    } catch (e) { check(round.checks, 'S1-S4 异常', false, String(e && e.stack || e).split('\n')[0]); }
    try {
      await stubOff();
      await s5_serverDown(round.checks);
      await stubOn();
      await s5b_mainWindowError(round.checks);
    } catch (e) { check(round.checks, 'S5 异常', false, String(e && e.stack || e).split('\n')[0]); }
    try {
      await s6_reopenAfterKill(round.checks);
    } catch (e) { check(round.checks, 'S6 异常', false, String(e && e.stack || e).split('\n')[0]); }
    results.scenarios.push(round);
    const failed = round.checks.filter(c => !c.pass);
    console.log(`ROUND ${r} done: ${round.checks.length - failed.length}/${round.checks.length} pass`);
  }
  await stubOff();
  const all = results.scenarios.flatMap(s => s.checks);
  const failedAll = all.filter(c => !c.pass);
  fs.writeFileSync(path.join(OUT, 'matrix.json'), JSON.stringify(results, null, 2));
  console.log(`TOTAL: ${all.length - failedAll.length}/${all.length} pass, rounds=${ROUNDS}`);
  process.exit(failedAll.length ? 2 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
