// 内容分类：按关键词给资讯打标签，供 fetch-news.mjs 使用
// 命中标题或摘要即计入，每条最多返回 2 个标签

const RULES = [
  ['大模型', ['大模型', '语言模型', 'llm', 'gpt', 'claude', 'gemini', 'qwen', '通义', '千问', 'deepseek', 'kimi', '文心', 'llama', 'mistral', 'grok', 'openai', 'anthropic', '推理模型']],
  ['智能体', ['智能体', 'agent', 'agentic', 'manus', 'copilot', 'autopilot', '自主任务']],
  ['芯片算力', ['芯片', '算力', 'gpu', 'nvidia', '英伟达', '昇腾', '台积电', 'tsmc', 'h100', 'h20', '数据中心', 'data center', '服务器', '推理卡']],
  ['机器人', ['机器人', 'robot', '具身', 'humanoid', '人形']],
  ['自动驾驶', ['自动驾驶', '智驾', 'self-driving', 'autonomous', 'waymo', 'fsd', 'robotaxi', '无人驾驶']],
  ['政策监管', ['政策', '监管', '法案', '禁令', 'regulation', 'policy', 'ban', '白宫', '欧盟', '出口管制', '备案', '合规', '制裁']],
  ['AI 安全', ['安全', '隐私', 'security', 'privacy', '漏洞', '攻击', '越狱', 'jailbreak', '泄露', '对齐', 'alignment']],
  ['商业融资', ['融资', '上市', 'ipo', '收购', '估值', '营收', 'funding', 'raises', 'billion', 'million', 'acquisition', 'investor', '股价', '市值']],
  ['开源', ['开源', 'open-source', 'open source', 'github', 'hugging face', 'huggingface']],
  ['AI 应用', ['应用', '助手', '生成', '视频生成', '图像', '绘画', '音乐', '编程', 'coding', '搜索', '办公', '教育', '医疗', '问诊', '写作', '翻译', 'app']],
];

// 知名 AI 公司识别：主题筛选「AI 公司动态」使用
// 展示名 -> 关键词（命中标题或摘要即算相关）
const COMPANIES = [
  ['OpenAI', ['openai', 'chatgpt', 'gpt-']],
  ['Anthropic', ['anthropic', 'claude']],
  ['Google', ['google', 'gemini', 'deepmind', '谷歌']],
  ['Meta', ['meta', 'llama', '扎克伯格']],
  ['Microsoft', ['microsoft', '微软', 'copilot']],
  ['xAI', ['xai', 'grok', '马斯克']],
  ['NVIDIA', ['nvidia', '英伟达', '黄仁勋']],
  ['Apple', ['apple', '苹果', 'siri']],
  ['百度', ['百度', '文心']],
  ['阿里巴巴', ['阿里', '通义', '千问', 'qwen']],
  ['字节跳动', ['字节', '豆包', 'doubao']],
  ['DeepSeek', ['deepseek', '深度求索']],
  ['月之暗面', ['月之暗面', 'kimi']],
  ['智谱', ['智谱', 'chatglm', 'glm-']],
  ['MiniMax', ['minimax', '海螺']],
  ['腾讯', ['腾讯', '混元']],
  ['华为', ['华为', '盘古', '昇腾']],
  ['科大讯飞', ['科大讯飞', '讯飞', '星火']],
  ['Mistral', ['mistral']],
  ['Perplexity', ['perplexity']],
];

/**
 * 识别资讯涉及的知名 AI 公司
 * @param {{title: string, summary?: string}} item
 * @returns {string[]} 公司展示名（0~3 个）
 */
export function detectCompanies(item) {
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  const found = [];
  for (const [name, keywords] of COMPANIES) {
    if (keywords.some((k) => text.includes(k))) {
      found.push(name);
      if (found.length === 3) break;
    }
  }
  return found;
}

// 筛选栏展示用：所有内容标签（含兜底），按定义顺序
export const TAGS = [...RULES.map(([tag]) => tag), 'AI 动态'];

/**
 * @param {{title: string, summary?: string}} item
 * @returns {string[]} 0~2 个内容标签
 */
export function categorize(item) {
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  const tags = [];
  for (const [tag, keywords] of RULES) {
    if (keywords.some((k) => text.includes(k))) {
      tags.push(tag);
      if (tags.length === 2) break;
    }
  }
  // 兜底：泛 AI 内容归入「AI 动态」；与 AI 无关的（汽车、数码、财经等）不打标签
  if (tags.length === 0 && (/\bai\b/.test(text) || text.includes('人工智能'))) {
    tags.push('AI 动态');
  }
  return tags;
}
