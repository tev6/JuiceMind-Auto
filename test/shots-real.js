/* 真实页面截图（用于 README）：登录 → 两个代表页 → 注入脚本 → 假模型生成 → 打码邮箱 → 截图 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = path.join(__dirname, '..', '.chrome-profile');
const script = fs.readFileSync(path.join(__dirname, '..', 'juicemind-ai-assistant.user.js'), 'utf8');
const CLASS = 'https://play.juicemind.com/classes/MHr2d8H3qADVUf7P3pCh';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOCK = `
window.fetch = async function (url, init) {
  const body = JSON.parse((init && init.body) || '{}');
  const joined = (body.messages || []).map(m => m.content).join('\\n');
  let payload = { type: 'short', answers: ['**输入（Input）** 是程序接收的数据，例如按下按键。'], explanation: '来自题目对三步流程的说明。' };
  if (/类型：选择题|类型：多选题/.test(joined)) payload = { type: 'mcq', answers: ['D'], explanation: 'print() 是 Python 里向控制台输出文本的函数。' };
  else if (/类型：编程/.test(joined)) payload = { type: 'code', answers: ['print("Welcome to Python!")\\nprint("This is my first program")\\nprint("Coding is fun")'], explanation: '修正三行 print 的引号与括号。' };
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }], model: 'demo' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
`;

const PAGES = [
  ['a717efc2-a7b4-4828-85c0-187f0eca29be', 'real-review'],
  ['2b8ce753-2c18-4ce8-bb1f-bd2fb789de72', 'real-code'],
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', userDataDir: PROFILE,
    args: ['--no-sandbox', '--hide-scrollbars'], protocolTimeout: 300000,
  });
  const page = await browser.newPage();
  page.on('dialog', async (d) => { try { await d.accept(); } catch (e) {} });
  await page.setViewport({ width: 1600, height: 980, deviceScaleFactor: 2 });

  for (const [id, name] of PAGES) {
    await page.goto(CLASS + '/item/' + id, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(7000);
    await page.evaluate(MOCK);
    await page.addScriptTag({ content: script });
    await page.waitForFunction(() => !!window.__JMAI__, { timeout: 20000 });
    await sleep(600);

    const n = await page.evaluate(async () => {
      const J = window.__JMAI__;
      J.Store.set({ apiKey: 'sk-demo', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', autoSubmit: false });
      const s = await J.Actions.scan(false);
      const first = s.questions[0];
      if (first) {
        const a = await J.Solvers.solveOne(first, s, 0);
        first.answer = a;
        first.status = 'done';
        await J.Appliers.apply(first);
      }
      J.UI.renderQuestions();
      // 面板挪到不遮住题目内容的位置
      const host = document.getElementById('jm-ai-host');
      const wrap = host.shadowRoot.querySelector('.wrap');
      wrap.style.left = '1180px';
      wrap.style.top = '540px';
      return s.questions.length;
    });

    // 打码邮箱 / 姓名
    await page.evaluate(() => {
      const emailRe = /[\w.+-]+@[\w.-]+\.\w+/;
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length === 0 && emailRe.test(el.textContent || '')) el.textContent = '***@***';
      }
    });
    await sleep(400);
    await page.screenshot({ path: path.join(__dirname, 'shots', name + '.png') });
    console.log(name + ': questions=' + n);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
