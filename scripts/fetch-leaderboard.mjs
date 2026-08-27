// 抓取多个 AI 模型排行榜数据，输出 src/data/leaderboard.json
// 数据源：LiveBench（通用基准）/ Aider（代码编辑）/ Artificial Analysis（智能指数）
// 用法：node scripts/fetch-leaderboard.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'data', 'leaderboard.json');

const FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function fetchText(url, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: { 'User-Agent': FETCH_UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = new URL(res.headers.location, url).href;
        return resolve(fetchText(loc, timeout));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`${url} -> HTTP ${res.statusCode}`));
      }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${url} -> timeout`)); });
  });
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
}

// ========== 1. LiveBench ==========
const LB_VERSIONS = [
  '2024-06-24', '2024-07-26', '2024-08-31', '2024-11-25',
  '2025-04-02', '2025-04-25', '2025-05-30', '2025-11-25',
  '2025-12-23', '2026-01-08', '2026-06-25',
];
const LB_CACHE = '?v=1787505463';

async function fetchLiveBench() {
  for (let i = LB_VERSIONS.length - 1; i >= 0; i--) {
    const version = LB_VERSIONS[i];
    const v = version.replaceAll('-', '_');
    const base = 'https://livebench.ai';
    try {
      console.log(`  尝试版本 ${version} ...`);
      const [csv, catJson] = await Promise.all([
        fetchText(`${base}/table_${v}.csv${LB_CACHE}`),
        fetchText(`${base}/categories_${v}.json${LB_CACHE}`),
      ]);
      console.log(`  ✓ 版本 ${version} 数据获取成功`);
      const lines = csv.trim().split('\n');
      const headers = lines[0].split(',');
      const rows = lines.slice(1).map((l) => l.split(','));
      const categories = JSON.parse(catJson);
      const models = rows.map((row) => {
        const obj = {};
        headers.forEach((h, j) => { obj[h] = row[j]; });
        const catScores = {};
        for (const [catName, tasks] of Object.entries(categories)) {
          const scores = tasks.map((t) => parseFloat(obj[t])).filter((n) => !isNaN(n));
          catScores[catName] = scores.length > 0
            ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null;
        }
        const valid = Object.values(catScores).filter((n) => n !== null);
        const globalAverage = valid.length > 0
          ? Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 100) / 100 : 0;
        return { model: obj.model, globalAverage, categories: catScores };
      }).sort((a, b) => b.globalAverage - a.globalAverage);
      return {
        id: 'livebench', name: 'LiveBench', desc: '通用基准测试',
        source: 'https://livebench.ai', version, categories, models,
      };
    } catch (e) {
      console.warn(`  ✗ 版本 ${version} 失败: ${e.message}`);
      if (i === 0) throw e;
    }
  }
}

// ========== 2. Artificial Analysis 智能指数 ==========
async function fetchArtificialAnalysis() {
  try {
    console.log('  抓取 Artificial Analysis 排行榜...');
    const html = await fetchText('https://artificialanalysis.ai/leaderboards/models', 60000);
    // 从 HTML 中提取模型数据
    // 页面是 Next.js SSR，数据嵌入在 HTML 中
    const models = [];

    // 尝试从 __NEXT_DATA__ JSON 中提取
    const ndMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (ndMatch) {
      try {
        const data = JSON.parse(ndMatch[1]);
        console.log('  从 __NEXT_DATA__ 提取数据');
        // 数据结构未知，尝试遍历查找模型数据
        const jsonStr = JSON.stringify(data);
        // 查找模型名和分数的模式
        const modelPattern = /"model_name"\s*:\s*"([^"]+)"/g;
        const scorePattern = /"intelligence_index"\s*:\s*([\d.]+)/g;
        const nameMatches = [...jsonStr.matchAll(modelPattern)];
        const scoreMatches = [...jsonStr.matchAll(scorePattern)];
        for (let i = 0; i < nameMatches.length && i < scoreMatches.length; i++) {
          models.push({
            model: nameMatches[i][1],
            score: parseFloat(scoreMatches[i][1]),
          });
        }
      } catch {}
    }

    // 如果 __NEXT_DATA__ 没有数据，尝试从表格行中提取
    if (models.length === 0) {
      // 查找类似 "Intelligence Index" 附近的数字
      // 从页面文本中提取已知的模式
      const text = stripTags(html);
      // 匹配模式：模型名后跟分数
      const lines = text.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        // 查找已知模型名
        if (/^(Claude|GPT|Gemini|Grok|Kimi|GLM|DeepSeek|Qwen|Llama|Mistral|Granite)\s/i.test(line)) {
          // 下一行可能是分数
          const nextLine = lines[i + 1].trim();
          const score = parseInt(nextLine);
          if (score > 0 && score < 200) {
            models.push({ model: line, score });
          }
        }
      }
    }

    models.sort((a, b) => b.score - a.score);
    const top = models.slice(0, 30); // 只保留 top 30
    if (top.length > 0) {
      console.log(`  ✓ Artificial Analysis: ${top.length} 个模型`);
      return {
        id: 'aa', name: 'Artificial Analysis', desc: '通用智能指数',
        source: 'https://artificialanalysis.ai/leaderboards/models', models: top,
      };
    }
    console.warn('  ✗ Artificial Analysis: 未提取到数据');
    return null;
  } catch (e) {
    console.warn(`  ✗ Artificial Analysis 抓取失败: ${e.message}`);
    return null;
  }
}

// ========== 主流程 ==========
async function main() {
  console.log('=== AI 模型排行榜数据抓取 ===\n');

  const leaderboards = [];

  // 1. LiveBench
  console.log('[1/2] LiveBench');
  try {
    const lb = await fetchLiveBench();
    console.log(`  共 ${lb.models.length} 个模型，前 3 名:`);
    lb.models.slice(0, 3).forEach((m) => console.log(`    ${m.model}: ${m.globalAverage}`));
    leaderboards.push(lb);
  } catch (e) {
    console.error(`  LiveBench 失败: ${e.message}`);
  }

  // 2. Artificial Analysis
  console.log('\n[2/2] Artificial Analysis');
  const aa = await fetchArtificialAnalysis();
  if (aa) leaderboards.push(aa);

  const output = { updatedAt: new Date().toISOString(), leaderboards };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`\n已输出 ${OUT}（${leaderboards.length} 个排行榜）`);
}

main().catch((e) => {
  console.error('抓取失败:', e.message);
  process.exit(1);
});
