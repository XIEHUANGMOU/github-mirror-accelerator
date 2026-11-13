/**
 * 端到端验证：用脚本里完全相同的探活逻辑（含内容校验）
 * 实际请求 4 个镜像，确认它们当前真的可用。
 */
const PROBE_URL = 'https://raw.githubusercontent.com/octocat/Hello-World/master/README';
const TIMEOUT = 9000;

const MIRRORS = [
  { host: 'https://ghfast.top',    label: 'ghfast' },
  { host: 'https://gh-proxy.com',  label: 'gh-proxy' },
  { host: 'https://gh.nxnow.top',  label: 'nxnow' },
  { host: 'https://ghproxy.net',   label: 'ghproxy' },
];

async function probeOne(host) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const res = await fetch(`${host}/${PROBE_URL}`, { signal: ac.signal, redirect: 'follow' });
    clearTimeout(timer);
    const body = await res.text();
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { host, ok: false, ms, reason: `HTTP ${res.status}` };
    if (!/Hello World/.test(body)) return { host, ok: false, ms, reason: '内容异常' };
    return { host, ok: true, ms, reason: '' };
  } catch (e) {
    clearTimeout(timer);
    return { host, ok: false, ms: Math.round(performance.now() - t0), reason: e.name === 'AbortError' ? '超时' : '连接失败' };
  }
}

console.log('端到端探活（脚本同款逻辑 + 内容校验）\n');
const results = [];
for (const m of MIRRORS) {
  const r = await probeOne(m.host);
  results.push(r);
  const tag = r.ok ? 'OK  ' : 'FAIL';
  console.log(`  ${tag}  ${m.label.padEnd(10)} ${String(r.ms).padStart(5)}ms  ${r.reason}`);
}

const healthy = results.filter(r => r.ok);
console.log(`\n健康 ${healthy.length}/${MIRRORS.length}`);

// 验证排序结果
const sorted = healthy.sort((a, b) => a.ms - b.ms);
if (sorted.length) {
  console.log(`最快: ${sorted[0].host} (${sorted[0].ms}ms)`);
}

// 验证 release 路径也能走
console.log('\nrelease 资产路径验证（Range 首 64KB）:');
const rel = 'https://github.com/obsproject/obs-studio/releases/download/33.0.1/OBS-Studio-33.0.1-macOS-Apple-dSYMs.tar.xz';
for (const r of healthy) {
  const t0 = performance.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    const res = await fetch(`${r.host}/${rel}`, {
      signal: ac.signal,
      headers: { Range: 'bytes=0-65535' },
      redirect: 'follow',
    });
    clearTimeout(timer);
    const buf = await res.arrayBuffer();
    const ms = Math.round(performance.now() - t0);
    const okStream = res.status === 206 && buf.byteLength > 1000;
    console.log(`  ${okStream ? 'OK  ' : 'FAIL'}  ${new URL(r.host).host.padEnd(20)} HTTP=${res.status} ${buf.byteLength}B ${ms}ms`);
  } catch (e) {
    console.log(`  FAIL  ${new URL(r.host).host.padEnd(20)} ${e.name}`);
  }
}

process.exit(healthy.length >= 3 ? 0 : 1);
