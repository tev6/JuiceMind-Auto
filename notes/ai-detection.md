# JuiceMind 的「过程检测」调查

调查方法：① 分析 68 个前端 chunk（47 MB）里的关键字与调用点；② 登录后在真实页面用 CDP 枚举事件监听器、抓全部网络请求（含 WebSocket 帧）、注入键入/粘贴/整体改写，观察服务端行为。
结论先给：**没有发现任何 AI 内容检测或打字过程埋点**；但代码练习页是**协同编辑器**，每次改动都会作为操作流推到服务端并留下版本历史。

## 一、有没有 AI 检测 / 抄袭检测

| 检测项 | 结论 | 证据 |
| --- | --- | --- |
| AI 生成内容检测（AI 文本/代码判定） | **没有** | 全量搜索 `aiDetect / ai_generated / aiScore / detector / gptzero / originality` 无业务命中；唯一的 `Detector` 是 Sentry 内部类 |
| 抄袭 / 代码相似度 | **没有** | `plagiar / similarity / integrity` 无业务命中（`integrity` 只出现在 webpack 的 SRI 属性里） |
| 粘贴检测 | **没有** | 无 `pasteDetected / pastedText / pasteCount` 之类的上报；页面上的 `paste/copy/cut` 监听全部来自 CodeMirror 与 Tiptap 自身的编辑能力 |
| 打字节奏 / 击键统计 | **没有** | 无 `keystroke / typingSpeed / keystrokeCount` 上报；输入过程中除协同 WS 外**没有任何请求** |
| 第三方埋点（GA / PostHog / Mixpanel / Amplitude / Hotjar / FullStory） | **未启用** | 运行时 `window.gtag / posthog / mixpanel / amplitude / analytics / FS / hj` 全部 `undefined`；整段会话只有 tRPC 与协同 WS 两类请求 |
| 切屏 / 失焦监控 | **没有上报** | `visibilitychange` 命中都是 UI 组件（Sentry 会话、编辑器）用途；模拟 `visibilitychange` + `blur` 后新增请求数 = 0 |
| AI 批改 | 有，但只看**结果** | `aiGradingEnabled` 是题目的批改选项，作用于提交上来的文本，不看过程 |

有一处容易误读：chunk 里出现过 `preventCheating` —— 那是**老师端 AI 出题**的参数（生成练习时要求"防作弊设计"），与学生端监控无关。

## 二、但代码练习页确实有完整的编辑过程记录

代码练习不是普通输入框，而是一个 **CRDT 协同编辑器**（Yjs 风格），通过 WebSocket 实时同步：

```
{t:"push", channel:"collab-ide:d84ebee5-…/main.py", version:28,
 transforms:[{ clientID:"q0HEWmcv…_Joey Wu",
               changes:[20,[0,"print(\"bulk\")\n\n"],…] }]}
```

要点：

1. **每次改动都上报**，以操作（transform）为单位，带 `version` 递增序号；客户端断线重连后用 `{t:"sub", fromVersion:N}` 把缺的操作补回来 —— 说明**服务端保留操作历史**，不是纯内存。
2. `clientID` 里带**用户显示名**（本机实测形如 `…_Joey Wu`）。
3. IDE 面板里有 **History（显示 `10 / 10` 这样的版本计数）** 与 **Version History** 对话框（`29-i3aog1k7ow.js`），可以逐版本查看并 **Restore**。刷新页面后版本数依然存在 —— 历史来自服务端。
4. 因此"是不是打字打出来的"在最底层是可推断的：逐字输入会产生**多个小操作**；粘贴/程序化写入会产生**一个大操作**；用脚本整篇替换则是一条"从头到尾"的替换操作。
5. 平台另有面向教师的历史接口，例如 `snapHistory.getVersionContent({ teamId, itemId, projectType, studentId, generation })` —— 说明"按学生取版本历史"是既有能力，至少在 Scratch/Snap 项目里给教师开放。

## 三、提交时上报了什么

`teamsCodeFreeTextResponses.upsertAnswer` / `teamsCodeSubmissionResponses.upsertAnswer` 的入参是：

```js
{ userId, nodeId, teamId, code, imageUrl, mode, language }
```

**只有最终文本**，没有耗时、击键、粘贴次数、焦点切换等任何过程字段。客观题（选择题）同理，只存最终选项。

## 四、对我们这个脚本意味着什么

- 提交这一层是"只看结果"的，没有任何 AI 判定器参与。
- 唯一的痕迹在协同编辑器的操作流里：脚本用 `view.dispatch({changes:{from:0,to:doc.length,insert}})` 写入，是一条**整篇替换**操作，在版本历史里与"逐字打字"形状不同。
- 选择题、简答题不受此影响：它们没有操作流，只存最终答案。
- 判定与处置（是否查看、如何解释）取决于任课老师，脚本层面无法也无意规避。

## 五、复现方式

```powershell
$env:JM_EMAIL='...'; $env:JM_PASS='...'
node test/probe-ai-detect.js   # 监听器 + 输入过程网络
node test/probe-history.js     # History 控件与版本请求
```

（探针需要登录态；脚本不入库，属一次性调查工具。）
