# 插件图标 · JuiceMind 助手

## 概念

**两行刚写下的文字 + 一支斜切光标。**

插件做的事是「把答案写进页面」，所以图形取「正在被写下」这一瞬间，而不是静态的文档或聊天图标：
两行文字长短不一（像刚敲出来的两行），右侧一支倾斜的光标，角度接近笔尖落纸的方向。

避开的三类常见做法：魔法棒/星星（AI 通用套路）、对话框（助手套路）、机器人/大脑（AI 套路）。
斜面是这套图形唯一的"签名"，让它在小尺寸下也不容易和「左对齐」类图标混淆。

## 规格

- 画布：32×32 网格，所有坐标取**偶数**——缩到 16px（恰好 0.5×）时落在整像素上，不会糊
- 笔画：文字行高 4（16px 时 2px），圆角 2；光标宽 4、高 20、倾斜 2 单位（≈5.7°）
- 颜色：品牌紫 `#4f46e5 → #9333ea`（取自 JuiceMind 站点主色）
- 图形用 `currentColor`，白底/深底/紫底都只需改文字颜色
- 16px 有单独的像素对位版本（`icon-app-16.svg`），不是缩小版

## 文件

```
icon.svg          独立图形，currentColor（面板内直接当 logo 用）
icon-app.svg      应用图标：紫渐变圆角底 + 白色图形（扩展/收藏夹/README）
icon-app-16.svg   16px 手工对位版（1px 圆角、2px 笔画、整数坐标）
png/              icon-{16,32,48,128,256}.png、icon-app-{...}.png
preview.html      所有尺寸与真实场景预览（浏览器直接打开）
preview.png       preview.html 的截图
render.cjs        重新生成 PNG：node assets/icon/render.cjs
```

## 用法

面板头部 / 收起圆钮（白色图形）：

```html
<img src="icon-app-48.png" width="19" height="19" style="filter:brightness(0) invert(1)">
```

或直接内联（跟随主题色）：

```html
<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor">
  <rect x="2" y="10" width="16" height="4" rx="2"/>
  <rect x="2" y="18" width="12" height="4" rx="2"/>
  <path d="M22 6h4l2 20h-4z"/>
</svg>
```

Tampermonkey 元数据（图标随脚本一起分发）：

```
// @icon         https://raw.githubusercontent.com/tev6/JuiceMind-Auto/main/assets/icon/png/icon-app-128.png
```

页面 favicon（注入）：

```js
const link = document.createElement('link');
link.rel = 'icon';
link.href = 'https://raw.githubusercontent.com/tev6/JuiceMind-Auto/main/assets/icon/png/icon-app-32.png';
document.head.appendChild(link);
```

## 设计过程（可复现）

1. 先出四版候选：切角卡片 + 光标、圆角卡片 + 光标、两行文字 + 光标、取景框 + 光标
2. 在 128/48/32/16 四种尺寸下渲染比对：
   - 卡片类在 16px 会退化成「小方块」，辨识度靠不住
   - 取景框在 16px 四角糊成一团
   - 两行文字 + 光标在 16px 依然清晰 → 选它
3. 再试「光标打断一行」「问号环 + 光标」「半框 + 光标」：前者像加号、后者像问号/括号，都被否掉
4. 最终把坐标对齐到偶数网格，并为 16px 单独做像素对位版本

## 注意

- 改图形时保持偶数坐标，否则 16px 会出现 0.5px 模糊
- `icon.svg` 用 `currentColor`，不要在文件里写死颜色；应用图标版本单独维护
- PNG 全部由 `render.cjs` 生成，不要手工改 PNG
