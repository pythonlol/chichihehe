// LLM 精筛：通过 DashScope qwen-plus 对每条资讯做结构化分析
// 输出 JSON: index / is_ai_related / is_promo / category / summary / score
// 仅用于可信媒体条目（核心源天然 AI 相关，跳过）
// 无 API key 或调用失败时返回 null，调用方回退到关键词方案
//
// 2026-11-10 修复摘要错位：原实现按数组下标回填（results[i + j] = parsed[j]），
// 模型只要少返一条、多返一条或换了顺序，整批摘要就会串到别的标题上。
// 现改为要求模型回传 index，按 index 精确回填；缺失的条目单条补抓一次，避免整批丢弃。
import { TAGS } from './categorize.mjs';

const API = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'qwen-plus';
const BATCH = 10;

// 分类候选从 categorize.mjs 的 TAGS 动态取，避免提示词与页面筛选栏漂移
const CATEGORY_LIST = TAGS.map((t) => `"${t}"`).join(',');

const SYSTEM_PROMPT = `你是 AI 资讯编辑。输入是带编号（1 到 N）的资讯列表，请逐条分析并输出 JSON 数组，每个元素为：
{"index": number, "is_ai_related": boolean, "is_promo": boolean, "category": string, "summary": string, "score": number}

- index: 该条资讯在输入中的编号（从 1 开始），必须原样回填
- is_ai_related: 是否与 AI/人工智能直接相关（纯 C# 教程、纯财经报道、数码测评等不算）
- is_promo: 是否为软文/广告/课程推广/营销内容
- category: 从以下选一个：${CATEGORY_LIST}；若该条是早报/合集，选其中分量最重的那条新闻所属的类别
- summary: 20-50 字一句话中文摘要，概括该 index 对应资讯的核心内容。
  若该条属于早报/合集/盘点（标题含「早报」「早知道」「周刊」「盘点」「一周」「速览」，或用「/」「；」「｜」并列多条新闻），
  必须概括其中最值得关注的 2-3 条，用「；」分隔，禁止只挑其中一条来写，否则读者会误以为该条只讲了那一件事
- score: 1-5 信息增量评分（5=重大突破/独家，3=有价值，1=低价值/重复/日常动态）

硬性要求：
1. 输出条数必须与输入条数完全一致，不得合并、拆分或省略任何一条
2. index 必须唯一，且与输入编号一一对应
3. summary 只能概括 index 指向的那一条资讯，严禁把其他条目的内容写进来
4. 只输出 JSON 数组，不要任何解释文字。`;

function extractJsonArray(text) {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* continue */ }
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch { /* continue */ }
  }
  return null;
}

// 早报/合集识别：这类标题并列多条新闻，逐条概括会误导读者
const DIGEST_PATTERN = /早报|早知道|周刊|盘点|一周|速览|要闻|简报|晨报|晚报/;

function isDigest(title = '') {
  if (DIGEST_PATTERN.test(title)) return true;
  // 标题里出现两个以上并列分隔符，也按合集处理
  return (title.match(/[/／;；|｜]/g) || []).length >= 2;
}

async function classifyBatch(batch, apiKey) {
  const userContent = batch.map((it, idx) =>
    `${idx + 1}. ${isDigest(it.title) ? '〔合集〕' : ''}[${it.source}] ${it.title}\n摘要：${it.summary || '（无摘要）'}`,
  ).join('\n\n');

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `资讯列表（共 ${batch.length} 条，编号 1-${batch.length}）：\n\n${userContent}` },
      ],
      temperature: 0.1,
    }),
    // 没有超时的话，单个挂起的请求会把整轮抓取无限期拖住
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 120)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const parsed = extractJsonArray(content);
  if (!parsed) {
    throw new Error(`LLM 返回非 JSON 数组: ${content.slice(0, 100)}`);
  }
  return parsed;
}

/**
 * 按模型回传的 index 把结果放回对应位置。
 * 兼容模型误用 0 基编号的情况；重复或越界的 index 直接忽略。
 * @returns {Set<number>} 已成功回填的相对下标（0 基）
 */
function placeByIndex(batchLength, parsed, results, offset) {
  const filled = new Set();

  const rawIdx = parsed
    .map((e) => Number(e?.index))
    .filter((n) => Number.isInteger(n));
  // 整批都是 0..N-1 且不含 N，判定模型用了 0 基编号
  const zeroBased = rawIdx.length > 0
    && rawIdx.every((n) => n >= 0 && n < batchLength)
    && !rawIdx.includes(batchLength);

  for (const entry of parsed) {
    let n = Number(entry?.index);
    if (!Number.isInteger(n)) continue;
    if (zeroBased) n += 1;
    if (n < 1 || n > batchLength) continue;
    const pos = n - 1;
    if (filled.has(pos)) continue;
    filled.add(pos);
    results[offset + pos] = entry;
  }
  return filled;
}

/**
 * 批量 LLM 分类
 * @param {Array} items — 可信媒体条目
 * @param {string} apiKey — DashScope API key
 * @returns {Promise<Array|null>} 分类结果数组（与 items 位置一一对应），全部失败返回 null
 */
export async function llmClassify(items, apiKey) {
  if (!apiKey || items.length === 0) return null;

  const results = new Array(items.length).fill(null);
  let batchFailed = 0;
  let missed = 0;

  // 先切好批次任务，便于并发调度
  const tasks = [];
  for (let i = 0; i < items.length; i += BATCH) {
    tasks.push({ offset: i, batch: items.slice(i, i + BATCH), no: Math.floor(i / BATCH) + 1 });
  }

  async function runTask({ offset, batch, no }) {
    try {
      const parsed = await classifyBatch(batch, apiKey);
      let filled = placeByIndex(batch.length, parsed, results, offset);

      // 模型完全没给可用 index：退回位置匹配，但仅在条数完全一致时接受
      if (filled.size === 0 && parsed.length === batch.length) {
        for (let j = 0; j < batch.length; j++) results[offset + j] = parsed[j];
        filled = new Set(batch.map((_, j) => j));
        console.warn(`[warn] 批次 ${no} 未返回可用 index，已按位置匹配 ${batch.length} 条`);
      }

      // 漏掉的条目单条补抓一次，避免整条失去摘要与分类
      const gaps = batch.map((_, j) => j).filter((j) => !filled.has(j));
      if (gaps.length > 0) {
        const singles = await Promise.allSettled(gaps.map((j) => classifyBatch([batch[j]], apiKey)));
        singles.forEach((r, k) => {
          if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return;
          const hit = r.value.find((e) => Number(e?.index) === 1) || r.value[0];
          if (hit) {
            results[offset + gaps[k]] = hit;
            filled.add(gaps[k]);
          }
        });
      }

      const stillMissing = batch.length - filled.size;
      if (stillMissing > 0) {
        missed += stillMissing;
        console.warn(`[warn] 批次 ${no} 仍有 ${stillMissing}/${batch.length} 条未匹配，回退关键词分类`);
      }
    } catch (err) {
      batchFailed++;
      console.warn(`[warn] LLM 分类批次 ${no} 失败: ${err.message}`);
    }
  }

  // 串行太慢：qwen-plus 单批约 40-50 秒，12 批要 8-10 分钟，会撞上 update.sh 的单步超时。
  // 每个批次写的是 results 里互不重叠的区间，3 路并发安全。
  const CONCURRENCY = 3;
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    await Promise.all(tasks.slice(i, i + CONCURRENCY).map(runTask));
  }

  // 全部失败则返回 null（回退关键词方案）
  if (results.every((r) => r === null)) return null;

  const ok = results.filter((r) => r !== null).length;
  console.log(`[llm] 分类完成：${ok}/${items.length} 条匹配${missed ? `，${missed} 条回退关键词` : ''}${batchFailed ? `，${batchFailed} 个批次失败` : ''}`);
  return results;
}
