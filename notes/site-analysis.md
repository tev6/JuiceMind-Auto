# play.juicemind.com 站点结构笔记

结论来自两轮实测：① 拉取 `/classes/<teamId>` 的 HTML 与 68 个 `_next/static/chunks/*`（Next.js + Turbopack）静态分析；② 登录后逐页点开 18 个条目，dump 真实 DOM 并试写入。
**改动脚本前先核对这里，尤其是「nodeView」那一节——静态产物里的 `data-*` 属性在真实 DOM 里是不存在的。**

## 路由

从打包产物里的路由表（`{"path":...,"regex":...}`）提取，共 25 条，学生相关的：

| 路径 | 用途 |
| --- | --- |
| `/classes/:teamId` | 班级/课程首页，左侧（虚拟滚动）导航树 + 条目列表 |
| `/classes/:teamId/item/:itemId` | 教学条目：教程、选择题、简答、编程练习、内嵌 IDE 都在这里 |
| `/quizzes/:quizId` | 测验 |
| `/gameRoom/:gameRoomId` | 实时竞赛 / 答题房 |
| `/course-router/:courseId/:itemId*?`、`/course/:classroomId/:slug*?` | 公开课程浏览 |

页面是纯客户端渲染（SSR 只给了一个空壳），内容随 RSC 下发；`/api/trpc/*` 只承载用户、时间、设置这类事务。

## 内容模型：Tiptap nodeView（**关键**）

课件正文是 Tiptap 文档，每个自定义节点用一个 React nodeView 渲染，**外层类是 `react-renderer node-<节点名>`**：

```html
<div class="react-renderer node-multipleChoiceQuestion" contenteditable="false" draggable="true">
  <div data-testid="multiple-choice-question" data-node-view-wrapper>
    <div class="mcqtitle"> <div class="tiptap ProseMirror">题干…</div> </div>
    <form>
      <div class="mb-2.5 …"><input type="radio" name="choices" aria-label="Choice 1"> …选项内容…</div>
      …
    </form>
    <button><span>Submit Answer</span></button>
  </div>
</div>
```

要点：

- 打包产物里的 `parseHTML: [{tag:"div[data-multipleChoiceQuestion]"}]` 只是**编辑器序列化**用的占位，live DOM 里**没有**这些 `data-*` 属性。按它们写选择器会一道题都找不到（这正是 v1 的 bug）。
- 题干和每个选项各自是一个**嵌套的 mini `.ProseMirror`**，所以 `document.querySelectorAll('.ProseMirror').length` 会远大于 1；外层那个才是正文。
- 每道题都有**自己的 `<form>`** 和自己的 `Submit Answer` 按钮；单选的 `<input type="radio" name="choices">` 在所有题里**同名**，按 `name` 分组会把 6 道题合成 1 道（v1 的第二个 bug）。

实测出现过的节点类型（18 个条目里）：

| 类名 | 题型 | 结构要点 |
| --- | --- | --- |
| `node-multipleChoiceQuestion` | 选择题 | 题干 `.mcqtitle`（第一个）+ `form input[type=radio]`，选项文本在同级 `.mcqtitle` 里，可能是 `node-codeBlock` |
| `node-shortAnswer` | 简答 | `[data-testid="short-answer-prompt-editor"]` 题干；`[data-testid="short-answer-response-editor"] [contenteditable="true"]` 答案区（Tiptap，空态有 placeholder） |
| `node-fillInTheBlank` | 填空 | 同上，答案也落在可编辑区 |
| `node-ide` | 编程 | 内嵌 `[data-testid="ide-panel"]`，题面在**该节点上方的正文**里 |
| `node-codeBlock` | 纯展示 | 只读代码块，**不是题目**（不能当编程题收） |
| `node-imageBlock` / `node-tip` | 展示 | 同上 |

未在该班级出现、但 bundle 里存在的类型：`codeSubmission`、`codeFreeText`、`parsons`、`dragAndDrop`、`tableSelect`、`freeText`、`reveal`、`fileUpload`、`buttonDrag`、`diffNode`、`tableOfContent`、`adminNote`、`codeSelect`、`comingSoon`、`embed`、`simulation`、`htmlNode`、`cyberRange`。脚本按 `node-<名>` 统一映射，不用为每个都写死。

## 编程练习页

练习题（Exercises 里的 Hello World Repair / Welcome Banner 等）是**两栏布局**：

- 左：`[data-testid="lesson-body-editor"]`（就是正文 `.ProseMirror`），题面写在这里；
- 右：页面级 `[data-testid="ide-panel"]`，含 `[data-testid="ide-tab"]`（main.py）、`[data-testid="ide-panel-layout"]`，代码编辑器是 **CodeMirror 6**（`.cm-editor`），**不是 Monaco**；
- IDE 是**异步挂载**的：进页面 2~3 秒内可能只有一个 `node-ide` 显示 `Loading…`，此时扫描应该跳过而不是造一道空题（脚本会等编辑器出现再重扫一次）。

## 写入方式（实测）

| 目标 | 可用方法 | 备注 |
| --- | --- | --- |
| CodeMirror 6 | `contentDOM.cmView.view.dispatch({changes:{from:0,to:doc.length,insert:text}})` | `.cm-content.cmView.view` 就是 `EditorView`，最稳 |
| CodeMirror 6（兜底） | 对 `.cm-content` 派发 `ClipboardEvent('paste')` + `DataTransfer` | 实测有效；`execCommand('insertText')` 在 CM6 里**无效**（返回 false） |
| Tiptap 可编辑区 | 选中全部 + `document.execCommand('insertText', false, text)` | 实测有效；paste 会**追加**而不是替换，只能当兜底 |
| 选择题 | `input.click()` | 勾上后 `:checked` 计数与站点状态一致 |
| 提交 | 每道题自己的 `Submit Answer` 按钮 | 无选项/无内容时按钮是 `disabled`，点之前要等一下 |

## tRPC 接口

`/api/trpc`，后端 `classes.juicemind.com/trpc`。学生侧相关过程名：

- `teamItems.getStringifiedContent({ teamsCourseItemId })` → `{ content }`，整份课件 Markdown
- `teamItems.getItem` / `teams.getTeamPageData` / `classes.getContentTree`
- `teamsCodeFreeTextResponses.upsertAnswer({ userId, nodeId, teamId, code, imageUrl, mode, language })`
- `teamsCodeSubmissionResponses.upsertAnswer(同上)`
- `teamsParsonsSubmissions.save/get`
- `teamsQuestionSubmissions.*`（`listForQuestionUser`、`setApproval`、`upsertStudentContest`…）
- `aiGeneration.*`（站点自带 AI 出题）

脚本对它们**只旁听不调用**（在 `fetch` / `XHR` 上挂只读钩子），避免猜写入参数；答案一律走 DOM。

## 主题变量（脚本玻璃窗取色来源）

```css
:root {
  --primary-color:#4f46e5; --secondary-color:#9333ea;
  --background:#fff; --surface:#fff;
  --text-primary:#1a1a1a; --text-secondary:#000000b3; --text-muted:#00000080;
  --border:#4f46e533; --card-bg:#4f46e50d; --highlight-bg:#4f46e514;
  --success:#10b981; --error:#ef4444; --shadow:#0000001a;
}
[data-theme=dark] {
  --background:#0a0a0a; --surface:#1a1a1a; --text-primary:#fff;
  --border:#4f46e54d; --card-bg:#4f46e51a;
}
```

亮暗判定读 `--background` 的相对亮度（<0.42 视为深色），不依赖类名。

字体：正文 Roboto / Assistant，代码 Roboto Mono。IDE 另有一套 `--ide-*` 变量挂在 `<html>` 上（Dracula 配色）。

## 提交（实测 2026-11-05）

点完 `Submit Answer` 之后，站点会弹一个 **MUI 浮层**（`class="MuiModal-root"`），它会挡住下一题的提交，必须关掉。实测三个状态：

| 状态 | 标题 | 里面有什么 | 能不能关 |
| --- | --- | --- | --- |
| 评分中 | `#modal-title` = `Grading submission` | `.MuiCircularProgress-root`（`role="progressbar"`）转圈 | **不能**，只能等它自己换成结果面板 |
| 客观题结果 | `Result` 徽章 + `Correct` / `Incorrect` + 提交时间 | 右上角一个圆钮，里面只有 `<svg data-testid="CloseIcon">` | 能 |
| 主观题结果 | `Needs grading` + "This submission needs to be graded by the teacher." | 同上 | 能 |

关键细节（踩过的坑）：

1. **关闭按钮平时是隐形的**：`<button class="absolute top-5 right-5 ..." style="opacity: 0;">`，鼠标移上去才显形，但照样能点。它是**唯一**能关掉结果面板的途径——遮罩是 `aria-hidden="true"` 的，点它不关；这不是 MUI `Dialog`（只是 `Modal`），Esc 同样不生效。
2. **别用整块 textContent 匹配结论词**：结论徽章和标题是相邻元素，`textContent` 会粘成 `IncorrectResult`，`\b` 对不上。要逐个元素读文本（`src/part4.js` 的 `SubmitFlow.readState`）。
3. **页面上另有一个 "Review pending" 按钮**（右侧进度面板），不是弹层。按 "pending request" 两个字匹配才能避开它。

## 选择题的两个坑（实测）

1. **站点会给每道题预勾第一个选项**（DOM 里 `checked` 为真），但 React 状态里还没有值——所以「Submit Answer」一开始是 `disabled`。
2. **点「已经勾上的那个」不会触发 change**：DOM 不派发 change，React 的 `onChange` 也不触发，站点状态不更新，提交按钮就一直禁用。实测四种写法（`input.click()`、完整指针序列、点整行、赋值 + 派发事件）全都无效——**唯一有效的办法是先把勾选清掉再点**，让 React 看到一次真实的变化。脚本的 `Appliers.clickOption` 现在就是这么做的。

## 其它

- 站点还嵌了 Code.org 的 Game Lab / animation-library 资源（`/api/v1/animation-library/...`），与答题无关。
- 可用的测试钩子：`data-testid="lesson-body-editor"`、`multiple-choice-question`、`short-answer-prompt-editor`、`short-answer-response-editor`、`ide-panel`、`ide-tab`、`ide-panel-layout`、`code-block-content`、`activity-type-icon`、`editor-history-bar`。
- 左侧导航是虚拟滚动树（`role="treeitem"`，行用 absolute 定位），换页后会折叠，抓取时要重新展开。
