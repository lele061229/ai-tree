// 桌面端安全判定：单一来源的可信地址比较，供主进程与测试复用。
// 原则：只做“精确 origin 相等”比较，绝不做字符串前缀匹配。
const { pathToFileURL } = require('node:url');

// 只接受 https；回环地址允许 http（开发/本机测试）。
function normalizeBase(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback) return '';
  return url.origin;
}

// target 的 origin 是否与 base 完全一致。
// 注意不要写成 target.startsWith(base)：那样会放过
// http://127.0.0.1:18080.evil.example 与 http://127.0.0.1:18080@evil.example。
function sameOrigin(target, base) {
  if (!base || typeof target !== 'string') return false;
  let url;
  try { url = new URL(target); } catch { return false; }
  return url.origin === base;
}

function filePathOf(target) {
  let url;
  try { url = new URL(target); } catch { return null; }
  if (url.protocol !== 'file:') return null;
  try { return decodeURIComponent(url.pathname).replace(/\//g, '\\').toLowerCase(); } catch { return null; }
}

// target 是否恰好是某个本地文件（允许 query/hash，例如 error.html?kind=card）。
function isExactFile(target, filePath) {
  const actual = filePathOf(target);
  if (!actual) return false;
  const expected = filePathOf(pathToFileURL(filePath).href);
  return !!expected && actual === expected;
}

module.exports = { normalizeBase, sameOrigin, isExactFile, filePathOf };
