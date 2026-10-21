// 交付态启动：像双击一样用默认数据目录启动本地版，并让父进程保持存活，
// 避免测试会话结束时把应用一起带走（沙箱会回收作业）。
// 用途：留给用户做“右键托盘 → 退出 AI Tree”这一步，然后由检查脚本核对清理。
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXE = process.env.KO_EXE;
if (!EXE || !fs.existsSync(EXE)) { console.error('需要 KO_EXE=<交付目录>\\AITreeLocal.exe'); process.exit(2); }
const UD = path.join(process.env.APPDATA, 'AI Tree 本地版');
const LOG = path.join(UD, 'logs', 'main.log');

function pids() {
  const cmd = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '"
    + EXE.replace(/'/g, "''") + "' } | ForEach-Object { [string]$_.ProcessId }";
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' })
      .split(/\r?\n/).map(s => Number(s.trim())).filter(n => n > 0);
  } catch (e) { return []; }
}

const before = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
const child = spawn(EXE, [], { cwd: path.dirname(EXE), detached: true, stdio: 'ignore', env: process.env });
child.unref();
console.log('spawned pid', child.pid, 'userdata', UD);

const started = Date.now();
const timer = setInterval(async () => {
  let ok = false;
  try {
    const r = await fetch('http://127.0.0.1:18213/api/health', { signal: AbortSignal.timeout(1500) });
    ok = r.status === 200;
  } catch {}
  if (ok) {
    console.log('health 200 after', Math.round((Date.now() - started) / 1000) + 's');
    if (fs.existsSync(LOG)) {
      const buf = fs.readFileSync(LOG);
      console.log('--- log ---\n' + buf.subarray(before).toString('utf8').trim());
    }
    console.log('exe pids:', pids());
    clearInterval(timer);
  } else if (Date.now() - started > 120000) {
    console.log('health timeout, pids:', pids());
    clearInterval(timer);
  }
}, 1500);

// 保活：不主动结束应用，等外部退出（用户点托盘退出）
setInterval(() => {}, 1 << 30);
