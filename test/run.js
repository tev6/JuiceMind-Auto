/* 集成冒烟测试：把 userscript 注入 jsdom，验证扫描 / 匹配 / 填入。
 * 运行：node test/run.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(ROOT, 'juicemind-ai-assistant.user.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');

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

const dom = new JSDOM(html, {
  url: 'https://play.juicemind.com/classes/TEAM/item/ITEM123',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

/* ---------- 环境补齐（jsdom 未实现的 API） ---------- */
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
window.PointerEvent = window.MouseEvent;
if (!window.CSS) window.CSS = {};
if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c);
window.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 10, left: 10, right: 810, bottom: 50, width: 800, height: 40 };
};

/* 极简 Monaco 桩：让 findMonacoEditor / setValue 走真实分支 */
const monacoEl = window.document.querySelector('.monaco-editor');
let codeValue = 'def add(a, b):\n    ';
window.monaco = {
  editor: {
    getEditors: () => [
      {
        getDomNode: () => monacoEl,
        getValue: () => codeValue,
        setValue: (v) => {
          codeValue = v;
        },
      },
    ],
  },
};

/* Parsons 交互桩：点击一行把它移到答案区 */
window.document.querySelectorAll('[data-parsons] [draggable="true"]').forEach((el) => {
  el.addEventListener('click', () => window.document.getElementById('pans').appendChild(el));
});

/* ---------- 注入脚本 ---------- */
window.eval(script);
const doc = window.document;

(async function main() {
  const J = window.__JMAI__;
  console.log('\n【1】脚本挂载');
  ok('__JMAI__ 已暴露', !!J);
  const host = doc.getElementById('jm-ai-host');
  ok('悬浮窗已插入（shadow host）', !!host);
  ok('shadow root 可用', host && host.shadowRoot && !!host.shadowRoot.querySelector('.panel'));
  if (!J) process.exit(1);

  console.log('\n【2】页面识别');
  const scan = await J.Actions.scan(false);
  ok('识别为 item 页', scan.kind === 'item', scan.kind);
  ok('标题取自 h1', scan.title === 'Lesson 3 · Loops', scan.title);
  ok('上下文包含教程正文', /learn about loops/.test(scan.context), scan.context.slice(0, 60));

  console.log('\n【3】题目抽取');
  const byType = {};
  scan.questions.forEach((q) => (byType[q.type] = q));
  ok('共识别 5 道题', scan.questions.length === 5, scan.questions.map((q) => q.type));
  ['mcq', 'code', 'parsons', 'blank', 'short'].forEach((t) => ok('包含题型 ' + t, !!byType[t]));

  const mcq = byType.mcq;
  ok('选择题 4 个选项', mcq && mcq.options.length === 4, mcq && mcq.options.map((o) => o.label));
  ok('选择题干正确', mcq && /Which loop repeats/.test(mcq.prompt), mcq && mcq.prompt);
  ok('选项 A 文本正确', mcq && /while loop/.test(mcq.options[0].text), mcq && mcq.options[0].text);
  ok('选项带原生 radio', mcq && !!mcq.options[0].input);

  const code = byType.code;
  ok('编程题识别到编辑器', code && code.editor && code.editor.kind === 'monaco');
  ok('编程题题干不含编辑器内容', code && /add\(a, b\)/.test(code.prompt) && !/def add/.test(code.prompt), code && code.prompt);
  ok('编程题当前值可读', code && /def add/.test(J.Appliers.readCode(code)), code && J.Appliers.readCode(code));

  const parsons = byType.parsons;
  ok('排序题识别到代码行', J.ParsonsHelper.lines(parsons.container).length === 2, J.ParsonsHelper.lines(parsons.container).map((l) => l.text));
  ok('排序题题干正确', /prints 1 then 2/.test(parsons.prompt), parsons.prompt);

  const blank = byType.blank;
  ok('填空题 2 个输入框', doc.querySelectorAll('[data-fillInTheBlank] input').length === 2);
  ok('填空题题干正确', /for i in/.test(blank.prompt), blank.prompt);

  const short = byType.short;
  ok('简答题识别到 textarea', short && short.editor && short.editor.kind === 'textarea');

  console.log('\n【4】选项匹配');
  const m = J.Appliers.matchOption(mcq, 'B');
  ok('字母 B → for loop', m && /for loop/.test(m.text), m && m.text);
  const m2 = J.Appliers.matchOption(mcq, 'A while loop');
  ok('文本匹配 → while loop', m2 && /while loop/.test(m2.text), m2 && m2.text);

  console.log('\n【5】答案填入');
  mcq.answer = { type: 'mcq', answers: ['A'], explanation: 'while 按条件重复' };
  let r = await J.Appliers.apply(mcq);
  ok('选择题 click 成功', r.ok, r);
  ok('目标 radio 被选中', mcq.options[0].input.checked === true);
  ok('其它 radio 未被选中', mcq.options[1].input.checked === false);

  code.answer = { type: 'code', answers: ['def add(a, b):\n    return a + b'], explanation: '' };
  r = await J.Appliers.apply(code);
  ok('代码写入 Monaco', r.ok && /return a \+ b/.test(codeValue), { ok: r.ok, codeValue });

  short.answer = { type: 'short', answers: ['A loop repeats a block of code.'] };
  r = await J.Appliers.apply(short);
  const ta = doc.querySelector('[data-shortAnswer] textarea');
  ok('简答写入 textarea', ta.value.includes('repeats a block'), ta.value);

  blank.answer = { type: 'blank', answers: ['range(3)', 'print(i)'] };
  r = await J.Appliers.apply(blank);
  const ins = Array.from(doc.querySelectorAll('[data-fillInTheBlank] input')).map((i) => i.value);
  ok('填空按顺序写入', ins[0] === 'range(3)' && ins[1] === 'print(i)', ins);

  console.log('\n【6】排序题按行号排好');
  parsons.answer = { type: 'parsons', answers: [1, 0], explanation: '' };
  r = await J.Appliers.apply(parsons);
  const ansOrder = Array.from(doc.querySelectorAll('#pans [draggable="true"]')).map((el) => el.textContent.trim());
  ok('点击后有行被移到答案区', r.ok, r);
  ok('答案区顺序为 print(1) → print(2)', ansOrder[0] === 'print(1)' && ansOrder[1] === 'print(2)', ansOrder);

  console.log('\n【7】答案 JSON 解析容错');
  const parsed = J.LLM.extractJson('好的，答案如下：\n```json\n{"type":"mcq","answers":["B"],"explanation":"x"}\n```\n希望有帮助');
  ok('解析带围栏与前后文的 JSON', parsed && parsed.answers[0] === 'B', parsed);
  const parsed2 = J.LLM.extractJson('{"answers":["A",],"explanation":"ok"}');
  ok('容忍尾逗号', parsed2 && parsed2.answers[0] === 'A', parsed2);
  const norm = J.Solvers.normalize({ type: 'code', answers: ['```python\nprint(1)\n```'] }, code);
  ok('normalize 去掉代码围栏', norm.answers[0] === 'print(1)', norm.answers[0]);

  console.log('\n【8】UI 渲染');
  J.UI.renderQuestions();
  ok('题目卡片已渲染', host.shadowRoot.querySelectorAll('.q').length === 5, host.shadowRoot.querySelectorAll('.q').length);
  ok('卡片含题型徽章', /选择题/.test(host.shadowRoot.querySelector('.q').textContent));
  ok('已生成的题显示答案区', host.shadowRoot.querySelectorAll('.q .answer').length >= 2);

  console.log('\n【9】提示词组装');
  const sys = J.Solvers.systemPrompt();
  ok('系统提示词含 JSON 结构约定', /"type"/.test(sys) && /answers/.test(sys));
  const block = J.Solvers.questionBlock(mcq, 0);
  ok('题目描述含选项字母', /A\./.test(block) && /B\./.test(block), block.slice(0, 120));
  ok('题目描述含题干', /Which loop/.test(block));

  console.log('\n【10】配置读写');
  J.Store.set({ apiKey: 'sk-test', model: 'gpt-4o-mini' });
  ok('配置已持久化', J.Store.get('apiKey') === 'sk-test');
  ok('默认值不丢', J.Store.get('temperature') === 0.2, J.Store.get('temperature'));
  ok('dark 主题变量可计算', typeof J.Theme.read().primary === 'string');
  J.Store.set({ apiKey: '' });

  console.log('\n【11】测验页：只读当前这一题');
  const quiz = await runQuizCase();
  ok('识别为 quiz 页', quiz.kind === 'quiz', quiz.kind);
  ok('只抽到 1 道可见题', quiz.questions.length === 1, quiz.questions.map((q) => q.prompt));
  ok('就是第 2 题', /len\("abc"\)/.test(quiz.questions[0] && quiz.questions[0].prompt), quiz.questions[0] && quiz.questions[0].prompt);
  ok('不包含隐藏题', !/Previous hidden|Next hidden/.test(JSON.stringify(quiz.questions.map((q) => q.prompt))));

  console.log('\n【12】模型名不受限 / 服务端报错可一键改');
  const modelErr = J.LLM._httpError(
    400,
    JSON.stringify({
      error: {
        message:
          'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash. (request_id: b3fda17c-e0a2-4c4a-bf16-98164e35a686)',
      },
    })
  );
  ok('解析出服务端支持的模型名', modelErr.supportedModels && modelErr.supportedModels.join(',') === 'deepseek-flash,deepseek-v4-pro', modelErr.supportedModels);
  ok('报错文本附带支持列表', /该接口支持的模型/.test(modelErr.message));
  ok('保留了原始错误信息', /deepseek-v4\.1-flash/.test(modelErr.message));

  J.Store.set({ model: 'deepseek-v4.1-flash' });
  ok('任意模型名都能存（不校验）', J.Store.get('model') === 'deepseek-v4.1-flash');

  J.UI.renderSettings();
  const cfgBox = host.shadowRoot.querySelector('[data-ref="cfg"]');
  ok('模型输入框带建议列表', !!cfgBox.querySelector('datalist#jm-model-list'));
  ok('建议里含 deepseek-v4.1-flash', /deepseek-v4\.1-flash/.test(cfgBox.querySelector('datalist').innerHTML));

  const mi = cfgBox.querySelector('[data-k="model"]');
  mi.value = 'my-custom-model-x';
  mi.dispatchEvent(new window.Event('input', { bubbles: true }));
  const ps = cfgBox.querySelector('[data-k="preset"]');
  ps.value = 'openai';
  ps.dispatchEvent(new window.Event('change', { bubbles: true }));
  ok('切换服务商不覆盖手填的模型名', cfgBox.querySelector('[data-k="model"]').value === 'my-custom-model-x', cfgBox.querySelector('[data-k="model"]').value);
  J.Store.set({ model: 'gpt-4o-mini' });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});

/** 第二个场景：测验页（独立 jsdom，重新注入脚本） */
async function runQuizCase() {
  const { JSDOM } = require('jsdom');
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, 'fixture-quiz.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'juicemind-ai-assistant.user.js'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://play.juicemind.com/quizzes/QUIZ1',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.PointerEvent = w.MouseEvent;
  if (!w.CSS) w.CSS = {};
  if (!w.CSS.escape) w.CSS.escape = (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c);
  w.Element.prototype.getBoundingClientRect = function () {
    const hidden = this.closest && this.closest('[style*="display:none"]');
    return hidden
      ? { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
      : { x: 0, y: 0, top: 10, left: 10, right: 810, bottom: 50, width: 800, height: 40 };
  };
  w.eval(script);
  const J2 = w.__JMAI__;
  return await J2.Actions.scan(false);
}

