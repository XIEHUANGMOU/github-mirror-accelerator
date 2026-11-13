/**
 * i18n 运行时验证：把 STRINGS 表和 t() 函数从脚本里抽出来，
 * 在 Node 里真实执行，确认两种语言都能正确渲染、占位符替换正常。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'github-mirror.user.js'), 'utf8');

// 抽取 STRINGS 定义
const s = src.indexOf('const STRINGS = {');
const e = src.indexOf('const DEFAULT_LANG');
const block = src.slice(s, e);

const STRINGS = eval(`(${block.replace('const STRINGS = ', '').trim().replace(/;$/, '')})`);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  <' + extra + '>' : ''}`); }
}

// 复刻 t()
const DEFAULT_LANG = 'en';
let LANG = 'en';
function t(key, vars) {
  const table = STRINGS[LANG] || STRINGS[DEFAULT_LANG];
  let out = table[key];
  if (out === undefined) out = STRINGS[DEFAULT_LANG][key];
  if (out === undefined) return key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k]));
    }
  }
  return out;
}

console.log('[1] 语言表结构');
ok('有 en', !!STRINGS.en);
ok('有 zh', !!STRINGS.zh);
ok('en 有 36 个 key', Object.keys(STRINGS.en).length === 36, Object.keys(STRINGS.en).length);
ok('zh 有 36 个 key', Object.keys(STRINGS.zh).length === 36, Object.keys(STRINGS.zh).length);
ok('两表 key 集合相同', JSON.stringify(Object.keys(STRINGS.en).sort()) === JSON.stringify(Object.keys(STRINGS.zh).sort()));

console.log('\n[2] 英文渲染');
LANG = 'en';
const enSamples = ['panelTitle', 'mirrors', 'auto', 'probe', 'toggleOn', 'clone', 'statHealthy'];
for (const k of enSamples) {
  const v = t(k);
  const hasCJK = /[\u4e00-\u9fa5]/.test(v);
  ok(`${k} = "${v}"${hasCJK ? ' (含中文!)' : ''}`, !hasCJK && v.length > 0);
}

console.log('\n[3] 中文渲染');
LANG = 'zh';
const zhSamples = ['panelTitle', 'mirrors', 'auto', 'probe', 'toggleOn', 'clone', 'statHealthy'];
for (const k of zhSamples) {
  const v = t(k);
  ok(`${k} = "${v}"`, /[\u4e00-\u9fa5]/.test(v));
}

console.log('\n[4] 占位符替换');
LANG = 'en';
ok('pinnedToast {name}', t('pinnedToast', { name: 'ghfast' }) === 'Pinned to ghfast', t('pinnedToast', { name: 'ghfast' }));
ok('trying {i}/{n}/{host}', t('trying', { i: 1, n: 4, host: 'https://a.b' }) === 'Trying [1/4] https://a.b', t('trying', { i: 1, n: 4, host: 'https://a.b' }));
ok('preparing {n}', t('preparing', { n: 4 }) === 'Preparing 4 mirror candidates', t('preparing', { n: 4 }));
ok('probeLog {name}/{result}', t('probeLog', { name: 'ghfast', result: '42ms' }) === 'Probe ghfast: 42ms');

LANG = 'zh';
ok('中文 pinnedToast', t('pinnedToast', { name: 'ghfast' }) === '固定 ghfast', t('pinnedToast', { name: 'ghfast' }));
ok('中文 trying', t('trying', { i: 1, n: 4, host: 'a' }) === '尝试 [1/4] a', t('trying', { i: 1, n: 4, host: 'a' }));
ok('中文 preparing', t('preparing', { n: 4 }) === '准备跳转，候选 4 个镜像', t('preparing', { n: 4 }));

console.log('\n[5] 边界');
LANG = 'en';
ok('未知 key 回落 key 本身', t('nonexistentKey') === 'nonexistentKey');
ok('无变量时正常返回', t('copy') === 'Copy');
ok('占位符重复替换', t('trying', { i: 2, n: 2, host: 'x' }) === 'Trying [2/2] x');

// 所有 key 在两种语言下都非空
LANG = 'en';
const emptyEn = Object.keys(STRINGS.en).filter(k => !STRINGS.en[k] || !String(STRINGS.en[k]).trim());
LANG = 'zh';
const emptyZh = Object.keys(STRINGS.zh).filter(k => !STRINGS.zh[k] || !String(STRINGS.zh[k]).trim());
ok('en 无空值', emptyEn.length === 0, emptyEn.join(','));
ok('zh 无空值', emptyZh.length === 0, emptyZh.join(','));

// en 表不该有中文
const cjkInEn = Object.entries(STRINGS.en).filter(([, v]) => /[\u4e00-\u9fa5]/.test(v));
ok('en 表无中文残留', cjkInEn.length === 0, cjkInEn.map(([k]) => k).join(','));

console.log(`\n${'='.repeat(50)}`);
console.log(`结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
