# JuiceMind 的「过程检测」调查

调查方法：① 分析 68 个前端 chunk（47 MB）里的关键字与调用点；② 登录后在真实页面用 CDP 枚举事件监听器、抓全部网络请求（含 WebSocket 帧）、注入键入/粘贴/整体改写，观察前端与网络行为。

**结论范围**：下文说的"没有"全部指**前端**。服务端收到提交后做了什么，前端看不到，无法从客户端代码断定。

一句话：**前端没有 AI 内容判定、没有击键/粘贴埋点、没有第三方分析 SDK**；但代码练习页是**协同编辑器**，每次改动都会作为操作流推到服务端并留下版本历史，因此"过程"在服务端是存在的，只是前端不拿它做判定。

## 一、前端有没有 AI 检测 / 抄袭检测

| 检测项 | 前端结论 | 证据 |
| --- | --- | --- |
| AI 生成内容检测（AI 文本/代码判定） | 没找到 | 全量搜索 `aiDetect / ai_generated / aiScore / detector / gptzero / originality` 无业务命中；唯一的 `Detector` 是 Sentry 内部类 |
| 抄袭 / 代码相似度 | 没找到 | `plagiar / similarity / integrity` 无业务命中（`integrity` 只出现在 webpack 的 SRI 属性里） |
| 粘贴检测 | 没找到 | 无 `pasteDetected / pastedText / pasteCount` 之类上报；页面上的 `paste/copy/cut` 监听全部来自 CodeMirror 与 Tiptap 自身的编辑能力 |
| 打字节奏 / 击键统计 | 没找到 | 无 `keystroke / typingSpeed` 上报；输入过程中除协同 WS 外没有任何请求 |
| 第三方埋点（GA / PostHog / Mixpanel / Amplitude / Hotjar / FullStory） | 未启用 | 运行时 `window.gtag / posthog / mixpanel / amplitude / analytics / FS / hj` 全为 `undefined`，整段会话只有 tRPC 与协同 WS 两类请求 |
| 切屏 / 失焦监控 | 没有上报 | 模拟 `visibilitychange` + `blur` 后新增请求数 = 0 |
| AI 批改 | 有，但只看结果 | `aiGradingEnabled` 作用于已提交的文本，不参与过程 |

容易误读的一处：chunk 里的 `preventCheating` 是**老师端 AI 出题**的参数（生成练习时要求"防作弊设计"），与学生端监控无关。

## 二、前端确实会把编辑过程发出去

代码练习不是普通输入框，而是 **CRDT 协同编辑器**（Yjs 风格），通过 WebSocket 实时同步：

```
{t:"push", channel:"collab-ide:<docId>/main.py", version:28,
 transforms:[{ clientID:"q0HEWmcv…_<显示名>",
               changes:[20,[0,"print(...)\n"],…] }]}
```

1. 每次改动都以操作（transform）为单位上报，带递增 `version`；断线重连用 `{t:"sub", fromVersion:N}` 补操作，说明**服务端保留操作历史**。
2. `clientID` 含用户显示名。
3. IDE 面板有 `History N / N` 与 **Version History** 对话框，可逐版本查看并 **Restore**；刷新后计数仍在，历史不来自内存。
4. 因此"逐字输入（多个小操作）"与"粘贴/程序化写入（一个大操作）"在操作流里形状不同。
5. 平台另有教师向历史接口，如 `snapHistory.getVersionContent({ teamId, itemId, projectType, studentId, generation })`。

## 三、提交时上报了什么

`teamsCodeFreeTextResponses.upsertAnswer` / `teamsCodeSubmissionResponses.upsertAnswer`：

```js
{ userId, nodeId, teamId, code, imageUrl, mode, language }
```

只有最终文本，没有耗时、击键、粘贴次数、焦点切换等字段。客观题同理，只存最终选项。

## 四、能不能断定"教师侧看不到异常"

不能。可观察的只有前端；教师后台若基于服务端数据（提交时间、版本历史条数、操作粒度）做统计或人工复核，我们从客户端代码里是看不到的。这类能力与"前端埋点"是两件不同的事。

## 五、这条结论的边界

- 只覆盖本次抓到的 68 个 chunk 与登录后的一次会话；站点更新后需重测。
- 服务端算法、日志、教师后台的展示字段均不在可见范围内。
- 若需要更确定的答案，只能从学校/教师侧确认，或对比"同样答案、不同输入方式"两次提交的评分差异。
