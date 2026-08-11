// 抓取工信部 + 北上广深汉五市经信局/工信局（委）官网的 AI 相关最新通知通告，输出 src/data/policy.json
// 用法：node scripts/fetch-policy.mjs
// 说明：六个来源均无 RSS，工信部走站内搜索 JSON 接口，其余五局均为静态列表页解析；
//       单个来源失败不影响其他来源，最终合并去重后按时间倒序取前 MAX_ITEMS 条。
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'data', 'policy.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_ITEMS = 5;
// AI 主题过滤：命中标题即算相关
const AI_RE = /人工智能|智能体|大模型|算力|机器人|具身|\bAI\b/i;
// 搜索类接口使用的查询词
const SEARCH_KWS = ['人工智能', '智能体', '大模型'];

async function fetchRes(url, opts = {}, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, {
        ...opts,
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
};

// 去 HTML 标签 + 解码常见实体（搜索接口的 title 含 <em> 高亮和 &ldquo; 等）
function clean(text = '') {
  return String(text)
    // 内联高亮标签直接抹掉，避免中文被切成「具身 智 能」这种碎片
    .replace(/<\/?(em|strong|b|span|font)\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function dateOnlyToIso(s) {
  return new Date(`${String(s).slice(0, 10)}T00:00:00+08:00`).toISOString();
}

// 深圳市工信局官网的 TLS 协商会让 undici(fetch) 报 bad ecpoint（疑似国密/非常规曲线），
// 改用 https 模块并限定 P-256 曲线 + RSA 密钥交换绕过；带一次重试
async function fetchTextSz(url, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const req = https.get(
          url,
          {
            headers: { 'User-Agent': UA },
            ecdhCurve: 'prime256v1',
            ciphers: 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:RSA+AES128:RSA+AES256',
            timeout: 20000,
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          }
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// —— 工业和信息化部：站内搜索 JSON 接口（按相关度排序，客户端再按时间排序去重）——
async function fetchMiit() {
  const items = [];
  for (const q of SEARCH_KWS) {
    const url =
      `https://www.miit.gov.cn/search-front-server/api/search/info` +
      `?websiteid=110000000000000&q=${encodeURIComponent(q)}&pg=15&p=1&tpl=14&category=51`;
    const res = await fetchRes(url);
    const json = JSON.parse(await res.text());
    for (const r of json?.data?.searchResult?.dataResults || []) {
      const d = r?.data || {};
      const title = clean(d.title);
      if (!title || !d.url || !d.cdate || !AI_RE.test(title)) continue;
      items.push({
        title,
        link: new URL(d.url, 'https://www.miit.gov.cn').href,
        source: '工业和信息化部',
        pubDate: new Date(Number(d.cdate)).toISOString(),
        summary: '',
      });
    }
  }
  return items;
}

// —— 北京市经信局：政策文件栏目静态列表（AI 密度高；通知公告栏目多为专精特新/小巨人，不抓）——
async function fetchBeijing() {
  const BASE = 'https://jxj.beijing.gov.cn/zwgk/2024zcwj/';
  const items = [];
  for (const page of ['', 'index_1.html', 'index_2.html']) {
    try {
      const res = await fetchRes(new URL(page, BASE).href);
      const html = await res.text();
      // 注意：日期 span 内（含方括号前后）有大量空白，正则要容忍
      const re =
        /<li><a href="(\.\/\d{6}\/t\d{8}_\d+\.html)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?<\/a>\s*<span class="date">\s*\[\s*(\d{4}-\d{2}-\d{2})\s*\]\s*<\/span><\/li>/g;
      let m;
      while ((m = re.exec(html))) {
        const title = clean(m[2]);
        if (!AI_RE.test(title)) continue;
        items.push({
          title,
          link: new URL(m[1], BASE).href,
          source: '北京市经信局',
          pubDate: dateOnlyToIso(m[3]),
          summary: '',
        });
      }
    } catch (err) {
      console.warn(`[warn] 北京市经信局 列表页 ${page || 'index.html'} 抓取失败: ${err.message}`);
    }
  }
  return items;
}

// —— 上海市经信委：公示公告静态列表（每页 10 条，分页从 index_2.html 开始；列表自带摘要）——
async function fetchShanghai() {
  const BASE = 'https://sheitc.sh.gov.cn/gg/';
  const items = [];
  for (const page of ['index.html', 'index_2.html', 'index_3.html', 'index_4.html', 'index_5.html']) {
    try {
      const res = await fetchRes(new URL(page, BASE).href);
      const html = await res.text();
      const re =
        /<a href="(\/gg\/\d{8}\/[0-9a-f]+\.html)" title="([^"]+)">([\s\S]*?)<span>(\d{4}-\d{2}-\d{2})<\/span>/g;
      let m;
      while ((m = re.exec(html))) {
        const title = clean(m[2]);
        if (!title || !AI_RE.test(title)) continue;
        // 块内 <p> 是正文开头，直接当摘要
        const summary = clean(m[3].match(/<p>([\s\S]*?)<\/p>/)?.[1] || '').slice(0, 200);
        items.push({
          title,
          link: `https://sheitc.sh.gov.cn${m[1]}`,
          source: '上海市经信委',
          pubDate: dateOnlyToIso(m[4]),
          summary,
        });
      }
    } catch (err) {
      console.warn(`[warn] 上海市经信委 列表页 ${page} 抓取失败: ${err.message}`);
    }
  }
  return items;
}

// —— 武汉市经济和信息化局：通知通告静态列表页（每页 15 条，index_1/index_2.html 翻页，404 到底）——
async function fetchWuhan() {
  const BASE = 'https://jxj.wuhan.gov.cn/xwzx_9/tztg/';
  const items = [];
  for (const page of ['', 'index_1.html', 'index_2.html']) {
    try {
      const res = await fetchRes(new URL(page, BASE).href);
      const html = await res.text();
      // 列表项结构：<a class="art_item" href='...'> 内含 art_day / art_month / art_list_ttl(title 属性是完整标题)
      const blockRe = /<a class="art_item" href='([^']+)'[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = blockRe.exec(html))) {
        const block = m[2];
        const day = block.match(/art_day[^>]*>(\d+)/)?.[1];
        const month = block.match(/art_month[^>]*>([\d-]+)/)?.[1];
        const title = clean(block.match(/art_list_ttl[^>]*title='([^']+)'/)?.[1] || '');
        if (!title || !day || !month || !AI_RE.test(title)) continue;
        items.push({
          title,
          link: new URL(m[1], BASE).href,
          source: '武汉市经信局',
          // 以显示日期为准（href 里的 t20260807 只是文章 ID，可能差一两天）
          pubDate: dateOnlyToIso(`${month}-${day}`),
          summary: '',
        });
      }
    } catch (err) {
      console.warn(`[warn] 武汉市经信局 列表页 ${page || 'index.html'} 抓取失败: ${err.message}`);
    }
  }
  return items;
}

// —— 广州市工信局：通知公告静态列表（标题在链接文本里，链接已是绝对地址；分页从 index_2 开始）——
async function fetchGuangzhou() {
  const BASE = 'https://gxj.gz.gov.cn/yw/tzgg/';
  const items = [];
  for (const page of ['index.html', 'index_2.html', 'index_3.html']) {
    try {
      const res = await fetchRes(new URL(page, BASE).href);
      const html = await res.text();
      const re =
        /<a href="(https:\/\/gxj\.gz\.gov\.cn\/yw\/tzgg\/content\/post_\d+\.html)"[^>]*>([^<]{4,80})<\/a>\s*<span class="pubDate">(\d{4}-\d{2}-\d{2})<\/span>/g;
      let m;
      while ((m = re.exec(html))) {
        const title = clean(m[2]);
        if (!title || !AI_RE.test(title)) continue;
        items.push({
          title,
          link: m[1],
          source: '广州市工信局',
          pubDate: dateOnlyToIso(m[3]),
          summary: '',
        });
      }
    } catch (err) {
      console.warn(`[warn] 广州市工信局 列表页 ${page} 抓取失败: ${err.message}`);
    }
  }
  return items;
}

// —— 深圳市工信局：通知公告静态列表（服务端渲染，无市政府站的 JS 渲染坑；分页从 index_2 开始）——
async function fetchShenzhen() {
  const BASE = 'https://gxj.sz.gov.cn/xxgk/xxgkml/qt/tzgg/';
  const items = [];
  for (const page of ['', 'index_2.html', 'index_3.html']) {
    try {
      // 该站 TLS 与 undici 不兼容，走专用通道
      const html = await fetchTextSz(new URL(page, BASE).href);
      // 链接文本带 <em> 序号，标题取 title 属性
      const re =
        /<div class="ListconC">\s*<span>(\d{4}-\d{2}-\d{2})<\/span><a href="(https:\/\/gxj\.sz\.gov\.cn\/[^"]*post_\d+\.html)"[^>]*title="([^"]+)"/g;
      let m;
      while ((m = re.exec(html))) {
        const title = clean(m[3]);
        if (!title || !AI_RE.test(title)) continue;
        items.push({
          title,
          link: m[2],
          source: '深圳市工信局',
          pubDate: dateOnlyToIso(m[1]),
          summary: '',
        });
      }
    } catch (err) {
      console.warn(`[warn] 深圳市工信局 列表页 ${page || 'index.html'} 抓取失败: ${err.message}`);
    }
  }
  return items;
}

const SOURCES = [
  ['工业和信息化部', fetchMiit],
  ['北京市经信局', fetchBeijing],
  ['上海市经信委', fetchShanghai],
  ['广州市工信局', fetchGuangzhou],
  ['深圳市工信局', fetchShenzhen],
  ['武汉市经信局', fetchWuhan],
];

const results = await Promise.all(
  SOURCES.map(async ([name, fn]) => {
    try {
      const list = await fn();
      console.log(`${name}: 命中 ${list.length} 条`);
      return list;
    } catch (err) {
      console.warn(`[warn] ${name} 抓取失败: ${err.message}`);
      return [];
    }
  })
);

const seen = new Set();
const items = results
  .flat()
  .filter((it) => {
    // 同一链接或同一标题只保留一条（搜索接口多关键词会重复命中，
    // 高亮位置不同会导致标题略有差异，故标题比较前去掉空白）
    const titleKey = it.title.replace(/\s+/g, '');
    if (seen.has(it.link) || seen.has(titleKey)) return false;
    seen.add(it.link);
    seen.add(titleKey);
    return true;
  })
  .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate))
  .slice(0, MAX_ITEMS);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2), 'utf8');
console.log(`已写入 ${items.length} 条政策通知 -> ${OUT}`);
