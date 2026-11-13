# GitHub 国内镜像加速

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-5.0%2B-blue)](https://www.tampermonkey.net/)

一个用于 GitHub 的油猴脚本：通过国内加速镜像代理下载流量，**账号和登录态完全不变，只换传输通道**。

[English](README.md)

## 为什么需要它

在国内直连 GitHub 下载 release 包、`git clone`、拉 raw 文件，经常几 KB/s 甚至直接超时。镜像站能解决速度问题，但手工切换很麻烦，而且镜像站本身经常挂掉——你永远不知道当前这个还能不能用。

这个脚本做三件事：

1. 自动改写下载链接到镜像站
2. 持续监测每个镜像的健康度，挂了自动换下一个
3. 给你一个面板，随时看到底哪个能用

## 特性

**自动故障转移** —— 点下载时不直接跳转，而是先用 `Range: bytes=0-1023` 探测目标镜像是否真的可达，可达才跳。不可达就换下一个，全部失败才回落直连。你不会再落到白屏或 404 页。

**内容校验** —— 只看状态码不够。实测发现 `ghproxy.cfd` 会返回 200 和一个 49KB 的 HTML 落地页而不是文件，所以探活函数强制校验响应体内容，不匹配判失败。

**健康度排序** —— 每个镜像记录实测延迟和成功状态。健康的按延迟升序排前面，失败的沉底，超过 1 小时的数据视为过期自动重测。

**简约调试面板** —— 右下角可拖动面板，实时显示每个镜像的状态、延迟、命中次数、故障切换次数，以及带时间戳的彩色日志流。

**登录态零影响** —— 只改写下载类 URL（release 资产、archive 包、raw 文件），页面本身仍走直连。不碰 Cookie，不碰凭据。

**私有仓库跳过** —— 检测到当前是私有仓库时自动不代理，因为镜像站拿不到你的 token，代理必然 404。

**中英双语界面** —— 自动跟随浏览器语言。

## 安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)（篡改猴）
2. 打开 [src/github-mirror.user.js](src/github-mirror.user.js)，点「Raw」
3. 篡改猴会弹出安装页，点「安装」

或者：把 `.user.js` 文件直接拖进浏览器窗口。

## 使用

装好后打开任意 GitHub 页面，右下角出现面板。

**镜像列表** —— 点一下固定使用该镜像，再点取消。「自动选优」始终选择当前最快的健康镜像。

**探活** —— 手动触发所有镜像检测。检测过程中标题栏圆点变黄，每个镜像右侧显示实测延迟或「失败」。

**开关** —— 一键启停镜像加速。关闭后所有链接走原始直连。

**克隆** —— 在仓库首页点击，复制带镜像前缀的 `git clone` 命令到剪贴板。

**面板** —— 拖动标题栏移动位置，点 `—` 折叠成一条。

### 切换语言

界面自动跟随浏览器语言：`zh` 开头的浏览器显示中文，其余显示英文。

想强制指定，打开浏览器控制台：

```javascript
__ghm.setLang('en')    // 英文
__ghm.setLang('zh')    // 中文
__ghm.setLang('auto')  // 跟随浏览器
__ghm.getLang()        // 查看当前
```

## 镜像源

当前内置 4 个，全部经过实测验证（raw 与 release 双路径）：

| 镜像 | 特点 |
|---|---|
| `gh.nxnow.top` | 最快，实测 ~1.3s |
| `ghfast.top` | 稳定，实测 ~1.4s |
| `gh-proxy.com` | 稳定，实测 ~2.2s |
| `ghproxy.net` | 慢速备胎，实测 ~5.6s |

脚本内还记录了一份 `DEAD_MIRRORS` 清单，包含 12 个已确认不可用的源及其死亡原因（停服、SSL 失败、429 限流、返回落地页等），避免以后被误加回来。

**这些是第三方公共代理服务，随时可能挂掉。** 这也是为什么脚本要做成探活 + 自动切换，而不是写死一个。

### 添加自己的镜像

编辑 `src/github-mirror.user.js` 开头的 `MIRRORS` 数组：

```javascript
const MIRRORS = [
  { host: 'https://你的镜像.com', label: '显示名', pri: 1, note: '备注' },
  // ...
];
```

同时记得在 UserScript 头的 `@connect` 里加上域名，否则 `GM_xmlhttpRequest` 会被拦截。

镜站的约定是 `{镜像域名}/{完整原始URL}`，例如：

```
https://ghfast.top/https://github.com/user/repo/releases/download/v1.0/a.zip
```

## 支持改写的链接类型

| 类型 | 例子 |
|---|---|
| Release 资产 | `github.com/u/r/releases/download/v1/a.zip` |
| 源码包 | `github.com/u/r/archive/refs/heads/main.zip` |
| Raw 视图 | `github.com/u/r/raw/main/x.js` |
| Raw 直链 | `raw.githubusercontent.com/u/r/main/x.js` |
| Codeload | `codeload.github.com/u/r/zip/refs/heads/main` |
| Objects 存储 | `objects.githubusercontent.com/...` |
| Gist 原始内容 | `gist.githubusercontent.com/...` |

页面本身（仓库首页、issue、PR、设置页）**不改写**，因为镜像站会把 GitHub 的界面结构打碎。

## 二次开发

### 项目结构

```
├── src/
│   └── github-mirror.user.js   # 主脚本，单文件无构建
├── tests/
│   ├── verify.mjs              # 65 项离线逻辑断言
│   ├── i18n-check.mjs          # 32 项翻译运行时检查
│   └── e2e-probe.mjs           # 端到端镜像探活，需网络
├── LICENSE                     # MIT
├── README.md                   # 英文
└── README.zh-CN.md             # 中文
```

### 运行测试

```bash
node tests/verify.mjs      # 离线逻辑验证，不需要网络
node tests/i18n-check.mjs  # 翻译表与渲染检查
node tests/e2e-probe.mjs   # 实际请求镜像站，需要网络
```

### 关键函数

`toMirror(url, host)` —— 把原始 GitHub URL 包成镜像 URL。处理 `github.com/u/r/raw/ref/path` 到 `raw.githubusercontent.com/u/r/ref/path` 的转换。

`rankedMirrors()` —— 按健康度排序镜像。自己实现优先级逻辑时主要改这里。

`probeOne(host)` —— 单个镜像探活。带内容校验，返回 `{host, ok, ms, reason}`。

`navigateWithFailover(url)` —— 带故障转移的跳转。这是下载点击的核心路径。

`quickCheck(url)` —— 轻量可达性检查，只取首字节。

`t(key, vars)` —— 翻译查表，支持 `{占位符}` 替换。

浏览器控制台里可以通过 `window.__ghm` 访问内部状态：

```javascript
__ghm.cfg           // 当前配置
__ghm.mirrors       // 镜像表
__ghm.dead          // 死源清单
__ghm.probeAll()    // 手动探活
__ghm.rankedMirrors()
__ghm.toMirror('https://github.com/u/r/releases/download/v1/a.zip')
__ghm.setLang('zh') // 切换语言
```

### 无构建

脚本是单文件，没有打包步骤，没有依赖，没有 npm install。改完直接刷新浏览器就生效。这是刻意的——一个用户脚本不该需要工具链。

### 添加新语言

在 `STRINGS` 对象里加一个条目，就能通过 `__ghm.setLang()` 选中：

```javascript
const STRINGS = {
  en: { /* ... */ },
  zh: { /* ... */ },
  ja: {
    panelTitle: 'GitHub ミラー',
    // ... 全部 36 个 key
  },
};
```

然后更新 `detectLang()`，把浏览器 locale 映射到新 key。

## 许可证

[MIT](LICENSE)

允许：
- 商业使用
- 修改
- 分发
- 私人使用
- 再许可

唯一要求：保留版权声明和许可证文本。

**你可以自由 fork、改写、二次开发、闭源发布，不需要征得同意。**

## 免责声明

本脚本仅改写 URL 传输路径，不代理、不存储、不转发任何内容。所有流量仍由你选择的第三方镜像服务处理。

镜像站的可用性、速度、隐私政策均不受本项目控制。使用前请自行判断是否信任该镜像。

本脚本不绕过任何访问控制，不改动任何凭据，不接触任何账号数据。
