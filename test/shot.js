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
    window.fetch = async function (url, init) {
      const body = JSON.parse((init && init.body) || '{}');
      const joined = (body.messages || []).map((m) => m.content).join('\n');
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
    host.shadowRoot.querySelector('[data-ref="btn-collapse"]').click();
  });
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: path.join(OUT, '06-dark-collapsed.png') });

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
