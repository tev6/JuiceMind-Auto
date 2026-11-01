/* 真实页面验收：登录 → 打开指定条目 → 注入脚本 → 扫描 → 用假模型生成 → 填入 → 校验 DOM。
 * 凭据只从环境变量读，不落盘。
 * 运行：
 *   $env:JM_EMAIL='...'; $env:JM_PASS='...'; node test/real.js
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = path.join(__dirname, '..', '.chrome-profile');
const script = fs.readFileSync(path.join(__dirname, '..', 'juicemind-ai-assistant.user.js'), 'utf8');
const CLASS = process.env.JM_CLASS_URL || 'https://play.juicemind.com/classes/<班级ID>';

const PAGES = [
  // [名称, itemId, 期望题数]
  ['3.2.2 Review - Hello, World!（6 道选择题）', 'a717efc2-a7b4-4828-85c0-187f0eca29be', 6],
  ['3.2.4 AP Practice（3 选择）', 'a72f2fa4-4513-4050-a806-e7e1b7377970', 3],
  ['3.1.4 Input/Processing/Output（1 选择 + 1 简答）', 'cf6adaf4-ac8a-484b-90ff-fc8cd985925d', 2],
  ['3.1.5 The JuiceMind IDE（2 简答 + 1 IDE）', '17b807f7-c5b4-42e5-a2a9-d3eb1aa22c12', 3],
  ['Hello World Repair（编程练习）', '2b8ce753-2c18-4ce8-bb1f-bd2fb789de72', 1],
  ['Welcome Banner（编程练习）', '35ce7b2e-b106-453a-bc7f-c5318b38978b', 1],
  ['3.1.2 What Is Code?（2 简答 + 1 填空）', '7b792e8b-e699-412c-9bc6-d680fa76ece4', 3],
];

const MOCK_FETCH = `
window.fetch = async function (url, init) {
  const body = JSON.parse((init && init.body) || '{}');
  const joined = (body.messages || []).map(m => m.content).join('\\n');
  let payload;
  if (/类型：选择题|类型：多选题/.test(joined)) payload = { type: 'mcq', answers: ['A'], explanation: 'mock: 选 A' };
  else if (/类型：编程/.test(joined)) payload = { type: 'code', answers: ['print("Welcome to Python!")\\nprint("This is my first program")\\nprint("Coding is fun")'], explanation: 'mock code' };
  else payload = { type: 'short', answers: ['mock 简答：程序分输入、处理、输出三步。'], explanation: '' };
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }], model: 'mock' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    userDataDir: PROFILE,
    args: ['--no-sandbox', '--hide-scrollbars'],
    protocolTimeout: 300000,
  });
  const page = await browser.newPage();
  page.on('dialog', async (d) => { try { await d.accept(); } catch (e) {} });
  await page.setViewport({ width: 1700, height: 1100 });

  // 确保登录
  await page.goto(CLASS, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);
  const needLogin = await page.evaluate(() => /\/login/.test(location.pathname) || !document.body.innerText.trim());
  if (needLogin) {
    await page.goto('https://play.juicemind.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('input[type=email]', { timeout: 20000 });
    await page.type('input[type=email]', process.env.JM_EMAIL, { delay: 10 });
    await page.type('input[type=password]', process.env.JM_PASS, { delay: 10 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {}),
      page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => /sign in|log in/i.test(x.textContent));
        (b || document.querySelector('button')).click();
      }),
    ]);
    await sleep(3000);
  }

  let allOk = true;
  for (const [name, idShort, expect] of PAGES) {
   try {
    // 找到完整 itemId
    const itemId = await page.evaluate(async (short) => short, idShort).catch(() => idShort);
    const url = CLASS + '/item/' + itemId;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(6500); // 等 IDE / 选择题渲染

    await page.evaluate(MOCK_FETCH);
    await page.addScriptTag({ content: script });
    await page.waitForFunction(() => !!window.__JMAI__ && !!document.getElementById('jm-ai-host'), { timeout: 20000 });
    await sleep(800);

    const scan = await page.evaluate(async () => {
      const J = window.__JMAI__;
      J.Store.set({ apiKey: 'sk-mock', model: 'mock', baseUrl: 'https://api.openai.com/v1', autoSubmit: false });
      const s = await J.Actions.scan(false);
      return {
        kind: s.kind,
        n: s.questions.length,
        qs: s.questions.map((q) => ({
          type: q.type,
          prompt: (q.prompt || '').slice(0, 70),
          opts: q.options.map((o) => o.label + ':' + (o.text || '').slice(0, 20)),
          editor: q.editor ? q.editor.kind : null,
        })),
      };
    });

    // 生成 + 填入
    const filled = await page.evaluate(async () => {
      const J = window.__JMAI__;
      const s = await J.Actions.scan(false);
      const results = [];
      for (const q of s.questions) {
        try {
          const a = await J.Solvers.solveOne(q, s, 0);
          q.answer = a;
          const r = await J.Appliers.apply(q);
          results.push({ type: q.type, ok: r.ok, msg: r.msg });
        } catch (e) {
          results.push({ type: q.type, ok: false, msg: 'ERR ' + e.message });
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      // 校验页面状态
      const submitInfo = s.questions.map(q => J.Appliers.findSubmitButtons(q).length);
      const checked = document.querySelectorAll('input[type=radio]:checked,input[type=checkbox]:checked').length;
      const saTexts = Array.from(document.querySelectorAll('[data-testid="short-answer-response-editor"] [contenteditable="true"]'))
        .map((el) => (el.innerText || '').trim().slice(0, 30));
      const cm = document.querySelector('.cm-editor .cm-content');
      const cmText = cm && cm.cmView && cm.cmView.view ? cm.cmView.view.state.doc.toString() : (cm ? cm.innerText : '');
      return { results, checked, saTexts, cmHead: (cmText || '').slice(0, 60), submitInfo };
    });

    const okCount = filled.results.filter((r) => r.ok).length;
    const pass = scan.n === expect && okCount === scan.n;
    if (!pass) allOk = false;
    console.log('\n===== ' + name + ' =====');
    console.log('  kind=' + scan.kind + '  识别=' + scan.n + '（期望 ' + expect + '）  填入成功=' + okCount + '/' + filled.results.length);
    scan.qs.forEach((q, i) => console.log('   #' + (i + 1) + ' [' + q.type + '/' + q.editor + '] ' + q.prompt + (q.opts.length ? '  选项=' + JSON.stringify(q.opts) : '')));
    console.log('  提交按钮命中: ' + JSON.stringify(filled.submitInfo));
    console.log('  页面状态: checked=' + filled.checked + ' sa=' + JSON.stringify(filled.saTexts.filter(Boolean)) + ' cm=' + JSON.stringify(filled.cmHead));
    const bad = filled.results.filter((r) => !r.ok);
    if (bad.length) console.log('  未填入: ' + JSON.stringify(bad));
    console.log('  ' + (pass ? '✓ PASS' : '✗ FAIL'));
    await page.screenshot({ path: 'test/shots/realcheck-' + idShort + '.png' });
   } catch (e) { allOk = false; console.log('\n===== ' + name + ' =====\n  FATAL ' + e.message); }
  }
  await browser.close();
  console.log('\n' + (allOk ? 'ALL PASS' : 'SOME FAILED'));
  process.exit(allOk ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
