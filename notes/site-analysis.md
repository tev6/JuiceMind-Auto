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
- 练习题有两种形态：
  - **改错题**（Hello World Repair）：编辑器里是一段有语法错的代码，题面说要修好它；
  - **补空题**（Cheer Squad）：编辑器里是 `for i in _____(7):` 这种带下划线空位的模板，题面说「补全空位」。
  两种都要**输出整段完整程序**——编辑器是整段覆盖的，只回一个空位的填法（`range`）会把程序冲掉。
  脚本侧：提示词要求输出整段程序（v1.14.2），另外模型万一只回一截，
  会把那一截**拼回原始代码**（`for i in _____(7):` + `range` → `for i in range(7):`）。

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

## 选择题：站点到底怎么记答案（2026-11-06 从打包产物里读出来的）

站点的选择题是 **React 受控组件**，答案状态只有一个数组：

```jsx
// 站点源码（压缩后还原）
<input aria-label={`Choice ${i+1}`}
       checked={selectedChoices.includes(choice.id)}   // 受控：勾没勾由状态决定
       name="choices"
       onChange={e => setSelectedChoices([choice.id])}  // 单选：整个数组换掉
       type={allowMultipleAnswers ? 'checkbox' : 'radio'} />
```

要点：

1. **提交按钮的 disabled 就是「有没有选」**：`disabled={0 === selectedChoices.length}`（再叠一个 `canSubmit`）。
   所以「按钮解禁」= 页面收下了答案 —— 这是脚本唯一可信的信号，比看 DOM 的 `checked` 靠谱。
2. **React 给每个 input 挂了「值追踪器」**（`_valueTracker`，记的是 `checked`）。
   - `input.checked = true` 这种赋值会**同时改掉追踪器**，于是 React 下次比较时认为「值没变」，
     `onChange` 不触发 → 站点状态不变 → 按钮一直禁用。
     **脚本以前那句「赋值 + 派发 input/change」的兜底，恰恰把状态锁死了。**
   - 浏览器的激活行为（`input.click()`）改的是 checkedness，**不经过 JS 属性 setter**，追踪器不变 ——
     所以 React 能看到变化。**这才是唯一可靠的点击方式。**
   - 「点已经勾上的那个」DOM 不变 → React 也看不到变化 → 必须先取消勾选再点。
3. **`name="choices"` 每道题都一样**，但每道题各自有 `<form>`，所以浏览器层面的单选组是按 form 分开的；
   React 自己的恢复逻辑也只处理**同一个 form** 里的 radio。
4. 题干和每个选项各是一个嵌套的 `.mcqtitle`；第一个 `.mcqtitle` 是题干（它在 `<form>` 外面）。

> 结论（脚本侧）：勾选项只做「真实点击 + 验证」，绝不赋值 `.checked`；
> 提交前轮询等按钮解禁，没解禁就把选项再点一次。

## 条目的四种状态（2026-11-06 从打包产物里读出来的）

站点给每个条目（以及每道题）一个状态，枚举和文案都在打包产物里：

| 状态 | 进度面板上的文案 | 意思 | 还能提交吗 |
| --- | --- | --- | --- |
| `notStarted` | `No submission` | 没交 | 能 |
| `inProgress` | `In progress` | 存了答案，还没交 | 能 |
| `waitingForReview` | `Needs grading` | **交了，等老师批** | **不能** |
| `reviewed` | `Graded` | **已批改** | **不能** |

关键点：

- 「Submit Answer」的 `disabled` 来自页面的 **`canSubmit`**（来自条目的 activity state），
  加上 `disabled={0 === selectedChoices.length}` —— 一旦交过，前者就一直为 false，
  **按钮永久禁用，点它没有任何意义**。
- 交过之后，题目的提交栏里按钮会被换成状态词：`Review pending` / `View grade` / `Approval pending`；
  管理员视角还多一个 `Unsubmit`（"Reopens the answer for editing and removes its JuiceMind grade."）。
- 右侧进度面板里有一个**状态徽章**，叶子节点，文字正好是 `Needs grading` / `Graded`
  （页面上显示成大写是 CSS `text-transform`，DOM 里是首字母大写）。
- 右边面板另有一个 `Review pending` 按钮 —— 别把它当成浮层（见上面「提交」一节的第 3 条）。

> 脚本侧（v1.13.0 起）：认出这些状态就直接跳过，**不填、不点按钮**，如实告诉用户。

## 「交过没有」到底看哪里（2026-11-10 真页实测，v1.14.1 修）

v1.13.0 判断「这道题交过没有」用了两条信号，**两条都是错的**，
结果是「一键完成本页」只做完第一题，后面的全被当成「已提交过·跳过」。

真实样本（2026-11-10 登录后逐页 dump）：

| 条目 | Q1 | Q2 | Q3 |
| --- | --- | --- | --- |
| 3.1.5 The JuiceMind IDE | 已交（`Review pending`） | **没交** | **没交** |
| 3.1.2 What Is Code? | 已交（`Review pending`） | 已批改（`View grade`） | **没交** |

三个关键事实：

1. **状态词在「这道题自己的节点」里**（`.react-renderer.node-xxx`）。
   题目的**父层是整篇课件正文**（`.tiptap.ProseMirror`），里面躺着**别的题**的状态词。
   以前 `ownStatus()` 连父层一起搜 → 第一题一交，后面每一题都从正文里捡到那个
   `Review pending` → 全被误判成「已提交过」。**只在自己的节点里搜。**

2. **交过的题，提交栏里同时留着两个按钮**：
   状态词（`View grade` / `Review pending` / `Approval pending` / `Unsubmit`）
   **和一个永久 disabled 的 `Submit Answer`**。
   所以「按钮 disabled」根本不能当「已提交」的证据。

3. **没填答案的题，`Submit Answer` 也是 disabled** ——
   站点规则 `disabled={0 === selectedChoices.length}`，没选答案就禁用。
   于是 v1.13.0 那条「整页徽章说交了 **且** 按钮点不动 → 算交过了」的兜底，
   在「第一题刚交完」时对**每一道还没答的题**都成立 → 整页被跳过。

   实测填了答案之后按钮会解禁（`disabled: true → false`），
   **站点并没有锁住整页**，是可以一道一道往下做的。

4. **进度面板的徽章是「条目」的状态，不是某道题的状态**：
   页面里只要有一道题交了，它就变成 `Needs grading`。
   拿它判断某一道题 → 误伤。只能用来做提示。

> 脚本侧（v1.14.1 起）：判断某道题交没交，**只看它自己节点里的状态词**；
> 整页徽章只用于提示，不参与逐题判断。

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

   > 2026-11-06 补充：上面第 2 条的「赋值 + 派发事件」其实是**有害**的 —— 赋值会改掉 React 的值追踪器，
   > 之后真正的点击会被吞掉。正确做法见上面「站点到底怎么记答案」一节。


## 其它

- 站点还嵌了 Code.org 的 Game Lab / animation-library 资源（`/api/v1/animation-library/...`），与答题无关。
- 可用的测试钩子：`data-testid="lesson-body-editor"`、`multiple-choice-question`、`short-answer-prompt-editor`、`short-answer-response-editor`、`ide-panel`、`ide-tab`、`ide-panel-layout`、`code-block-content`、`activity-type-icon`、`editor-history-bar`。
- 左侧导航是虚拟滚动树（`role="treeitem"`，行用 absolute 定位），换页后会折叠，抓取时要重新展开。
