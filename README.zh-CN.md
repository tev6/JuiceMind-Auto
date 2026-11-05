[中文](README.zh-CN.md) | English

# JuiceMind AI 答题助手

给 [play.juicemind.com](https://play.juicemind.com) 用的 Tampermonkey 脚本：识别页面上的题目，调用大模型 API 生成答案，再全流程、全自动地填回页面并提交。

[![CI](https://github.com/tev6/JuiceMind-Auto/actions/workflows/ci.yml/badge.svg)](https://github.com/tev6/JuiceMind-Auto/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.12.1-blue)](https://github.com/tev6/JuiceMind-Auto/commits/main)
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

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox）。
2. 点以下链接安装脚本，Tampermonkey 弹出安装页后点「安装」：

   **https://raw.githubusercontent.com/tev6/JuiceMind-Auto/main/juicemind-ai-assistant.user.js**

3. 打开JuiceMind的任意课程页，右侧会出现面板。没看到就按 `Alt + J`。

> 脚本只在应用端域名 `play.juicemind.com` 与 `classes.juicemind.com` 运行；营销站 `juicemind.com` 只有介绍页，不会注入面板。

## 配置

点面板里的「设置」：

| 填什么 | 例如 |
| --- | --- |
| API Base URL | `https://api.deepseek.com/v1`（也可先选「服务商预设」自动填） |
| API Key | `sk-...`（你自己的 key） |
| 模型 | 如 `deepseek-flash` |

点「保存」→「测试连接」，看到成功就能用了。

> 支持 OpenAI 兼容接口：OpenAI / DeepSeek / Moonshot / OpenRouter / xAI / Gemini / 本地 Ollama。

**测试连接时 Tampermonkey 弹窗？** 正常不会——脚本已经声明了跨域访问权限。要是还弹，说明你的 Tampermonkey 设成了严格模式，或者装的是老版本脚本：点 **Always allow domain** 只放行这一个 API 域名就够了；不想再看到就点 **Always allow**。

**高级设置**在设置页底部的折叠区，收着温度、最大 tokens、上下文长度、补充提示词、解释语言，以及「独立设置大模型输出语言」——默认不勾选，模型输出跟着右上角语言开关走；勾选后可以单独指定输出语言。

## 使用

| 场景 | 使用方法 |
| --- | --- |
| **一键完成整页** | 点「**一键完成本页**」 |
| 解多题 | `扫描页面` → `生成全部` → `填入全部` |
| 解单题 | `扫描页面` → 该题卡片上点 `生成` → `填入` |
| 纯教程页 | 切到「总结」一键生成速学笔记，或「对话」中问某个知识点 |

**一键完成本页**（v1.12.0 起）：答题页上方的整行按钮。每道题依次做四件事——填入答案、点提交、等结果、关弹窗。
**注意**：你调用的AI也可能犯错，虽然答案提交后站点就改不了了，但是如果答错脚本还会返回结果

当遇到 `已提交·答错` 标记，表明提交成功，但站点判定答案不正确
当遇到 `提交失败` 标记，表明没提交上去（可能是没找到按钮、按钮仍是禁用、接口报错等原因)

生成阶段仍然是一次请求答完整页；只有填入和提交是逐题做的。

### 快捷键

| 按键 | 作用 |
| --- | --- |
| `Alt + J`（Mac 为 `⌥ J`） | 收起 / 展开面板 |
| `Alt + Enter` | 生成全部 |
| `Alt + Shift + S` | 扫描页面 |

### 面板细节

如果扫描被收起，点击其上方可以展开看完整题干、全部选项和完整答案

页脚会显示本会话累计的 token 用量；请求进行中可点页脚右侧的「停止」中断，已生成的内容会保留。

悬浮窗可以拖：拖标题栏或底部移动整窗，收起后变成可拖动的圆钮。

## 常见问题

**面板没出现** — 脚本没启用，或不在 `play.juicemind.com` / `classes.juicemind.com` 下。刷新后按 `Alt + J`。

**401 / 403** — Key 或者 Base URL 填错

**`HTTP 400 ... supported API model names are ...`** — 你填的模型名这个接口不认

**扫不到题** — 等页面加载完再扫

**Tampermonkey 弹「跨域资源」授权窗** — 点 `Always allow domain` 放行这个 API 域名就行，见「配置」。

**提交后答案改不了了** — 站点就是这样。`已提交·答错` 表示提交成功但答案不对，只能知道结果。

## 开发

- `src/part1..6.js` 为源码分片，合并后便是 `juicemind-ai-assistant.user.js`
- 站点怎么选元素、怎么写进编辑器：见 [notes/site-analysis.md](notes/site-analysis.md)
- 改完 `src/` 后运行 `node scripts/build.mjs` 重新生成 bundle；CI 会校验两者是否一致
- 学生端会自动升级：脚本头带 `@updateURL`，Tampermonkey 每次检查到版本号变化就拉新版
- 本地测试：`npm i` → `npm test`（jsdom 154 项）、`npm run test:ui`（拖拽 / 隐藏 / 流式 / 一键全流程，需要本机 Chrome）
- 文档配图：`npm run shots` 用本地模拟页生成，不含任何个人信息
- 真实页验收与截图：把条目 ID 填进 `test/items.local.json`（模板 `test/items.example.json`，该文件不进仓库），再跑 `node test/real.js` / `node test/shots-real.js`

## 贡献

本脚本由作者基于 JuiceMind 中的 APCSP 课程进行测试，暂未验证 JuiceMind 其他课程的适配情况。因此，作者无法保证该脚本在其他课程中也能完整运行。

欢迎通过 PR 或 Issue 补充其他课程的适配、报告问题，或提出改进建议。

## 更新记录

完整历史见 [CHANGELOG.md](CHANGELOG.md)。

- **1.12.1** — 补全 `@connect` 域名声明，Tampermonkey 不再对已知服务商弹跨域授权窗
- **1.12.0** — **新增一键完成本页功能**——全流程从检测->生成->填入->提交，循环遍历所有题目
- **1.11.1** — 简单维护，修小错误
- **1.11.0** — 新增批量答题功能：一次请求答完整页（不含自动提交）；提示词继续精简（500→240 token）。5 题页面实测输入 1966→587 token（−70%）。
- **1.10.0** — **省 token 处理**：上下文按题截取，解析默认关闭，按题型设置 max_tokens。实测选择题单次相比上版本减少至约 −90%、简答题约 −55%。

## 许可与免责

MIT License，见 [LICENSE](LICENSE)。

项目仅供学习交流，请遵守所在学校的学术规范。
