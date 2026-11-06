/* 视觉验收：用本机 Chrome 渲染模拟页面 + 注入脚本 + 假模型响应，截图。
 * 运行：node test/shot.js
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'shots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const script = fs.readFileSync(path.join(ROOT, 'juicemind-ai-assistant.user.js'), 'utf8');
const pageUrl = 'file:///' + path.join(__dirname, 'visual.html').replace(/\\/g, '/');


/* 假模型：对话返回 Markdown 内容，用来验证渲染与复制按钮 */
const MD_ANSWER = [
  '## while 和 for 的区别',
  '',
  '**while** 按条件重复，**for** 按序列遍历：',
  '',
  '- `while`：条件为真就一直跑，容易写成死循环',
  '- `for`：次数确定时更省心',
  '',
  '> 记住：while 里一定要记得改循环变量。',
  '',
  '```python',
  'i = 0',
  'while i < 3:',
  '    print(i)',
  '    i += 1',
  '```',
  '',
  '| 循环 | 适用场景 |',
  '| --- | --- |',
  '| while | 次数未知 |',
  '| for | 次数已知 |',
].join('\n');

async function installMock(page) {
  await page.evaluate((mdAnswer) => {
    const summaryMd = [
      '## 一句话总结',
      '循环让同一段代码重复执行，Python 有 while（按条件）和 for（按序列）两种。',
      '',
      '## 核心要点',
      '- `while` 在条件为真时持续重复，容易写成死循环',
      '- `for` 按序列逐个取值，次数确定时更省心',
      '- 循环体内必须改变循环变量，否则条件永远成立',
      '- 缩进决定循环体的范围',
      '',
      '## 关键术语',
      '| 术语 | 含义 |',
      '| --- | --- |',
      '| 循环变量 | 控制循环是否继续的量 |',
      '| 循环体 | 每次迭代执行的代码块 |',
      '',
      '## 易错点',
      '- 忘记 `i += 1` 导致死循环',
      '- 循环体缩进不一致',
      '',
      '## 自测',
      '1. `while` 和 `for` 各适合什么场景？（次数未知 / 次数已知）',
      '2. 什么情况下 `while` 会永远不结束？（条件恒为真）',
    ].join('\n');
    window.fetch = async function (url, init) {
      const body = JSON.parse((init && init.body) || '{}');
      const joined = (body.messages || []).map((m) => m.content).join('\n');
      // 批量答题（v1.11.0 起）：一次请求答整页，模型要回一个答案数组
      if (/请一次给出以上/.test(joined)) {
        const heads = joined.match(/【第 \d+ 题】类型：[^\n]+/g) || [];
        const list = heads.map((h, idx) => {
          const label = (h.split('类型：')[1] || '').trim();
          let one;
          if (label === '选择题' || label === '多选题') {
            one = { type: 'mcq', answers: ['A'], explanation: 'while 循环在条件为真时持续重复，for 循环遍历序列。' };
          } else if (label === '编程') {
            one = { type: 'code', answers: ['def add(a, b):\n    return a + b'], explanation: '直接返回两数之和。' };
          } else {
            one = { type: 'short', answers: ['如果循环变量在循环体内从不改变，条件会一直为真，循环就永远不会结束。'], explanation: '' };
          }
          return Object.assign({ i: idx + 1 }, one);
        });
        const j = { id: 'mock', model: 'mock-model', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(list) } }], usage: { total_tokens: 42 } };
        return new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (/quick-study notes/.test(joined)) {
        const en = [
          '## One-line summary',
          'Conditionals let a program choose between paths: independent if statements, if-else chains, and nested conditionals.',
          '',
          '## Key points',
          '- Independent `if` statements are all evaluated; earlier results never short-circuit later ones',
          '- Overlapping conditions can produce several matching branches in one run',
          '- Nesting puts one conditional inside another branch',
          '- `if / elif / else` guarantees exactly one branch runs',
          '- Deeper nesting hurts readability — prefer early returns or flatter chains',
          '',
          '## Glossary',
          '| Term | Meaning |',
          '| --- | --- |',
          '| independent if | a separate `if` that is always checked |',
          '| nested conditional | a conditional inside another branch |',
          '',
          '## Pitfalls',
          '- Assuming `elif` behaves like a second independent `if`',
          '- Losing track of indentation in deep nesting',
          '',
          '## Self-check',
          '1. When do two branches both run? (with independent if statements and overlapping conditions)',
          '2. How many branches can an if/elif/else chain execute? (exactly one)',
        ].join('\n');
        const j = { choices: [{ message: { role: 'assistant', content: en } }], usage: { total_tokens: 300 } };
        return new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (/速学笔记/.test(joined)) {
        const j = { choices: [{ message: { role: 'assistant', content: summaryMd } }], usage: { total_tokens: 320 } };
        return new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (/学习助手/.test(joined)) {
        const j = { choices: [{ message: { role: 'assistant', content: mdAnswer } }], model: 'mock' };
        return new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      let payload = { type: 'short', answers: ['x'], explanation: 'mock' };
      if (/类型：选择题|类型：多选题/.test(joined)) {
        payload = { type: 'mcq', answers: ['A'], explanation: 'while 循环在条件为真时持续重复，for 循环遍历序列。' };
      } else if (/类型：编程/.test(joined)) {
        payload = { type: 'code', answers: ['def add(a, b):\n    return a + b'], explanation: '直接返回两数之和。' };
      } else if (/类型：简答|类型：论述/.test(joined)) {
        payload = { type: 'short', answers: ['如果循环变量在循环体内从不改变，条件会一直为真，循环就永远不会结束。'], explanation: '' };
      }
      const json = { id: 'mock', model: 'mock-model', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(payload) } }], usage: { total_tokens: 42 } };
      return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  }, MD_ANSWER);
}


(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(pageUrl, { waitUntil: 'load' });

  // 假模型：在脚本注入前挂上，脚本里的 fetch 调用就会命中它
  await installMock(page);
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => !!document.getElementById('jm-ai-host'));

  // 填好配置，让「生成」按钮可用
  await page.evaluate(() => {
    const J = window.__JMAI__;
    J.Store.set({ apiKey: 'sk-mock', model: 'mock-model', baseUrl: 'https://api.openai.com/v1' });
    J.UI.updateSub();
  });

  const clickInPanel = (ref) =>
    page.evaluate((r) => {
      const host = document.getElementById('jm-ai-host');
      host.shadowRoot.querySelector('[data-ref="' + r + '"]').click();
    }, ref);

  // 面板摆到右下角的舒适位置
  await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    const wrap = host.shadowRoot.querySelector('.wrap');
    wrap.style.left = '1000px';
    wrap.style.top = '150px';
  });

  // 展开一道题，看完整题干 + 选项 + 答案
  const expandFirst = () =>
    page.evaluate(() => {
      const host = document.getElementById('jm-ai-host');
      const q = host.shadowRoot.querySelector('.q');
      const chev = q && q.querySelector('.chev');
      if (chev) chev.click();
      const pane = host.shadowRoot.querySelector('.pane[data-pane="solve"]');
      if (pane) pane.scrollTop = 0;
    });

  await clickInPanel('btn-scan');
  await new Promise((r) => setTimeout(r, 350));
  await page.screenshot({ path: path.join(OUT, '01-light-scanned.png') });

  await clickInPanel('btn-solve');
  await page.waitForFunction(
    () => {
      const host = document.getElementById('jm-ai-host');
      return host && host.shadowRoot.querySelectorAll('.q.done').length >= 3;
    },
    { timeout: 15000 }
  );
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, '02-light-answered.png') });

  // 展开第一题：完整题干 + 全部选项 + 完整答案 + 复制按钮
  await expandFirst();
  await new Promise((r) => setTimeout(r, 350));
  await page.screenshot({ path: path.join(OUT, '08-expanded.png') });
  await expandFirst(); // 收回去
  await new Promise((r) => setTimeout(r, 200));

  // 模型名被服务端拒绝时的「改用」提示
  await page.evaluate(() => {
    const J = window.__JMAI__;
    const q = J.PageModel.questions[2];
    if (!q) return;
    q.status = 'error';
    q.error =
      'HTTP 400 （该接口支持的模型：deepseek-flash / deepseek-v4-pro） The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash.';
    q.supportedModels = ['deepseek-flash', 'deepseek-v4-pro'];
    J.UI.refreshCard(q);
    J.UI.setTab('solve');
  });
  // 滚到出错的那张卡片
  await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    const pane = host.shadowRoot.querySelector('.pane[data-pane="solve"]');
    if (pane) pane.scrollTop = pane.scrollHeight;
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(OUT, '07-model-error.png') });

  // 设置页
  await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    host.shadowRoot.querySelectorAll('.tab')[2].click();
    const pane = host.shadowRoot.querySelector('.pane[data-pane="cfg"]');
    if (pane) pane.scrollTop = 260;
  });
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: path.join(OUT, '03-light-settings.png') });

  // 总结（现在落在「对话」页里，作为一条聊天输出）
  await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    host.shadowRoot.querySelectorAll('.tab')[1].click();
  });
  await clickInPanel('btn-summary');
  await new Promise((r) => setTimeout(r, 900));
  // 总结很长时对话区停在底部，截图往上滚一点，好让开头的小标题露出来
  await page.evaluate(() => {
    const log = document.getElementById('jm-ai-host').shadowRoot.querySelector('[data-ref="chatlog"]');
    if (log) log.scrollTop = 0;
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: path.join(OUT, '09-summary.png') });

  // 对话页（流式，用假响应）
  await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    host.shadowRoot.querySelectorAll('.tab')[1].click();
    host.shadowRoot.querySelector('[data-ref="chat-in"]').value = '用一句话解释 while 和 for 的区别';
  });
  await clickInPanel('btn-send');
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: path.join(OUT, '04-light-chat.png') });

  // 深色主题
  await page.evaluate(() => {
    document.documentElement.classList.add('dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    document.body.style.background = '#0a0a0a';
    const host = document.getElementById('jm-ai-host');
    host.shadowRoot.querySelectorAll('.tab')[0].click();
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, '05-dark-answered.png') });

  // 折叠态
  await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    host.shadowRoot.querySelector('[data-ref="btn-hide"]').click();
  });
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: path.join(OUT, '06-dark-collapsed.png') });

  // 高级设置（展开）
  await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    host.shadowRoot.querySelector('.fab').click();
    host.shadowRoot.querySelectorAll('.tab')[2].click();
    const d = host.shadowRoot.querySelector('details.adv');
    if (d) d.open = true;
    const pane = host.shadowRoot.querySelector('.pane[data-pane="cfg"]');
    if (pane) pane.scrollTop = 300;
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, '10-advanced.png') });

  // 切到英文并重新总结，验证英文输出
  await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    host.shadowRoot.querySelector('[data-ref="btn-lang"]').click();
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    host.shadowRoot.querySelectorAll('.tab')[1].click();
  });
  await clickInPanel('btn-summary');
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: path.join(OUT, '11-english.png') });
  const metrics = await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    const panel = host.shadowRoot.querySelector('.panel');
    const cs = getComputedStyle(panel);
    return {
      cards: host.shadowRoot.querySelectorAll('.q').length,
      done: host.shadowRoot.querySelectorAll('.q.done').length,
      width: panel.getBoundingClientRect().width,
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
      radius: cs.borderRadius,
    };
  });
  console.log(JSON.stringify(metrics, null, 2));
  await browser.close();
  console.log('screenshots → ' + OUT);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
