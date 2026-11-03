/* 交互验收（puppeteer）：拖拽、隐藏/Alt+J、流式输出。
 * 运行：node test/ui.js
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const script = fs.readFileSync(path.join(ROOT, 'juicemind-ai-assistant.user.js'), 'utf8');
const pageUrl = 'file:///' + path.join(__dirname, 'visual.html').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => !!window.__JMAI__);
  await sleep(300);

  const panelBox = () =>
    page.evaluate(() => {
      const host = document.getElementById('jm-ai-host');
      const w = host.shadowRoot.querySelector('.wrap');
      const r = w.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), hidden: w.getAttribute('data-hidden') === 'true' };
    });

  console.log('\n【1】拖拽');
  const before = await panelBox();
  const hd = await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    const r = host.shadowRoot.querySelector('.hd').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(hd.x, hd.y);
  await page.mouse.down();
  await page.mouse.move(hd.x - 220, hd.y + 120, { steps: 12 });
  await page.mouse.up();
  await sleep(250);
  const after = await panelBox();
  ok('拖动头部后位置改变', after.left !== before.left || after.top !== before.top, { before, after });
  ok('拖动量大致正确', Math.abs(after.left - before.left + 220) < 30 && Math.abs(after.top - before.top - 120) < 30, { before, after });

  console.log('\n【2】拖拽后位置被记住');
  await page.reload({ waitUntil: 'load' });
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => !!window.__JMAI__);
  await sleep(400);
  const restored = await panelBox();
  ok('刷新后回到拖到的位置', Math.abs(restored.left - after.left) < 3 && Math.abs(restored.top - after.top) < 3, { after, restored });

  console.log('\n【3】隐藏悬浮窗');
  await page.evaluate(() => {
    const J = window.__JMAI__;
    J.Store.set({ hidePanel: true });
  });
  await page.reload({ waitUntil: 'load' });
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => !!window.__JMAI__);
  await sleep(500);
  const hiddenStart = await panelBox();
  ok('开启后启动即隐藏', hiddenStart.hidden === true, hiddenStart);
  const fabVisible = await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    const fab = host.shadowRoot.querySelector('.fab');
    return getComputedStyle(fab).display !== 'none';
  });
  ok('隐藏时不显示那个 AI 圆钮', fabVisible === false, fabVisible);

  await page.keyboard.down('Alt');
  await page.keyboard.press('j');
  await page.keyboard.up('Alt');
  await sleep(350);
  const shown = await panelBox();
  ok('Alt+J 能叫出来', shown.hidden === false, shown);

  await page.keyboard.down('Alt');
  await page.keyboard.press('j');
  await page.keyboard.up('Alt');
  await sleep(350);
  const hiddenAgain = await panelBox();
  ok('再按 Alt+J 收回去', hiddenAgain.hidden === true, hiddenAgain);

  console.log('\n【4】流式输出');
  // 装一个会分块吐 SSE 的假接口
  await page.evaluate(() => {
    const J = window.__JMAI__;
    J.Store.set({ hidePanel: false, apiKey: 'sk-mock', model: 'mock', baseUrl: 'https://api.openai.com/v1', stream: true });
  });
  await page.reload({ waitUntil: 'load' });
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => !!window.__JMAI__);
  await sleep(300);

  await page.evaluate(() => {
    const enc = new TextEncoder();
    const pieces = ['## 流式', '测试\n\n', '- 第一段\n', '- 第二段\n'];
    window.fetch = async function (url, init) {
      const body = JSON.parse(init.body || '{}');
      if (body.stream !== true) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'non-stream' } }] }), { status: 200 });
      }
      const stream = new ReadableStream({
        start(controller) {
          let i = 0;
          const tick = () => {
            if (i < pieces.length) {
              const chunk = 'data: ' + JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] }) + '\n\n';
              controller.enqueue(enc.encode(chunk));
              setTimeout(tick, 120);
            } else {
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
              controller.close();
            }
          };
          tick();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
  });

  await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    const sr = host.shadowRoot;
    sr.querySelectorAll('.tab')[1].click();
    sr.querySelector('[data-ref="chat-in"]').value = '流式测试';
    sr.querySelector('[data-ref="btn-send"]').click();
  });

  const snapshots = [];
  for (let i = 0; i < 6; i++) {
    await sleep(150);
    snapshots.push(
      await page.evaluate(() => {
        const host = document.getElementById('jm-ai-host');
        const b = host.shadowRoot.querySelectorAll('.cmsg.ai');
        return b.length ? (b[b.length - 1].innerText || '').trim() : '';
      })
    );
  }
  const distinct = new Set(snapshots.filter(Boolean));
  ok('接收过程中内容在增长（不是一次性出现）', distinct.size >= 3, snapshots);
  await sleep(900);
  const finalText = await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    const b = host.shadowRoot.querySelectorAll('.cmsg.ai');
    return b.length ? b[b.length - 1].innerText : '';
  });
  ok('最终内容完整', /第一段/.test(finalText) && /第二段/.test(finalText), finalText);
  ok('Markdown 被渲染（有列表）', await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    return !!host.shadowRoot.querySelector('.cmsg.ai li');
  }));

  console.log('\n【5】圆钮可拖动');
  await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    host.shadowRoot.querySelector('[data-ref="btn-collapse"]').click();
  });
  await sleep(250);
  const fabBefore = await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    const f = host.shadowRoot.querySelector('.fab').getBoundingClientRect();
    return { left: f.left, top: f.top, cx: f.left + f.width / 2, cy: f.top + f.height / 2 };
  });
  await page.mouse.move(fabBefore.cx, fabBefore.cy);
  await page.mouse.down();
  await page.mouse.move(fabBefore.cx - 140, fabBefore.cy - 90, { steps: 12 });
  await page.mouse.up();
  await sleep(300);
  const fabAfter = await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    const w = host.shadowRoot.querySelector('.wrap');
    const f = host.shadowRoot.querySelector('.fab').getBoundingClientRect();
    return { left: f.left, top: f.top, collapsed: w.getAttribute('data-collapsed') };
  });
  ok('拖动圆钮能移动', Math.abs(fabAfter.left - fabBefore.left + 140) < 40 && Math.abs(fabAfter.top - fabBefore.top + 90) < 40, { fabBefore, fabAfter });
  ok('拖动之后不会误触展开', fabAfter.collapsed === 'true', fabAfter.collapsed);
  const fabClick = await page.evaluate(() => {
    const host = document.getElementById('jm-ai-host');
    host.shadowRoot.querySelector('.fab').click();
    return host.shadowRoot.querySelector('.wrap').getAttribute('data-collapsed');
  });
  await sleep(200);
  ok('纯点击仍然能展开', fabClick === 'false', fabClick);

  await browser.close();
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
