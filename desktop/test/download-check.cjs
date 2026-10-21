// 一次性检查：本地实例是否真的能把打包内的 Skill 安装包发出来（内容与仓库一致）。
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const EXE = path.resolve(__dirname, '..', 'dist', 'win-unpacked', 'AI Tree.exe');
const env = { ...process.env, KO_USERDATA: process.env.KO_USERDATA };
delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.http_proxy; delete env.https_proxy;
const child = spawn(EXE, [], { cwd: path.dirname(EXE), env, detached: true, stdio: 'ignore' });
child.unref();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function killAll() {
  const cmd = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '"
    + path.dirname(EXE).replace(/'/g, "''") + "\\*' } | ForEach-Object { [string]$_.ProcessId }";
  let out = '';
  try { out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; }
  for (const p of out.split(/\r?\n/).map(s => Number(s.trim())).filter(n => n > 0)) {
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(p)], { stdio: 'ignore' }); } catch {}
  }
}

(async () => {
  let ok = false;
  for (let i = 0; i < 90 && !ok; i++) {
    await sleep(500);
    try { const r = await fetch('http://127.0.0.1:18213/api/health'); ok = r.ok; } catch {}
  }
  console.log('health:', ok);
  if (ok) {
    const res = await fetch('http://127.0.0.1:18213/downloads/knowledge-os-sync-1.1.2.zip');
    const buf = Buffer.from(await res.arrayBuffer());
    console.log('download status:', res.status, 'bytes:', buf.length,
      'sha256:', crypto.createHash('sha256').update(buf).digest('hex'));
  }
  killAll();
})();
