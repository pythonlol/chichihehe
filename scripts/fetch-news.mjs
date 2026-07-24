// 抓取各 RSS 源的 AI 资讯，输出 src/data/news.json
// 用法：node scripts/fetch-news.mjs
import Parser from 'rss-parser';
import { categorize, detectCompanies } from './categorize.mjs';
import { translateEnglishItems } from './translate.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'data', 'news.json');

const FEEDS = [
  // 中文
  { name: '少数派', url: 'https://sspai.com/feed', lang: 'zh' },
  { name: '36氪', url: 'https://36kr.com/feed', lang: 'zh' },
  { name: 'InfoQ 中文', url: 'https://www.infoq.cn/feed', lang: 'zh' },
  { name: '爱范儿', url: 'https://www.ifanr.com/feed', lang: 'zh' },
  // 英文
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', lang: 'en' },
  { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed', lang: 'en' },
  { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/', lang: 'en' },
  { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', lang: 'en' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', lang: 'en' },
];

const DAYS = 7;
const MAX_ITEMS = 100;

const parser = new Parser({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  },
});

function stripHtml(html = '') {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchFeed(feed) {
  try {
    const res = await parser.parseURL(feed.url);
    return (res.items || []).map((item) => ({
      title: (item.title || '').trim(),
      link: item.link || '',
      source: feed.name,
      lang: feed.lang,
      pubDate: item.isoDate || (item.pubDate ? new Date(item.pubDate).toISOString() : null),
      summary: stripHtml(item.contentSnippet || item.content || item.summary || '').slice(0, 200),
    }));
  } catch (err) {
    console.warn(`[warn] ${feed.name} 抓取失败: ${err.message}`);
    return [];
  }
}

const results = await Promise.all(FEEDS.map(fetchFeed));
const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;

const seen = new Set();
const items = results
  .flat()
  .filter((it) => it.title && it.link && it.pubDate && !Number.isNaN(Date.parse(it.pubDate)))
  .filter((it) => Date.parse(it.pubDate) >= cutoff)
  .filter((it) => {
    if (seen.has(it.link)) return false;
    seen.add(it.link);
    return true;
  })
  .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate))
  .slice(0, MAX_ITEMS);

// —— 热度计算：热门实体打分 ——
// 统计标题关键词被多少家不同媒体提及，同一实体（公司/产品/人物）被报道得越多，
// 包含该实体的新闻热度越高；用 IDF 抑制“的、发布”这类高频泛词的干扰。
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'will', 'says', 'after', 'over', 'into', 'amid', 'what', 'how', 'why', 'its', 'are', 'was', 'has', 'have', 'new', 'news', 'you', 'your']);

function tokensOf(title) {
  const t = new Set();
  for (const w of title.toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (w.length >= 3 && !STOP.has(w)) t.add(w);
  }
  const zh = title.match(/[一-鿿]/g);
  if (zh) for (let i = 0; i < zh.length - 1; i++) t.add(zh[i] + zh[i + 1]);
  return t;
}

const toksOf = items.map((it) => tokensOf(it.title));
const srcOf = new Map(); // token -> Set(source)
const df = new Map();    // token -> 出现该 token 的新闻数
toksOf.forEach((toks, i) => {
  for (const x of toks) {
    if (!srcOf.has(x)) srcOf.set(x, new Set());
    srcOf.get(x).add(items[i].source);
    df.set(x, (df.get(x) || 0) + 1);
  }
});
const N = items.length;
items.forEach((item, i) => {
  let s = 0;
  for (const x of toksOf[i]) {
    const ns = srcOf.get(x).size;
    if (ns >= 2) s += (ns - 1) * Math.log(N / df.get(x));
  }
  item.heat = Math.round(s * 10) / 10;
  item.tags = categorize(item);
  item.companies = detectCompanies(item);
});
// 热度降序，热度相同按时间降序
items.sort((a, b) => b.heat - a.heat || Date.parse(b.pubDate) - Date.parse(a.pubDate));

// 英文资讯翻译为中文（titleZh / summaryZh），需 DASHSCOPE_API_KEY，无 key 时保留原文
await translateEnglishItems(items);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2), 'utf8');
console.log(`已写入 ${items.length} 条资讯 -> ${OUT}`);
