# 项目约定

## 每次会话开始

先阅读以下背景文件，梳理项目背景，再开始干活：

1. `背景说明.md` — 北京市智能体引领发展若干措施的结构化整理
2. `为什么要创建这个网站.txt` — 政策原文解读（背景说明的原始来源）

## 项目背景（速览）

本项目围绕《北京市关于加快智能体引领发展的若干措施》建设网站，核心方向：

- 政策解读与知识库（10 条措施的结构化内容）
- Agentic AI 应用展示（Harness Engineering、FDE、OPC 等概念落地）
- Token 经济（TaaS / AaaS / RaaS，按价值计费）
- 标杆场景（科学、医疗、教育、政务、制造、文化）
- 安全与治理（分级监管、权限控制、提示词防护）

## 环境

- Node.js v24.9.0 免安装版，位于 `%LOCALAPPDATA%\Programs\nodejs\node-v24.9.0-win-x64`，已加入用户 PATH
- 若新终端找不到 `node`，重新打开终端窗口即可
- Git Bash 中使用 npm 前需先执行：`export PATH="$(cygpath -u "$LOCALAPPDATA")/Programs/nodejs/node-v24.9.0-win-x64:$PATH"`
- npm 安装依赖建议加镜像：`--registry=https://registry.npmmirror.com`

## 网站项目（AI 每日资讯静态站）

Astro 5 静态站，聚合中英 RSS 源的每日 AI 资讯。

结构：

- `scripts/fetch-news.mjs` — 抓取 RSS（36氪、少数派、InfoQ 中文、爱范儿、TechCrunch AI、VentureBeat AI、MIT Technology Review、The Verge AI、Ars Technica），输出 `src/data/news.json`（保留近 7 天、最多 100 条，按热度降序）
- `scripts/categorize.mjs` — 关键词内容分类，给每条资讯打 0~2 个内容标签（大模型、智能体、芯片算力、机器人、自动驾驶、政策监管、AI 安全、商业融资、开源、AI 应用，兜底 AI 动态），导出 `TAGS` 供首页筛选栏使用；另导出 `detectCompanies` 识别知名 AI 公司（OpenAI、Anthropic、Google、Meta、阿里、字节、DeepSeek 等 20 家），供「AI 公司动态」主题筛选
- `scripts/translate.mjs` — 英文资讯翻译为中文（titleZh/summaryZh），走阿里百炼 DashScope OpenAI 兼容接口（qwen-turbo，批量 10 条/次），需环境变量 `DASHSCOPE_API_KEY`，未设置则跳过保留英文；结果缓存 `src/data/translation-cache.json`（随仓库提交，按 link 去重，只翻新增）
- `scripts/fetch-policy.mjs` — 抓取工信部 + 北上广深汉五市经信局/工信局（委）官网的 AI 相关最新通知通告（六源均无 RSS：工信部走站内搜索 JSON 接口，五局均解析静态列表页；深圳市工信局 TLS 与 undici 不兼容，走 https 模块限定 P-256 曲线 + RSA 密钥交换的专用通道），按标题关键词（人工智能/智能体/大模型/算力/机器人等）过滤，合并去重按时间倒序取最新 5 条，输出 `src/data/policy.json`（随仓库提交）；单源失败不影响其他源
- `src/pages/index.astro` — 首页，新闻卡片 + 筛选栏：全部 / AI 日报（RSS 资讯中最新一天热度 Top 5）/ AI 公司动态（按公司分组的可展开视图：summary 显示公司名、动态数、最新一条标题，点开 `<details>` 看该公司全部动态，组内按时间降序）/ 最新资讯（policy.json 政策通知，统一打「最新资讯」标签、热度计 0 排在全部列表末尾）/ 各内容标签；翻译条目悬停标题可见英文原文
- `src/components/NewsCard.astro` — 新闻卡片组件（来源、内容标签、热度、时间、摘要），主列表与公司分组共用
- `src/pages/about.astro` — 关于页（含政策背景）
- `src/pages/security.astro` — 安全与治理页（政策第 7 条：运行时治理、分级监管、任务轨迹）
- `src/pages/feedback.astro` — 反馈页（标题「想说点什么」，字段：建议内容 + 可选邮箱），AJAX 提交到 Formspree，endpoint 常量 `FORMSPREE_ENDPOINT` 需替换为实际表单地址
- `src/layouts/Layout.astro`、`src/styles/global.css` — 布局与全局样式（经 Astro 内联打包）；主题切换：左下角浮动切换器（亮色/暗色/护眼），`data-theme` 挂在 `<html>` 上，localStorage 持久化，`<head>` 内联脚本防闪烁；主题变量见 global.css `:root[data-theme=...]`
- `.github/workflows/daily-update.yml` — 每天 UTC 0 点抓取并部署到 GitHub Pages；依次跑 fetch-news.mjs（读取 `secrets.DASHSCOPE_API_KEY`，需在仓库 Settings → Secrets 配置，否则新增英文资讯不翻译）和 fetch-policy.mjs（政策通知，无需密钥）

常用命令：

- `npm run fetch` — 手动抓取最新资讯（RSS 资讯 + 政策通知；单独跑用 `npm run fetch:news` / `npm run fetch:policy`）
- `npm run dev` / `npm run build` / `npm run preview`

注意：机器之心 RSS（jiqizhixin.com/rss）已失效返回 HTML，勿再加回。

## 部署状态（2026-07-23）

- 仓库 `pythonlol/chichihehe`（公开），线上地址：https://pythonlol.github.io/chichihehe/
- GitHub Pages 已开启（workflow 模式），推送 main 或每天 UTC 0 点自动构建部署
- 本机网络阻断 github.com，但 `.git/config` 已配 `url."https://ghfast.top/https://github.com/".insteadOf` 代理且 Windows 凭据管理器存有 ghfast.top 的 Token（2026-08-11 起普通 `git push` 可直接用）；**不要**再用 API 方式基于陈旧本地状态构造提交——2026-07-27 的 API 推送曾覆盖丢失主题切换等改动（已修复）
- 个人 Token 需同时具备 `repo` + `workflow` 权限，否则无法推送 `.github/workflows/` 下的文件

## 阿里云服务器部署（2026-07-24）

- 服务器：阿里云 ECS 华南2（河源），Alibaba Cloud Linux 3，公网 IP `47.120.70.114`，网站根路径直接访问：http://47.120.70.114
- 项目位置 `/opt/ai-news`，Node.js 在 `/usr/local/nodejs`，Nginx 站点配置 `/etc/nginx/conf.d/ai-news.conf`（默认 server 块已在 nginx.conf 中注释，备份 nginx.conf.bak）
- 每日更新：cron `0 8 * * *` 执行 `/opt/ai-news/update.sh`（依次跑 fetch-news.mjs + fetch-policy.mjs，ASTRO_BASE=/ 构建到根路径），日志 `/var/log/ai-news-update.log`；服务器无 git，文件靠 upload.mjs 上传同步
- 域名 `chichihehe.cc`（含 www）已完成备案（2026-07-27，备案号 `鄂ICP备2026038748号`，已悬挂在全站页脚并链接至 beian.miit.gov.cn），DNS A 记录（@ 和 www）指向 47.120.70.114，线上地址：https://chichihehe.cc
- 注意：本机执行 `ASTRO_BASE=/ npm run build` 等带 `/` 开头参数的命令前，必须先 `export MSYS_NO_PATHCONV=1`，否则 `/` 会被 MSYS 转成 `C:/Program Files/Git`，污染构建产物
- HTTPS 已上线（2026-07-27）：Let's Encrypt 证书，`certbot --nginx` 申请并自动改写 Nginx 配置（443 SSL + 80 跳转 301），覆盖 chichihehe.cc + www.chichihehe.cc，2026-10-25 到期，certbot 定时任务自动续期
- 注意：ECS 安全组入方向需放行 TCP 443（HTTPS 不通时先查安全组，再查服务器防火墙）
- 构建用 `ASTRO_BASE=/` 覆盖 base；GitHub Pages 仍用 `/chichihehe`（两处部署互不影响）
- 本机 SSH 工具：`.tmp/deploy/ssh.mjs`（执行远端命令）、`.tmp/deploy/upload.mjs`（上传文件），凭据在 `.tmp/deploy/config.json`（.tmp 已 gitignore）；Git Bash 中调用时必须 `export MSYS_NO_PATHCONV=1`，否则 `/opt/...` 参数会被转成 Windows 路径
