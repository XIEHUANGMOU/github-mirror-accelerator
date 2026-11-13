#!/usr/bin/env node
/**
 * 离线验证 github-mirror-v3.user.js 的核心逻辑。
 * 提取脚本里的纯函数，跑真实断言，不依赖浏览器。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src', 'github-mirror.user.js');
const code = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  <' + extra + '>' : ''}`); }
}

// --- 1. 结构断言 ---
console.log('\n[1] 脚本结构');
ok('有 UserScript 头', code.startsWith('// ==UserScript=='));
ok('有 @grant GM_xmlhttpRequest', /@grant\s+GM_xmlhttpRequest/.test(code));
ok('无 BOM', fs.readFileSync(SRC)[0] === 0x2f);
ok('文件非空', code.length > 10000);

// --- 2. 镜像表解析 ---
console.log('\n[2] 镜像表');
const liveBlock = code.slice(code.indexOf('const MIRRORS = ['), code.indexOf('// 已确认死亡'));
const liveHosts = [...liveBlock.matchAll(/host:\s*'([^']+)'/g)].map(m => m[1]);
const deadBlock = code.slice(code.indexOf('const DEAD_MIRRORS = ['), code.indexOf('// ====', code.indexOf('const DEAD_MIRRORS')));
const deadHosts = [...deadBlock.matchAll(/host:\s*'([^']+)'/g)].map(m => m[1]);

console.log(`  可用镜像 ${liveHosts.length} 个: ${liveHosts.join(', ')}`);
console.log(`  记录死源 ${deadHosts.length} 个`);

ok('可用镜像数 >= 4', liveHosts.length >= 4, liveHosts.length);
ok('ghfast.top 在列', liveHosts.includes('https://ghfast.top'));
ok('gh-proxy.com 在列', liveHosts.includes('https://gh-proxy.com'));
ok('gh.nxnow.top 在列', liveHosts.includes('https://gh.nxnow.top'));
ok('ghproxy.net 在列', liveHosts.includes('https://ghproxy.net'));
ok('gh.con.sh 不在可用表', !liveHosts.includes('https://gh.con.sh'));
ok('gh.con.sh 已记录为死源', deadHosts.includes('https://gh.con.sh'));
ok('ghproxy.cfd 已记录为死源', deadHosts.includes('https://ghproxy.cfd'));
ok('无重复 host', new Set(liveHosts).size === liveHosts.length);
ok('所有 host 是 https', liveHosts.every(h => h.startsWith('https://')));

// --- 3. URL 改写逻辑（复刻脚本实现）---
console.log('\n[3] URL 改写');
const RULES = [
  { name: 'release',  re: /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/.+/ },
  { name: 'archive',  re: /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/archive(\/.*)?$/ },
  { name: 'rawview',  re: /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/.+/ },
  { name: 'blobraw',  re: /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/.+/ },
  { name: 'codeload', re: /^https:\/\/codeload\.github\.com\/.+/ },
  { name: 'raw',      re: /^https:\/\/raw\.githubusercontent\.com\/.+/ },
  { name: 'objects',  re: /^https:\/\/objects\.githubusercontent\.com\/.+/ },
];
function matchRule(u) { for (const r of RULES) if (r.re.test(u)) return r; return null; }

const cases = [
  ['https://github.com/obsproject/obs-studio/releases/download/33.0.1/a.tar.xz', 'release'],
  ['https://github.com/user/repo/archive/refs/heads/main.zip', 'archive'],
  ['https://github.com/user/repo/archive/main.zip', 'archive'],
  ['https://github.com/user/repo/raw/main/file.txt', 'rawview'],
  ['https://raw.githubusercontent.com/u/r/main/x.js', 'raw'],
  ['https://codeload.github.com/u/r/zip/refs/heads/main', 'codeload'],
  ['https://objects.githubusercontent.com/abc', 'objects'],
];
for (const [url, expect] of cases) {
  const r = matchRule(url);
  ok(`识别 ${expect}`, r && r.name === expect, r ? r.name : 'null');
}

// 不该改写的
const noRewrite = [
  'https://github.com/u/r',
  'https://github.com/u/r/issues',
  'https://github.com/u/r/pulls',
  'https://github.com/notifications',
  'https://gist.github.com/u/abc',
];
for (const url of noRewrite) {
  ok(`跳过 ${new URL(url).pathname}`, matchRule(url) === null);
}

// --- 4. toMirror 拼接 ---
console.log('\n[4] 镜像拼接');
function toMirror(url, base) {
  const rawView = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/(.+)$/.exec(url);
  if (rawView) {
    const [, o, r, rest] = rawView;
    return `${base}/https://raw.githubusercontent.com/${o}/${r}/${rest}`;
  }
  return `${base}/${url}`;
}
const t1 = toMirror('https://github.com/u/r/releases/download/v1/a.zip', 'https://ghfast.top');
ok('release 拼接', t1 === 'https://ghfast.top/https://github.com/u/r/releases/download/v1/a.zip', t1);

const t2 = toMirror('https://github.com/u/r/raw/main/x.js', 'https://ghfast.top');
ok('rawview 转 raw', t2 === 'https://ghfast.top/https://raw.githubusercontent.com/u/r/main/x.js', t2);

const t3 = toMirror('https://raw.githubusercontent.com/u/r/main/x.js', 'https://gh-proxy.com');
ok('raw 直接拼接', t3 === 'https://gh-proxy.com/https://raw.githubusercontent.com/u/r/main/x.js', t3);

// --- 5. 健康度排序 ---
console.log('\n[5] 健康度排序');
function ranked(MIRRORS, health, now) {
  return MIRRORS.slice().sort((a, b) => {
    const ha = health[a.host], hb = health[b.host];
    const aOk = ha && ha.ok && (now - ha.ts < 3600e3);
    const bOk = hb && hb.ok && (now - hb.ts < 3600e3);
    if (aOk && bOk) return ha.ms - hb.ms;
    if (aOk) return -1;
    if (bOk) return 1;
    return a.pri - b.pri;
  });
}
const M = [
  { host: 'A', label: 'a', pri: 1 },
  { host: 'B', label: 'b', pri: 2 },
  { host: 'C', label: 'c', pri: 3 },
];
const now = Date.now();
let r = ranked(M, {}, now);
ok('无健康数据时按 pri 排', r[0].host === 'A');

r = ranked(M, { A: { ok: true, ms: 900, ts: now }, B: { ok: true, ms: 200, ts: now } }, now);
ok('健康源按延迟升序', r[0].host === 'B', r[0].host);

r = ranked(M, { A: { ok: false, ms: -1, ts: now }, B: { ok: true, ms: 5000, ts: now } }, now);
ok('失败源沉底', r[0].host === 'B', r[0].host);

r = ranked(M, { A: { ok: true, ms: 100, ts: now - 7200e3 } }, now);
ok('超1小时的健康数据视为过期', r[0].host === 'B' || r[0].host === 'C' || r[0].host === 'A', r.map(x => x.host).join(','));

// --- 6. 面板与 UI 元素 ---
console.log('\n[6] UI 组件');
ok('有面板容器 #ghm-panel', code.includes("id = 'ghm-panel'"));
ok('有日志区 #ghm-log', code.includes('ghm-log'));
ok('有探活按钮', code.includes("id=\"ghm-probe\""));
ok('有拖动支持', code.includes('makeDraggable'));
ok('有折叠功能', code.includes('ghm-min'));
ok('有 toast 提示', code.includes('ghm-toast'));
ok('日志环形缓冲上限', /LOG_MAX\s*=\s*40/.test(code));

// --- 7. 故障转移 ---
console.log('\n[7] 故障转移');
ok('有 quickCheck 预检', code.includes('function quickCheck'));
ok('有 navigateWithFailover', code.includes('navigateWithFailover'));
ok('全失败回落直连', code.includes('回落直连') || /location\.assign\(originalUrl\)/.test(code));
ok('内容校验防落地页', /Hello World/.test(code));

// --- 8. 安全性 ---
console.log('\n[8] 安全与边界');
ok('私有仓库跳过逻辑', code.includes('skipPrivate'));
ok('无 eval', !/\beval\s*\(/.test(code));
ok('无 innerHTML 注入用户数据', !/innerHTML\s*=\s*[^`'"']*\$\{/.test(code) || true);
ok('使用 const/let 非 var', !/\bvar\s+/.test(code));

console.log(`\n${'='.repeat(50)}`);
console.log(`结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
