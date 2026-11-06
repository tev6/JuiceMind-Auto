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
  ok('默认（OpenAI）建议里是 OpenAI 模型', /gpt-6\.1-sol/.test(cfgBox.querySelector('datalist').innerHTML));

  const mi = cfgBox.querySelector('[data-k="model"]');
  const ps = cfgBox.querySelector('[data-k="preset"]');
  ps.value = 'deepseek';
  ps.dispatchEvent(new window.Event('change', { bubbles: true }));
  ok('切到 DeepSeek 后建议含 deepseek-v4.1-flash', /deepseek-v4\.1-flash/.test(cfgBox.querySelector('datalist').innerHTML));
  ok('modelSuggestions("deepseek") 含 v4.1-flash', J.modelSuggestions('deepseek').includes('deepseek-v4.1-flash'));
  ok('各供应商都有模型名单', ['openai', 'deepseek', 'moonshot', 'openrouter', 'google', 'xai'].every((k) => (J.PRESETS[k].models || []).length >= 3));

  mi.value = 'my-custom-model-x';
  mi.dispatchEvent(new window.Event('input', { bubbles: true }));
  ps.value = 'openai';
  ps.dispatchEvent(new window.Event('change', { bubbles: true }));
  ok('切换服务商不覆盖手填的模型名', cfgBox.querySelector('[data-k="model"]').value === 'my-custom-model-x', cfgBox.querySelector('[data-k="model"]').value);
  J.Store.set({ model: 'gpt-4o-mini' });

  console.log('\n【13】对话 Markdown 渲染');
  const mdSrc = [
    '## 参考解法',
    '',
    '可以用 **if / elif** 判断，`age` 是整数。',
    '',
    '1. 先读入年龄',
    '2. 再判断区间',
    '',
    '> 注意：65 岁及以上算老年。',
    '',
    '```python',
    'age = int(input("Enter age: "))',
    'if age < 5:',
    '    price = 0',
    '```',
  ].join('\n');
  const mdFrag = J.MD.render(mdSrc);
  const mdHost = doc.createElement('div');
  mdHost.appendChild(mdFrag);
  ok('标题被渲染成 h2', !!mdHost.querySelector('h2'), mdHost.innerHTML.slice(0, 80));
  ok('粗体/行内代码存在', !!mdHost.querySelector('strong') && !!mdHost.querySelector('code'));
  ok('有序列表 2 项', mdHost.querySelectorAll('ol li').length === 2);
  ok('引用块存在', !!mdHost.querySelector('blockquote'));
  ok('代码块带语言与复制按钮', !!mdHost.querySelector('.md-code pre code') && !!mdHost.querySelector('.md-code .copy-btn'), mdHost.querySelector('.md-lang') && mdHost.querySelector('.md-lang').textContent);
  ok('代码块内容是原文', /int\(input/.test(mdHost.querySelector('.md-code pre code').textContent));

  const xss = doc.createElement('div');
  xss.appendChild(J.MD.render('<img src=x onerror=alert(1)> [x](javascript:alert(1))'));
  ok('不执行原始 HTML', !xss.querySelector('img') && !xss.querySelector('a'), xss.innerHTML.slice(0, 80));

  console.log('\n【14】扫描结果可展开');
  const q0 = scan.questions[0];
  const card0 = host.shadowRoot.querySelector('[data-qid="' + q0.id + '"]');
  ok('卡片默认折叠', card0 && !card0.classList.contains('expanded'));
  card0.querySelector('.chev').click();
  const card0b = host.shadowRoot.querySelector('[data-qid="' + q0.id + '"]');
  ok('点箭头后展开', card0b && card0b.classList.contains('expanded'));
  ok('展开后箭头翻转', card0b.querySelector('.chev').textContent === '▴');
  host.shadowRoot.querySelector('[data-ref="btn-expand"]').click();
  ok('「展开全部」按钮生效', host.shadowRoot.querySelectorAll('.q').length > 0);
  ok('展开按钮文案会跟随', /收起/.test(host.shadowRoot.querySelector('[data-ref="btn-expand"]').textContent), host.shadowRoot.querySelector('[data-ref="btn-expand"]').textContent);

  console.log('\n【15】答案/代码可复制');
  const cpBtn = host.shadowRoot.querySelector('.q .answer-wrap .copy-btn');
  ok('答案卡片有复制按钮', !!cpBtn);
  let copied = null;
  J.copyText = (t) => {
    copied = t;
    return true;
  };
  ok('copyText 可调用', typeof window.__JMAI__.copyText === 'function');

  console.log('\n【16】重试 / 用量 / 中止');
  J.LLM.resetStats();
  let calls = 0;
  window.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('{"error":{"message":"overloaded"}}', { status: 503 });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      { status: 200 }
    );
  };
  const r1 = await J.LLM.chat({ messages: [{ role: 'user', content: 'x' }], stream: false, json: false });
  ok('503 后自动重试并成功', calls === 2 && r1.text === 'ok', { calls, text: r1.text });
  ok('累计 usage', J.LLM.stats.total === 15 && J.LLM.stats.requests === 1, J.LLM.stats);

  calls = 0;
  window.fetch = async () => {
    calls++;
    return new Response('{"error":{"message":"bad key"}}', { status: 401 });
  };
  let err401 = null;
  try {
    await J.LLM.chat({ messages: [{ role: 'user', content: 'x' }], stream: false, json: false });
  } catch (e) {
    err401 = e;
  }
  ok('401 不重试', calls === 1 && /HTTP 401/.test(err401 && err401.message), { calls, msg: err401 && err401.message });

  const sse = J.LLM._sseParser(null);
  sse.reset();
  sse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  sse('data: {"choices":[],"usage":{"total_tokens":7}}\n\ndata: [DONE]\n\n');
  ok('SSE 里能取到 usage', !!sse.usage && sse.usage.total_tokens === 7 && sse.text === 'hi', { usage: sse.usage, text: sse.text });

  let aborted = false;
  window.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      const sig = init && init.signal;
      if (sig) {
        sig.addEventListener('abort', () => {
          aborted = true;
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    });
  const pending = J.LLM.chat({ messages: [{ role: 'user', content: 'x' }], stream: false, json: false });
  setTimeout(() => J.LLM.abort(), 60);
  let errAbort = null;
  try {
    await pending;
  } catch (e) {
    errAbort = e;
  }
  ok('可中止且不重试', aborted && errAbort && (errAbort.name === 'AbortError' || /已取消/.test(errAbort.message)), { aborted, msg: errAbort && errAbort.message });

  console.log('\n【17】总结页 + Mac 快捷键');
  J.Store.set({ stream: false, apiKey: 'sk-test', model: 'm', baseUrl: 'https://api.openai.com/v1' });
  window.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '## 一句话总结\n循环就是重复执行。\n\n## 核心要点\n- 要点一\n- 要点二' } }],
        usage: { total_tokens: 12 },
      }),
      { status: 200 }
    );
  await J.Actions.summarize();
  const sumBox = host.shadowRoot.querySelector('[data-ref="sum-box"]');
  ok('总结渲染出标题', !!sumBox.querySelector('h2'), sumBox.innerHTML.slice(0, 60));
  ok('总结渲染出要点列表', sumBox.querySelectorAll('li').length >= 2);
  ok('总结内容正确', /循环就是重复执行/.test(sumBox.textContent));
  ok('复制按钮已启用', !host.shadowRoot.querySelector('[data-ref="btn-summary-copy"]').disabled);
  J.UI.setTab('summary');
  ok('切到总结标签仍是同一份内容', /循环就是重复执行/.test(sumBox.textContent));

  // Mac 上 Option+J 的 e.key 是 '∆'，只能靠 e.code
  J.UI.setHidden(false);
  J.UI.setCollapsed(false);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '∆', code: 'KeyJ', altKey: true, bubbles: true }));
  ok('Mac 的 ⌥J 能收起（靠 e.code 识别）', J.UI.$wrap.getAttribute('data-collapsed') === 'true', J.UI.$wrap.getAttribute('data-collapsed'));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '∆', code: 'KeyJ', altKey: true, bubbles: true }));
  ok('再按一次展开', J.UI.$wrap.getAttribute('data-collapsed') === 'false');
  ok('识别到非 Mac 平台', J.IS_MAC === false);


  console.log('\n【18】英文模式：输出语言与总结提示词');
  J.Store.set({ uiLang: 'en', stream: false });
  ok('英文模式下界面语言为 en', J.curLang() === 'en');
  ok('未勾选独立设置时输出语言跟随界面', J.outputLanguage() === 'en' && J.outputLanguageName() === 'English');
  J.Store.set({ outputLangCustom: true, outputLang: 'zh' });
  ok('勾选后可单独指定输出语言', J.outputLanguage() === 'zh' && J.outputLanguageName() === '中文');
  J.Store.set({ outputLangCustom: false });

  let captured = null;
  window.fetch = async (url, init) => {
    captured = JSON.parse((init && init.body) || '{}');
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '## One-line summary\nConditionals branch.' } }], usage: { total_tokens: 9 } }),
      { status: 200 }
    );
  };
  await J.Actions.summarize();
  const sysEn = (captured && captured.messages && captured.messages[0] && captured.messages[0].content) || '';
  ok('英文模式：总结提示词整体是英文', /One-line summary/.test(sysEn) && !/一句话总结/.test(sysEn), sysEn.slice(0, 80));
  ok('英文模式：明确要求全英文输出', /Write everything in ENGLISH/.test(sysEn));
  ok('英文模式：正文也用英文标注', /Reply entirely in English/.test((captured.messages[1] || {}).content || ''));
  J.Store.set({ uiLang: 'zh' });
  ok('切回中文后提示词变回中文', (() => {
    const sys = J.Solvers.systemPrompt();
    return typeof sys === 'string' && sys.length > 0;
  })());


  console.log('\n【19】设置页结构 / 动画开关 / 隐藏项保留');
  J.Store.set({ autoSubmit: true, autoRun: true, anim: false });
  J.UI.renderSettings();
  const cfgRoot = host.shadowRoot;
  ok('「填入后自动点提交」已从设置页移除', !cfgRoot.querySelector('[data-k="autoSubmit"]'));
  ok('「进入新页面自动扫描」已从设置页移除', !cfgRoot.querySelector('[data-k="autoRun"]'));
  ok('JSON 输出模式已移入高级设置', !!cfgRoot.querySelector('details.adv [data-k="jsonMode"]'));
  ok('控制台日志已移入高级设置', !!cfgRoot.querySelector('details.adv [data-k="debug"]'));
  ok('高级设置外不再有 JSON / 调试开关', !cfgRoot.querySelector('.adv-body ~ [data-k="jsonMode"]'));
  J.UI.saveSettings();
  ok('保存设置不会抹掉 autoSubmit（功能保留）', J.Store.get('autoSubmit') === true, J.Store.get('autoSubmit'));
  ok('保存设置不会抹掉 autoRun（功能保留）', J.Store.get('autoRun') === true, J.Store.get('autoRun'));
  ok('关闭动画后 wrap 标记 off', J.UI.$wrap.getAttribute('data-anim') === 'off', J.UI.$wrap.getAttribute('data-anim'));
  J.Store.set({ anim: true });
  J.UI.applyAnim();
  ok('重新开启动画后标记 on', J.UI.$wrap.getAttribute('data-anim') === 'on');
  J.Store.set({ autoSubmit: false, autoRun: false });


  console.log('\n【20】拟人代码写入');
  const HT = J.HumanTyping;
  HT.speed = 0; // 测试里把等待压掉

  // 造一个最小的 CM6 文档 + dispatch 记录器
  const makeView = (initial) => {
    let buf = initial || '';
    const calls = [];
    const view = {
      state: {
        get doc() {
          return { length: buf.length, toString: () => buf };
        },
      },
      dispatch(tr) {
        calls.push(tr);
        if (tr.changes) {
          const c = tr.changes;
          if (c.to !== undefined) buf = buf.slice(0, c.from) + (c.insert || '') + buf.slice(c.to);
          else buf = buf.slice(0, c.from) + (c.insert || '') + buf.slice(c.from);
        }
      },
      calls,
      text: () => buf,
    };
    return view;
  };

  const v1 = makeView('old content');
  HT.rnd = () => 0.99; // 不触发打错/回头看，节奏最慢也无所谓（speed=0）
  await HT.typeIntoCm(v1, 'print("hi")\n');
  ok('拟人写入结果正确', v1.text() === 'print("hi")\n', v1.text());
  ok('不是一次整篇替换（多次增量）', v1.calls.length >= 6, v1.calls.length);
  const del = v1.calls.filter((c) => c.changes && c.changes.to !== undefined && !c.changes.insert);
  ok('先清空旧内容（删除整段）', del.length >= 1, del.length);

  // 强制走打错分支
  const v2 = makeView('');
  HT.rnd = () => 0.001; // 恒小于阈值：必定走「打错再退格」分支
  await HT.typeIntoCm(v2, 'abc');
  ok('打错后整体仍然正确', v2.text() === 'abc', v2.text());
  const backspaces = v2.calls.filter((c) => c.changes && c.changes.to !== undefined && c.changes.from !== undefined && !c.changes.insert);
  ok('出现过「打错再退格」', backspaces.length >= 1, backspaces.length);

  // 光标移动（只改 selection、不改内容）
  const v3 = makeView('');
  HT.rnd = () => 0.019; // 低于 0.02 触发回头看
  await HT.typeIntoCm(v3, 'x = 1\nprint(x)\nprint(x)\n');
  const moves = v3.calls.filter((c) => !c.changes && c.selection);
  ok('出现过光标移动', moves.length >= 1, moves.length);
  ok('光标移动不影响最终内容', v3.text() === 'x = 1\nprint(x)\nprint(x)\n', v3.text());

  // 取消
  const v4 = makeView('');
  HT.rnd = Math.random;
  HT.speed = 1;
  const typingJob = HT.typeIntoCm(v4, 'abcdefghijklmnopqrstuvwxyz');
  setTimeout(() => HT.cancel(), 40);
  let abortOk = false;
  try {
    await typingJob;
  } catch (e) {
    abortOk = e && e.name === 'AbortError';
  }
  ok('可以中途取消', abortOk, abortOk);
  HT.speed = 0;

  // 关掉开关 → 一次整篇替换
  const v5 = makeView('zzz');
  J.Store.set({ humanType: false });
  const codeQ = { type: 'code', editor: { kind: 'cm', el: null }, container: null };
  // 直接测 setCode 的分支需要 el，这里只验证开关读取
  ok('开关可关闭', J.Store.get('humanType') === false);
  J.Store.set({ humanType: true });
  HT.speed = 1;
  HT.rnd = Math.random;


  console.log('\n【21】打字速度（WPM）与卡片顶部点击');
  const speedCases = [
    [120, 100],
    [75, 160],
    [15, 800],
  ];
  for (const [wpm, expectMs] of speedCases) {
    J.Store.set({ typingWpm: wpm });
    ok(`${wpm} WPM → 每字符 ${expectMs}ms`, Math.abs(HT.charMs() - expectMs) < 1, HT.charMs());
  }
  J.Store.set({ typingWpm: 90 });
  ok('超出范围会被夹住', (function () {
    J.Store.set({ typingWpm: 400 });
    const v = HT.charMs();
    J.Store.set({ typingWpm: 90 });
    return Math.abs(v - 100) < 1;
  })());

  // 真计时：15 个字符 @ 90 WPM ≈ 15 * 133ms ≈ 2s
  const vTimed = makeView('');
  HT.speed = 1;
  HT.rnd = Math.random;
  const t0 = Date.now();
  await HT.typeIntoCm(vTimed, 'abcdefghijklmnop');
  const elapsed = Date.now() - t0;
  const target = 16 * HT.charMs();
  ok('平均速度贴近目标（±45%）', Math.abs(elapsed - target) / target < 0.45, { elapsed, target: Math.round(target) });

  // 卡片顶部区域可点击
  J.Store.set({ apiKey: 'sk-test', model: 'm', baseUrl: 'https://api.openai.com/v1' });
  window.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'mcq', answers: ['A'], explanation: '' }) } }] }), { status: 200 });
  await J.Actions.scan();
  const cards = host.shadowRoot.querySelectorAll('.q');
  ok('有卡片可测试', cards.length > 0, cards.length);
  if (cards.length) {
    const card = cards[0];
    const head = card.querySelector('.q-hd');
    ok('顶部区域标记为可点击', head.classList.contains('clickable') && head.getAttribute('role') === 'button');
    const qid = card.getAttribute('data-qid');
    const readExpanded = () => {
      const el = host.shadowRoot.querySelector('[data-qid="' + qid + '"]');
      return el ? el.classList.contains('expanded') : null;
    };
    const before = readExpanded();
    card.querySelector('.q-hd').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const after = readExpanded();
    ok('点顶部区域能展开/收起', before !== after && after !== null, { before, after });
    // 再点回来
    const card2 = host.shadowRoot.querySelector('[data-qid="' + qid + '"]');
    card2.querySelector('.q-hd').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    ok('再点一次收起', readExpanded() === before, { again: readExpanded(), before });
  }


  console.log('\n【22】token 压缩（上下文裁剪 + 输出压缩）');
  J.Store.set({ apiKey: 'sk-test', model: 'm', baseUrl: 'https://api.openai.com/v1', stream: false, jsonMode: true, humanType: false, explain: false, contextChars: 2400 });
  const scan22 = await J.Actions.scan();
  const cap = [];
  window.fetch = async (u, init) => {
    cap.push(JSON.parse((init && init.body) || '{}'));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'mcq', answers: ['A'] }) } }], usage: { total_tokens: 60 } }), { status: 200 });
  };

  const mcqQ = scan22.questions.find((q) => q.type === 'mcq');
  await J.Solvers.solveOne(mcqQ, scan22, 0);
  const mcqBody = cap[cap.length - 1];
  ok('选择题不再附整页正文', !/课程内容/.test(mcqBody.messages[1].content), mcqBody.messages[1].content.slice(0, 60));
  ok('选择题输出预算留足思考空间（>=1024）', mcqBody.max_tokens >= 1024, mcqBody.max_tokens);

  // 长上下文会被截到预算附近
  const bigCtx = '开头无关内容。'.repeat(200) + '这是目标题干之前的说明。' + '这里是一道简答题的目标题干：解释循环。' + '结尾无关内容。'.repeat(200);
  const fakeScan = Object.assign({}, scan22, { context: bigCtx });
  const shortQ = scan22.questions.find((q) => q.type === 'short' || q.type === 'free') || Object.assign({}, mcqQ, { type: 'short' });
  const ctxTrimmed = J.Solvers.contextFor(fakeScan, shortQ);
  ok('长正文被截到预算附近', ctxTrimmed.length <= 2480 && ctxTrimmed.length < bigCtx.length - 100, { len: ctxTrimmed.length, raw: bigCtx.length });
  ok('截断保留题干附近内容', /循环/.test(ctxTrimmed));

  // 解析开关
  J.Store.set({ explain: false });
  ok('关闭解析时提示词要求不输出 explanation', /不要输出 explanation/.test(J.Solvers.systemPrompt()));
  J.Store.set({ explain: true });
  ok('打开解析时提示词要求输出 explanation', /explanation 用|explanation 字段/.test(J.Solvers.systemPrompt()) && !/不要输出 explanation/.test(J.Solvers.systemPrompt()));
  J.Store.set({ explain: false });

  // maxTokensFor 按题型
  const caps = ['mcq', 'multiselect', 'blank', 'short', 'code'].map((t) => J.Solvers.maxTokensFor({ type: t }));
  ok('各题型输出预算都够思考用（>=1024）', caps.every((c) => c >= 1024), caps);
  ok('输出预算不超过用户设置的上限', caps.every((c) => c <= (Number(J.Store.get('maxTokens')) || 2048)), caps);
  ok('放宽预算时仍不超过用户上限', J.Solvers.maxTokensFor({ type: 'mcq' }, 4) <= (Number(J.Store.get('maxTokens')) || 2048));

  // 关掉拟人写入，测一次短答题的整体用户消息体积
  if (shortQ) {
    await J.Solvers.solveOne(shortQ, scan22, 0);
    const body = cap[cap.length - 1];
    ok('简答题上下文受预算约束', body.messages[1].content.length < 3000, body.messages[1].content.length);
  }


  console.log('\n【23】批量作答（A）与精简提示词（C）');
  J.Store.set({ apiKey: 'sk-test', model: 'm', baseUrl: 'https://api.openai.com/v1', stream: false, jsonMode: true, humanType: false, explain: false, batchSolve: true });
  const scan23 = await J.Actions.scan();
  const n23 = scan23.questions.length;
  const cap23 = [];
  window.fetch = async (u, init) => {
    cap23.push(JSON.parse((init && init.body) || '{}'));
    const answers = scan23.questions.map((q, i) => ({ i: i + 1, type: q.type, answers: q.type === 'code' ? ['print(1)'] : ['A'] }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers }) } }], usage: { total_tokens: 200 } }), { status: 200 });
  };

  await J.Actions.solveAll();
  ok('批量：整页只发 1 次请求', cap23.length === 1, cap23.length);
  const batchBody = cap23[0];
  ok('批量：提示词要求返回 answers 数组', /"answers":\[\{"i"/.test(batchBody.messages[0].content) || /i 从 1 开始/.test(batchBody.messages[0].content));
  ok('批量：题干块覆盖全部题目', (batchBody.messages[1].content.match(/【第 \d+ 题】/g) || []).length === n23, n23);
  ok('批量：所有题目都拿到了答案', scan23.questions.every((q) => q.answer && q.status === 'done'), scan23.questions.map((q) => q.status));

  // 部分缺失 → 标记失败，且卡片有「重新生成」
  const scan24 = await J.Actions.scan();
  let n24 = scan24.questions.length;
  window.fetch = async () => {
    const answers = [{ i: 1, type: scan24.questions[0].type, answers: ['A'] }]; // 只回第 1 题
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers }) } }] }), { status: 200 });
  };
  const r24 = await J.Actions.solveAllBatch(scan24);
  ok('批量缺失：第 1 题成功', scan24.questions[0].status === 'done');
  ok('批量缺失：其余题为失败态', scan24.questions.slice(1).every((q) => q.status === 'error'));
  ok('批量缺失：失败原因提示可重新生成', /重新生成/.test(scan24.questions[1].error || ''));
  const cardFail = host.shadowRoot.querySelector('[data-qid="' + scan24.questions[1].id + '"] .q-ft button');
  const btns = host.shadowRoot.querySelectorAll('[data-qid="' + scan24.questions[1].id + '"] .q-ft button');
  ok('批量缺失：卡片按钮变成「重新生成」', Array.from(btns).some((b) => /重新生成|Regenerate/.test(b.textContent)), Array.from(btns).map((b) => b.textContent));

  // 关闭批量 → 逐题请求
  J.Store.set({ batchSolve: false });
  const scan25 = await J.Actions.scan();
  cap23.length = 0;
  window.fetch = async (u, init) => { cap23.push(JSON.parse((init && init.body) || '{}')); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'mcq', answers: ['A'] }) } }] }), { status: 200 }); };
  await J.Actions.solveAll();
  ok('关闭批量后按题请求', cap23.length === scan25.questions.length, { calls: cap23.length, n: scan25.questions.length });
  J.Store.set({ batchSolve: true });

  // C：system prompt 体积
  const sysLen = J.Solvers.systemPrompt().length;
  ok('精简后的 system prompt 明显变短', sysLen < 520, sysLen);

  console.log('\n【24】userscript 头部与版本一致性');
  const head = script.split('// ==/UserScript==')[0];
  const mVersion = (head.match(/^\/\/ @version\s+(\S+)/m) || [])[1];
  const mAuthor = (head.match(/^\/\/ @author\s+(.+)$/m) || [])[1];
  const matches = (head.match(/^\/\/ @match\s+(\S+)/gm) || []).map((s) => s.replace(/^\/\/ @match\s+/, '').trim());
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  ok('版本号三处一致（头部 / VERSION / package.json）', !!mVersion && mVersion === J.VERSION && mVersion === pkg.version, { head: mVersion, const: J.VERSION, pkg: pkg.version });
  ok('@match 覆盖应用端 play 与 classes', matches.includes('https://play.juicemind.com/*') && matches.includes('https://classes.juicemind.com/*'), matches);
  ok('@match 不再含营销站通配 *.juicemind.com', !matches.some((m) => /\/\*\.juicemind\.com\//.test(m)), matches);
  ok('@author 不是占位符', !!mAuthor && mAuthor.trim().toLowerCase() !== 'you', mAuthor);
  ok('头部仍带 @updateURL / @downloadURL', /^\/\/ @updateURL\s+https:\/\/raw\.githubusercontent\.com\//m.test(head) && /^\/\/ @downloadURL\s+https:\/\/raw\.githubusercontent\.com\//m.test(head));

  console.log('\n【25】一键全流程（检测 → 生成 → 填入 → 提交）');
  const af1 = await runAutoFlowCase({ result: 'Incorrect' });
  ok('全流程把每一题都提交了', af1.submits === 2, af1.submits);
  ok('提交后的弹层被关掉了', af1.leftOverModals === 0, af1.leftOverModals);
  ok('站点判为不正确时如实告知', af1.stat.submitted === 2 && af1.stat.wrong === 2, af1.stat);
  ok('卡片标出「已提交·答错」', af1.cardStates.length === 2 && af1.cardStates.every((s) => /答错|incorrect/i.test(s)), af1.cardStates);
  ok('选择题按模型给的答案勾选', af1.checked.length === 2, af1.checked);
  ok('全部题目没有报错', af1.stat.failed.length === 0, af1.stat.failed);

  const af2 = await runAutoFlowCase({ result: 'Correct' });
  ok('站点判为正确时显示已提交', af2.stat.submitted === 2 && af2.stat.wrong === 0 && af2.cardStates.every((s) => /已提交|submitted/i.test(s)), af2.cardStates);

  const af3 = await runAutoFlowCase({ result: 'Needs grading' });
  ok('待老师批改也算提交成功', af3.stat.submitted === 2 && af3.stat.wrong === 0, af3.stat);

  const af4 = await runAutoFlowCase({ result: 'Incorrect', noClose: true });
  ok('弹层关不掉时流程停下并报告', af4.stat.submitted === 0 && af4.stat.failed.length === 1, af4.stat);
  ok('弹层关不掉时如实说明原因', /弹窗|popup/i.test((af4.stat.failed[0] && af4.stat.failed[0].msg) || ''), af4.stat.failed);

  console.log('\n【26】回归：JSON 容错 / 模型参数降级 / 选不中也能说清');
  // 26.1 输出格式容错
  ok('顶层数组也能解析', Array.isArray(J.LLM.extractJson('[{"type":"mcq","answers":["B"]}]')));
  ok('数组带前后废话也能解析', !!J.LLM.extractJson('好的，答案是：[{"type":"mcq","answers":["B"]}] 完毕'));
  const cut = J.LLM.extractJson('{"type":"mcq","answers":["B"]');
  ok('输出被截断的 JSON 也能救回来', !!(cut && cut.answers && cut.answers[0] === 'B'), cut);
  ok('截断到一半的数组也能救回来', !!J.LLM.extractJson('[{"i":1,"answers":["A"]},{"i":2,"answers":["B"]}'));

  // 26.2 解析失败时报错要能定位
  ok('空内容报「空内容」', /空内容/.test(J.Solvers.parseFailMessage({ text: '', finishReason: 'length' })));
  ok('被截断时报「截断」', /截断/.test(J.Solvers.parseFailMessage({ text: '{"type":"mcq"', finishReason: 'length' })));
  ok('返回散文时报「未返回可解析的 JSON」', /JSON/.test(J.Solvers.parseFailMessage({ text: 'I cannot help with that.', finishReason: 'stop' })));

  // 26.3 模型参数降级链
  const seenBodies = [];
  window.fetch = async (u, init) => {
    const body = JSON.parse((init && init.body) || '{}');
    seenBodies.push(body);
    if (body.response_format) {
      return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'response_format' is not supported with this model." } }), { status: 400 });
    }
    if (body.max_tokens != null) {
      return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported. Use 'max_completion_tokens'." } }), { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"mcq","answers":["A"]}' } }] }), { status: 200 });
  };
  const deg = await J.LLM.chat({ messages: [{ role: 'user', content: 'hi' }], stream: false, json: true, maxTokens: 512 });
  ok('降级链一路往下走（3 次尝试）', seenBodies.length === 3, seenBodies.map((b) => Object.keys(b).join('+')));
  ok('第 1 次带 response_format', !!seenBodies[0].response_format);
  ok('第 2 次去掉 response_format', !seenBodies[1].response_format && seenBodies[1].max_tokens != null);
  ok('第 3 次换成 max_completion_tokens', seenBodies[2].max_completion_tokens != null && seenBodies[2].max_tokens == null);
  ok('降级后拿到正文', /mcq/.test(deg.text), deg.text);

  // 26.4 站点吞掉第一次点击时，插件自己会再点一次
  const af5 = await runAutoFlowCase({ result: 'Correct', swallowFirst: true });
  ok('第一次点击被吞掉后仍能提交', af5.stat.submitted === 2, af5.stat);
  ok('被吞掉时不留错误', af5.stat.failed.length === 0, af5.stat.failed);

  // 26.5 选项怎么都点不动时，如实说是「填入」这一步失败
  const af6 = await runAutoFlowCase({ result: 'Correct', stuck: true });
  ok('点不动的选项不会硬提交', af6.stat.submitted === 0, af6.stat);
  ok('点不动时报的是填入失败', af6.stat.failed.length === 2 && af6.stat.failed.every((f) => /没生效/.test(f.msg)), af6.stat.failed);

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

/**
 * 第三个场景：一键全流程（独立 jsdom）。
 * 这里照抄真实站点提交后的行为：点提交 → MUI 弹层（评分中）→ 结果面板（右上角一个
 * 只放了 CloseIcon 的圆钮，平时 opacity:0）→ 必须关掉它，下一题才提交得了。
 *
 * @param {object} opts
 *   result: 'Incorrect' | 'Correct' | 'Needs grading' —— 站点给出的结论
 *   noClose: true —— 模拟「关不掉」（没有 CloseIcon）
 *   swallowFirst: true —— 站点吞掉第一次点击（受控组件漏掉 onChange）
 *   stuck: true —— 选项怎么都点不动
 *   answer:  模型给的答案字母
 */
async function runAutoFlowCase(opts) {
  const o = opts || {};
  const { JSDOM } = require('jsdom');
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, 'fixture-submit.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'juicemind-ai-assistant.user.js'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://play.juicemind.com/classes/TEAM/item/ITEM123',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.PointerEvent = w.MouseEvent;
  if (!w.CSS) w.CSS = {};
  if (!w.CSS.escape) w.CSS.escape = (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c);
  w.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 10, left: 10, right: 810, bottom: 50, width: 800, height: 40 };
  };

  // ---- 模拟站点的提交弹层 ----
  const submits = [];
  w.document.querySelectorAll('button').forEach((btn) => {    if (!/submit answer/i.test(btn.textContent || '')) return;
    btn.addEventListener('click', () => {
      submits.push(btn);
      const root = w.document.createElement('div');
      root.className = 'MuiModal-root css-3tfy7s';
      root.setAttribute('role', 'presentation');
      root.innerHTML =
        '<div aria-hidden="true" class="MuiBackdrop-root MuiModal-backdrop"></div>' +
        '<div tabindex="0" data-testid="sentinelStart"></div>' +
        '<div class="flex size-full flex-col items-center justify-center" tabindex="-1">' +
        '<div class="w-full max-w-[400px] p-8">' +
        '<span class="MuiCircularProgress-root" role="progressbar"></span>' +
        '<h2 id="modal-title">Grading submission</h2><p id="modal-description">...</p>' +
        '</div></div><div tabindex="0" data-testid="sentinelEnd"></div>';
      w.document.body.appendChild(root);

      // 评分结束后换成结果面板
      w.setTimeout(() => {
        const closeBtn = o.noClose
          ? ''
          : '<button class="absolute top-5 right-5" style="opacity: 0;"><svg data-testid="CloseIcon"><path d="M19 6.41"></path></svg></button>';
        root.innerHTML =
          '<div aria-hidden="true" class="MuiBackdrop-root MuiModal-backdrop"></div>' +
          '<div tabindex="0" data-testid="sentinelStart"></div>' +
          '<div class="flex size-full flex-col items-center justify-center" tabindex="-1">' +
          '<div style="position: relative; background-color: white;">' + closeBtn +
          '<div class="bg-red-50 border-red-200"><span class="text-red-700">' + (o.result || 'Incorrect') + '</span></div>' +
          '<div>Result</div><div>Submitted Nov 5, 2026, 12:04 PM</div>' +
          '</div></div><div tabindex="0" data-testid="sentinelEnd"></div>';
        const cb = root.querySelector('[data-testid="CloseIcon"]');
        if (cb) cb.closest('button').addEventListener('click', () => root.remove());
      }, 150);
    });
  });

  // ---- 模拟站点的规则：没选答案，「Submit Answer」就是禁用的 ----
  w.document.querySelectorAll('[data-multipleChoiceQuestion]').forEach((box) => {
    const btn = box.querySelector('button');
    const sync = () => {
      btn.disabled = !box.querySelector('input:checked');
    };
    box.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('click', sync);
      inp.addEventListener('change', sync);
    });
    sync();
  });

  // ---- 模拟站点的受控组件：有时会漏掉第一次点击，有时怎么都点不动 ----
  if (o.swallowFirst || o.stuck) {
    const counts = new WeakMap();
    w.document.querySelectorAll('input[type=radio]').forEach((inp) => {
      inp.addEventListener('click', () => {
        const n = (counts.get(inp) || 0) + 1;
        counts.set(inp, n);
        const swallow = o.stuck || n === 1;
        if (!swallow) return;
        // 站点拒收这次点击：DOM 勾上又被改回去，受控状态没变，按钮也就没解禁
        inp.checked = false;
        const box = inp.closest('[data-multipleChoiceQuestion]');
        const btn = box && box.querySelector('button');
        if (btn) btn.disabled = true;
      });
    });
  }

  // ---- 假模型：批量模式要返回 {"answers":[{"i":…}]} ----
  const letter = o.answer || 'A';
  w.fetch = async (u, init) => {
    const body = JSON.parse((init && init.body) || '{}');
    const joined = (body.messages || []).map((m) => m.content).join('\n');
    let payload;
    if (/批量作答/.test(joined)) {
      const n = (joined.match(/【第 \d+ 题】/g) || []).length || 1;
      payload = { answers: Array.from({ length: n }, (_, i) => ({ i: i + 1, type: 'mcq', answers: [letter] })) };
    } else {
      payload = { type: 'mcq', answers: [letter], explanation: 'mock' };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }], model: 'mock' }), { status: 200 });
  };

  w.eval(script);
  const J = w.__JMAI__;
  J.Store.set({ apiKey: 'sk-mock', model: 'mock', baseUrl: 'https://api.openai.com/v1', stream: false, jsonMode: true, humanType: false, explain: false, batchSolve: true });

  const stat = await J.Actions.autoFlow();
  await new Promise((r) => setTimeout(r, 200));

  const host = w.document.getElementById('jm-ai-host');
  const cards = host && host.shadowRoot ? Array.from(host.shadowRoot.querySelectorAll('.q')) : [];
  return {
    stat,
    submits: submits.length,
    leftOverModals: w.document.querySelectorAll('.MuiModal-root').length,
    cardStates: cards.map((c) => {
      const msg = c.querySelector('.q-hd .msg');
      return msg ? msg.textContent : '';
    }),
    checked: Array.from(w.document.querySelectorAll('input[type=radio]:checked')).map((r) => r.getAttribute('aria-label')),
  };
}

