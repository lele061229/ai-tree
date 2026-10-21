// 托盘“退出”真实验收（不是 taskkill）：
//   1) 真实点击托盘右键菜单里的“退出 AI Tree”（Windows UI Automation，见 tools/tray-click-quit.ps1）
//   2) 确认对应 AI Tree 主进程退出，且日志走完 before-quit → will-quit → quit(0)
//   3) 立即重新启动，确认能看到窗口
//   R1：等进程退出后立刻启动
//   R2：点击后不等退出、立刻启动（验证单实例锁重试，不靠 app.exit(0)）
//
// 用法：KO_EXE=<打包 exe> node test/tray-quit.cjs
const { chromium } = require('playwright-core');
const { execFileSync, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const EXE = process.env.KO_EXE;
const PY = process.env.KO_PYTHON || 'python';
const PORT = Number(process.env.KO_PORT || 18080);
const BASE = `http://127.0.0.1:${PORT}`;
const EXE_DIR = path.dirname(EXE);
const OUT = process.env.KO_OUT || path.join(__dirname, 'out-tray');
const LOG = path.join(process.env.APPDATA || '', 'AI Tree', 'logs', 'main.log');
const PS1 = path.join(__dirname, 'tray-click-quit.ps1');

if (!EXE) { console.error('缺少 KO_EXE'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const results = { rounds: [], checks: [] };
function check(name, pass, detail) {
  results.checks.push({ name, pass: !!pass, detail: detail === undefined ? null : detail });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + '  ' + JSON.stringify(detail === undefined ? null : detail));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function launch(extraArgs = []) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.http_proxy; delete env.https_proxy;
  execFileSync('cmd.exe', ['/c', 'start', '', EXE, '--self-test-tray-menu', ...extraArgs], { env, stdio: 'ignore', cwd: EXE_DIR });
}

function procs() {
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
const mainPids = () => procs().map(p => p.pid);

function killOursForSetup() {
  for (const p of procs()) {
    try { execFileSync('taskkill', ['/F', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch {}
  }
}

function osVisible() {
  try {
    const out = execFileSync(PY, [path.join(__dirname, '..', '..', 'source', 'e2e', 'desktop', 'window_state.py'), 'AI Tree'], { encoding: 'utf8' });
    return JSON.parse(out).any_visible === true;
  } catch { return false; }
}
const logSize = () => { try { return fs.statSync(LOG).size; } catch { return 0; } };
const logTail = offset => { try { return fs.readFileSync(LOG, 'utf8').slice(offset); } catch { return ''; } };

async function waitFor(fn, timeoutMs, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

function clickTrayQuit() {
  const outPath = path.join(OUT, 'tray-click.json');
  try { fs.unlinkSync(outPath); } catch {}
  const started = Date.now();
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', PS1, '-Out', outPath,
  ], { encoding: 'utf8', timeout: 60000 });
  const elapsed = Date.now() - started;
  let info = null;
  try { info = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
  return { info, elapsed, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const CARD_HTML = '<!doctype html><html><body><div id="card" data-conn="stub"></div></body></html>';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (String(req.url).startsWith('/card.html')) return res.end(CARD_HTML);
  return res.end('<!doctype html><html><body><h1>stub-main</h1></body></html>');
});
const listen = () => new Promise(r => server.listen(PORT, '127.0.0.1', r));
const close = () => new Promise(r => server.close(r));

async function ensureRunning(label) {
  const pids = mainPids();
  if (pids.length) return pids[0];
  launch();
  const found = await waitFor(() => (mainPids().length ? mainPids()[0] : null), 25000, 200);
  check(label + ' 应用已启动', !!found, found);
  await sleep(2500);
  return found;
}

async function round(n, mode) {
  const r = { round: n, mode, checks: [] };
  const push = (name, pass, detail) => {
    r.checks.push({ name, pass: !!pass, detail: detail === undefined ? null : detail });
    check('[R' + n + '] ' + name, pass, detail);
  };
  console.log('===== ROUND ' + n + ' (' + mode + ') =====');
  await ensureRunning('R' + n);
  const before = mainPids();
  const offset = logSize();
  // 等应用把真实托盘菜单弹出来（--self-test-tray-menu），再让 UIA 点菜单项。
  await waitFor(() => logTail(offset).includes('self-test: popup tray menu'), 15000, 200);

  const click = clickTrayQuit();
  console.log('tray-click:', JSON.stringify(click.info));
  push('真实点击托盘图标并执行“退出”', !!click.info && click.info.ok === true && click.info.invoked === true,
    click.info ? { icon: click.info.icon_found, menu: click.info.menu_found, stage: click.info.stage, steps: click.info.steps } : click.stderr);

  if (mode === 'relaunch-immediately') {
    // 不等退出，立刻启动第二个实例（最严格的“退出后马上双击”）
    const oldPid = before[0];
    launch();
    const oldGone = await waitFor(() => !mainPids().includes(oldPid), 15000, 100);
    push('旧进程完成退出（新实例在等待锁）', !!oldGone, { oldPid, now: mainPids() });
    const alive = await waitFor(() => mainPids().find(p => p !== oldPid) || null, 30000, 150);
    push('立即重开后有且只有一个主进程', !!alive && mainPids().length === 1, { pids: mainPids() });
    const vis = await waitFor(() => osVisible(), 20000, 250);
    push('立即重开后窗口可见', !!vis, { visible: osVisible() });
  } else {
    const gone = await waitFor(() => mainPids().length === 0, 15000, 80);
    push('托盘“退出”后 AI Tree 主进程已退出', !!gone, { before, remaining: mainPids() });
    const t0 = Date.now();
    launch();
    const alive = await waitFor(() => (mainPids().length ? mainPids()[0] : null), 30000, 120);
    push('退出后立刻双击能重新启动', !!alive, { pids: mainPids(), startMs: Date.now() - t0 });
    const vis = await waitFor(() => osVisible(), 20000, 250);
    push('重开后窗口可见', !!vis, { visible: osVisible() });
  }

  await sleep(600);
  const tail = logTail(offset);
  push('日志记录 tray quit clicked', tail.includes('tray quit clicked'), null);
  push('日志走完 before-quit → will-quit → quit', tail.includes('before-quit') && tail.includes('will-quit') && /\] quit \{/.test(tail), null);
  const quitLine = tail.split('\n').find(l => /\] quit \{/.test(l)) || '';
  push('正常退出（exitCode=0，非强制 kill）', quitLine.includes('"exitCode":0'), quitLine.trim());
  r.log = tail;
  results.rounds.push(r);
  return r;
}

async function main() {
  killOursForSetup();
  await sleep(600);
  await listen();
  await round(1, 'wait-exit');
  await round(2, 'relaunch-immediately');

  const all = results.checks;
  const failed = all.filter(c => !c.pass);
  fs.writeFileSync(path.join(OUT, 'tray-quit.json'), JSON.stringify(results, null, 2));
  console.log(`TOTAL: ${all.length - failed.length}/${all.length} pass`);
  await close();
  process.exit(failed.length ? 2 : 0);
}

main().catch(async e => {
  console.error('FATAL', e && e.stack || e);
  try { await close(); } catch {}
  process.exit(1);
});
