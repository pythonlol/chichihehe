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
    // 中文科技媒体补充：覆盖百度/阿里/腾讯/字节/智谱/月之暗面/MiniMax 等国内大厂动态（2026-08-27 加入）
    { name: 'IT之家', url: 'https://www.ithome.com/rss/', lang: 'zh' },
    { name: 'TechWeb', url: 'https://www.techweb.com.cn/rss/allnews.xml', lang: 'zh' },
    { name: '爱范儿', url: 'https://www.ifanr.com/feed', lang: 'zh' },
    { name: '极客公园', url: 'https://www.geekpark.net/rss', lang: 'zh' },
    { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', lang: 'en' },
    { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed', lang: 'en' },
    { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/', lang: 'en' },
    { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', lang: 'en' },
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', lang: 'en' },
    { name: 'Wired', url: 'https://www.wired.com/feed/tag/ai/latest/rss', lang: 'en' },
    // 2026-11-10 新增：补齐英文科技媒体与公司官方博客两类来源
    { name: 'The Decoder', url: 'https://the-decoder.com/feed/', lang: 'en' },
    { name: 'Claude.dev', url: 'https://claude.dev/rss.xml', lang: 'en' }, // Anthropic 官方开发者博客
    { name: 'Meta Engineering', url: 'https://engineering.fb.com/feed/', lang: 'en' }, // Meta 官方工程博客
  ],
};

const DAYS = 7;
const MAX_ITEMS = 100;
const MAX_PER_SOURCE = 15; // 单源上限，防止单一源（如 arXiv）挤占名额
// 注：旧的 Jaccard 阈值 DEDUP_THRESHOLD 已废弃，现由 sameEvent() 的三条规则判定同事件

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
    // arXiv RSS 的摘要前缀形如「arXiv:2611.08647v1 Announce Type: new Abstract: 」，纯机器标记
    .replace(/^arXiv:\S+\s+Announce Type:\s*\S*\s*Abstract:\s*/i, '')
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
  '人才培养项目', '训练营', '课程报名', '立即报名', '火热报名', '报名通道',
  '免费试听', '限时优惠', '立即抢购', '名额有限', 'early bird',
];

function isSpam(item) {
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  return SPAM_KEYWORDS.some((k) => text.includes(k));
}

// —— 赞助内容过滤 ——
const SPONSORED_KEYWORDS = [
  'sponsored', 'sponsored:', 'sponsored by', 'sponsor post',
  'presented by', 'branded content', '推广位', '营销推广', '商务推广', '赞助内容', '广告内容',
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

// 从 meta 标签提取 og:description / description（比抠 <p> 干净，多数新闻站都有）
function metaDescription(html) {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/(?:property|name)=["'](og:description|twitter:description|description)["']/i.test(tag)) continue;
    const c = tag.match(/content=["']([\s\S]*?)["']/i);
    const text = c ? cleanSummary(stripHtml(c[1])).slice(0, 200) : '';
    if (text.length >= 15) return text;
  }
  return null;
}

async function fetchArticleSummary(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': FETCH_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const meta = metaDescription(html);
    if (meta) return meta;
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

// —— LLM 精筛 ——
// 可信媒体：判断相关性/软文/分类/摘要/信息增量
// arXiv：核心源里唯一的「无质量信号」来源，也送进 LLM，一是拿到 score 用于按质量挑选，
//        二是直接得到中文摘要（省掉后续翻译环节）。
// 官方博客（OpenAI / DeepMind / NVIDIA）内容质量稳定且天然 AI 相关，继续跳过以省 token。
const isArxiv = (it) => String(it.source || '').startsWith('arXiv');

// arXiv 7 天累计可达数百条（2026-11-10 实测 455 条），全送 LLM 要 40+ 批，既慢又浪费 token。
// 先按发布时间取最近的若干条参与打分，最终仍由 ARXIV_KEEP 决定留几条；更早的直接淘汰。
const ARXIV_LLM_MAX = 40;
const arxivByTime = filteredItems.filter(isArxiv).sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
const arxivScoredLinks = new Set(arxivByTime.slice(0, ARXIV_LLM_MAX).map((it) => it.link));
arxivByTime.slice(ARXIV_LLM_MAX).forEach((it) => { it._llmDrop = true; });

const llmItems = filteredItems.filter((it) => it.tier === 'trusted' || arxivScoredLinks.has(it.link));

// arXiv 的英文 abstract 动辄 200+ 字符，送 LLM 只为拿中文摘要和分数，截断能明显缩短每批耗时
const ARXIV_LLM_SUMMARY_MAX = 150;
llmItems.forEach((it) => {
  if (isArxiv(it) && (it.summary || '').length > ARXIV_LLM_SUMMARY_MAX) {
    it.summary = it.summary.slice(0, ARXIV_LLM_SUMMARY_MAX);
  }
});

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

// —— arXiv 按分数挑选：论文数量大、单条价值密度低，只保留信息增量最高的几条 ——
// 没有 score 的（LLM 调用失败）排在后面，不占用高名额
const ARXIV_KEEP = 6;
const arxivPool = filteredItems.filter((it) => isArxiv(it) && !it._llmDrop);
if (arxivPool.length > ARXIV_KEEP) {
  const ranked = [...arxivPool].sort(
    (a, b) => (b.llmScore ?? 0) - (a.llmScore ?? 0) || Date.parse(b.pubDate) - Date.parse(a.pubDate),
  );
  ranked.slice(ARXIV_KEEP).forEach((it) => { it._llmDrop = true; });
  console.log(`arXiv 按信息增量保留 ${ARXIV_KEEP}/${arxivPool.length} 条（分数线 ${ranked[ARXIV_KEEP - 1].llmScore ?? '无'}）`);
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

// —— 跨源去重：识别「同一事件的不同报道」 ——
// 旧实现用「标题+摘要」的 Jaccard ≥ 0.35，实测在真实语料上永远不触发：
// 100 条里最高只有 0.16，连标题几乎完全一致的两条都识别不出（摘要把标题信号稀释了）。
// 更关键的是去重发生在翻译之前，英文标题和中文标题字符集完全不同，字符相似度必然是 0。
// 改为三条互补规则，核心是「稀有实体」，这是唯一能跨语言对齐的信号。
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'will', 'says',
  'after', 'over', 'into', 'amid', 'what', 'how', 'why', 'its', 'are',
  'was', 'has', 'have', 'new', 'news', 'you', 'your', 'a', 'an', 'to',
  'of', 'in', 'on', 'at', 'by', 'is', 'it', 'as', 'or', 'be', 'not',
  'but', 'can', 'may', 'do', 'if', 'we', 'he', 'she', 'they',
]);

// 泛词：几乎每条标题都有，不能当作「同一事件」的证据
const GENERIC_ENTITY = new Set([
  'agent', 'agents', 'model', 'models', 'llm', 'llms', 'api', 'app', 'apps',
  'research', 'blog', 'feed', 'official', 'news', 'update', 'release', 'launch', 'announce',
]);

// 英文/型号实体：Claude、Fable、Muse、GPT-6、5.2 这类
function entityTokens(title = '') {
  const s = new Set();
  for (const w of title.match(/[A-Za-z][A-Za-z0-9.\-]{2,}/g) || []) {
    const k = w.toLowerCase().replace(/[.\-]+$/, '');
    if (k.length >= 3 && !STOP.has(k) && !GENERIC_ENTITY.has(k)) s.add(k);
  }
  for (const num of title.match(/\d+\.\d+/g) || []) s.add(num);
  return s;
}

function zhBigrams(title = '') {
  const s = new Set();
  const zh = title.match(/[一-鿿]/g);
  if (zh) for (let i = 0; i < zh.length - 1; i++) s.add(zh[i] + zh[i + 1]);
  return s;
}

// 早报/合集类标题里并列多条新闻，天然会和其他条目重叠，不能按普通条目判同事件
const DIGEST_TITLE = /早报|早知道|周刊|盘点|一周|速览|要闻|简报|晨报|晚报/;
function isDigestTitle(t = '') {
  return DIGEST_TITLE.test(t) || (t.match(/[/／;；|｜]/g) || []).length >= 2;
}

function intersectSize(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

cappedItems.forEach((it) => {
  it.companies = detectCompanies(it);
});

const entSets = cappedItems.map((it) => entityTokens(it.title || ''));
const zhSets = cappedItems.map((it) => zhBigrams(it.title || ''));
const digestFlags = cappedItems.map((it) => isDigestTitle(it.title || ''));

// 实体稀有度：只出现在少数条目里的实体才有辨识力，像 "openai" 这种到处都是的没有
const entDf = new Map();
for (const s of entSets) for (const t of s) entDf.set(t, (entDf.get(t) || 0) + 1);
const isRareEnt = (t) => (entDf.get(t) || 0) <= Math.max(3, cappedItems.length * 0.06);

function sameEvent(i, j) {
  const sharedEnt = [...entSets[i]].filter((t) => entSets[j].has(t));
  const rareShared = sharedEnt.filter(isRareEnt);
  const sharedZh = intersectSize(zhSets[i], zhSets[j]);
  const sameCompany = (cappedItems[i].companies || []).some(
    (c) => (cappedItems[j].companies || []).includes(c),
  );

  // 规则 1（跨语言主信号）：共享 ≥2 个实体且至少 1 个稀有，如 Anthropic + Fable + 5.2
  if (sharedEnt.length >= 2 && rareShared.length >= 1) return true;
  // 规则 2（中文对中文）：二元组重叠够多且有共同公司；合集类不参与，否则早报会跟别的新闻乱合并
  if (!digestFlags[i] && !digestFlags[j] && sharedZh >= 5 && sameCompany) return true;
  // 规则 3：标题几乎一致（仅有空格或标点差异）
  const union = new Set([...entSets[i], ...zhSets[i], ...entSets[j], ...zhSets[j]]).size;
  if ((sharedEnt.length + sharedZh) / (union || 1) >= 0.5) return true;
  return false;
}

// 贪心聚类
const assigned = new Set();
const deduped = [];
for (let i = 0; i < cappedItems.length; i++) {
  if (assigned.has(i)) continue;
  const cluster = [i];
  assigned.add(i);
  for (let j = i + 1; j < cappedItems.length; j++) {
    if (assigned.has(j)) continue;
    if (sameEvent(i, j)) {
      cluster.push(j);
      assigned.add(j);
    }
  }
  if (cluster.length === 1) {
    deduped.push(cappedItems[i]);
    continue;
  }

  // 主条目优先级：非合集 > core > 更早发布
  // 早报只作为「也报道了」的补充来源，不能让它顶掉专门讲该事件的那条
  const ranked = cluster.map((idx) => ({
    item: cappedItems[idx],
    digestRank: digestFlags[idx] ? 1 : 0,
    tierRank: cappedItems[idx].tier === 'core' ? 0 : 1,
    pubTime: Date.parse(cappedItems[idx].pubDate),
  }));
  ranked.sort((a, b) => a.digestRank - b.digestRank || a.tierRank - b.tierRank || a.pubTime - b.pubTime);

  const main = ranked[0].item;
  const sources = [...new Set(cluster.map((idx) => cappedItems[idx].source))];
  const others = sources.filter((s) => s !== main.source);
  // coverage = 涉及的不同来源数（不是条目数），供热度加成与页面展示
  main.coverage = sources.length;
  // 只有真正来自其他来源时才有意义，避免出现「另外 0 家也报道了」
  if (others.length > 0) main.alsoReportedBy = others;
  deduped.push(main);
}

// —— 100 条截断：公司动态优先保留 ——
// 纯按时间截断会把发布稍早的大厂动态（腾讯/字节等）整组挤掉，
// 先保住涉及知名公司的条目，再按时间补足其余名额
const byTime = deduped.sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
const companyItems = byTime.filter((it) => (it.companies || []).length > 0);
const plainItems = byTime.filter((it) => !(it.companies || []).length);
const items = [...companyItems.slice(0, MAX_ITEMS), ...plainItems].slice(0, MAX_ITEMS);

// —— 热度计算：多源报道打分 + 时间衰减 ——
// 基础分：统计标题关键词被多少家不同媒体提及，用 IDF 抑制高频泛词干扰；
// 多源加成：去重时被聚类掉的同事件报道（coverage）每个额外源 +5，
// 否则大新闻去重后反而丢失"多家报道"信号；
// 时间衰减：半衰期 48 小时，避免旧高热新闻压过新新闻。
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
const nowMs = Date.now();
items.forEach((item, i) => {
  let s = 0;
  for (const x of toksOf[i]) {
    const ns = srcOf.get(x).size;
    if (ns >= 2) s += (ns - 1) * Math.log(N / df.get(x));
  }
  if (item.coverage > 1) s += (item.coverage - 1) * 5;
  const ageHours = Math.max(0, (nowMs - Date.parse(item.pubDate)) / 3600000);
  s *= Math.pow(0.5, ageHours / 48);
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

// 数据已落盘。部分 HTTP keep-alive 句柄可能残留，导致 event loop 不退出，
// 进而让 update.sh 卡在第一步、后续抓取与构建全部不执行。这里显式收尾。
process.exit(0);

