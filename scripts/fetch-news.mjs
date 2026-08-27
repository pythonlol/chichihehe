// 抓取各 RSS 源的 AI 资讯，输出 src/data/news.json
// 三层白名单源：核心源（全采）/ 可信媒体（AI 关键词筛选）/ 聚合源（不采）
// 跨源去重：同一事件按关键词指纹聚类，只保留最权威/最早的一条
// 用法：node scripts/fetch-news.mjs
import Parser from 'rss-parser';
import { categorize, detectCompanies, isAIRelated } from './categorize.mjs';
import { llmClassify } from './llm-classify.mjs';
import { translateEnglishItems } from './translate.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'data', 'news.json');

// —— 三层白名单源 ——
// core：官方博客 / 学术源，内容天然 AI 相关，全量采集
// trusted：可信媒体，经 AI 关键词筛选后采集
// 聚合 / 自媒体不采（标题党、洗稿重灾区，仅作线索）
const SOURCES = {
  core: [
    { name: 'OpenAI Blog', url: 'https://openai.com/blog/rss.xml', lang: 'en' },
    { name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', lang: 'en' },
    { name: 'arXiv cs.AI', url: 'https://rss.arxiv.org/rss/cs.AI', lang: 'en' },
    { name: 'arXiv cs.CL', url: 'https://rss.arxiv.org/rss/cs.CL', lang: 'en' },
    { name: 'arXiv cs.LG', url: 'https://rss.arxiv.org/rss/cs.LG', lang: 'en' },
    { name: 'NVIDIA AI Blog', url: 'https://blogs.nvidia.com/blog/category/deep-learning/feed/', lang: 'en' },
  ],
  trusted: [
    { name: '量子位', url: 'https://www.qbitai.com/feed', lang: 'zh' },
    { name: 'InfoQ 中文', url: 'https://www.infoq.cn/feed', lang: 'zh' },
    { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', lang: 'en' },
    { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed', lang: 'en' },
    { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/', lang: 'en' },
    { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', lang: 'en' },
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', lang: 'en' },
    { name: 'Wired', url: 'https://www.wired.com/feed/tag/ai/latest/rss', lang: 'en' },
  ],
};

const DAYS = 7;
const MAX_ITEMS = 100;
const MAX_PER_SOURCE = 15; // 单源上限，防止单一源（如 arXiv）挤占名额
const DEDUP_THRESHOLD = 0.35; // Jaccard 相似度阈值，≥此值视为同事件

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

// —— 摘要清洗：去掉来源标注、推广语、点击引导等残渣 ——
function cleanSummary(text = '') {
  return text
    .replace(/图片来源[：:][^\n。；;]*/g, '')
    .replace(/图源[：:][^\n。；;]*/g, '')
    .replace(/#?欢迎关注[^。]*。/g, '')
    .replace(/更多精彩内容[^。]*。/g, '')
    .replace(/点击查看(原文|全文|更多)[。]?/g, '')
    .replace(/扫码关注[^。]*。?/g, '')
    .replace(/长按[^。]*二维码[^。]*。?/g, '')
    .replace(/查看全文/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// —— 垃圾内容过滤：培训/营销/课程推广 ——
const SPAM_KEYWORDS = [
  '人才培养项目', '训练营', '报名', '课程报名', '免费试听',
  '限时优惠', '立即抢购', '名额有限', 'early bird',
];

function isSpam(item) {
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  return SPAM_KEYWORDS.some((k) => text.includes(k));
}

// —— 赞助内容过滤 ——
const SPONSORED_KEYWORDS = [
  'sponsored', 'sponsored:', 'sponsored by', 'sponsor post',
  'presented by', 'branded content', '推广', '赞助内容', '广告内容',
];

function isSponsored(item) {
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  return SPONSORED_KEYWORDS.some((k) => text.includes(k));
}

// —— 占位摘要检测：需抓全文重新生成 ——
function isPlaceholderSummary(summary = '') {
  const t = summary.trim();
  if (t.length === 0) return true;
  if (t.length < 15) return true;
  if (/^点击?(查看)?(原文|全文|更多)$/.test(t)) return true;
  if (/^\.{3,}$/.test(t)) return true;
  return false;
}

// —— 抓取全文重新生成摘要 ——
const FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchArticleSummary(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': FETCH_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '');
    const paras = cleaned.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
    const text = paras
      .map((p) => stripHtml(p))
      .filter((t) => t.length > 15)
      .join(' ');
    return cleanSummary(text).slice(0, 200) || null;
  } catch {
    return null;
  }
}

// 批量修复占位摘要（限并发，限总数）
async function fixPlaceholderSummaries(items, max = 15, concurrency = 5) {
  const needFix = items.filter((it) => isPlaceholderSummary(it.summary));
  if (needFix.length === 0) return;
  const toFetch = needFix.slice(0, max);
  console.log(`检测到 ${needFix.length} 条占位摘要，抓取 ${toFetch.length} 条全文...`);
  for (let i = 0; i < toFetch.length; i += concurrency) {
    const batch = toFetch.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async (item) => {
        const summary = await fetchArticleSummary(item.link);
        if (summary) item.summary = summary;
      }),
    );
  }
}

async function fetchFeed(feed, tier) {
  try {
    const res = await parser.parseURL(feed.url);
    return (res.items || []).map((item) => ({
      title: (item.title || '').trim(),
      link: item.link || '',
      source: feed.name,
      lang: feed.lang,
      tier,
      pubDate: item.isoDate || (item.pubDate ? new Date(item.pubDate).toISOString() : null),
      summary: cleanSummary(stripHtml(item.contentSnippet || item.content || item.summary || '')).slice(0, 200),
    }));
  } catch (err) {
    console.warn(`[warn] ${feed.name} 抓取失败: ${err.message}`);
    return [];
  }
}

// —— 采集 ——
const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;

// 核心源：全量采集
const coreResults = await Promise.all(SOURCES.core.map((f) => fetchFeed(f, 'core')));
// 可信媒体：AI 关键词筛选
const trustedResults = await Promise.all(SOURCES.trusted.map((f) => fetchFeed(f, 'trusted')));

// —— 合并 + 基础过滤 ——
const seenUrls = new Set();
const allItems = [...coreResults.flat(), ...trustedResults.flat()]
  .filter((it) => it.title && it.link && it.pubDate && !Number.isNaN(Date.parse(it.pubDate)))
  .filter((it) => Date.parse(it.pubDate) >= cutoff)
  // 垃圾内容过滤（培训/营销推广）
  .filter((it) => !isSpam(it))
  // 赞助内容过滤
  .filter((it) => !isSponsored(it))
  // URL 去重
  .filter((it) => {
    if (seenUrls.has(it.link)) return false;
    seenUrls.add(it.link);
    return true;
  });

// —— 占位摘要修复：抓全文重新生成（限并发，限总数）——
await fixPlaceholderSummaries(allItems);

// —— 可信媒体 AI 相关性筛选（在摘要修复后，确保有真实文本可判）——
const filteredItems = allItems.filter((it) => it.tier === 'core' || isAIRelated(it));

// —— LLM 精筛：可信媒体条目过 qwen-turbo 做结构化分析 ——
// 核心源天然 AI 相关且摘要质量高，跳过以节省 token
const llmItems = filteredItems.filter((it) => it.tier === 'trusted');
const llmKey = process.env.DASHSCOPE_API_KEY;
const llmResults = await llmClassify(llmItems, llmKey);
if (llmResults) {
  let dropped = 0;
  llmItems.forEach((item, i) => {
    const r = llmResults[i];
    if (!r) return; // 单条解析失败，保留原数据走关键词分类
    if (r.is_ai_related === false || r.is_promo === true) {
      item._llmDrop = true;
      dropped++;
      return;
    }
    if (r.category) item.tags = [r.category];
    if (r.summary) item.summary = r.summary;
    if (r.score) item.llmScore = r.score;
  });
  console.log(`LLM 精筛：${llmItems.length} 条 → 丢弃 ${dropped} 条`);
} else {
  console.log('LLM 精筛跳过（无 API key 或调用失败），回退关键词方案');
}

// —— 单源上限：每源最多 MAX_PER_SOURCE 条（按时间降序）——
const bySource = new Map();
for (const it of filteredItems) {
  if (it._llmDrop) continue;
  if (!bySource.has(it.source)) bySource.set(it.source, []);
  bySource.get(it.source).push(it);
}
const cappedItems = [];
for (const [, items] of bySource) {
  items.sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
  cappedItems.push(...items.slice(0, MAX_PER_SOURCE));
}

// —— 跨源去重：关键词指纹聚类 ——
// 提取公司名 + 标题/摘要关键词组成指纹，Jaccard 相似度 ≥ 阈值视为同事件
// 聚类内保留最权威（core > trusted）且最早的一条
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'will', 'says',
  'after', 'over', 'into', 'amid', 'what', 'how', 'why', 'its', 'are',
  'was', 'has', 'have', 'new', 'news', 'you', 'your', 'a', 'an', 'to',
  'of', 'in', 'on', 'at', 'by', 'is', 'it', 'as', 'or', 'be', 'not',
  'but', 'can', 'may', 'do', 'if', 'we', 'he', 'she', 'they',
]);

function fingerprintTokens(item) {
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  const tokens = new Set();
  // 英文词
  for (const w of text.match(/[a-z0-9]+/g) || []) {
    if (w.length >= 3 && !STOP.has(w)) tokens.add(w);
  }
  // 中文二元组
  const zh = text.match(/[一-鿿]/g);
  if (zh) {
    for (let i = 0; i < zh.length - 1; i++) {
      tokens.add(zh[i] + zh[i + 1]);
    }
  }
  // 公司名（最稳定的实体标识）
  for (const c of item.companies || []) {
    tokens.add(c.toLowerCase());
  }
  return tokens;
}

function jaccard(a, b) {
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter++;
  }
  return inter / (a.size + b.size - inter);
}

// 预计算公司和指纹
cappedItems.forEach((it) => {
  it.companies = detectCompanies(it);
});
const fingerprints = cappedItems.map(fingerprintTokens);

// 贪心聚类
const assigned = new Set();
const deduped = [];
for (let i = 0; i < cappedItems.length; i++) {
  if (assigned.has(i)) continue;
  const cluster = [i];
  assigned.add(i);
  for (let j = i + 1; j < cappedItems.length; j++) {
    if (assigned.has(j)) continue;
    if (jaccard(fingerprints[i], fingerprints[j]) >= DEDUP_THRESHOLD) {
      cluster.push(j);
      assigned.add(j);
    }
  }
  if (cluster.length === 1) {
    deduped.push(cappedItems[i]);
    continue;
  }
  // 选最优：core 优先，其次最早发布
  const ranked = cluster.map((idx) => ({
    item: cappedItems[idx],
    tierRank: cappedItems[idx].tier === 'core' ? 0 : 1,
    pubTime: Date.parse(cappedItems[idx].pubDate),
  }));
  ranked.sort((a, b) => a.tierRank - b.tierRank || a.pubTime - b.pubTime);
  deduped.push(ranked[0].item);
}

const items = deduped
  .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate))
  .slice(0, MAX_ITEMS);

// —— 热度计算：热门实体打分 ——
// 统计标题关键词被多少家不同媒体提及，同一实体（公司/产品/人物）被报道得越多，
// 包含该实体的新闻热度越高；用 IDF 抑制"的、发布"这类高频泛词的干扰。
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
  if (!item.tags) item.tags = categorize(item);
  // companies 已在去重阶段计算，无需重复
});
// 热度降序，热度相同按时间降序
items.sort((a, b) => b.heat - a.heat || Date.parse(b.pubDate) - Date.parse(a.pubDate));

// 英文资讯翻译为中文（titleZh / summaryZh），需 DASHSCOPE_API_KEY，无 key 时保留原文
await translateEnglishItems(items);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2), 'utf8');
console.log(`已写入 ${items.length} 条资讯 -> ${OUT}`);
