# 「击键级历史」到底记录了什么

结论先行：**文本题、选择题没有过程数据；代码题有**——它是协同编辑器，每次改动都以操作流实时上传，并且服务端保留版本、可回放。

本文分三层：官方声称 → 客户端实测 → 对插件的含义。

## 一、官方怎么说的

| 来源 | 原话 |
| --- | --- |
| Blog（Co-Founder, 2025-04） | Benefit #7 (Paid)：*"When a student completes an assignment, you're able to see every keystroke that the student has made. Additionally, we do flag plagiarized and 'Copy and pasted' responses."* |
| AP CSA 课程页 | *"Full Student History — See every keystroke a student made while completing an assignment. Plagiarised and copy-pasted responses are flagged."* + 单独一条 Benefit「Plagiarism Detection」 |
| IDE 产品页 | *"Catch students cheating — Disable copy and paste to reduce cheating, monitor the class in real time, and replay any submission using the history slider"* / *"Replay any submission step by step"* |

三点值得注意：

1. 都是 **Paid** 功能，默认不一定开启——但对班级是否开启不可知。
2. 措辞是"完成作业后"（when a student completes an assignment）——说明数据在提交时汇总给教师看。
3. "flag" 是**标记**，不是自动判分；最终处置仍在老师手里。

## 二、客户端实测（play.juicemind.com，学生账号）

### 2.1 代码题：确实实时上传

协同通道 `collab-ide:<docId>/main.py`，消息形如：

```json
{"t":"push","channel":"collab-ide:…/main.py","version":63,
 "transforms":[{"effects":[],"clientID":"<随机前缀>_<学生显示名>",
                "changes":[5,[0,"#"],…]}]}
```

每次推送带 `version`；断线重连用 `{"t":"sub","fromVersion":N}` 补齐历史 → **服务端有操作序列**。

实测三种写入方式的形状（一次 `push` ≈ 历史里的一步）：

| 操作 | 推送次数 | 每次内容 |
| --- | --- | --- |
| 真人敲 20 个字符（100ms/键） | **6 次** | 每帧 5~15 个 delta（客户端按 ~150ms 批量发送） |
| 脚本整篇替换（当前实现） | **1 次** | 1 个 delta：`[[88,"print(...)",""]]`（删除 88 字符 + 插入全文） |
| 分段写入（2 字符 / 70ms） | 4 次 | 多段小 delta |

编辑器底部还有 `data-testid="editor-history-bar"` 的 **1..N 滑块**，支持逐版本 restore；`snapHistory.listVersions / getVersionContent` 是另一套（Scratch/Snap 项目的 XML 快照，按 `studentId` 取）。

### 2.2 文本题（简答/论述）：打字过程中零上报

在简答题页真实键入 13 个字符：

```
打字期间新增 WS 帧: 0
打字期间新增请求:   0
```

也就是说，作答文本只存在于本地 DOM，**提交时才随 `upsertAnswer` 上传**：

```js
{ userId, nodeId, teamId, code, imageUrl, mode, language }
```

没有耗时、击键、粘贴次数字段。选择题同理，只存最终选项。

### 2.3 前端没有任何"检测"代码

- 无 `pasteDetected / keystroke / typingSpeed` 之类上报
- 无第三方分析 SDK（gtag/posthog/mixpanel/amplitude 在运行时都是 `undefined`）
- 模拟 `visibilitychange` / `blur` 后新增请求 = 0

所以"抄袭/AI 检测"不在浏览器里跑，只可能在后端与教师后台。

## 三、对插件的含义

### 3.1 不同题型的暴露程度完全不同

| 题目类型 | 过程数据 | 插件的痕迹 | 风险 |
| --- | --- | --- | --- |
| 选择题 / 多选 | 无（仅最终选项） | 一次 click | 低 |
| 简答 / 论述 / 填空 | 无（仅最终文本） | 一次 insertText | 低（但用时很短） |
| Parsons / 拖拽 | 无（仅最终顺序） | 若干次 click | 低 |
| **代码题（CodeMirror / IDE）** | **有，实时操作流** | **1 次 push，整篇替换** | **高** |

代码题这一条，和老师按下 `Ctrl+A → Ctrl+V` 在操作流里**完全同形**。而官方明确说会 flag「Copy and pasted」——所以我们现在的写法和被 flag 的目标特征一致。

### 3.2 还有一个非内容信号：节奏

服务端知道页面何时打开、何时提交。一次「打开 → 30 秒 → 提交 6 题」的时间分布，本身就是异常信号，与内容无关。当前 `autoRun`（自动扫描生成）+ 自动填入 + `autoSubmit` 的组合把这条信号放到最大。

### 3.3 什么不会被发现

- 没有任何"AI 生成"判定器，所以答案的**文风**不会被自动判为 AI（老师人工看是另一回事）
- 文本题没有过程数据，填入方式（键盘/脚本/粘贴）在服务端无法区分
- 我们不打字，但也不产生"异常击键"——因为我们根本不产生击键

## 四、可选的对策（按代价排序）

1. **代码题不自动写**：只在选择题/简答题用；代码题只给答案让学生自己敲。风险最低，功能损失最大。
2. **分段写入 + 拟人节奏**：把代码按 3~8 字符切片，每片间隔 40~120ms 随机，偶发"打错再退格"、随机移动光标。实测能把 1 次整篇替换变成多帧小 delta；但**仍不是逐键**（每帧 5~15 delta 的批量特征仍在），也解释不了"零错误、零回改"。
3. **只降低节奏异常**：去掉自动提交、加随机等待、不连续刷题。对内容层帮助为零，对时间分布有帮助。
4. **保持现状**：文本题基本安全；代码题风险自负。

诚实结论：只要用脚本写代码题，就一定会留下"整篇一次性替换"的操作流；能不能完全伪装成手打，取决于服务端到底存到多细的粒度（客户端看不到），**无法保证**。

## 五、复现方式

```powershell
$env:JM_EMAIL='…'; $env:JM_PASS='…'; $env:JM_CLASS_URL='…'
node test/probe-ops2.js   # 打字 vs 整篇替换的推送形状
node test/probe-text.js   # 简答题打字是否上报
```

（探针需要登录态，未入库。）
