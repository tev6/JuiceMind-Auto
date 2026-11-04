
  /* ============================ 7. 题型求解器 ============================ */

  const ANSWER_SCHEMA = `只输出一个 JSON 对象（不要 Markdown 围栏、不要多余文字），结构：
{
  "type": "mcq | multiselect | short | free | code | parsons | blank",
  "answers": [...],
  "explanation": "一两句话说明依据"
}
各类型 answers 约定：
- mcq：单个选项字母，如 ["B"]
- multiselect：选项字母数组，如 ["A","C"]
- short / free：字符串数组，每个元素是一段可直接填入的答案
- code：字符串数组，元素是完整可运行代码（不要 Markdown 围栏，注意缩进）
- parsons：数字数组，表示给出的代码行按正确顺序排列的行号（从 0 开始，用尽所有行）
- blank：字符串数组，按空位从左到右`;

  const Solvers = {
    answers: new Map(), // key -> {answer, at}

    systemPrompt() {
      const lang = Store.get('language') === 'en' ? 'English' : '中文';
      const outLang = outputLanguageName();
      const extra = Store.get('systemPrompt') || '';
      return [
        '你是 JuiceMind 在线学习平台的作业助手，服务对象是正在上课的学生。',
        '你的目标是给出「可以直接填进页面并被判为正确」的答案，而不是讲解。',
        '',
        '做题要求：',
        '1. 先完整阅读题目与提供的课程上下文，再作答；题干缺失时用上下文推断。',
        '2. 选择题必须只依据选项内容判断，不要臆造选项；多选要把所有正确项都列出。',
        '3. 编程题按题目要求与给定的语言/模板写出完整代码，保留必要缩进，不要输出解释性注释以外的多余内容；若题目要求函数名或输入输出格式，严格遵守。',
        '4. 简答/论述题用与题目相同语言作答，长度贴合题目要求（没要求就 2-4 句）。',
        '5. 填空题按空位顺序给答案，保持原语言的拼写与大小写。',
        `6. explanation 字段用${lang}写，便于学生理解。`,
        `7. answers 里的答案正文用${outLang}书写（代码本身按题目要求的语言），不要混用其他语言。`,
        '',
        ANSWER_SCHEMA,
        extra ? '\n补充要求：' + extra : '',
      ]
        .filter(Boolean)
        .join('\n');
    },

    /** 页面上下文（教程正文、条目标题） */
    contextBlock(scan) {
      const parts = [];
      parts.push('【页面】' + (scan.title || PageModel.title()) + '（类型：' + (scan.kind || PageModel.kind) + '）');
      const ctx = (scan.context || '').trim();
      if (ctx) parts.push('【课程内容 / 页面正文（节选）】\n' + ctx);
      const tapped = NetTap.collectText();
      if (tapped.length) {
        const merged = truncate(norm(tapped.join('\n\n')), 3000);
        if (merged && !ctx.includes(merged.slice(0, 80))) parts.push('【接口里的课程原文（节选）】\n' + merged);
      }
      return parts.join('\n\n');
    },

    /** 单题描述 */
    questionBlock(q, idx) {
      const lines = [];
      lines.push('【第 ' + (idx + 1) + ' 题】类型：' + (TYPE_LABEL[q.type] || q.type));
      const prompt = (q.prompt || '').trim();
      lines.push('题干：' + (prompt || '（页面未提供显式题干，请参考选项与上下文）'));

      if (q.options && q.options.length) {
        lines.push('选项：');
        q.options.forEach((o) => {
          lines.push('  ' + o.label + '. ' + oneLine(o.raw || o.text));
        });
      }

      if (q.type === 'code') {
        const cur = Appliers.readCode(q);
        if (q.codeTemplate) lines.push('题目提供的代码模板：\n' + truncate(q.codeTemplate, 3000));
        if (cur && cur.trim()) lines.push('编辑器里当前的代码（可能是半成品）：\n' + truncate(cur, 3000));
        const lang = (cur && q.language) || q.language || 'python';
        lines.push('目标语言：' + lang);
      }

      if (q.type === 'parsons') {
        const ls = ParsonsHelper.lines(q.container);
        if (ls.length) {
          lines.push('待排序的代码行（行号 : 内容）：');
          ls.forEach((l, i) => lines.push('  ' + i + ' : ' + oneLine(l.text)));
        }
      }

      if (q.hint && q.hint.gradingInstructions) {
        lines.push('评分说明：' + truncate(oneLine(q.hint.gradingInstructions), 600));
      }
      return lines.join('\n');
    },

    cacheKey(q) {
      const ctx = q.prompt + '|' + (q.options || []).map((o) => o.raw).join('|');
      let h = 0;
      const s = location.pathname + '#' + ctx;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return h + ':' + s.length;
    },

    async solveOne(q, scan, idx) {
      if (!Store.get('apiKey')) throw new Error('请先在「设置」里填写 API Key');
      const messages = [
        { role: 'system', content: this.systemPrompt() },
        {
          role: 'user',
          content: [this.contextBlock(scan), this.questionBlock(q, idx), '\n请给出这一题的答案 JSON。'].join('\n\n'),
        },
      ];
      const res = await LLM.chat({ messages, stream: false, json: true });
      const parsed = LLM.extractJson(res.text);
      if (!parsed) throw new Error('模型未返回可解析的 JSON：' + truncate(oneLine(res.text), 160));
      const answer = this.normalize(parsed, q);
      this.answers.set(this.cacheKey(q), { answer, at: Date.now() });
      return answer;
    },

    /** 把模型答复规整成统一结构 */
    normalize(parsed, q) {
      let answers = parsed.answers;
      if (answers == null && parsed.answer != null) answers = parsed.answer;
      if (answers == null) {
        // 有些模型会用人话字段
        answers = parsed.code || parsed.selected || parsed.choice || parsed.text || '';
      }
      if (!Array.isArray(answers)) answers = [answers];
      answers = answers
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .map((a) => a.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, ''))
        .map((a) => (a.length < 400 && /\n/.test(a) ? a.replace(/\n+$/, '') : a));

      const type = parsed.type || q.type;
      return {
        type,
        answers,
        explanation: oneLine(parsed.explanation || parsed.reasoning || parsed.reason || ''),
        raw: parsed,
      };
    },

    /* --------------------------- 批量 --------------------------- */

    async solveAll(questions, scan, hooks) {
      let ok = 0;
      let fail = 0;
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (hooks && hooks.onBefore) hooks.onBefore(q, i);
        try {
          q.status = 'running';
          // 已经有答案的题直接复用，避免重复花钱
          const cached = q.answer ? { answer: q.answer, at: Date.now() } : this.answers.get(this.cacheKey(q));
          const answer = cached && Date.now() - cached.at < 10 * 60 * 1000 ? cached.answer : await this.solveOne(q, scan, i);
          q.answer = answer;
          q.status = 'done';
          ok++;
          if (hooks && hooks.onDone) hooks.onDone(q, i);
        } catch (e) {
          q.status = 'error';
          q.error = e.message || String(e);
          q.supportedModels = (e && e.supportedModels) || null;
          fail++;
          if (hooks && hooks.onError) hooks.onError(q, e, i);
          if (/API Key|401|403|未配置/.test(q.error)) break; // 配置类错误直接停
        }
        await sleep(120);
      }
      return { ok, fail };
    },
  };

  /* ============================ 8. 落盘（填入页面） ============================ */

  const Appliers = {
    /** 原生赋值 + React/Vue 兼容事件 */
    setNativeValue(el, value) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },

    /** contenteditable（ProseMirror / Tiptap）整体替换：实测 execCommand 在站点编辑器里有效 */
    setEditableText(el, text) {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, text);
      } catch (e) {
        ok = false;
      }
      // 校验：编辑器可能吞掉了这次输入
      const now = oneLine(textOf(el));
      if (ok && now && now.length > 0) return true;
      // 回退：粘贴事件（CodeMirror 6 / Tiptap 都吃 paste）
      if (this.pasteText(el, text)) return true;
      if (!ok) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      return ok;
    },

    /** 用 ClipboardEvent 往可编辑区里注入文本 */
    pasteText(el, text) {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return oneLine(textOf(el)).length > 0;
      } catch (e) {
        return false;
      }
    },

    /** CodeMirror 6 的 EditorView：contentDOM.cmView.view */
    cmViewOf(el) {
      const content = el.classList && el.classList.contains('cm-content') ? el : el.querySelector('.cm-content');
      if (!content) return null;
      const v = content.cmView;
      if (v && v.view && v.view.state && typeof v.view.dispatch === 'function') return v.view;
      return null;
    },

    findMonacoEditor(el) {
      const m = W.monaco || (typeof unsafeWindow !== 'undefined' && unsafeWindow.monaco);
      if (!m || !m.editor) return null;
      try {
        const list = m.editor.getEditors ? m.editor.getEditors() : [];
        for (const ed of list) {
          let dom = null;
          try {
            dom = ed.getDomNode ? ed.getDomNode() : null;
          } catch (e) {
            dom = null;
          }
          if (dom && (el === dom || el.contains(dom) || dom.contains(el))) return ed;
        }
      } catch (e) {
        /* ignore */
      }
      return null;
    },

    readCode(q) {
      const ed = q.editor;
      if (!ed) return '';
      if (ed.kind === 'monaco') {
        const inst = this.findMonacoEditor(ed.el);
        if (inst) {
          try {
            return inst.getValue();
          } catch (e) {
            /* ignore */
          }
        }
        const lines = ed.el.querySelectorAll('.view-line');
        if (lines.length) return Array.from(lines).map((l) => l.textContent).join('\n');
        return '';
      }
      if (ed.kind === 'cm') {
        const view = this.cmViewOf(ed.el);
        if (view) {
          try {
            return view.state.doc.toString();
          } catch (e) {
            /* ignore */
          }
        }
        return textOf(ed.el.querySelector('.cm-content') || ed.el);
      }
      if (ed.kind === 'pm') return textOf(ed.el);
      return ed.el.value || '';
    },

    setCode(q, code) {
      const ed = q.editor;
      if (!ed) return false;
      if (ed.kind === 'monaco') {
        const inst = this.findMonacoEditor(ed.el);
        if (inst) {
          try {
            inst.setValue(code);
            return true;
          } catch (e) {
            warn('Monaco setValue 失败，尝试键入', e);
          }
        }
        const ta = ed.el.querySelector('textarea');
        if (ta) {
          ta.focus();
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true, metaKey: true, bubbles: true }));
          try {
            document.execCommand('selectAll', false, null);
            return document.execCommand('insertText', false, code);
          } catch (e) {
            return false;
          }
        }
        return false;
      }
      if (ed.kind === 'cm') {
        // 首选 CodeMirror 6 的内部 API（实测 contentDOM.cmView.view 可用）
        const view = this.cmViewOf(ed.el);
        if (view) {
          try {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
            if (view.state.doc.toString().length) return true;
          } catch (e) {
            warn('CM6 dispatch 失败，改用粘贴', e);
          }
        }
        const content = ed.el.querySelector('.cm-content');
        if (content) {
          if (this.pasteText(content, code) && this.readCode(q).length) return true;
          return this.setEditableText(content, code);
        }
        return false;
      }
      if (ed.kind === 'pm') return this.setEditableText(ed.el, code);
      this.setNativeValue(ed.el, code);
      return true;
    },

    /* --------------------------- 选择题 --------------------------- */

    clickOption(opt) {
      if (!opt) return false;
      const target = opt.input || opt.clickEl || opt.el;
      if (!target) return false;
      try {
        target.click();
      } catch (e) {
        /* ignore */
      }
      // 确保状态（React 受控组件可能忽略 click）
      if (opt.input) {
        setTimeout(() => {
          try {
            if (!opt.input.checked) {
              opt.input.checked = true;
              opt.input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } catch (e) {
            /* ignore */
          }
        }, 30);
      }
      return true;
    },

    /** 把模型的字母/文本映射到具体选项 */
    matchOption(q, value) {
      const v = oneLine(value);
      if (!v) return null;
      const letter = (v.match(/^([A-Ha-h])(?:[.)、:：]|\s|$)/) || [])[1];
      if (letter) {
        const byLabel = q.options.find((o) => o.label === letter.toUpperCase());
        if (byLabel) return byLabel;
      }
      const num = v.match(/^(\d{1,2})(?:[.)、:：]|\s|$)/);
      if (num) {
        const i = Number(num[1]) - 1;
        if (q.options[i]) return q.options[i];
      }
      // 文本匹配
      let best = null;
      let bs = 0.42;
      for (const o of q.options) {
        const s = Math.max(similarity(v, o.text), similarity(v, o.raw));
        if (s > bs) {
          bs = s;
          best = o;
        }
      }
      return best;
    },

    applyChoice(q, answer) {
      const values = (answer.answers || []).filter((a) => oneLine(a));
      const picked = [];
      for (const v of values) {
        const opt = this.matchOption(q, v);
        if (opt && !picked.includes(opt)) picked.push(opt);
      }
      if (!picked.length) return { ok: false, msg: '没能把答案对应到选项：' + truncate(values.join(' / '), 60) };
      if (q.type !== 'multiselect' && picked.length > 1) picked.length = 1;
      picked.forEach((o) => this.clickOption(o));
      return { ok: true, msg: '已选择 ' + picked.map((o) => o.label).join('、') };
    },

    /* --------------------------- 文本题 --------------------------- */

    applyText(q, answer) {
      const text = (answer.answers || []).join('\n\n').trim();
      if (!text) return { ok: false, msg: '答案为空' };
      const ed = q.editor;
      if (ed) {
        if (ed.kind === 'monaco') {
          const done = this.setCode(q, text);
          return { ok: done, msg: done ? '已写入编辑器' : '编辑器写入失败' };
        }
        if (ed.kind === 'pm' || ed.kind === 'cm') {
          const target = ed.kind === 'cm' ? ed.el.querySelector('.cm-content') : ed.el;
          const done = this.setEditableText(target, text);
          return { ok: done, msg: done ? '已写入编辑器' : '编辑器写入失败' };
        }
        this.setNativeValue(ed.el, text);
        return { ok: true, msg: '已填入输入框' };
      }
      // 没有定位到编辑器：在控件范围内找第一个可输入元素
      const holder = q.container;
      const cand =
        (holder && holder.querySelector('textarea')) ||
        (holder && holder.querySelector('[contenteditable="true"]')) ||
        (holder && holder.querySelector('input[type="text"]'));
      if (!cand) return { ok: false, msg: '页面上找不到可输入的框' };
      if (cand.isContentEditable) this.setEditableText(cand, text);
      else this.setNativeValue(cand, text);
      return { ok: true, msg: '已填入输入框' };
    },

    /* --------------------------- 代码题 --------------------------- */

    applyCode(q, answer) {
      const code = (answer.answers || []).join('\n').replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '');
      if (!code.trim()) return { ok: false, msg: '代码为空' };
      const done = this.setCode(q, code);
      return { ok: done, msg: done ? '已写入编辑器（' + code.split('\n').length + ' 行）' : '编辑器写入失败，请手动复制' };
    },

    /* --------------------------- 填空题 --------------------------- */

    applyBlanks(q, answer) {
      const inputs = $$('input:not([type="hidden"]),textarea', q.container).filter((el) => isVisible(el) && !el.closest('.monaco-editor'));
      if (!inputs.length) return this.applyText(q, answer);
      const vals = answer.answers || [];
      inputs.forEach((inp, i) => {
        if (vals[i] == null) return;
        this.setNativeValue(inp, String(vals[i]));
      });
      return { ok: true, msg: '已填入 ' + Math.min(inputs.length, vals.length) + ' 个空' };
    },

    /* --------------------------- 排序题 --------------------------- */

    async applyParsons(q, answer) {
      const lines = ParsonsHelper.lines(q.container);
      if (!lines.length) {
        return { ok: false, msg: '找不到可拖动的代码行' };
      }
      const nums = (answer.answers || [])
        .map((a) => Number(String(a).match(/\d+/)))
        .filter((n) => Number.isFinite(n) && n >= 0 && n < lines.length);
      if (!nums.length) {
        // 模型可能直接给了排序后的文本
        const texts = (answer.answers || []).map(oneLine).filter(Boolean);
        if (texts.length < 2) return { ok: false, msg: '答案里没有有效的行顺序' };
        return await ParsonsHelper.arrangeByText(q.container, texts);
      }
      return await ParsonsHelper.arrangeByIndex(q.container, nums);
    },

    /* --------------------------- 统一入口 --------------------------- */

    async apply(q) {
      const a = q.answer;
      if (!a) return { ok: false, msg: '还没有生成答案' };
      if (q.type === 'mcq' || q.type === 'multiselect') return this.applyChoice(q, a);
      if (q.type === 'code') return this.applyCode(q, a);
      if (q.type === 'parsons') return await this.applyParsons(q, a);
      if (q.type === 'blank') return this.applyBlanks(q, a);
      if (q.type === 'table') return { ok: false, msg: '表格选择题需要手动点选：' + truncate(a.answers.join(' / '), 80) };
      if (q.type === 'dnd') return { ok: false, msg: '拖拽题需要手动完成：' + truncate(a.answers.join(' / '), 80) };
      return this.applyText(q, a);
    },

    /* --------------------------- 提交 --------------------------- */

    findSubmitButtons(q) {
      const roots = [q.container];
      let node = q.container;
      for (let i = 0; i < 3 && node; i++, node = node.parentElement) roots.push(node);
      roots.push(PageModel.scope || document.body, document.body);
      const seen = new Set();
      const out = [];
      for (const r of roots) {
        if (!r) continue;
        for (const b of $$('button,[role="button"],input[type="submit"]', r)) {
          if (seen.has(b) || !isVisible(b)) continue;
          seen.add(b);
          const t = oneLine(textOf(b) || b.value || '');
          if (/^(submit|submit answer|submit answers|check|check answer|check answers|run tests|run code|提交|提交答案|检查|运行测试|运行代码|保存并提交)$/i.test(t)) out.push(b);
        }
        // 同一层级里找到就优先用它（离这道题最近的按钮）
        if (out.length) break;
      }
      return out;
    },

    async submit(q) {
      const btns = this.findSubmitButtons(q);
      if (!btns.length) return { ok: false, msg: '没找到提交按钮，请手动提交' };
      const btn = btns[0];
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
        await sleep(400);
        if (btn.disabled) return { ok: false, msg: '提交按钮还是禁用状态（内容可能没被页面接受），请手动确认' };
      }
      btn.click();
      await sleep(500);
      return { ok: true, msg: '已点击「' + oneLine(textOf(btn)) + '」' };
    },
  };

  /* --------------------------- Parsons 辅助 --------------------------- */

  const ParsonsHelper = {
    lines(container) {
      if (!container) return [];
      const sels = ['[draggable="true"]', 'li', '[role="listitem"]', '[class*="parsons" i] li', '[class*="line" i]'];
      for (const sel of sels) {
        const els = $$(sel, container).filter((el) => isVisible(el) && oneLine(textOf(el)).length > 0);
        if (els.length >= 2) {
          return els.map((el) => ({ el, text: oneLine(textOf(el)) }));
        }
      }
      return [];
    },

    /** 在候选行里找目标行：先精确、再包含、最后相似度 */
    pickLine(lines, text) {
      const t = oneLine(text).toLowerCase();
      if (!t) return null;
      let hit = lines.find((l) => oneLine(l.text).toLowerCase() === t);
      if (hit) return hit;
      hit = lines.find((l) => {
        const s = oneLine(l.text).toLowerCase();
        return s.length > 3 && t.length > 3 && (s.includes(t) || t.includes(s));
      });
      if (hit) return hit;
      let best = null;
      let bs = 0.6;
      for (const l of lines) {
        const s = similarity(t, l.text);
        if (s > bs) {
          bs = s;
          best = l;
        }
      }
      return best;
    },

    async arrangeByIndex(container, order) {
      // 先把行号解析成文本（元素被移走之后索引会变）
      const initial = this.lines(container);
      const targetTexts = order.map((i) => (initial[i] ? initial[i].text : null)).filter(Boolean);
      if (!targetTexts.length) return { ok: false, msg: '行号与页面上的代码行对不上' };
      let moved = 0;
      for (const t of targetTexts) {
        const lines = this.lines(container);
        const best = this.pickLine(lines, t);
        if (!best) continue;
        const before = lines.map((l) => l.text).join('\n');
        this.fireClick(best.el);
        await sleep(90);
        const after = this.lines(container).map((l) => l.text).join('\n');
        if (before !== after) moved++;
      }
      return {
        ok: moved > 0,
        msg: moved > 0 ? '已按顺序点击 ' + moved + ' 行' : '点击没能改变顺序，可能需要拖动：请手动调整',
      };
    },

    async arrangeByText(container, texts) {
      let moved = 0;
      for (const t of texts) {
        const lines = this.lines(container);
        const best = this.pickLine(lines, t);
        if (!best) continue;
        this.fireClick(best.el);
        moved++;
        await sleep(90);
      }
      return { ok: moved > 0, msg: '已按文本顺序点击 ' + moved + ' 行' };
    },

    fireClick(el) {
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    },
  };
