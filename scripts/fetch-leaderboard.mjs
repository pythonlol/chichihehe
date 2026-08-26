// 抓取 LiveBench Global Average 排行榜数据
// 从 livebench.ai 获取最新版本的 table CSV 和 categories JSON
// 计算各分类平均分和全局平均分（Global Average），输出 src/data/leaderboard.json
//
// 用法：node scripts/fetch-leaderboard.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'data', 'leaderboard.json');

// 已知的 LiveBench 版本日期（从网站 JS bundle 提取），新版本发布后在此追加
const VERSIONS = [
  '2024-06-24', '2024-07-26', '2024-08-31', '2024-11-25',
  '2025-04-02', '2025-04-25', '2025-05-30', '2025-11-25',
  '2025-12-23', '2026-01-08', '2026-06-25',
];

const CACHE_BUSTER = '?v=1787505463';

function fetchText(url, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
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

// 从最新版本开始尝试，直到成功获取数据
async function fetchLatest() {
  for (let i = VERSIONS.length - 1; i >= 0; i--) {
    const version = VERSIONS[i];
    const v = version.replaceAll('-', '_');
    const base = `https://livebench.ai`;
    try {
      console.log(`尝试版本 ${version} ...`);
      const [csv, catJson] = await Promise.all([
        fetchText(`${base}/table_${v}.csv${CACHE_BUSTER}`),
        fetchText(`${base}/categories_${v}.json${CACHE_BUSTER}`),
      ]);
      console.log(`✓ 版本 ${version} 数据获取成功`);
      return { version, csv, categories: JSON.parse(catJson) };
    } catch (e) {
      console.warn(`✗ 版本 ${version} 失败: ${e.message}`);
      if (i === 0) throw new Error('所有已知版本均获取失败');
    }
  }
}

// 解析 CSV（LiveBench CSV 格式简单：无引号包裹，直接 split）
function parseCsv(csv) {
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',');
  const rows = lines.slice(1).map((line) => {
    const values = line.split(',');
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = values[i];
    }
    return obj;
  });
  return { headers, rows };
}

// 计算每个模型的全局平均分和各分类平均分
function computeScores(rows, categories) {
  return rows.map((row) => {
    const model = row.model;
    const catScores = {};
    for (const [catName, tasks] of Object.entries(categories)) {
      const scores = tasks
        .map((t) => parseFloat(row[t]))
        .filter((n) => !isNaN(n));
      catScores[catName] = scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
        : null;
    }
    // Global Average = 各分类平均分的平均
    const validCatScores = Object.values(catScores).filter((n) => n !== null);
    const globalAverage = validCatScores.length > 0
      ? Math.round((validCatScores.reduce((a, b) => a + b, 0) / validCatScores.length) * 100) / 100
      : 0;
    return { model, globalAverage, categories: catScores };
  }).sort((a, b) => b.globalAverage - a.globalAverage);
}

async function main() {
  console.log('=== LiveBench 排行榜数据抓取 ===');

  const { version, csv, categories } = await fetchLatest();
  const { rows } = parseCsv(csv);
  console.log(`共 ${rows.length} 个模型`);

  const models = computeScores(rows, categories);
  console.log(`前 3 名:`);
  for (const m of models.slice(0, 3)) {
    console.log(`  ${m.model}: ${m.globalAverage}`);
  }

  const output = {
    updatedAt: new Date().toISOString(),
    version,
    source: 'https://livebench.ai',
    categories,
    models,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`\n已输出 ${OUT}（${models.length} 个模型）`);
}

main().catch((e) => {
  console.error('抓取失败:', e.message);
  process.exit(1);
});
