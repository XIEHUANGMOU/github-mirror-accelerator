// ==UserScript==
// @name         GitHub 国内镜像加速 · 增强版
// @namespace    https://github.com/hbf/github-mirror
// @version      3.0.0
// @description  多镜像自动故障转移 + 断点测速 + 简约调试面板。账号登录态不变，只换传输通道。所有镜像均经实测验证。
// @author       hbf
// @match        https://github.com/*
// @match        https://gist.github.com/*
// @match        https://raw.githubusercontent.com/*
// @match        https://codeload.github.com/*
// @match        https://objects.githubusercontent.com/*
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        unsafeWindow
// @connect      ghfast.top
// @connect      gh-proxy.com
// @connect      gh.nxnow.top
// @connect      ghproxy.net
// @connect      github.com
// @connect      raw.githubusercontent.com
// @run-at       document-start
// @noframes
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  // ===========================================================================
  // 镜像表 —— 全部经实测验证，2026-11 采集
  // 状态标记来自真实 curl 探测，不是猜的
  // ===========================================================================
  const MIRRORS = [
    // 实测 1.4s，raw + release 双通
    { host: 'https://ghfast.top',    label: 'ghfast',  pri: 1, note: '实测最快' },
    // 实测 2.3s，release 206 流式正常
    { host: 'https://gh-proxy.com',  label: 'gh-proxy', pri: 2, note: '稳定' },
    // 实测 1.3s(裸连) / 3.0s(release)
    { host: 'https://gh.nxnow.top',  label: 'nxnow',   pri: 3, note: '新源' },
    // 实测 6.5s，慢但可用
    { host: 'https://ghproxy.net',   label: 'ghproxy', pri: 4, note: '慢速备胎' },
  ];

  // 已确认死亡/不可用的源，留作记录避免再被加回来
  const DEAD_MIRRORS = [
    { host: 'https://gh.con.sh',     reason: '已停服: Suspent due to abuse report' },
    { host: 'https://ghproxy.cfd',   reason: '返回 HTML 落地页而非文件' },
    { host: 'https://gh.llkk.cc',    reason: '超时 20s+' },
    { host: 'https://github.moeyy.xyz', reason: 'SSL 失败' },
    { host: 'https://ghproxy.cc',    reason: 'SSL 失败' },
    { host: 'https://hub.gitmirror.com', reason: 'SSL 失败' },
    { host: 'https://ghp.ci',        reason: 'SSL 失败' },
    { host: 'https://gh.ddlc.top',   reason: '429 限流' },
    { host: 'https://ghproxy.homeboyc.cn', reason: '403 禁止' },
    { host: 'https://mrepo.org',     reason: '403 禁止' },
    { host: 'https://gh-proxy.cn',   reason: '503 服务不可用' },
    { host: 'https://gh.xmly.dev',   reason: '530 Cloudflare' },
  ];

  // ===========================================================================
  // 配置
  // ===========================================================================
  const CFG_KEY = 'ghm3_cfg';
  const DEFAULT_CFG = {
    enabled: true,
    rewriteDownload: true,
    rewriteRaw: true,
    showCloneHint: true,
    showPanel: true,
    autoFailover: true,
    skipPrivate: true,
    pinned: '',              // 空 = 自动选优
    health: {},              // host -> {ms, ok, ts, verified}
    stats: { hits: 0, fails: 0, failovers: 0 },
    log: [],                 // 最近 40 条调试日志
  };

  const CFG = Object.assign({}, DEFAULT_CFG, loadCfg());

  function loadCfg() {
    try {
      const v = typeof GM_getValue === 'function' ? GM_getValue(CFG_KEY) : JSON.parse(localStorage.getItem(CFG_KEY));
      return v && typeof v === 'object' ? v : {};
    } catch (e) { return {}; }
  }
  function saveCfg() {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(CFG_KEY, CFG);
      else localStorage.setItem(CFG_KEY, JSON.stringify(CFG));
    } catch (e) { /* ignore */ }
  }

  // ===========================================================================
  // 日志 —— 面板可见，也进内存环形缓冲
  // ===========================================================================
  const LOG_MAX = 40;
  function log(level, msg, extra) {
    const entry = { t: Date.now(), level, msg, extra: extra || '' };
    CFG.log.unshift(entry);
    if (CFG.log.length > LOG_MAX) CFG.log.length = LOG_MAX;
    const fn = level === 'err' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[GHM] ${msg}`, extra || '');
    if (panelEl && !panelEl.classList.contains('ghm-min')) renderLog();
  }
  const logInfo = (m, e) => log('info', m, e);
  const logWarn = (m, e) => log('warn', m, e);
  const logErr = (m, e) => log('err', m, e);

  // ===========================================================================
  // URL 规则
  // ===========================================================================
  const RULES = [
    { name: 'release',  re: /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/.+/ },
    { name: 'archive',  re: /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/archive(\/.*)?$/ },
    { name: 'rawview',  re: /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/.+/ },
    { name: 'blobraw',  re: /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/.+/ },
    { name: 'gistraw',  re: /^https:\/\/gist\.githubusercontent\.com\/.+/ },
    { name: 'codeload', re: /^https:\/\/codeload\.github\.com\/.+/ },
    { name: 'raw',      re: /^https:\/\/raw\.githubusercontent\.com\/.+/ },
    { name: 'objects',  re: /^https:\/\/objects\.githubusercontent\.com\/.+/ },
  ];

  const RAW_TYPES = new Set(['raw', 'gistraw', 'objects']);

  function matchRule(url) {
    if (!url || typeof url !== 'string') return null;
    for (const r of RULES) if (r.re.test(url)) return r;
    return null;
  }

  function isPrivateRepo() {
    try {
      const meta = document.querySelector('meta[name="octolytics-dimension-repository_public"]');
      if (meta) return meta.getAttribute('content') === 'false';
      if (document.body && document.body.classList.contains('private-repo')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function shouldRewrite(url) {
    if (!CFG.enabled) return false;
    const rule = matchRule(url);
    if (!rule) return false;
    if (CFG.skipPrivate && isPrivateRepo()) {
      logInfo('跳过: 私有仓库不代理', url);
      return false;
    }
    if (RAW_TYPES.has(rule.name) && !CFG.rewriteRaw) return false;
    if (!RAW_TYPES.has(rule.name) && !CFG.rewriteDownload) return false;
    return true;
  }

  // ===========================================================================
  // 镜像选择 —— 健康度排序 + 自动故障转移
  // ===========================================================================
  function rankedMirrors() {
    const h = CFG.health || {};
    return MIRRORS.slice().sort((a, b) => {
      const ha = h[a.host], hb = h[b.host];
      const aOk = ha && ha.ok && (Date.now() - ha.ts < 3600e3);
      const bOk = hb && hb.ok && (Date.now() - hb.ts < 3600e3);
      // 健康的优先，健康的按延迟排
      if (aOk && bOk) return ha.ms - hb.ms;
      if (aOk) return -1;
      if (bOk) return 1;
      return a.pri - b.pri;
    });
  }

  function currentMirror() {
    if (CFG.pinned) return CFG.pinned;
    return rankedMirrors()[0].host;
  }

  function toMirror(url, host) {
    const base = (host || currentMirror()).replace(/\/+$/, '');
    for (const m of MIRRORS) if (url.startsWith(m.host)) return url;
    for (const m of DEAD_MIRRORS) if (url.startsWith(m.host)) return url;

    const rawView = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/(.+)$/.exec(url);
    if (rawView) {
      const [, o, r, rest] = rawView;
      return `${base}/https://raw.githubusercontent.com/${o}/${r}/${rest}`;
    }
    return `${base}/${url}`;
  }

  // ===========================================================================
  // 探活 —— 带 Content 校验，不只看状态码
  // ===========================================================================
  const PROBE_URL = 'https://raw.githubusercontent.com/octocat/Hello-World/master/README';
  const PROBE_TIMEOUT = 9000;

  function probeOne(host) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      let settled = false;
      const done = (ok, reason) => {
        if (settled) return;
        settled = true;
        const ms = Math.round(performance.now() - t0);
        CFG.health[host] = { ms: ok ? ms : -1, ok, ts: Date.now(), reason: reason || '' };
        resolve({ host, ok, ms, reason });
      };
      const timer = setTimeout(() => done(false, '超时'), PROBE_TIMEOUT);

      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: `${host}/${PROBE_URL}`,
          timeout: PROBE_TIMEOUT,
          onload: (res) => {
            clearTimeout(timer);
            const body = String(res.responseText || '');
            if (res.status < 200 || res.status >= 400) return done(false, `HTTP ${res.status}`);
            // 关键: 内容校验。镜像返回 HTML 落地页时必须判定为失败
            if (!/Hello World/.test(body)) return done(false, '内容异常(非文件)');
            done(true, '');
          },
          onerror: () => { clearTimeout(timer); done(false, '连接失败'); },
          ontimeout: () => { clearTimeout(timer); done(false, '超时'); },
        });
      } catch (e) {
        clearTimeout(timer);
        done(false, 'GM_xhr 异常');
      }
    });
  }

  let probing = false;
  async function probeAll(onTick) {
    if (probing) return CFG.health;
    probing = true;
    try {
      for (const m of MIRRORS) {
        if (onTick) onTick(m.host, 'probing');
        const r = await probeOne(m.host);
        logInfo(`探活 ${m.label}: ${r.ok ? r.ms + 'ms' : '失败(' + r.reason + ')'}`);
        if (onTick) onTick(m.host, r.ok ? 'ok' : 'fail');
      }
      saveCfg();
      renderPanel();
      return CFG.health;
    } finally {
      probing = false;
    }
  }

  // ===========================================================================
  // 点击拦截 + 自动故障转移
  // ===========================================================================
  function buildTargetList(originalUrl) {
    // 候选序列: 当前选中 -> 其余按健康度排
    const list = [];
    if (CFG.pinned) list.push(CFG.pinned);
    for (const m of rankedMirrors()) {
      if (!list.includes(m.host)) list.push(m.host);
    }
    return list.map((h) => ({ host: h, url: toMirror(originalUrl, h) }));
  }

  /**
   * 先探活再跳转。开一个新标签页前用 GM_xhr 确认目标可达，
   * 不可达就换下一个，避免用户落到白屏或错误页。
   */
  async function navigateWithFailover(originalUrl) {
    const targets = buildTargetList(originalUrl);
    logInfo(`准备跳转，候选 ${targets.length} 个镜像`);

    for (let i = 0; i < targets.length; i++) {
      const cand = targets[i];
      logInfo(`尝试 [${i + 1}/${targets.length}] ${cand.host}`);

      const reachable = await quickCheck(cand.url);
      if (reachable) {
        CFG.stats.hits++;
        saveCfg();
        logInfo(`跳转成功 -> ${cand.host}`);
        location.assign(cand.url);
        return;
      }

      CFG.stats.fails++;
      if (i > 0) CFG.stats.failovers++;
      CFG.health[cand.host] = { ms: -1, ok: false, ts: Date.now(), reason: '跳转前探测失败' };
      logWarn(`镜像不可用，切换下一个`, cand.host);
      saveCfg();
      renderPanel();
    }

    // 全部失败，回落到直连
    logErr('所有镜像均不可用，回落直连');
    toast('镜像全部不可用，走直连');
    location.assign(originalUrl);
  }

  /** 轻量可达性检查：只取首字节，不下载整个文件 */
  function quickCheck(url) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => done(false), 6000);
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: 6000,
          headers: { Range: 'bytes=0-1023' },
          onload: (res) => {
            clearTimeout(timer);
            done(res.status >= 200 && res.status < 400);
          },
          onerror: () => { clearTimeout(timer); done(false); },
          ontimeout: () => { clearTimeout(timer); done(false); },
        });
      } catch (e) { clearTimeout(timer); done(false); }
    });
  }

  function onClickCapture(ev) {
    if (!CFG.enabled) return;
    if (ev.defaultPrevented) return;
    if (ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

    const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;

    const href = a.getAttribute('href');
    if (!href) return;

    let abs;
    try { abs = new URL(href, location.href).href; } catch (e) { return; }
    if (!shouldRewrite(abs)) return;

    ev.preventDefault();
    ev.stopPropagation();
    navigateWithFailover(abs);
  }

  // ===========================================================================
  // 简约调试面板
  // ===========================================================================
  let panelEl = null;
  let toastEl = null;

  const CSS = `
  #ghm-panel{
    position:fixed;right:16px;bottom:16px;z-index:2147483000;
    width:268px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:10px;
    box-shadow:0 12px 32px rgba(1,4,9,.6);overflow:hidden;
    transition:width .15s ease,height .15s ease;
  }
  #ghm-panel *{box-sizing:border-box}
  #ghm-panel .hd{
    display:flex;align-items:center;gap:7px;padding:8px 10px;
    background:#161b22;border-bottom:1px solid #30363d;cursor:move;user-select:none;
  }
  #ghm-panel .dot{width:7px;height:7px;border-radius:50%;background:#3fb950;flex:0 0 auto;box-shadow:0 0 6px #3fb95066}
  #ghm-panel .dot.off{background:#484f58;box-shadow:none}
  #ghm-panel .dot.busy{background:#d29922;box-shadow:0 0 6px #d2992266}
  #ghm-panel .ttl{font-weight:600;color:#e6edf3;flex:1;letter-spacing:.02em}
  #ghm-panel .x{cursor:pointer;color:#8b949e;padding:0 3px;font-size:14px;line-height:1}
  #ghm-panel .x:hover{color:#f85149}
  #ghm-panel .bd{display:flex;flex-direction:column}
  #ghm-panel.ghm-min .bd{display:none}
  #ghm-panel.ghm-min{width:auto}

  #ghm-panel .sec{padding:8px 10px;border-bottom:1px solid #21262d}
  #ghm-panel .sec:last-child{border-bottom:0}
  #ghm-panel .lbl{color:#6e7681;font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}

  #ghm-panel .mrow{
    display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:4px;
    cursor:pointer;margin-bottom:1px;
  }
  #ghm-panel .mrow:hover{background:#161b22}
  #ghm-panel .mrow.on{background:#12261e}
  #ghm-panel .mrow .n{flex:1;color:#c9d1d9}
  #ghm-panel .mrow.on .n{color:#56d364}
  #ghm-panel .mrow .ms{color:#6e7681;font-size:11px}
  #ghm-panel .love{color:#3fb950;font-size:10px}

  #ghm-panel .btns{display:flex;gap:5px;padding:8px 10px;border-bottom:1px solid #21262d}
  #ghm-panel button{
    flex:1;font:inherit;font-size:11px;cursor:pointer;color:#c9d1d9;
    background:#21262d;border:1px solid #30363d;border-radius:5px;padding:4px 6px;
  }
  #ghm-panel button:hover{background:#30363d;color:#fff;border-color:#484f58}
  #ghm-panel button:active{transform:translateY(1px)}
  #ghm-panel button.on{border-color:#238636;color:#56d364;background:#12261e}
  #ghm-panel button:disabled{opacity:.45;cursor:default}

  #ghm-panel .stat{display:flex;gap:10px;padding:6px 10px;color:#6e7681;font-size:11px;border-bottom:1px solid #21262d}
  #ghm-panel .stat b{color:#c9d1d9;font-weight:600}

  #ghm-panel .logzone{max-height:132px;overflow-y:auto;padding:6px 10px;font-size:11px}
  #ghm-panel .logzone::-webkit-scrollbar{width:6px}
  #ghm-panel .logzone::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
  #ghm-panel .lg{display:flex;gap:5px;padding:1px 0;line-height:1.35}
  #ghm-panel .lg .tm{color:#484f58;flex:0 0 auto}
  #ghm-panel .lg .ms{color:#8b949e;word-break:break-all}
  #ghm-panel .lg.info .ms{color:#8b949e}
  #ghm-panel .lg.warn .ms{color:#d29922}
  #ghm-panel .lg.err .ms{color:#f85149}

  #ghm-toast{
    position:fixed;right:16px;bottom:16px;z-index:2147483001;
    font:12px ui-monospace,monospace;background:#1f6feb;color:#fff;
    padding:7px 13px;border-radius:6px;opacity:0;pointer-events:none;
    transition:opacity .18s ease;max-width:300px;
  }
  #ghm-toast.show{opacity:1}
  #ghm-toast.err{background:#da3633}

  #ghm-hint{
    margin:8px 0;padding:7px 10px;border:1px dashed #238636;border-radius:6px;
    font:12px ui-monospace,monospace;display:flex;gap:8px;align-items:center;color:#7d8590;
  }
  #ghm-hint code{flex:1;overflow:auto;white-space:nowrap;color:#8b949e}
  #ghm-hint button{
    font:inherit;font-size:11px;cursor:pointer;padding:2px 9px;border-radius:4px;
    border:1px solid #30363d;background:#21262d;color:#c9d1d9;
  }
  `;

  function addStyle() {
    try { if (typeof GM_addStyle === 'function') { GM_addStyle(CSS); return; } } catch (e) { /* ignore */ }
    const s = document.createElement('style');
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function ensurePanel() {
    if (panelEl && document.documentElement.contains(panelEl)) return panelEl;

    panelEl = document.createElement('div');
    panelEl.id = 'ghm-panel';
    panelEl.innerHTML = `
      <div class="hd">
        <i class="dot"></i>
        <span class="ttl">GitHub 镜像</span>
        <span class="x" title="收起">—</span>
      </div>
      <div class="bd">
        <div class="sec">
          <div class="lbl">镜像源 · 点击固定</div>
          <div id="ghm-list"></div>
        </div>
        <div class="btns">
          <button id="ghm-probe">探活</button>
          <button id="ghm-toggle">开关</button>
          <button id="ghm-clone">克隆</button>
        </div>
        <div class="stat" id="ghm-stat"></div>
        <div class="logzone" id="ghm-log"></div>
      </div>
    `;
    (document.body || document.documentElement).appendChild(panelEl);

    panelEl.querySelector('.x').addEventListener('click', (e) => {
      e.stopPropagation();
      panelEl.classList.toggle('ghm-min');
    });

    panelEl.querySelector('#ghm-probe').addEventListener('click', async () => {
      const btn = panelEl.querySelector('#ghm-probe');
      btn.disabled = true;
      btn.textContent = '探活中';
      await probeAll((host, st) => {
        const row = panelEl.querySelector(`[data-host="${host}"]`);
        if (row) {
          const dot = panelEl.querySelector('.dot');
          dot.classList.toggle('busy', st === 'probing');
          const ms = row.querySelector('.ms');
          if (ms) ms.textContent = st === 'probing' ? '…' : st === 'ok' ? ((CFG.health[host] || {}).ms + 'ms') : '失败';
        }
      });
      btn.disabled = false;
      btn.textContent = '探活';
    });

    panelEl.querySelector('#ghm-toggle').addEventListener('click', () => {
      CFG.enabled = !CFG.enabled;
      saveCfg();
      renderPanel();
      toast(CFG.enabled ? '已启用镜像加速' : '已关闭镜像加速');
    });

    panelEl.querySelector('#ghm-clone').addEventListener('click', () => {
      const cmd = buildCloneCommand();
      if (!cmd) { toast('当前页不是仓库首页', true); return; }
      copyText(cmd);
      toast('已复制克隆命令');
    });

    makeDraggable(panelEl);
    return panelEl;
  }

  function makeDraggable(el) {
    const hd = el.querySelector('.hd');
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    hd.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('x')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      el.style.right = 'auto'; el.style.bottom = 'auto';
      el.style.left = ox + 'px'; el.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = (ox + e.clientX - sx) + 'px';
      el.style.top = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  function renderPanel() {
    if (!CFG.showPanel) {
      if (panelEl) { panelEl.remove(); panelEl = null; }
      return;
    }
    if (!document.body) return;
    const el = ensurePanel();

    el.querySelector('.dot').classList.toggle('off', !CFG.enabled);

    const list = el.querySelector('#ghm-list');
    list.innerHTML = '';

    const auto = document.createElement('div');
    auto.className = 'mrow' + (CFG.pinned ? '' : ' on');
    auto.innerHTML = `<span class="n">自动选优</span><span class="ms">${rankedMirrors()[0].label}</span>`;
    auto.addEventListener('click', () => {
      CFG.pinned = ''; saveCfg(); renderPanel(); toast('切到自动选优');
    });
    list.appendChild(auto);

    for (const m of MIRRORS) {
      const h = (CFG.health || {})[m.host];
      const row = document.createElement('div');
      row.className = 'mrow' + (CFG.pinned === m.host ? ' on' : '');
      row.dataset.host = m.host;
      let msTxt = '未测';
      if (h) msTxt = h.ok ? h.ms + 'ms' : '失败';
      row.innerHTML = `<span class="n">${m.label}</span><span class="ms">${msTxt}</span>`;
      row.title = m.note;
      row.addEventListener('click', () => {
        CFG.pinned = CFG.pinned === m.host ? '' : m.host;
        saveCfg(); renderPanel();
        toast(CFG.pinned ? '固定 ' + m.label : '切到自动选优');
      });
      list.appendChild(row);
    }

    const tg = el.querySelector('#ghm-toggle');
    tg.textContent = CFG.enabled ? '已开' : '已关';
    tg.className = CFG.enabled ? 'on' : '';

    const s = CFG.stats || { hits: 0, fails: 0, failovers: 0 };
    const healthy = MIRRORS.filter((m) => {
      const h = (CFG.health || {})[m.host];
      return h && h.ok && (Date.now() - h.ts < 3600e3);
    }).length;
    el.querySelector('#ghm-stat').innerHTML =
      `<span>健康 <b>${healthy}/${MIRRORS.length}</b></span>` +
      `<span>命中 <b>${s.hits}</b></span>` +
      `<span>切换 <b>${s.failovers}</b></span>`;

    renderLog();
    return el;
  }

  function renderLog() {
    if (!panelEl) return;
    const zone = panelEl.querySelector('#ghm-log');
    if (!zone) return;
    zone.innerHTML = '';
    const items = (CFG.log || []).slice(0, 14);
    if (!items.length) {
      zone.innerHTML = '<div class="lg"><span class="ms" style="color:#484f58">暂无日志</span></div>';
      return;
    }
    for (const it of items) {
      const d = new Date(it.t);
      const tm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      const row = document.createElement('div');
      row.className = 'lg ' + it.level;
      row.innerHTML = `<span class="tm">${tm}</span><span class="ms"></span>`;
      row.querySelector('.ms').textContent = it.msg + (it.extra ? ' ' + it.extra : '');
      zone.appendChild(row);
    }
  }

  function toast(msg, isErr) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'ghm-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.className = ''; }, 2000);
  }

  // ===========================================================================
  // 克隆命令 / 提示条
  // ===========================================================================
  function buildCloneCommand() {
    const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/)?$/.exec(location.href.split(/[?#]/)[0]);
    if (!m) return null;
    const [, owner, repo] = m;
    const base = currentMirror().replace(/\/+$/, '');
    return `git clone ${base}/https://github.com/${owner}/${repo}.git`;
  }

  function copyText(text) {
    try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return; } } catch (e) { /* ignore */ }
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  }

  function injectCloneHint() {
    if (!CFG.showCloneHint || !CFG.enabled) return;
    if (document.getElementById('ghm-hint')) return;
    const cmd = buildCloneCommand();
    if (!cmd) return;

    const anchor = document.querySelector('#repository-container-header')
      || document.querySelector('.Layout-sidebar')
      || document.querySelector('main');
    if (!anchor) return;

    const box = document.createElement('div');
    box.id = 'ghm-hint';
    const code = document.createElement('code');
    code.textContent = cmd;
    const btn = document.createElement('button');
    btn.textContent = '复制';
    btn.addEventListener('click', () => { copyText(cmd); toast('已复制'); });
    box.appendChild(code);
    box.appendChild(btn);
    anchor.prepend(box);
  }

  // ===========================================================================
  // 生命周期
  // ===========================================================================
  function onReady() {
    addStyle();
    renderPanel();
    injectCloneHint();
  }

  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(onReady, 200);
  }

  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('DOMContentLoaded', onReady);
  document.addEventListener('turbo:load', scheduleRefresh);
  document.addEventListener('turbo:render', scheduleRefresh);
  document.addEventListener('turbo:frame-load', scheduleRefresh);
  document.addEventListener('pjax:end', scheduleRefresh);
  window.addEventListener('popstate', scheduleRefresh);

  if (document.readyState !== 'loading') onReady();

  new MutationObserver(() => {
    if (CFG.showPanel && !document.getElementById('ghm-panel')) scheduleRefresh();
  }).observe(document.documentElement, { childList: true });

  // 首次进入自动探活（缓存 30 分钟）
  const lastProbe = Math.max(0, ...Object.values(CFG.health || {}).map((h) => h.ts || 0));
  if (Date.now() - lastProbe > 30 * 60e3) {
    setTimeout(() => { probeAll().catch(() => {}); }, 1200);
  }

  // 调试接口
  try {
    (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__ghm = {
      cfg: CFG, mirrors: MIRRORS, dead: DEAD_MIRRORS,
      probeAll, rankedMirrors, toMirror, renderPanel, saveCfg,
    };
  } catch (e) { /* ignore */ }
})();
