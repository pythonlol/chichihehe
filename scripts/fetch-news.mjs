// 抓取各 RSS 源的 AI 资讯，输出 src/data/news.json
// 用法：node scripts/fetch-news.mjs
import Parser from 'rss-parser';
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
  // 英文
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', lang: 'en' },
  { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed', lang: 'en' },
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

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2), 'utf8');
console.log(`已写入 ${items.length} 条资讯 -> ${OUT}`);
