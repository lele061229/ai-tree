// 本地后端管理：打包内 Python 运行时 + SQLite 数据目录 + 就绪探测。
// 设计要点：
// - 端口从 18213 起找第一个空闲口，并在本次会话内固定：localStorage 按 origin
//   （含端口）隔离，端口漂移会导致前端本地状态“重启即丢”。
// - 数据保存在 <userData>/local（%APPDATA%\AI Tree\local），不在程序目录，
//   更新/重装不会覆盖。
// - 只监听 127.0.0.1；鉴权体系在后端完整保留（见 backend/local.py）。
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const http = require('node:http');

const PREFERRED_PORT = 18213;
const READY_TIMEOUT_MS = 90000; // 首次启动含建库，留足余量

let child = null;
let currentPort = 0;
let stopped = false;

function resourcesDir() {
  // 打包后：resources/（app.asar 同级）；开发模式：仓库根（backend/ 与 dist/ 在上层）。
  const packed = path.join(process.resourcesPath || '', '');
  const candidate = path.join(packed, 'backend');
  if (fs.existsSync(path.join(candidate, 'local.py'))) return packed;
  return path.join(__dirname, '..', '..'); // 开发：desktop/../.. = 仓库根
}

function runtimePython() {
  const bundled = path.join(resourcesDir(), 'runtime', 'python.exe');
  if (fs.existsSync(bundled)) return bundled;
  return null; // 开发模式由调用方提供 KO_LOCAL_PYTHON
}

function log(...parts) {
  try { require.main && require.main.exports; } catch {}
  // main.js 注入的 logger；未注入时走 console
  (module.exports._log || console.log)('[backend]', ...parts);
}

function freePort(start) {
  return new Promise(resolve => {
    let port = start;
    const tryNext = () => {
      const srv = net.createServer();
      srv.once('error', () => { port += 1; if (port > start + 50) return resolve(0); tryNext(); });
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    };
    tryNext();
  });
}

function healthOnce(origin) {
  return new Promise(resolve => {
    const req = http.get(origin + '/api/health', { timeout: 2000 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitReady(origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = false;
  while (Date.now() < deadline) {
    if (stopped) return false;
    last = await healthOnce(origin);
    if (last) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

function dataDir() {
  const dir = path.join(app.getPath('userData'), 'local');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function start(extraEnv = {}) {
  stopped = false;
  const port = await freePort(PREFERRED_PORT);
  if (!port) throw new Error('本地端口分配失败（18213-18263 全部被占用）');
  const root = resourcesDir();
  const py = runtimePython() || process.env.KO_LOCAL_PYTHON;
  if (!py) throw new Error('找不到内置 Python 运行时（resources/runtime/python.exe）');
  const dir = dataDir();
  const env = { ...process.env, ...extraEnv, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: '1' };
  const args = ['-m', 'backend.local', 'run', '--data', dir, '--port', String(port)];
  const spawned = spawn(py, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child = spawned;
  currentPort = port;
  const origin = 'http://127.0.0.1:' + port;
  let out = '';
  spawned.stdout.on('data', d => { out += d; if (out.length > 20000) out = out.slice(-10000); });
  spawned.stderr.on('data', d => { out += d; if (out.length > 20000) out = out.slice(-10000); });
  spawned.on('exit', (code, signal) => {
    (module.exports._log || console.log)('[backend] exit', { code, signal });
    if (out.trim()) (module.exports._log || console.log)('[backend] tail', out.slice(-2000));
    if (child === spawned) child = null;
  });
  const ready = await waitReady(origin, READY_TIMEOUT_MS);
  if (!ready) {
    const err = new Error('本地服务未能在 ' + Math.round(READY_TIMEOUT_MS / 1000) + ' 秒内就绪');
    err.tail = out.slice(-2000);
    try { spawned.kill(); } catch {}
    throw err;
  }
  // 端口就绪不等于“这是我们的服务”：若端口被上一个残留后端占着，
  // 健康检查会打到别人的进程，而本进程可能已经因绑定失败退出。
  let info = null;
  try { info = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8')); } catch {}
  if (spawned.exitCode !== null || !info || info.pid !== spawned.pid) {
    const err = new Error('本地服务端口被占用或未成功接管（port ' + port + '）');
    err.tail = out.slice(-2000);
    try { spawned.kill(); } catch {}
    throw err;
  }
  return { port, origin, pid: spawned.pid, dataDir: dir };
}

function origin() {
  return currentPort ? 'http://127.0.0.1:' + currentPort : '';
}

function stop() {
  stopped = true;
  const c = child;
  child = null;
  if (!c || c.exitCode !== null) return;
  try { c.kill(); } catch {}
}

function running() {
  return !!child && child.exitCode === null;
}

module.exports = { start, stop, origin, running, dataDir, freePort, PREFERRED_PORT };
