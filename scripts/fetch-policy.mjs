// 抓取北上广深四市政府 + 武汉市经信局 + 工信部官网的 AI 相关最新通知通告，输出 src/data/policy.json
// 用法：node scripts/fetch-policy.mjs
// 说明：六个来源均无 RSS，分别走 JSON 搜索接口（工信部、广东统一搜索）或静态列表页解析（北京、上海、武汉）；
//       单个来源失败不影响其他来源，最终合并去重后按时间倒序取前 MAX_ITEMS 条。
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

// —— 北京市政府：政策文件列表页为单页全量静态 HTML（近千条，日期倒序）——
async function fetchBeijing() {
  const BASE = 'https://www.beijing.gov.cn/zhengce/zhengcefagui/';
  const res = await fetchRes(BASE);
  const html = await res.text();
  const re =
    /<a href="(\.\/\d{6}\/t\d{8}_\d+\.html)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?<\/a>\s*<span>(\d{4}-\d{2}-\d{2})<\/span>/g;
  const items = [];
  let m;
  while ((m = re.exec(html))) {
    const title = clean(m[2]);
    if (!AI_RE.test(title)) continue;
    items.push({
      title,
      link: new URL(m[1], BASE).href,
      source: '北京市政府',
      pubDate: dateOnlyToIso(m[3]),
      summary: '',
    });
  }
  return items;
}

// —— 上海市政府：近期信息公开静态列表页（条目少，AI 命中经常为 0，属正常）——
async function fetchShanghai() {
  const res = await fetchRes('https://www.shanghai.gov.cn/nw12344/index.html');
  const html = await res.text();
  // 每条出现两次（带/不带日期 span），按 href 去重；日期从 URL 路径提取
  const re = /<a href="(\/nw12344\/(\d{4})(\d{2})(\d{2})\/[0-9a-z]+\.html)"[^>]*title="([^"]+)"/g;
  const seen = new Set();
  const items = [];
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const title = clean(m[5]);
    if (!AI_RE.test(title)) continue;
    items.push({
      title,
      link: `https://www.shanghai.gov.cn${m[1]}`,
      source: '上海市政府',
      pubDate: dateOnlyToIso(`${m[2]}-${m[3]}-${m[4]}`),
      summary: '',
    });
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

// —— 广东统一搜索接口（广州 site_id=200001，深圳 site_id=755001）——
// 两步：先 GET 搜索页拿 cookie + CSRF token，再 form-urlencoded POST 查询（JSON body 会被静默忽略）
async function fetchGd(siteId, sourceName) {
  const items = [];
  for (const q of ['人工智能', '智能体']) {
    try {
      const page = await fetchRes(
        `https://search.gd.gov.cn/search/all/${siteId}?keywords=${encodeURIComponent(q)}`
      );
      const cookies = (page.headers.getSetCookie?.() || [])
        .map((c) => c.split(';')[0])
        .join('; ');
      const html = await page.text();
      const token = html.match(/var _CSRF = '([^']+)'/)?.[1];
      if (!token) {
        console.warn(`[warn] ${sourceName} 未获取到 CSRF token，跳过关键词「${q}」`);
        continue;
      }
      const res = await fetchRes('https://search.gd.gov.cn/api/search/all', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-TOKEN': token,
          Referer: `https://search.gd.gov.cn/search/all/${siteId}`,
          ...(cookies ? { Cookie: cookies } : {}),
        },
        body: new URLSearchParams({ keywords: q, site_id: siteId, page: '1', sort: 'time' }),
      });
      const json = JSON.parse(await res.text());
      const news = json?.data?.news;
      // total 异常大（百万级）说明关键词被静默忽略、返回的是全站结果，视为失败
      if (!news || Number(news.total) > 100000) {
        console.warn(`[warn] ${sourceName} 关键词「${q}」返回异常（total=${news?.total}），跳过`);
        continue;
      }
      for (const r of news.list || []) {
        const title = clean(r.title);
        if (!title || !r.url || !r.pub_time || !AI_RE.test(title)) continue;
        items.push({
          title,
          link: r.url,
          source: sourceName,
          pubDate: dateOnlyToIso(r.pub_time),
          summary: clean(r.content || r.abstract || '').slice(0, 200),
        });
      }
    } catch (err) {
      console.warn(`[warn] ${sourceName} 关键词「${q}」抓取失败: ${err.message}`);
    }
  }
  return items;
}

const SOURCES = [
  ['工业和信息化部', fetchMiit],
  ['北京市政府', fetchBeijing],
  ['上海市政府', fetchShanghai],
  ['武汉市经信局', fetchWuhan],
  ['广州市政府', () => fetchGd('200001', '广州市政府')],
  ['深圳市政府', () => fetchGd('755001', '深圳市政府')],
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
