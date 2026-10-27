// 抓取多个 AI 模型排行榜数据，输出 src/data/leaderboard.json
// 数据源：LiveBench 2.0（长周期真实任务）/ Artificial Analysis（综合智能指数）
// 用法：node scripts/fetch-leaderboard.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'data', 'leaderboard.json');

const FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function fetchOnce(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: { 'User-Agent': FETCH_UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = new URL(res.headers.location, url).href;
        return resolve(fetchOnce(loc, timeout));
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

// livebench.ai 的 TLS 偶发 ECONNRESET，重试两次
async function fetchText(url, timeout = 60000, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchOnce(url, timeout);
    } catch (e) {
      lastErr = e;
      if (e.message.includes('HTTP 4')) throw e;
    }
  }
  throw lastErr;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 从 text 的 start 位置（必须是 { 或 [）起配平取出完整 JSON 片段
function sliceBalanced(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// 简易 CSV 解析（LiveBench 的 csv 字段内不含逗号）
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

function toNum(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s === 'n/a' || s === 'NA') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// ========== 1. LiveBench 2.0 ==========
// 2.0 起改为 SPA + 静态数据目录：/data/<YYYYMMDD>/table.csv、categories.json、cost.csv
// release 列表写在 SPA 的 JS 里，这里按倒序探测，取第一个可用的
const LB_RELEASES = ['20261025', '20261014'];

// 维度中文名（key 保留英文，用于数据取值和排序）
const LB_METRIC_LABELS = {
  'Long Agentic': '长周期 Agent',
  'Reasoning': '推理',
  'Coding': '代码',
  'Browser': '浏览器',
  'Data Analysis': '数据分析',
  'Research': '研究',
  'Design': '设计',
};

async function fetchLiveBenchModelInfo() {
  // 模型显示名/厂商只存在于 SPA bundle 里，抓不到就回退到 slug 美化
  const info = {};
  try {
    const home = await fetchText('https://livebench.ai/');
    const m = home.match(/\/static\/js\/main\.[a-z0-9]+\.js/);
    if (!m) return info;
    const js = await fetchText(`https://livebench.ai${m[0]}`);
    const re = /"([a-z0-9][a-z0-9._\-]*)":\{/g;
    let hit;
    while ((hit = re.exec(js)) !== null) {
      const slug = hit[1];
      if (info[slug]) continue;
      const body = sliceBalanced(js, hit.index + hit[0].length - 1);
      if (!body) continue;
      const dn = body.match(/displayName:"([^"]+)"/);
      if (!dn) continue;
      const org = body.match(/organization:"([^"]+)"/);
      info[slug] = {
        name: dn[1],
        creator: org ? org[1] : null,
        openWeights: /openweight:!0/.test(body),
        reasoning: /reasoner:!0/.test(body),
      };
    }
  } catch (e) {
    console.warn(`  ! 模型信息抓取失败（回退 slug）: ${e.message}`);
  }
  return info;
}

function prettifySlug(slug) {
  return slug.replace(/[-_]/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

async function fetchLiveBench() {
  for (const release of LB_RELEASES) {
    const base = `https://livebench.ai/data/${release}`;
    try {
      console.log(`  尝试 release ${release} ...`);
      const [csv, catJson, costCsv] = await Promise.all([
        fetchText(`${base}/table.csv`),
        fetchText(`${base}/categories.json`),
        fetchText(`${base}/cost.csv`).catch(() => null),
      ]);
      const rawCats = JSON.parse(catJson);
      const weights = rawCats._overall_weights || {};
      const catNames = Object.keys(rawCats).filter((k) => !k.startsWith('_'));

      // 价格表：slug -> 输入/输出单价（美元/百万 token）
      const costMap = {};
      if (costCsv) {
        parseCsv(costCsv).forEach((r) => {
          const pin = toNum(r.input_price_per_million);
          const pout = toNum(r.output_price_per_million);
          if (pin !== null || pout !== null) costMap[r.model] = { pin, pout };
        });
      }

      const info = await fetchLiveBenchModelInfo();

      const rows = parseCsv(csv);
      const models = rows.map((row) => {
        const slug = row.model;
        const metrics = {};
        let weightedSum = 0;
        let weightTotal = 0;
        for (const cat of catNames) {
          const cols = rawCats[cat] || [];
          const vals = cols.map((c) => toNum(row[c])).filter((n) => n !== null);
          if (vals.length === 0) continue;
          const score = vals.reduce((a, b) => a + b, 0) / vals.length;
          metrics[cat] = round2(score);
          const w = weights[cat] ?? 1;
          weightedSum += score * w;
          weightTotal += w;
        }
        const meta = info[slug] || {};
        const cost = costMap[slug] || {};
        return {
          model: meta.name || prettifySlug(slug),
          slug,
          creator: meta.creator || null,
          openWeights: meta.openWeights ?? null,
          reasoning: meta.reasoning ?? null,
          overall: weightTotal > 0 ? round2(weightedSum / weightTotal) : null,
          metrics,
          priceIn: cost.pin ?? null,
          priceOut: cost.pout ?? null,
        };
      }).filter((m) => m.overall !== null)
        .sort((a, b) => b.overall - a.overall);

      const label = `${release.slice(0, 4)}-${release.slice(4, 6)}-${release.slice(6, 8)}`;
      console.log(`  ✓ release ${label}：${models.length} 个模型，${catNames.length} 个维度`);
      return {
        id: 'livebench',
        name: 'LiveBench',
        desc: '长周期真实任务基准，模型交付成品由评分器检验',
        source: 'https://livebench.ai',
        version: label,
        scoreLabel: '综合得分',
        scoreMax: 100,
        metrics: catNames.map((c) => ({ key: c, label: LB_METRIC_LABELS[c] || c })),
        models,
      };
    } catch (e) {
      console.warn(`  ✗ release ${release} 失败: ${e.message}`);
    }
  }
  throw new Error('所有 LiveBench release 均抓取失败');
}

// ========== 2. Artificial Analysis 智能指数 ==========
// 站点已迁移到 Next.js App Router，数据在 RSC flight payload 的 initialModels 里
function extractFlight(html) {
  const parts = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\[\s\S])*")\]\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { parts.push(JSON.parse(m[1])); } catch {}
  }
  return parts.join('');
}

// 推理档位变体（Max/Xhigh/High/Medium/Low）会各自占一条，合并到同一模型只留最高分
const EFFORT_SUFFIX = /-(xhigh|high|medium|low|minimal)$/;

function stripEffort(name) {
  const m = name.match(/\s*\(([^)]*)\)\s*$/);
  if (!m) return { name: name.trim(), effort: null };
  const inner = m[1];
  if (!/(max|xhigh|high|medium|low|minimal)/i.test(inner)) return { name: name.trim(), effort: null };
  const effort = inner.split(',')[0].trim();
  return { name: name.slice(0, m.index).trim(), effort };
}

async function fetchArtificialAnalysis() {
  try {
    console.log('  抓取 Artificial Analysis 排行榜...');
    const html = await fetchText('https://artificialanalysis.ai/leaderboards/models', 90000);
    const flight = extractFlight(html);
    if (!flight) throw new Error('未解析出 RSC flight 数据');

    const key = '"initialModels":';
    const idx = flight.indexOf(key);
    if (idx < 0) throw new Error('未找到 initialModels');
    const arrStart = flight.indexOf('[', idx);
    const raw = sliceBalanced(flight, arrStart);
    if (!raw) throw new Error('initialModels 数组不完整');
    const list = JSON.parse(raw);

    // 先按 slug 去掉档位后缀成组，组内取最高分
    const groups = new Map();
    for (const m of list) {
      if (m.intelligenceIndex === null || m.intelligenceIndex === undefined) continue;
      const baseSlug = m.slug.replace(EFFORT_SUFFIX, '');
      const prev = groups.get(baseSlug);
      if (!prev || m.intelligenceIndex > prev.intelligenceIndex) groups.set(baseSlug, m);
    }

    const models = [...groups.values()].map((m) => {
      const { name, effort } = stripEffort(m.name);
      // 子分是 0~1 的比例，统一折算成百分制
      const pct = (k) => (m.scores?.[k] != null ? round2(m.scores[k] * 100) : null);
      return {
        model: name,
        slug: m.slug,
        creator: m.modelCreatorName || null,
        openWeights: !!m.isOpenWeights,
        reasoning: !!m.isReasoning,
        effort,
        overall: round2(m.intelligenceIndex),
        metrics: {
          'humanitys-last-exam': pct('humanitys-last-exam'),
          'long-context': pct('artificial-analysis-long-context-reasoning'),
          'omniscience': pct('omniscience-accuracy'),
          'critpt': pct('critpt'),
        },
        contextWindow: m.contextWindowTokens ?? null,
        speed: m.medianOutputTokensPerSecond != null ? Math.round(m.medianOutputTokensPerSecond) : null,
        priceIn: m.price1mInputTokens ?? null,
        priceOut: m.price1mOutputTokens ?? null,
      };
    }).sort((a, b) => b.overall - a.overall);

    console.log(`  ✓ Artificial Analysis：${list.length} 条原始记录 → 去重后 ${models.length} 个模型`);
    return {
      id: 'aa',
      name: 'Artificial Analysis',
      desc: '多基准加权综合智能指数',
      source: 'https://artificialanalysis.ai/leaderboards/models',
      version: null,
      scoreLabel: '智能指数',
      scoreMax: 100,
      metrics: [
        { key: 'humanitys-last-exam', label: '人文终考' },
        { key: 'long-context', label: '长上下文' },
        { key: 'omniscience', label: '知识准确性' },
        { key: 'critpt', label: '物理推理' },
      ],
      models,
    };
  } catch (e) {
    console.warn(`  ✗ Artificial Analysis 抓取失败: ${e.message}`);
    return null;
  }
}

// ========== 主流程 ==========
async function main() {
  console.log('=== AI 模型排行榜数据抓取 ===\n');

  const leaderboards = [];

  console.log('[1/2] LiveBench');
  try {
    const lb = await fetchLiveBench();
    lb.models.slice(0, 3).forEach((m, i) => console.log(`    ${i + 1}. ${m.model} — ${m.overall}`));
    leaderboards.push(lb);
  } catch (e) {
    console.error(`  LiveBench 失败: ${e.message}`);
  }

  console.log('\n[2/2] Artificial Analysis');
  const aa = await fetchArtificialAnalysis();
  if (aa) {
    aa.models.slice(0, 3).forEach((m, i) => console.log(`    ${i + 1}. ${m.model} — ${m.overall}`));
    leaderboards.push(aa);
  }

  if (leaderboards.length === 0) {
    throw new Error('两个数据源均失败，保留原有 leaderboard.json');
  }

  const output = { updatedAt: new Date().toISOString(), leaderboards };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`\n已输出 ${OUT}（${leaderboards.length} 个排行榜）`);
}

main().catch((e) => {
  console.error('抓取失败:', e.message);
  process.exit(1);
});
