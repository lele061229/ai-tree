// 一次性探针：验证 --self-test-tray-menu 弹出后，UIA 是否能在不同延迟下抓到菜单项。
// 不参与正式验收，只为定位 S6 失败原因是时序还是能力。
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXE = process.env.KO_EXE;
const EXE_DIR = path.dirname(EXE);
const USERDATA = process.env.KO_USERDATA;
const PS1 = path.join(__dirname, 'tray-click-quit.ps1');
const OUT = process.env.KO_OUT || path.join(__dirname, 'out-local', 'tray-probe.json');

function pids() {
  const cmd = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '"
    + EXE.replace(/'/g, "''") + "' } | ForEach-Object { [string]$_.ProcessId }";
  let out = '';
  try { out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; }
  return out.split(/\r?\n/).map(s => Number(s.trim())).filter(n => n > 0);
}
for (const p of pids()) { try { execFileSync('taskkill', ['/F', '/T', '/PID', String(p)], { stdio: 'ignore' }); } catch {} }

const env = { ...process.env, KO_USERDATA: USERDATA };
delete env.ELECTRON_RUN_AS_NODE;
delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.http_proxy; delete env.https_proxy;
if (process.env.KO_LAUNCH === 'start') {
  // 和 tray-quit.cjs 一样用 shell 启动：给进程正常的前台激活上下文。
  execFileSync('cmd.exe', ['/c', 'start', '', EXE, '--self-test-tray-menu'], { env, stdio: 'ignore', cwd: EXE_DIR });
} else {
  const child = spawn(EXE, ['--self-test-tray-menu'], { cwd: EXE_DIR, env, detached: true, stdio: 'ignore' });
  child.unref();
}

const logFile = path.join(USERDATA, 'logs', 'main.log');
let offset = 0;
try { offset = fs.statSync(logFile).size; } catch {}
const started = Date.now();
let popped = false;
for (let i = 0; i < 300 && !popped; i++) {
  try {
    const buf = fs.readFileSync(logFile);
    popped = buf.subarray(offset).toString('utf8').includes('self-test: popup tray menu');
  } catch {}
  if (!popped) execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 200'], { stdio: 'ignore' });
}
console.log('popup logged after ms:', Date.now() - started);
console.log('delay since popup before click: 0 (immediate)');

const t0 = Date.now();
const useDump = process.env.KO_MODE === 'dump';
const ps = useDump ? path.join(__dirname, 'tray-dump.ps1') : PS1;
try {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', ps, '-Out', OUT, useDump ? '-WaitMs' : '-WaitMs', useDump ? '10000' : '15000'], { encoding: 'utf8', timeout: 60000 });
} catch (e) { /* 读结果文件 */ }
console.log('ps elapsed ms:', Date.now() - t0);
console.log(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : 'no result');
const left = pids();
console.log('remaining pids:', JSON.stringify(left));
for (const p of left) { try { execFileSync('taskkill', ['/F', '/T', '/PID', String(p)], { stdio: 'ignore' }); } catch {} }
