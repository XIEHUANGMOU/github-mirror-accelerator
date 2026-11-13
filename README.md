# GitHub Mirror Accelerator

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-5.0%2B-blue)](https://www.tampermonkey.net/)

**English** · [简体中文](https://github.com/XIEHUANGMOU/github-mirror-accelerator/blob/main/README.zh-CN.md)

A userscript that proxies GitHub download traffic through acceleration mirrors. **Your account and session stay untouched — only the transport path changes.**

## Why

Downloading release assets, cloning repos, or fetching raw files from GitHub can be painfully slow or outright broken in some regions. Mirrors fix the speed, but switching between them manually is tedious — and mirrors die all the time. You never know if the one you're using still works.

This script does three things:

1. Rewrites download links to go through mirrors
2. Continuously monitors each mirror's health and switches when one dies
3. Gives you a panel to see which mirror is actually usable

## Features

**Automatic failover** — When you click a download, the script doesn't redirect immediately. It first probes the target mirror with `Range: bytes=0-1023` to confirm it's actually reachable. If not, it moves to the next candidate. Only when all mirrors fail does it fall back to a direct connection. You'll never hit a blank page or a 404 again.

**Content validation** — Status codes alone aren't enough. Testing revealed `ghproxy.cfd` returns HTTP 200 with a 49KB HTML landing page instead of the file. So the health probe validates response body content and treats mismatches as failures.

**Health-based ranking** — Each mirror records its measured latency and success state. Healthy mirrors sort by ascending latency; failed ones sink to the bottom. Data older than one hour is considered stale and re-measured.

**Minimal debug panel** — A draggable panel in the bottom-right corner showing each mirror's status, latency, hit count, failover count, and a color-coded timestamped log stream.

**Zero session impact** — Only download-type URLs are rewritten (release assets, archive packages, raw files). Pages themselves still load directly. No cookies touched, no credentials involved.

**Private repo skip** — Detects private repositories and automatically disables proxying, since mirrors can't access your token and would inevitably 404.

**Bilingual UI** — English and Chinese, auto-detected from your browser language.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser
2. Click **[Install userscript](https://github.com/XIEHUANGMOU/github-mirror-accelerator/raw/main/src/github-mirror.user.js)** — Tampermonkey catches the `.user.js` and shows its install page
3. Confirm the install

Or drag the `.user.js` file straight into your browser window.

## Usage

Open any GitHub page and the panel appears in the bottom-right.

**Mirror list** — Click to pin a mirror, click again to unpin. "Auto (fastest)" always picks the current fastest healthy mirror.

**Probe** — Manually test all mirrors. The title-bar dot turns yellow during testing; each mirror shows measured latency or "fail".

**On/Off** — Enable or disable mirror acceleration. When off, all links go direct.

**Clone** — On a repository homepage, copies a `git clone` command prefixed with the mirror to your clipboard.

**Panel** — Drag the title bar to move it, click `—` to collapse.

### Changing the language

The UI auto-detects: browsers reporting a `zh` language get Chinese, everyone else gets English.

To force a language, open the browser console:

```javascript
__ghm.setLang('en')    // English
__ghm.setLang('zh')    // 中文
__ghm.setLang('auto')  // follow browser
__ghm.getLang()        // check current
```

## Mirrors

Four built-in mirrors, all live-tested on both raw and release paths:

| Mirror | Notes |
|---|---|
| `gh.nxnow.top` | Fastest, ~1.3s measured |
| `ghfast.top` | Stable, ~1.4s measured |
| `gh-proxy.com` | Stable, ~2.2s measured |
| `ghproxy.net` | Slow fallback, ~5.6s measured |

The script also keeps a `DEAD_MIRRORS` list documenting 12 confirmed-dead sources with their cause of death (shut down, SSL failure, 429 rate limit, returns landing page, etc.) so they don't get re-added by mistake.

**These are third-party public proxy services. They can die at any time.** That's exactly why the script does health probing and automatic switching instead of hardcoding one.

### Adding your own mirror

Edit the `MIRRORS` array at the top of `src/github-mirror.user.js`:

```javascript
const MIRRORS = [
  { host: 'https://your-mirror.com', label: 'display name', pri: 1, note: 'note' },
  // ...
];
```

Also add the domain to the UserScript header's `@connect` list, otherwise `GM_xmlhttpRequest` will be blocked.

The mirror convention is `{mirror}/{full original URL}`:

```
https://ghfast.top/https://github.com/user/repo/releases/download/v1.0/a.zip
```

## Supported URL types

| Type | Example |
|---|---|
| Release assets | `github.com/u/r/releases/download/v1/a.zip` |
| Source archives | `github.com/u/r/archive/refs/heads/main.zip` |
| Raw view | `github.com/u/r/raw/main/x.js` |
| Raw direct | `raw.githubusercontent.com/u/r/main/x.js` |
| Codeload | `codeload.github.com/u/r/zip/refs/heads/main` |
| Objects storage | `objects.githubusercontent.com/...` |
| Gist raw | `gist.githubusercontent.com/...` |

Pages themselves (repo home, issues, PRs, settings) are **not** rewritten — mirrors break GitHub's UI structure.

## Development

### Structure

```
├── src/
│   └── github-mirror.user.js   # main script, single file, no build step
├── tests/
│   ├── verify.mjs              # 65 offline logic assertions
│   ├── i18n-check.mjs          # 32 translation runtime checks
│   └── e2e-probe.mjs           # end-to-end mirror probing (needs network)
├── LICENSE                     # MIT
├── README.md
└── README.zh-CN.md
```

### Running tests

```bash
node tests/verify.mjs      # offline logic checks, no network needed
node tests/i18n-check.mjs  # translation table + rendering checks
node tests/e2e-probe.mjs   # actually hits mirrors, needs network
```

`verify.mjs` covers: script structure, mirror table integrity, 7 URL type detections, 5 negative skip cases, mirror URL composition, 4 health-ranking scenarios, UI component presence, failover logic, i18n table parity, and security boundaries.

### Key functions

`toMirror(url, host)` — Wraps an original GitHub URL into a mirror URL. Handles the `github.com/u/r/raw/ref/path` → `raw.githubusercontent.com/u/r/ref/path` conversion.

`rankedMirrors()` — Sorts mirrors by health. This is where you'd change the priority logic.

`probeOne(host)` — Single mirror health check with content validation. Returns `{host, ok, ms, reason}`.

`navigateWithFailover(url)` — Failover-aware redirect. This is the core download click path.

`quickCheck(url)` — Lightweight reachability check, first bytes only.

`t(key, vars)` — Translation lookup with `{placeholder}` substitution.

Debug interface via `window.__ghm`:

```javascript
__ghm.cfg              // current config
__ghm.mirrors          // mirror table
__ghm.dead             // dead mirror list
__ghm.probeAll()       // manual health check
__ghm.rankedMirrors()
__ghm.toMirror('https://github.com/u/r/releases/download/v1/a.zip')
__ghm.setLang('zh')    // switch language
```

### No build step

Single file, no bundler, no dependencies, no `npm install`. Edit and refresh the browser. This is deliberate — a userscript shouldn't require a toolchain.

### Adding a language

Add an entry to the `STRINGS` object and the language will be selectable via `__ghm.setLang()`:

```javascript
const STRINGS = {
  en: { /* ... */ },
  zh: { /* ... */ },
  ja: {
    panelTitle: 'GitHub ミラー',
    // ... all 36 keys
  },
};
```

Then update `detectLang()` to map the browser locale to your new key.

## License

[MIT](LICENSE)

You may:
- Use commercially
- Modify
- Distribute
- Use privately
- Sublicense

The only requirement: keep the copyright notice and license text.

**Fork it, rewrite it, build on it, ship it closed-source — no permission needed.**

## Disclaimer

This script only rewrites URL transport paths. It does not proxy, store, or forward any content. All traffic is still handled by whichever third-party mirror service you select.

Mirror availability, speed, and privacy policies are outside this project's control. Judge for yourself whether you trust a given mirror.

This script does not bypass any access control, does not modify any credentials, and does not touch any account data.
