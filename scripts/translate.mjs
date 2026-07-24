// 英文资讯翻译：调用阿里百炼 DashScope（OpenAI 兼容模式）批量翻译标题和摘要
// 需要环境变量 DASHSCOPE_API_KEY；未设置时跳过翻译并保留英文原文
// 翻译结果缓存在 src/data/translation-cache.json（随仓库提交），按 link 去重，只翻新增条目
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = join(__dirname, '..', 'src', 'data', 'translation-cache.json');

const API = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'qwen-turbo';
const BATCH = 10;

async function translateBatch(texts, key) {
  const prompt = [
    '将下面 JSON 数组里的英文逐条翻译成自然流畅的中文新闻语言，保持数组顺序和长度不变。',
    '公司名、产品名、模型名保留原文（如 OpenAI、GPT-5）。仅输出 JSON 字符串数组，不要输出任何其他内容：',
    JSON.stringify(texts),
  ].join('\n');
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`DashScope HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const m = content.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('翻译响应不是 JSON 数组');
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr) || arr.length !== texts.length) {
    throw new Error(`翻译条数不符：期望 ${texts.length}，实得 ${arr.length}`);
  }
  return arr.map((s) => String(s).trim());
}

// 把 list 按 BATCH 分批翻译；某批失败时保留原文（返回 null 占位）
async function translateAll(texts, key) {
  const out = new Array(texts.length).fill(null);
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    try {
      const zh = await translateBatch(batch, key);
      for (let j = 0; j < zh.length; j++) out[i + j] = zh[j];
    } catch (err) {
      console.warn(`[warn] 翻译批次 ${i / BATCH + 1} 失败，保留原文: ${err.message}`);
    }
  }
  return out;
}

/**
 * 为 lang === 'en' 的资讯补充 titleZh / summaryZh（有缓存直接用缓存）
 * @param {Array<{link: string, lang: string, title: string, summary: string}>} items
 */
export async function translateEnglishItems(items) {
  const targets = items.filter((it) => it.lang === 'en');
  if (targets.length === 0) return;

  let cache = {};
  try {
    cache = JSON.parse(await readFile(CACHE, 'utf8'));
  } catch { /* 缓存不存在则从零开始 */ }

  const missing = [];
  for (const it of targets) {
    const c = cache[it.link];
    if (c && c.titleZh) {
      it.titleZh = c.titleZh;
      if (c.summaryZh) it.summaryZh = c.summaryZh;
    } else {
      missing.push(it);
    }
  }

  if (missing.length > 0) {
    const key = process.env.DASHSCOPE_API_KEY;
    if (!key) {
      console.warn(`[warn] 未设置 DASHSCOPE_API_KEY，${missing.length} 条英文资讯保留原文`);
    } else {
      console.log(`翻译 ${missing.length} 条英文资讯...`);
      const titles = await translateAll(missing.map((it) => it.title), key);
      const summaries = await translateAll(missing.map((it) => it.summary || ' '), key);
      missing.forEach((it, i) => {
        if (titles[i]) {
          it.titleZh = titles[i];
          const summaryZh = (summaries[i] || '').trim();
          if (it.summary && summaryZh) it.summaryZh = summaryZh;
          cache[it.link] = { titleZh: it.titleZh, ...(it.summaryZh ? { summaryZh: it.summaryZh } : {}) };
        }
      });
    }
  }

  // 裁剪缓存，只保留当前仍存在的条目，并写回
  const keep = new Set(targets.map((it) => it.link));
  const pruned = Object.fromEntries(Object.entries(cache).filter(([k]) => keep.has(k)));
  await mkdir(dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(pruned, null, 2), 'utf8');
}
