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

- `scripts/fetch-news.mjs` — 抓取 RSS（36氪、少数派、TechCrunch AI、The Verge AI、Ars Technica），输出 `src/data/news.json`（保留近 7 天、最多 100 条）
- `src/pages/index.astro` — 首页，按日期分组的新闻卡片 + 来源/语言筛选
- `src/pages/about.astro` — 关于页（含政策背景）
- `src/layouts/Layout.astro`、`src/styles/global.css` — 布局与全局样式（经 Astro 内联打包）
- `.github/workflows/daily-update.yml` — 每天 UTC 0 点抓取并部署到 GitHub Pages

常用命令：

- `npm run fetch` — 手动抓取最新资讯
- `npm run dev` / `npm run build` / `npm run preview`

注意：机器之心 RSS（jiqizhixin.com/rss）已失效返回 HTML，勿再加回。

## 部署状态（2026-07-23）

- 仓库 `pythonlol/chichihehe`（公开），线上地址：https://pythonlol.github.io/chichihehe/
- GitHub Pages 已开启（workflow 模式），推送 main 或每天 UTC 0 点自动构建部署
- **本机网络阻断 github.com**（api.github.com 和 codeload 可达）：普通 `git push` 不可用，需用 `.tmp/push-via-api.mjs` 走 Git Data API 推送（以远端 head 为父提交，本地与远端 commit sha 可能不一致，属正常现象）
- 个人 Token 需同时具备 `repo` + `workflow` 权限，否则无法推送 `.github/workflows/` 下的文件

## 阿里云服务器部署（2026-07-24）

- 服务器：阿里云 ECS 华南2（河源），Alibaba Cloud Linux 3，公网 IP `47.120.70.114`，网站根路径直接访问：http://47.120.70.114
- 项目位置 `/opt/ai-news`，Node.js 在 `/usr/local/nodejs`，Nginx 站点配置 `/etc/nginx/conf.d/ai-news.conf`（默认 server 块已在 nginx.conf 中注释，备份 nginx.conf.bak）
- 每日更新：cron `0 8 * * *` 执行 `/opt/ai-news/update.sh`（ASTRO_BASE=/ 构建到根路径），日志 `/var/log/ai-news-update.log`
- 构建用 `ASTRO_BASE=/` 覆盖 base；GitHub Pages 仍用 `/chichihehe`（两处部署互不影响）
- 本机 SSH 工具：`.tmp/deploy/ssh.mjs`（执行远端命令）、`.tmp/deploy/upload.mjs`（上传文件），凭据在 `.tmp/deploy/config.json`（.tmp 已 gitignore）；Git Bash 中调用时必须 `export MSYS_NO_PATHCONV=1`，否则 `/opt/...` 参数会被转成 Windows 路径
