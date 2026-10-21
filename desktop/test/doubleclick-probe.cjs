// 双击等价启动探针：不注入 KO_USERDATA、不清环境变量之外的东西，
// 完全按 Explorer 双击的方式（cwd=exe 目录、detached、无参数）启动，
// 然后观察：进程、日志、端口、实例发现文件。
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const EXE = process.argv[2] || path.resolve('dist/win-unpacked/AI Tree 本地版.exe');
const UD = path.join(process.env.APPDATA, process.env.KO_APPNAME || 'AI Tree 本地版');
const LOG = path.join(UD, 'logs', 'main.log');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function psList() {
  // 只查属于这个 exe 路径的进程
  const cmd = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '" + EXE.replace(/'/g, "''") + "' } | ForEach-Object { $_.ProcessId }";
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
    return out.split(/\r?\n/).map(s => Number(s.trim())).filter(n => n > 0);
  } catch (e) { return []; }
}

async function health(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(1500) });
    return r.status;
  } catch { return 0; }
}

(async () => {
  const before = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
  console.log('exe      :', EXE);
  console.log('userdata :', UD);
  console.log('log      :', LOG, 'offset', before);
  console.log('running before:', psList());

  const child = spawn(EXE, [], { cwd: path.dirname(EXE), detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  console.log('spawned pid:', child.pid);

  let lastLog = before;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const pids = psList();
    const h = await health(18213);
    let chunk = '';
    try {
      const buf = fs.readFileSync(LOG);
      chunk = buf.subarray(lastLog).toString('utf8');
      lastLog = buf.length;
    } catch {}
    if (chunk) console.log('--- t+' + (i + 1) + 's ---\n' + chunk.trimEnd());
    if (h === 200) {
      console.log('HEALTH 200 at t+' + (i + 1) + 's, pids=' + JSON.stringify(pids));
      break;
    }
    if (i % 5 === 4) console.log('t+' + (i + 1) + 's pids=' + JSON.stringify(pids) + ' health=' + h);
    if (pids.length === 0 && i > 3) { console.log('进程已退出，停止等待'); break; }
  }
  console.log('final pids:', psList(), 'health:', await health(18213));
  try { console.log('server.json:', fs.readFileSync(path.join(UD, 'local', 'server.json'), 'utf8')); } catch (e) { console.log('server.json: MISSING'); }
})();
