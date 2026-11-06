[中文](README.zh-CN.md) | English

<p align="center">
  <img src="assets/icon/png/icon-app-128.png" width="96" alt="JuiceMind AI 答题助手">
</p>

# JuiceMind AI 答题助手

给 [play.juicemind.com](https://play.juicemind.com) 用的 Tampermonkey 脚本：识别页面上的题目，调用大模型 API 生成答案，再全流程、全自动地填回页面并提交。

[![CI](https://github.com/tev6/JuiceMind-Auto/actions/workflows/ci.yml/badge.svg)](https://github.com/tev6/JuiceMind-Auto/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.12.2-blue)](https://github.com/tev6/JuiceMind-Auto/commits/main)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![插件面板：扫描出题目并生成答案](docs/img/panel.png)

## 目录

- [功能](#功能)
- [安装](#安装)
- [配置](#配置)
- [使用](#使用)
- [常见问题](#常见问题)
- [开发](#开发)
- [贡献](#贡献)
- [更新记录](#更新记录)
- [许可与免责](#许可与免责)

## 功能

| 功能 | 说明 |
| --- | --- |
| **一键完成整页** | 检测 → 生成 → 填入 → 提交，逐题走同一套流程 |
| **批量答题** | 一次请求答完整页，5 题页面实测输入 token 降 70% |
| **省 token** | 上下文按题截取、解析默认关闭、按题型收紧 max_tokens |
| **拟人写入** | 代码题逐字敲进编辑器，随机节奏与停顿，不是一次整篇替换 |
| **总结速学** | 教程页压成速学笔记：一句总结、核心要点、关键词表、易错点、自测题 |
| **对话问答** | 带 Markdown 渲染、流式输出、一键复制代码块 |
| **中英一键切换** | 标题栏拨动开关，界面文字和模型输出语言一起切 |
| **题型覆盖** | 选择 / 多选 / 简答 / 论述 / 填空 + CodeMirror 编程题 + 内嵌 IDE |
| **悬浮窗** | 可拖动、可折叠成圆钮，页脚显示本会话 token 用量 |

![总结页：把一页教程压成速学笔记](docs/img/summary.png)

## 安装

### 方式一：一键安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox）。
2. 点以下链接安装脚本，Tampermonkey 弹出安装页后点「安装」：

   **https://raw.githubusercontent.com/tev6/JuiceMind-Auto/main/juicemind-ai-assistant.user.js**

3. 打开JuiceMind的任意课程页，右侧会出现面板。没看到就按 `Alt + J`。

### 方式二：手动粘贴

一键安装不灵，或者你想先看看代码再装：

1. 在浏览器里打开脚本源码：

   **https://raw.githubusercontent.com/tev6/JuiceMind-Auto/main/juicemind-ai-assistant.user.js**

2. 全选复制——记得连开头那段 `// ==UserScript==` 一起复制。
3. Tampermonkey：点工具栏图标 →「新建脚本」。
4. 删掉模板，粘贴，保存（Ctrl+S / Cmd+S）。
5. 打开JuiceMind的任意课程页。

> 手动粘贴的脚本照样能自动更新——脚本头带 `@updateURL`，Tampermonkey 会自己拉新版。要是没更新，去脚本的「设置」页勾上「检查更新」，见「常见问题」。

> 脚本只在应用端域名 `play.juicemind.com` 与 `classes.juicemind.com` 运行；营销站 `juicemind.com` 只有介绍页，不会注入面板。

## 配置

点面板里的「设置」：

| 填什么 | 例如 |
| --- | --- |
| API Base URL | `https://api.deepseek.com/v1`（也可先选「服务商预设」自动填） |
| API Key | `sk-...`（你自己的 key） |
| 模型 | `deepseek-flash` |

点「保存」→「测试连接」，就能用了。

> 支持 OpenAI 兼容接口：OpenAI / DeepSeek / Moonshot / OpenRouter / xAI / Gemini / 本地 Ollama。

## 使用

| 场景 | 使用方法 |
| --- | --- |
| **一键完成整页** | 点「**一键完成本页**」——检测 → 生成 → 填入 → 提交，逐题走同一套流程 |
| 解多题 | `扫描页面` → `生成全部` → `填入全部` |
| 解单题 | `扫描页面` → 该题卡片上点 `生成` → `填入` |
| 纯教程页 | 切到「总结」一键生成速学笔记，或在「对话」中问某个知识点 |

每道题的结果都会回报给你，你始终知道站点到底收没收这份答案。

快捷键：`Alt + J`（Mac 为 `⌥ J`）收起/展开 · `Alt + Enter` 生成全部 · `Alt + Shift + S` 扫描。

## 常见问题

**Tampermonkey 弹「跨域资源」授权窗** — 点 `Always allow domain` 放行这个 API 域名，或者点 `Always allow` 以后不再看到。脚本已经声明了跨域访问权限，只有装的是老版本脚本、或者 Tampermonkey 设成严格模式时才会弹。见「配置」。

**脚本没有自动更新** — Tampermonkey 大约一天才查一次 `@updateURL`，而且查到之后还要你点确认才会替换，所以新版本很容易被漏掉。想立刻拉最新版：打开 Tampermonkey 面板，对这个脚本点「检查更新」。如果是手动粘贴安装的，再打开脚本的「设置」页，确认勾上了「检查更新」，并且 Update URL 填的是那条 raw 链接。

**面板没出现** — 脚本没启用，或不在 `play.juicemind.com` / `classes.juicemind.com` 下。刷新后按 `Alt + J`。

**401 / 403** — Key 或者 Base URL 填错

**`HTTP 400 ... supported API model names are ...`** — 你填的模型名这个接口不认

**扫不到题** — 等页面加载完再扫

**卡片上的标记是什么意思？**

| 标记 | 含义 |
| --- | --- |
| `已提交` | 提交成功，站点判定正确（或待老师批改） |
| `已提交·答错` | 提交成功，但站点判定答案不正确 |
| `提交失败` | 没提交上去（没找到按钮 / 按钮仍是禁用 / 接口报错），卡片上会写明原因 |

**提交后答案改不了了** — 站点就是这样。`已提交·答错` 表示提交成功但答案不对，能做的只有知道结果。你调用的AI也可能犯错，这正是脚本把每道题的结果都回报给你的原因。

**「一键完成本页」具体做了什么？** 每道题依次：填入答案、点提交、等结果、关弹窗。生成阶段仍然是一次请求答完整页；只有填入和提交是逐题做的。

**进阶设置在哪？** 设置页底部的折叠区——温度、最大 tokens、上下文长度、补充提示词、解释语言，以及「独立设置大模型输出语言」（默认不勾选，模型输出跟着右上角语言开关走）。

**怎么展开收起的扫描、看 token 用量、挪面板？** 扫描收起后，点它上方可以展开看完整题干、全部选项和完整答案。页脚显示本会话累计的 token 用量，请求进行中可以点「停止」中断，已生成的内容会保留。拖标题栏或底部移动整窗，收起后变成可拖动的圆钮。

## 开发

- `src/part1..6.js` 为源码分片，合并后便是 `juicemind-ai-assistant.user.js`
- 站点怎么选元素、怎么写进编辑器：见 [notes/site-analysis.md](notes/site-analysis.md)
- 改完 `src/` 后运行 `node scripts/build.mjs` 重新生成 bundle；CI 会校验两者是否一致
- 发布循环：`node scripts/build.mjs --bump patch` 一次性改 `@version`、`VERSION`、`package.json` 并重建 bundle。CI 会在「bundle 变了但版本号没变」时拦下这次推送——Tampermonkey 只认版本号，没升号的发布学生端永远收不到
- 学生端会自动升级：脚本头带 `@updateURL`，Tampermonkey 每次检查到版本号变化就拉新版
- 本地测试：`npm i` → `npm test`（jsdom 154 项）、`npm run test:ui`（拖拽 / 隐藏 / 流式 / 一键全流程，需要本机 Chrome）
- 文档配图：`npm run shots` 用本地模拟页生成，不含任何个人信息
- 图标：设计稿在 `assets/icon/`——改 SVG 时保持坐标取偶数，再跑 `node assets/icon/render.cjs` 重新生成 PNG
- 真实页验收与截图：把条目 ID 填进 `test/items.local.json`（模板 `test/items.example.json`，该文件不进仓库），再跑 `node test/real.js` / `node test/shots-real.js`

## 贡献

本脚本由作者基于 JuiceMind 中的 APCSP 课程进行测试，暂未验证 JuiceMind 其他课程的适配情况。因此，作者无法保证该脚本在其他课程中也能完整运行。

欢迎通过 PR 或 Issue 补充其他课程的适配、报告问题，或提出改进建议。

## 更新记录

完整历史见 [CHANGELOG.md](CHANGELOG.md)。

- **1.12.2** — 新插件图标：两行正在被写下的文字 + 一支斜切光标，替换原来的四角星；Tampermonkey 面板里的脚本图标同步更新
- **1.12.1** — 补全 `@connect` 域名声明，Tampermonkey 不再对已知服务商弹跨域授权窗
- **1.12.0** — **新增一键完成本页功能**——全流程从检测->生成->填入->提交，循环遍历所有题目
- **1.11.1** — 简单维护，修小错误
- **1.11.0** — 新增批量答题功能：一次请求答完整页（不含自动提交）；提示词继续精简（500→240 token）。5 题页面实测输入 1966→587 token（−70%）。
- **1.10.0** — **省 token 处理**：上下文按题截取，解析默认关闭，按题型设置 max_tokens。实测选择题单次相比上版本减少至约 −90%、简答题约 −55%。

## 许可与免责

MIT License，见 [LICENSE](LICENSE)。

项目仅供学习交流，请遵守所在学校的学术规范。
