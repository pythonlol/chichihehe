// LLM 精筛：通过 DashScope qwen-turbo 对每条资讯做结构化分析
// 输出 JSON: is_ai_related / is_promo / category / summary / score
// 仅用于可信媒体条目（核心源天然 AI 相关，跳过）
// 无 API key 或调用失败时返回 null，调用方回退到关键词方案
import { TAGS } from './categorize.mjs';

const API = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'qwen-turbo';
const BATCH = 10;

const SYSTEM_PROMPT = `你是 AI 资讯编辑。请分析每条资讯，输出 JSON 数组，每个元素包含：
{"is_ai_related": boolean, "is_promo": boolean, "category": string, "summary": string, "score": number}

- is_ai_related: 是否与 AI/人工智能直接相关（纯 C# 教程、纯财经报道、数码测评等不算）
- is_promo: 是否为软文/广告/课程推广/营销内容
- category: 从以下选一个："大模型","智能体","芯片算力","具身智能","政策与安全","商业融资","AI 动态"
- summary: 20-50 字一句话中文摘要，概括核心内容
- score: 1-5 信息增量评分（5=重大突破/独家，3=有价值，1=低价值/重复/日常动态）

只输出 JSON 数组，不要任何其他文字。`;

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

async function classifyBatch(batch, apiKey) {
  const userContent = batch.map((it, idx) =>
    `${idx + 1}. [${it.source}] ${it.title}\n摘要：${it.summary || '（无摘要）'}`,
  ).join('\n\n');

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `资讯列表（共 ${batch.length} 条）：\n\n${userContent}` },
      ],
      temperature: 0.3,
    }),
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
 * 批量 LLM 分类
 * @param {Array} items — 可信媒体条目
 * @param {string} apiKey — DashScope API key
 * @returns {Promise<Array|null>} 分类结果数组（与 items 等长），失败返回 null
 */
export async function llmClassify(items, apiKey) {
  if (!apiKey || items.length === 0) return null;

  const results = new Array(items.length).fill(null);
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    try {
      const parsed = await classifyBatch(batch, apiKey);
      for (let j = 0; j < batch.length && j < parsed.length; j++) {
        results[i + j] = parsed[j];
      }
    } catch (err) {
      console.warn(`[warn] LLM 分类批次 ${Math.floor(i / BATCH) + 1} 失败: ${err.message}`);
    }
  }

  // 全部失败则返回 null（回退关键词方案）
  if (results.every((r) => r === null)) return null;
  return results;
}
