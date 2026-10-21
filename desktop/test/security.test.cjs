// 可信地址判定的单元测试（node --test）。
// 重点：同前缀恶意域名、不同端口、协议降级、file:// 与非主 frame 不能被放行。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { normalizeBase, sameOrigin, isExactFile } = require('../security');

const BASE = 'https://120.25.151.128';
const LOOP = 'http://127.0.0.1:18080';

test('normalizeBase：只接受 https（回环可 http），并归一到 origin', () => {
  assert.equal(normalizeBase('https://120.25.151.128'), BASE);
  assert.equal(normalizeBase('https://120.25.151.128/'), BASE);
  assert.equal(normalizeBase('120.25.151.128'), BASE);
  assert.equal(normalizeBase('https://120.25.151.128/path?a=1#x'), BASE);
  assert.equal(normalizeBase(LOOP), LOOP);
  assert.equal(normalizeBase('http://example.com'), ''); // 非回环禁止明文
  assert.equal(normalizeBase('javascript:alert(1)'), '');
  assert.equal(normalizeBase('   '), '');
});

test('sameOrigin：只认精确 origin', () => {
  assert.equal(sameOrigin(BASE + '/', BASE), true);
  assert.equal(sameOrigin(BASE + '/card.html?x=1#y', BASE), true);
  assert.equal(sameOrigin('https://120.25.151.128:443/', BASE), true); // 默认端口等价
  assert.equal(sameOrigin(LOOP + '/card.html', LOOP), true);
});

test('sameOrigin：同前缀恶意域名不得放行', () => {
  const evil = [
    'https://120.25.151.128.evil.example/',
    'https://120.25.151.128.evil.example/card.html',
    'http://127.0.0.1:18080.evil.example/card.html',
    'http://127.0.0.1:18080@evil.example/card.html', // userinfo 混淆
    'http://127.0.0.1:18080%2eevil.example/',
  ];
  for (const url of evil) {
    assert.equal(sameOrigin(url, BASE) || sameOrigin(url, LOOP), false, url);
  }
});

test('sameOrigin：不同端口 / 协议 / 子路径穿越都按 origin 判定', () => {
  assert.equal(sameOrigin('http://127.0.0.1:18081/card.html', LOOP), false);
  assert.equal(sameOrigin('https://127.0.0.1:18080/card.html', LOOP), false); // 协议不同
  assert.equal(sameOrigin('http://127.0.0.1:18080/../admin', LOOP), true); // 同 origin，路径无关
  assert.equal(sameOrigin('file:///C:/Windows/System32/drivers/etc/hosts', LOOP), false);
  assert.equal(sameOrigin('data:text/html,<h1>x</h1>', LOOP), false);
  assert.equal(sameOrigin('javascript:alert(1)', LOOP), false);
  assert.equal(sameOrigin('', LOOP), false);
  assert.equal(sameOrigin(null, LOOP), false);
});

test('isExactFile：只认指定的本地文件（允许 query/hash）', () => {
  const errorPage = path.join(__dirname, '..', 'error.html');
  const settingsPage = path.join(__dirname, '..', 'settings.html');
  const errorUrl = 'file:///' + errorPage.replace(/\\/g, '/') + '?kind=card&code=-102';
  assert.equal(isExactFile(errorUrl, errorPage), true);
  assert.equal(isExactFile(errorUrl, settingsPage), false);
  assert.equal(isExactFile('file:///' + settingsPage.replace(/\\/g, '/'), settingsPage), true);
  assert.equal(isExactFile('file:///C:/Windows/win.ini', errorPage), false);
  assert.equal(isExactFile(errorUrl.replace('error.html', 'error.html.bak'), errorPage), false);
  assert.equal(isExactFile(BASE + '/error.html', errorPage), false);
});
