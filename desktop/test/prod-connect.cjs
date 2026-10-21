// 用真实打包客户端只读试连正式站点，判断 TLS 与页面兼容性。
// 做法：备份 config.json → 临时改为正式地址 → 启动 → 读取 main.log →
//       结束本次诊断进程 → 还原 config.json。
// 不上传任何数据、不登录、不改服务器。
//
// 用法：KO_EXE=<打包 exe> node test/prod-connect.cjs
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');

const EXE = process.env.KO_EXE;
const PROD = process.env.KO_PROD || 'https://120.25.151.128';
const EXE_DIR = path.dirname(EXE);
const UD = path.join(process.env.APPDATA || '', 'AI Tree');
const CFG = path.join(UD, 'config.json');
const LOG = path.join(UD, 'logs', 'main.log');
const OUT = process.env.KO_OUT || path.join(__dirname, 'out-prod', 'prod-connect.json');

if (!EXE) { console.error('缺少 KO_EXE'); process.exit(1); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
function killOurs() {
  for (const p of procs()) { try { execFileSync('taskkill', ['/F', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch {} }
}
const logSize = () => { try { return fs.statSync(LOG).size; } catch { return 0; } };
const logTail = o => { try { return fs.readFileSync(LOG, 'utf8').slice(o); } catch { return ''; } };

function osVisible() {
  try {
    const out = execFileSync(process.env.KO_PYTHON || 'python',
      [path.join(__dirname, '..', '..', 'source', 'e2e', 'desktop', 'window_state.py'), 'AI Tree'],
      { encoding: 'utf8' });
    return JSON.parse(out).any_visible === true;
  } catch { return false; }
}

async function main() {
  killOurs();
  await sleep(600);
  const backup = fs.existsSync(CFG) ? fs.readFileSync(CFG) : null;
  if (backup) fs.writeFileSync(path.join(path.dirname(OUT), 'config.backup.json'), backup);
  const cfg = backup ? JSON.parse(backup.toString('utf8').replace(/^\uFEFF/, '')) : {};
  const result = { prod: PROD, originalServerUrl: cfg.serverUrl || null, checks: [], log: '' };
  const check = (n, p, d) => { result.checks.push({ name: n, pass: !!p, detail: d === undefined ? null : d }); console.log((p ? 'PASS' : 'FAIL') + '  ' + n + '  ' + JSON.stringify(d === undefined ? null : d)); };

  try {
    fs.writeFileSync(CFG, JSON.stringify({ ...cfg, serverUrl: PROD }, null, 1), { mode: 0o600 });
    const offset = logSize();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.http_proxy; delete env.https_proxy;
    execFileSync('cmd.exe', ['/c', 'start', '', EXE, '--remote-debugging-port=9222'], { env, stdio: 'ignore', cwd: EXE_DIR });
    // 等页面加载 + 错误页切换
    const deadline = Date.now() + 25000;
    let tail = '';
    while (Date.now() < deadline) {
      await sleep(800);
      tail = logTail(offset);
      if (tail.includes('http status error') || tail.includes('did-fail-load')) break;
    }
    await sleep(1500);
    tail = logTail(offset);
    result.log = tail;
    check('客户端启动并读取正式地址', tail.includes('process start'), tail.split('\n')[0]);
    check('没有证书错误（无双 -202/-200 记录）', !/did-fail-load.*(-202|-200)/.test(tail), (tail.match(/did-fail-load.*/g) || []).slice(0, 2));
    check('正式站点可达（不是 ERR_CONNECTION / CERT）', !/-102|ERR_CONNECTION|CERT_/.test(tail), (tail.match(/did-fail-load.*/g) || []).slice(0, 2));
    check('缺少 card.html 时识别 HTTP 404', /http status error.*"code":404/.test(tail), (tail.match(/http status error.*/g) || []).slice(0, 2));

    // 用 CDP 确认卡片窗口真的切到了本地错误页（不是空窗口）
    let browser = null;
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 8000 }); } catch {}
    if (browser) {
      const pages = browser.contexts().flatMap(c => c.pages());
      const card = pages.find(p => p.url().includes('error.html')) || pages.find(p => p.url().includes('card.html'));
      check('卡片窗口显示本地错误页', !!card && card.url().includes('error.html'), card && card.url());
      result.errorPageUrl = card ? card.url() : null;
      try { await browser.close(); } catch {}
    } else {
      check('卡片窗口显示本地错误页', false, 'CDP 连接失败');
    }
    check('错误页窗口可见', osVisible(), null);
  } finally {
    killOurs();
    await sleep(500);
    if (backup) fs.writeFileSync(CFG, backup);
    else { try { fs.unlinkSync(CFG); } catch {} }
    result.configRestoredTo = backup ? JSON.parse(backup.toString('utf8').replace(/^\uFEFF/, '')).serverUrl : '(no config)';
  }

  const failed = result.checks.filter(c => !c.pass);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`TOTAL: ${result.checks.length - failed.length}/${result.checks.length} pass`);
  process.exit(failed.length ? 2 : 0);
}
main().catch(e => { console.error('FATAL', e); try { killOurs(); } catch {} process.exit(1); });
