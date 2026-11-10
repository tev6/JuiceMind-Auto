
  /* ============================ 7. 题型求解器 ============================ */

  const ANSWER_SCHEMA = `只输出一个 JSON 对象，不要 Markdown 围栏、不要多余文字：
{"type":"mcq|multiselect|short|free|code|parsons|blank","answers":[...],"explanation":"可选"}
- mcq: ["B"]；multiselect: ["A","C"]
- short/free: 可直接填入的段落数组
- code: 完整可运行代码全文（保留缩进，含题目给的原代码）
- parsons: 行号数组（从 0 开始，按正确顺序）
- blank: 按空位从左到右`;

  /**
   * 第二次重试时额外加的规则。
   * 必须写明这是**第二次**尝试：模型才知道上一版已经试过一次，
   * 该在上一版的基础上改，而不是从头再来一遍。
   */
  const RETRY_RULE =
    '【这是第二次重试（retry #2）】你上一版程序没有通过站点的单元测试。' +
    '请对照给出的「期望输出 / 实际输出 / 备注」改正程序，不要重复上一版的错误；' +
    '仍然输出完整、可直接运行的程序（保留题目给的原代码结构）。';

  /* ============================ 6.5 拟人化输入 ============================ */
  /**
   * 把整篇代码「敲」进编辑器：随机节奏、偶尔打错再退格、偶尔回头看一眼前面的行。
   * 目的不是伪装成某一个具体的人，而是让协同操作流里出现多次小增量，
   * 而不是一条「整篇替换」。
   */
  const HumanTyping = {
    token: 0,
    speed: 1, // 1 = 正常；测试里设 0 把等待压掉
    rnd: Math.random,

    cancel() {
      this.token++;
    },

    begin() {
      this.token++;
      return this.token;
    },

    alive(token) {
      return token === this.token;
    },

    rand(a, b) {
      return a + (b - a) * this.rnd();
    },

    async wait(ms) {
      const t = Math.round(ms * this.speed);
      if (t > 0) await new Promise((r) => setTimeout(r, t));
    },

    /** 单字符的「思考时间」：换行、右括号之后会慢一点，缩进快一点 */
    delayFor(ch, indent) {
      let ms = this.rand(52, 128);
      if (ch === '\n') ms += this.rand(140, 420);
      else if (/[)\]}:]/.test(ch)) ms += this.rand(50, 190);
      else if (/[,(=]/.test(ch)) ms += this.rand(25, 110);
      if (indent) ms = this.rand(28, 68);
      if (this.rnd() < 0.035) ms += this.rand(320, 900); // 偶尔停下来想
      return ms;
    },

    /** 打错时最可能按到的键 */
    typoFor(ch) {
      const near = {
        a: 's', s: 'a', d: 's', f: 'd', g: 'f', h: 'g', j: 'h', k: 'j', l: 'k',
        e: 'r', r: 'e', t: 'r', y: 't', u: 'y', i: 'u', o: 'i', p: 'o',
        q: 'w', w: 'q', z: 'x', x: 'z', c: 'x', v: 'c', b: 'v', n: 'b', m: 'n',
        0: '9', 1: '2', 2: '3', 3: '4', 9: '0',
        '(': ')', ')': '(', '[': ']', ']': '[', '"': "'", "'": '"',
        '=': '-', '-': '=', '.': ',', ',': '.', ':': ';', ';': ':',
      };
      return near[ch] || String.fromCharCode(ch.charCodeAt(0) + 1);
    },

    abort() {
      const e = new Error('已取消');
      e.name = 'AbortError';
      return e;
    },

    /** 目标平均速度（WPM，1 词按 5 字符算）→ 每字符毫秒数 */
    charMs() {
      const wpm = Math.min(120, Math.max(15, Number(Store.get('typingWpm')) || 75));
      return 12000 / wpm;
    },

    /** 规划整段文字怎么敲：决定每步是什么、间隔多少 */
    plan(text) {
      const steps = [];
      let i = 0;
      while (i < text.length) {
        const size = this.rnd() < 0.82 ? 1 : 2;
        const chunk = text.slice(i, i + size);
        i += chunk.length;

        // 偶发打错 + 退格
        if (chunk.length === 1 && /[a-zA-Z0-9(),.:;=()\[\]"'\-]/.test(chunk) && this.rnd() < 0.05) {
          steps.push({ kind: 'typo', wrong: this.typoFor(chunk), delay: this.rand(90, 240), undo: this.rand(50, 150) });
        }

        const isIndent = text.slice(0, i).endsWith('\n') && text[i] === ' ';
        steps.push({ kind: 'type', text: chunk, delay: this.delayFor(chunk[chunk.length - 1], isIndent) });

        // 偶发回头看一眼
        if (i > 20 && this.rnd() < 0.02) {
          steps.push({ kind: 'glance', back: Math.round(this.rand(8, Math.min(48, i))), delay: this.rand(140, 300), hold: this.rand(200, 560) });
        }
      }
      return steps;
    },

    /** 往 CodeMirror 6 里手打 */
    async typeIntoCm(view, text) {
      const token = this.begin();
      const docLen = () => view.state.doc.length;

      // 覆盖已有内容：真人也是先全选删掉
      if (docLen()) {
        view.dispatch({ changes: { from: 0, to: docLen() }, selection: { anchor: 0 } });
        await this.wait(this.rand(120, 320));
        if (!this.alive(token)) throw this.abort();
      }

      const steps = this.plan(text);
      // 归一化：让「字符数 / 总耗时」贴近目标 WPM（停顿也算在内）
      const nominal = steps.reduce((sum, st) => sum + (st.delay || 0) + (st.undo || 0) + (st.hold || 0), 0);
      const target = text.length * this.charMs();
      const factor = Math.min(4, Math.max(0.12, target / Math.max(1, nominal)));

      for (const st of steps) {
        if (!this.alive(token)) throw this.abort();

        if (st.kind === 'typo') {
          const at = docLen();
          view.dispatch({ changes: { from: at, insert: st.wrong }, selection: { anchor: at + st.wrong.length } });
          await this.wait(st.delay * factor);
          if (!this.alive(token)) throw this.abort();
          view.dispatch({ changes: { from: at, to: at + st.wrong.length }, selection: { anchor: at } });
          await this.wait(st.undo * factor);
        } else if (st.kind === 'glance') {
          const back = Math.max(0, docLen() - st.back);
          view.dispatch({ selection: { anchor: back } });
          await this.wait(Math.max(st.delay, st.hold) * factor);
          if (!this.alive(token)) throw this.abort();
          view.dispatch({ selection: { anchor: docLen() } });
        } else {
          const from = docLen();
          view.dispatch({ changes: { from, insert: st.text }, selection: { anchor: from + st.text.length } });
          await this.wait(st.delay * factor);
        }
      }
      return true;
    },

    /** 往 Monaco 里手打（有 executeEdits 就用它，逐块应用） */
    async typeIntoMonaco(inst, text) {
      const token = this.begin();
      const model = inst.getModel && inst.getModel();
      if (!model || typeof inst.executeEdits !== 'function') {
        inst.setValue(text);
        return true;
      }
      inst.setValue('');
      const steps = this.plan(text);
      const nominal = steps.reduce((sum, st) => sum + (st.delay || 0) + (st.undo || 0) + (st.hold || 0), 0);
      const target = text.length * this.charMs();
      const factor = Math.min(4, Math.max(0.12, target / Math.max(1, nominal)));

      const insertAtEnd = (chunk) => {
        const mdl = inst.getModel();
        const end = mdl.getFullModelRange().getEndPosition();
        inst.executeEdits('typed', [
          {
            range: { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column },
            text: chunk,
            forceMoveMarkers: true,
          },
        ]);
      };

      for (const st of steps) {
        if (!this.alive(token)) throw this.abort();
        if (st.kind === 'type') {
          insertAtEnd(st.text);
          await this.wait(st.delay * factor);
        } else if (st.kind === 'typo') {
          insertAtEnd(st.wrong);
          await this.wait(st.delay * factor);
          if (!this.alive(token)) throw this.abort();
          const mdl = inst.getModel();
          const end = mdl.getFullModelRange().getEndPosition();
          const col = Math.max(1, end.column - st.wrong.length);
          inst.executeEdits('typed', [
            {
              range: { startLineNumber: end.lineNumber, startColumn: col, endLineNumber: end.lineNumber, endColumn: end.column },
              text: '',
            },
          ]);
          await this.wait(st.undo * factor);
        } else {
          await this.wait(Math.max(st.delay, st.hold) * factor);
        }
      }
      return true;
    },
  };

  const Solvers = {
    answers: new Map(), // key -> {answer, at}

    systemPrompt() {
      const lang = Store.get('language') === 'en' ? 'English' : '中文';
      const outLang = outputLanguageName();
      const explain = !!Store.get('explain');
      const extra = Store.get('systemPrompt') || '';
      const batch = !!this._batch;
      return [
        '你是 JuiceMind 课程助手，替上课的学生作答，答案要能直接填进页面。',
        '规则：',
        '1. 依据题干、选项与上下文作答；选择题只看选项内容，多选给全。',
        '2. 代码题输出整段完整程序：保留题目给的原代码，把空补上整体输出；哪怕题目只让你补一个空，也不要只回那一截。',
        '3. 简答 2~4 句，用题目语言；填空按空位顺序、保留原拼写。',
        '4. answers 用' + outLang + '；' + (explain ? 'explanation 用' + lang + '。' : '不要输出 explanation 字段。'),
        batch ? '5. 批量作答：返回 {"answers":[{"i":题号, ...}, ...]}，i 从 1 开始，覆盖每一题。' : '',
        '',
        ANSWER_SCHEMA,
        extra ? '补充要求：' + extra : '',
      ]
        .filter(Boolean)
        .join('\n');
    },

    /** 页面上下文：按题目截取，能省则省（token 主要花在这里） */
    contextFor(scan, q) {
      const title = (scan.title || PageModel.title() || '').trim();
      const kind = scan.kind || PageModel.kind;
      const header = '【页面】' + title + '（类型：' + kind + '）';

      // 选择题的选项本身就是全部信息，不需要再附正文
      const selfContained = (q.type === 'mcq' || q.type === 'multiselect') && (q.options || []).length >= 2;
      if (selfContained) return header;

      const budget = Math.max(600, Math.min(Number(Store.get('contextChars')) || 2400, 8000));
      let body = (scan.context || '').trim();
      if (body) body = this.sliceAround(body, q.prompt, budget);

      // 正文不足时才去翻接口里抓到的原文
      if (!body || body.length < budget * 0.5) {
        const tapped = NetTap.collectText();
        if (tapped.length) {
          const merged = truncate(norm(tapped.join('\n\n')), budget);
          if (merged && (!body || !body.includes(merged.slice(0, 60)))) body = merged;
        }
      }
      return body ? header + '\n\n【课程内容（节选，仅保留与本题相关的部分）】\n' + body : header;
    },

    /** 在长正文里截出题干附近的一段 */
    sliceAround(ctx, prompt, budget) {
      if (!ctx) return '';
      if (ctx.length <= budget) return ctx;
      const p = String(prompt || '').replace(/\s+/g, ' ').trim();
      let at = -1;
      if (p) {
        at = ctx.indexOf(p.slice(0, Math.min(24, p.length)));
        if (at < 0 && p.length > 40) at = ctx.indexOf(p.slice(20, 50));
      }
      if (at < 0) return truncate(ctx, budget);
      const before = Math.round(budget * 0.35);
      const from = Math.max(0, at - before);
      const to = Math.min(ctx.length, from + budget);
      return (from > 0 ? '…' : '') + ctx.slice(from, to) + (to < ctx.length ? '…' : '');
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

    /**
     * 按题型给输出预算。
     * max_tokens 只是「上限」，给大一点不会让模型多写，只是不至于半句话就被切断。
     * 以前选择题只给 120 —— 对带思考的模型（新一代 reasoning 模型）来说
     * 思考就把额度用光了，正文是空的，于是「模型未返回可解析的 JSON」。
     */
    maxTokensFor(q, mult) {
      const cap = Number(Store.get('maxTokens')) || 2048;
      const byType = {
        mcq: 1024,
        multiselect: 1024,
        blank: 1024,
        short: 2048,
        free: 2048,
        code: 4096,
        parsons: 2048,
      };
      const base = Math.min(cap, byType[q.type] || 2048);
      return mult ? Math.min(cap, Math.max(Math.round(base * mult), 1024)) : base;
    },

    cacheKey(q) {
      const ctx = q.prompt + '|' + (q.options || []).map((o) => o.raw).join('|');
      let h = 0;
      const s = location.pathname + '#' + ctx;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return h + ':' + s.length;
    },

    /** 解析失败时给一句能定位问题的话 */
    parseFailMessage(res) {
      const text = (res && res.text) || '';
      const finish = (res && res.finishReason) || '';
      if (!text) {
        if (finish === 'length') {
          return L(
            '模型返回了空内容：输出到一半就被 max_tokens 截断了（还没轮到正文），请把「最大输出」调大再试',
            'The model returned empty content: the output was cut off by max_tokens before the answer — raise the output limit'
          );
        }
        return L(
          '模型返回了空内容（可能一直在思考，或 max_tokens 太小）',
          'The model returned empty content (it may still be thinking, or max_tokens is too small)'
        );
      }
      if (finish === 'length') {
        return (
          L('模型输出被 max_tokens 截断了：', 'The model output was cut off by max_tokens: ') +
          truncate(oneLine(text), 160)
        );
      }
      return L('模型未返回可解析的 JSON：', 'The model did not return parseable JSON: ') + truncate(oneLine(text), 160);
    },

    async solveOne(q, scan, idx) {
      if (!Store.get('apiKey')) throw new Error('请先在「设置」里填写 API Key');
      const messages = [
        { role: 'system', content: this.systemPrompt() },
        {
          role: 'user',
          content: [this.contextFor(scan, q), this.questionBlock(q, idx), '\n请给出这一题的答案 JSON。'].join('\n\n'),
        },
      ];
      let res = await LLM.chat({ messages, stream: false, json: true, maxTokens: this.maxTokensFor(q) });
      let parsed = LLM.extractJson(res.text);
      if (!parsed) {
        // 解析不出来，最常见的原因是输出被 max_tokens 截断：放宽预算再来一次
        log('单题没解析出 JSON，放宽输出预算重试一次');
        res = await LLM.chat({ messages, stream: false, json: true, maxTokens: this.maxTokensFor(q, 4) });
        parsed = LLM.extractJson(res.text);
      }
      if (!parsed) throw new Error(this.parseFailMessage(res));
      const answer = this.normalize(parsed, q);
      this.answers.set(this.cacheKey(q), { answer, at: Date.now() });
      return answer;
    },

    /**
     * 第二次重试：把站点的测试失败信息喂给模型，让它改程序。
     *
     * 提示词里必须写明这是「第二次重试」——模型才知道上一版已经试过一次，
     * 该在上一版的基础上改，而不是从头再来。
     */
    async retryWithTests(q, scan, idx, failures) {
      if (!Store.get('apiKey')) throw new Error('请先在「设置」里填写 API Key');
      const messages = [
        { role: 'system', content: this.systemPrompt() + '\n\n' + RETRY_RULE },
        {
          role: 'user',
          content: [
            this.contextFor(scan, q),
            this.questionBlock(q, idx),
            this.testFailBlock(failures),
            '\n这是第二次重试，请根据上面的测试失败信息改正程序，给出这一题的答案 JSON。',
          ].join('\n\n'),
        },
      ];
      let res = await LLM.chat({ messages, stream: false, json: true, maxTokens: this.maxTokensFor(q) });
      let parsed = LLM.extractJson(res.text);
      if (!parsed) {
        log('重试没解析出 JSON，放宽输出预算再来一次');
        res = await LLM.chat({ messages, stream: false, json: true, maxTokens: this.maxTokensFor(q, 4) });
        parsed = LLM.extractJson(res.text);
      }
      if (!parsed) throw new Error(this.parseFailMessage(res));
      const answer = this.normalize(parsed, q);
      this.answers.set(this.cacheKey(q), { answer, at: Date.now() });
      return answer;
    },

    /** 把测试失败信息整理成给模型看的块 */
    testFailBlock(failures) {
      const list = failures && failures.length ? failures : [];
      if (!list.length) return '【站点单元测试结果】第一次尝试没有通过测试，但没有读到具体用例，请自己复核程序。';
      const lines = ['【站点单元测试结果：第一次尝试没有通过】'];
      list.forEach((f, i) => {
        lines.push('--- 失败用例 ' + (i + 1) + ' ---');
        if (f.name) lines.push('测试名：' + f.name);
        if (f.description) lines.push('测试说明：' + f.description);
        if (f.expected) lines.push('期望输出：\n' + f.expected);
        if (f.actual) lines.push('实际输出：\n' + f.actual);
        if (f.notes) lines.push('测试备注：' + f.notes);
      });
      return lines.join('\n');
    },

    /** 整页一次请求答完（省掉重复的 system + 上下文） */
    async solveBatch(questions, scan) {
      if (!questions.length) return { answers: [], missing: [] };
      if (!Store.get('apiKey')) throw new Error('请先在「设置」里填写 API Key');

      const allChoice = questions.every((q) => (q.type === 'mcq' || q.type === 'multiselect') && (q.options || []).length >= 2);
      const budget = Math.max(600, Math.min(Number(Store.get('contextChars')) || 2400, 8000));
      const ctx = allChoice ? this.contextFor(scan, questions[0]) : this.batchContext(scan, budget);

      const blocks = questions.map((q, i) => this.questionBlock(q, i));
      const user = [ctx, blocks.join('\n\n'), '\n请一次给出以上 ' + questions.length + ' 题的答案 JSON（i 从 1 开始）。'].join('\n\n');

      this._batch = true;
      const messages = [
        { role: 'system', content: this.systemPrompt() },
        { role: 'user', content: user },
      ];
      this._batch = false;

      // 批量答整页的预算：按题型累加，但始终受「答案生成最大 tokens」这个上限约束
      const answerCap = Number(Store.get('maxTokens')) || 2048;
      const cap = questions.reduce((sum, q) => sum + this.maxTokensFor(q), 0);
      let res = await LLM.chat({ messages, stream: false, json: true, maxTokens: Math.min(answerCap, Math.min(8192, Math.max(1200, cap))) });

      let parsed = LLM.extractJson(res.text);
      if (!parsed) {
        log('批量没解析出 JSON，放宽输出预算重试一次');
        res = await LLM.chat({ messages, stream: false, json: true, maxTokens: Math.min(answerCap, Math.min(8192, Math.max(4096, cap * 2))) });
        parsed = LLM.extractJson(res.text);
      }
      let list = parsed;
      if (parsed && !Array.isArray(parsed)) list = parsed.answers || parsed.results || parsed.items || parsed.data;
      if (!Array.isArray(list)) throw new Error(this.parseFailMessage(res));

      const out = [];
      const missing = [];
      questions.forEach((q, idx) => {
        const one = list.length === questions.length ? list[idx] : list.find((x) => Number(x && (x.i || x.index || x.id)) === idx + 1);
        if (!one) {
          missing.push(idx);
          return;
        }
        try {
          out.push({ idx, answer: this.normalize(one, q) });
        } catch (e) {
          missing.push(idx);
        }
      });
      return { answers: out, missing };
    },

    /** 批量时整页共用的一段上下文（不做单题定位） */
    batchContext(scan, budget) {
      const title = (scan.title || PageModel.title() || '').trim();
      const header = '【页面】' + title + '（类型：' + (scan.kind || PageModel.kind) + '）';
      let body = (scan.context || '').trim();
      if (body) body = truncate(body, Math.round(budget * 1.5));
      if (!body) {
        const tapped = NetTap.collectText();
        if (tapped.length) body = truncate(norm(tapped.join('\n\n')), budget);
      }
      return body ? header + '\n\n【课程内容（节选）】\n' + body : header;
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
      const out = {
        type,
        answers,
        explanation: oneLine(parsed.explanation || parsed.reasoning || parsed.reason || ''),
        raw: parsed,
      };
      // 代码题兜底：模型只回了要补的那一截，拼回原始程序
      const fixed = this.fixCodeFragment(out, q);
      if (fixed) {
        out.answers = [fixed.code];
        out.explanation = (out.explanation ? out.explanation + ' ' : '') + fixed.note;
      }
      return out;
    },

    /**
     * 「填空式」代码练习的兜底。
     *
     * 题目让模型补一个空（`for i in _____(7):`），有些模型会只回那几个字（`range`）。
     * 插件是**整段覆盖**编辑器，只回一个片段等于把原程序冲掉 —— 这里把它拼回原始代码。
     *
     * @returns {{code: string, note: string}|null} 拼不了就返回 null
     */
    fixCodeFragment(answer, q) {
      if (!q || q.type !== 'code') return null;
      // 原始代码只认第一次读到的：之后插件可能已经往编辑器里写过东西了
      if (q._origCode == null) q._origCode = Appliers.readCode(q) || '';
      const original = q._origCode;
      const frag = (answer.answers || []).join('\n').trim();
      const code = this.spliceBlank(original, frag);
      if (!code) return null;
      return {
        code,
        note: L(
          '（模型只回了要补的那一截，已帮你拼回完整程序）',
          '(the model returned only the blank — it was spliced back into the full program)'
        ),
      };
    },

    /**
     * 把一个「空位的填法」拼回原始代码。
     * 只认「一个名字 / 一次调用 / 一个字符串」这种短片段，
     * 免得把整段程序误当成填法塞进空里。
     */
    spliceBlank(original, frag) {
      if (!original || !frag) return '';
      if (!/_{2,}/.test(original)) return ''; // 原代码里没有空位，用不上
      const f = String(frag).trim();
      if (!f || f.length > 40 || /\n/.test(f)) return '';
      const ok = /^(?:[A-Za-z_][A-Za-z0-9_]*(?:\s*\([^()]*\))?|["'][^"'\n]*["'])$/;
      if (!ok.test(f)) return '';
      // print / return / for … 这些是语句，不是填法
      if (/^(print|return|if|for|while|def|class|import|from|else|elif|try|except|with|assert|lambda|pass|break|continue|raise|yield)\b/i.test(f)) return '';
      return original.replace(/_{2,}/, () => f);
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
    _pageStatusCache: null, // {at, value}：整页状态徽章的短缓存

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

    async setCode(q, code) {
      const ed = q.editor;
      if (!ed) return false;
      if (ed.kind === 'monaco') {
        const inst = this.findMonacoEditor(ed.el);
        if (inst) {
          try {
            if (Store.get('humanType') !== false) {
              await HumanTyping.typeIntoMonaco(inst, code);
            } else {
              inst.setValue(code);
            }
            return true;
          } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            warn('Monaco 写入失败，回退 setValue', e);
            try {
              inst.setValue(code);
              return true;
            } catch (e2) {
              /* 交给下面的兜底 */
            }
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
        if (view && Store.get('humanType') !== false) {
          // 拟人写入：逐字敲进去（产生多条小增量，而不是一次整篇替换）
          try {
            await HumanTyping.typeIntoCm(view, code);
            if (view.state.doc.toString().trim()) return true;
          } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            warn('拟人写入失败，回退到整篇替换', e);
            try {
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
              if (view.state.doc.toString().length) return true;
            } catch (e2) {
              warn('CM6 dispatch 失败，改用粘贴', e2);
            }
          }
        }
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

    /**
     * 勾一个选项。
     *
     * 站点的选项是 React 受控组件（checked 来自 selectedChoices），而 React
     * 给每个 input 挂了一个「值追踪器」：
     *   · 直接赋值 .checked 会把追踪器一起改掉 → React 认为「值没变」，
     *     onChange 不触发 → 站点状态不变 → 提交按钮一直是禁用的；
     *   · 点「已经勾上的那个」DOM 也不会变 → 同样触发不了 onChange。
     * 所以只能：先把勾选清掉（让 React 看到一次变化），再触发浏览器真正的激活行为。
     * 绝对不要再用「赋值 + 派发事件」去补 —— 那只会把追踪器搅乱，之后的点击全被吞掉。
     */
    async clickOption(opt) {
      if (!opt) return false;
      const input = opt.input;
      const target = opt.input || opt.clickEl || opt.el;
      if (!target) return false;

      const clear = () => {
        if (!input) return;
        try {
          input.checked = false;
        } catch (e) {
          /* ignore */
        }
      };
      const click = (el) => {
        try {
          el.click();
        } catch (e) {
          /* ignore */
        }
      };
      const stuck = () => !input || input.checked;

      // 单选且已经勾着：先取消再点回来（DOM 勾着但站点状态空着时，这是唯一能触发 change 的办法）
      if (input && input.type !== 'checkbox' && input.checked) clear();
      click(target);
      await sleep(60);
      if (stuck()) return true;

      // 没生效：再来一次「取消 → 点击」
      clear();
      click(target);
      await sleep(60);
      if (stuck()) return true;

      // 还不行：点整行 / label（有些实现把 onChange 挂在行上）
      const row = (input && (input.closest('label') || input.parentElement)) || opt.el;
      if (row && row !== target) {
        clear();
        click(row);
        await sleep(60);
      }
      return stuck();
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

    /** 把答案对应到具体选项 */
    pickOptions(q) {
      const values = ((q.answer && q.answer.answers) || []).filter((a) => oneLine(a));
      const picked = [];
      for (const v of values) {
        const opt = this.matchOption(q, v);
        if (opt && !picked.includes(opt)) picked.push(opt);
      }
      if (q.type !== 'multiselect' && picked.length > 1) picked.length = 1;
      return picked;
    },

    async applyChoice(q, answer) {
      const values = (answer.answers || []).filter((a) => oneLine(a));
      const picked = this.pickOptions(q);
      if (!picked.length) return { ok: false, msg: '没能把答案对应到选项：' + truncate(values.join(' / '), 60) };
      let allOk = true;
      for (const o of picked) {
        const ok = await this.clickOption(o);
        if (!ok) allOk = false;
      }
      if (!allOk) {
        return { ok: false, msg: '选项点了没生效（题目可能已提交或只读），请手动勾选' };
      }
      return { ok: true, msg: '已选择 ' + picked.map((o) => o.label).join('、') };
    },

    /* --------------------------- 文本题 --------------------------- */

    async applyText(q, answer) {
      const text = (answer.answers || []).join('\n\n').trim();
      if (!text) return { ok: false, msg: '答案为空' };
      const ed = q.editor;
      if (ed) {
        if (ed.kind === 'monaco') {
          const done = await this.setCode(q, text);
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

    async applyCode(q, answer) {
      const code = (answer.answers || []).join('\n').replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '');
      if (!code.trim()) return { ok: false, msg: '代码为空' };
      const done = await this.setCode(q, code);
      if (done) q._settledAt = 0; // 刚写完，得重新等一次同步
      return { ok: done, msg: done ? '已写入编辑器（' + code.split('\n').length + ' 行）' : '编辑器写入失败，请手动复制' };
    },

    /* --------------------------- 填空题 --------------------------- */

    async applyBlanks(q, answer) {
      const inputs = $$('input:not([type="hidden"]),textarea', q.container).filter((el) => isVisible(el) && !el.closest('.monaco-editor'));
      if (!inputs.length) return await this.applyText(q, answer);
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
      if (q.type === 'code') return await this.applyCode(q, a);
      if (q.type === 'parsons') return await this.applyParsons(q, a);
      if (q.type === 'blank') return await this.applyBlanks(q, a);
      if (q.type === 'table') return { ok: false, msg: '表格选择题需要手动点选：' + truncate(a.answers.join(' / '), 80) };
      if (q.type === 'dnd') return { ok: false, msg: '拖拽题需要手动完成：' + truncate(a.answers.join(' / '), 80) };
      return await this.applyText(q, a);
    },

    /* --------------------------- 提交状态 --------------------------- */

    /**
     * 这道题还能提交吗？
     *
     * 站点给条目四种状态（打包产物里的枚举）：
     *   No submission / In progress / Needs grading / Graded
     * 交过之后，**这道题自己的**提交栏里按钮会换成状态词
     * （Review pending / View grade / Approval pending / Unsubmit）。
     *
     * 所以判断「这道题交过没有」只有一个可靠依据：**它自己那一块 DOM 里有没有状态词**。
     *
     * ⚠ 整页进度面板上的徽章**不能**用来判断某一道题：那是条目的状态，
     * 页面里只要有一道题交了，它就会变成「Needs grading」——
     * 拿它当逐题依据，会把后面所有还没交的题一起跳过。
     *
     * @param {object} q 这道题
     * @returns {'open'|'submitted'|'graded'}
     */
    submitState(q) {
      return this.ownStatus(q) || 'open';
    },

    /**
     * 题目自己的提交栏：交过之后，按钮会被换成状态词。
     *
     * ⚠ 只在**这道题自己的节点**里找，不能往父层找。
     * 父层是整篇课件正文，里面躺着**别的题**的状态词：
     * 第一题一交，后面每一题都会从正文里捡到那个「Review pending」，
     * 于是全被误判成「已提交过·跳过」。
     * （2026-11-10 真页实测：3.1.5 IDE 那页只有 Q1 交了，Q2/Q3 根本没交。）
     */
    ownStatus(q) {
      const scope = this.ownScope(q);
      if (!scope) return '';
      for (const b of $$('button,[role="button"]', scope)) {
        const t = oneLine(textOf(b)).toLowerCase();
        if (!t) continue;
        if (t === 'review pending' || t === 'approval pending' || t === 'unsubmit' || t === 'run grading again') return 'submitted';
        if (t === 'view grade') return 'graded';
      }
      return '';
    },

    /**
     * 这道题「自己的」那一片 DOM。
     *
     * 正常路径：容器就是这道题的节点（.react-renderer.node-xxx），
     * 提交栏在它里面。
     * 兜底扫描（控件在课件正文之外）时容器是 <form>，
     * 那就往上找到最近的那个题节点。
     */
    ownScope(q) {
      const c = q && q.container;
      if (!c) return null;
      const rr = c.closest && c.closest('.react-renderer');
      if (rr) return rr;
      if (c.tagName === 'FORM') return c.parentElement || c;
      return c;
    },

    /**
     * 整页进度面板上的状态徽章（叶子节点，文字正好是状态名）。
     * 这是**条目**的状态：页面里只要有一道题交了，它就会变成「Needs grading」，
     * 所以只用来做提示，不能用来判断某一道题交没交。
     */
    pageStatus() {
      const c = this._pageStatusCache;
      if (c && Date.now() - c.at < 2000) return c.value;
      let value = '';
      const scope = PageModel.scope;
      for (const el of $$('*')) {
        if (el.children.length) continue;
        const t = String(el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (t !== 'needs grading' && t !== 'graded') continue;
        if (scope && scope.contains(el)) continue; // 课件正文里的字不算
        if (!isVisible(el)) continue;
        value = t === 'graded' ? 'graded' : 'submitted';
        break;
      }
      this._pageStatusCache = { at: Date.now(), value };
      return value;
    },

    /** 已经交过的题，跳过时给用户看的话 */
    skippedMsg(state) {
      return state === 'graded'
        ? L('这题已经批改过了，不用再提交', 'This one was already graded — nothing to submit')
        : L('这题已经提交过了（站点显示待批改），不用再提交', 'This one was already submitted — nothing to submit');
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

    /** 按钮算不算禁用（MUI 有时用 aria-disabled） */
    isButtonDisabled(b) {
      if (!b) return true;
      return !!(b.disabled || b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true');
    },

    /**
     * 这道题的提交按钮。
     * 每次都重新找：React 重新渲染时可能把旧节点换掉，
     * 拿着旧引用看 disabled，永远是旧状态。
     */
    submitButton(q) {
      const btns = this.findSubmitButtons(q);
      if (!btns.length) return null;
      const enabled = btns.find((b) => !this.isButtonDisabled(b));
      return enabled || btns[0];
    },

    /**
     * 等站点的提交按钮解禁。
     * 站点的规则是「没选答案 → 按钮 disabled」，所以按钮解禁与否
     * 就是「页面到底收没收下这道答案」唯一可信的信号。
     */
    async waitEnabled(q, timeout) {
      const t0 = Date.now();
      let btn = null;
      while (Date.now() - t0 < (timeout || 2000)) {
        btn = this.submitButton(q);
        if (btn && !this.isButtonDisabled(btn)) return { ok: true, btn };
        await sleep(120);
      }
      return { ok: false, btn };
    },

    /**
     * 代码写进编辑器之后，等页面把它同步好再提交。
     *
     * IDE 要把代码送过去、跑起来；提交太快站点会以为程序没就绪，
     * 弹一个「先运行测试之类的」提示框，把后面的题全挡住。
     * 等多久可以在设置里调（3~10 秒）。
     */
    async waitCodeSettled(q) {
      if (!q || q.type !== 'code') return;
      const sec = Math.max(3, Math.min(10, Number(Store.get('codeWaitSec')) || 5));
      // 刚等过就别再等一次（Test 验证之后紧接着提交，别白白多等 5 秒）
      if (q._settledAt && Date.now() - q._settledAt < sec * 1000) return;
      UI.status(L(`代码已写入，等 ${sec} 秒让页面同步…`, `Code written — waiting ${sec}s for the page to sync…`), 'busy');
      await sleep(sec * 1000);
      q._settledAt = Date.now();
    },

    /** 再操作一次：受控组件偶尔会漏掉第一次点击 */
    async retryApply(q) {
      if (!q.answer) return false;
      if (q.type === 'code') return false; // 代码题是拟人逐字敲的，重写反而更糟
      if (q.type === 'mcq' || q.type === 'multiselect') {
        const picked = this.pickOptions(q);
        if (!picked.length) return false;
        for (const o of picked) await this.clickOption(o);
        return true;
      }
      const r = await this.apply(q);
      return !!r.ok;
    },

    async submit(q) {
      // 已经交过的题：站点把提交按钮锁死了（disabled 来自页面的 canSubmit），
      // 点它没有意义。这种时候直接跳过，不去碰按钮。
      const st = this.submitState(q);
      if (st !== 'open') {
        return { ok: true, skipped: true, state: st, msg: this.skippedMsg(st) };
      }
      const found = this.submitButton(q);
      if (!found) return { ok: false, msg: L('没找到提交按钮，请手动提交', 'No submit button found — submit it manually') };

      // 代码题：等页面把代码同步好再提交，免得站点弹提示框
      await this.waitCodeSettled(q);

      // 按钮解禁 = 站点收下了这道答案。不能只看一次，要给它一点反应时间。
      let ready = await this.waitEnabled(q, 1200);
      if (!ready.ok) {
        const again = await this.retryApply(q);
        if (again) ready = await this.waitEnabled(q, 2500);
      }
      if (!ready.ok) {
        // 说清楚是「站点没收下这道答案」，还是「这一页已经被锁住了」
        const locked = this.pageStatus()
          ? L('（页面状态是「待老师批改」，这一页的提交可能被站点锁住了）', '(the page is awaiting grading — the site may have locked submissions)')
          : '';
        return {
          ok: false,
          msg: L(
            '提交按钮一直是禁用的（站点没接受这道答案），请手动勾选并提交',
            'The submit button stayed disabled (the page did not accept the answer) — tick it and submit manually'
          ) + locked,
        };
      }
      const btn = this.submitButton(q) || ready.btn;
      // 提交前先拍快照：浮层、报错提示、接口响应都要和「提交后」做对比
      const pre = {
        overlays: SubmitFlow.snapshot(),
        errors: SubmitFlow.errorSnapshot(),
        rpc: new Set(NetTap.records),
      };
      btn.click();
      const post = await SubmitFlow.settle(q, pre);
      if (post.err) {
        return { ok: false, err: post.err, dialog: post.dialog, state: post.state, msg: L('提交失败：', 'Submit failed: ') + post.err };
      }
      if (post.blocked) {
        return { ok: false, blocked: true, err: L('提交结果弹窗没能关掉，下一题提交不了，请手动关掉它', 'The result popup did not close — close it manually before the next question'), dialog: post.dialog, state: post.state, msg: L('提交后弹窗关不掉', 'Could not close the result popup') };
      }
      // 提交成功；答案对不对是另一回事，但要如实告诉用户
      if (post.state === 'incorrect') {
        return { ok: true, wrong: true, state: post.state, dialog: post.dialog, msg: L('已提交（站点判为不正确）', 'Submitted (marked incorrect)') };
      }
      if (post.state === 'needs-grading') {
        return { ok: true, state: post.state, dialog: post.dialog, msg: L('已提交（待老师批改）', 'Submitted (waiting for the teacher)') };
      }
      if (post.state === 'timeout') {
        return { ok: true, state: post.state, dialog: post.dialog, msg: L('已提交（没等到结果）', 'Submitted (no result shown)') };
      }
      return { ok: true, state: post.state, dialog: post.dialog, msg: L('已提交', 'Submitted') };
    },
  };

  /* ============================ 8.5 提交流程 ============================ */
  /**
   * 站点提交后会弹出一个 MUI 浮层（.MuiModal-root），它会挡住下一题的提交，必须先关掉。
   * 实测（2026-11 真实页面）浮层有三个状态：
   *   1. "Grading submission"  —— 评分中的转圈（.MuiCircularProgress-root），没有关闭按钮
   *   2. "Result" + Correct/Incorrect + 提交时间 —— 客观题自动判分
   *   3. "Needs grading" —— 主观题，等老师批
   * 状态 2/3 右上角有一个只放了 CloseIcon 的圆钮（<svg data-testid="CloseIcon">），
   * 平时 opacity:0（鼠标移上去才显形），但照样能点 —— 这是唯一的关闭途径：
   * 遮罩是 aria-hidden 的，点它不会关；这也不是 Dialog，Esc 同样不生效。
   *
   * 站点没有公开这个浮层的结构契约（换版本就会变），所以这里不依赖固定选择器：
   *   · 结构命中 —— 提交之后新冒出来的可见浮层（主要手段）
   *   · 文案命中 —— 同时含 "pending request" 两个词才算（页面上另有 "Review pending" 按钮，别误伤）
   * 关不掉也不死磕：如实报告卡在哪一步，让用户知道发生了什么。
   *
   * 顺便判断「这次提交成没成功、答案对不对」：答案一旦提交就改不了了，
   * 出错只能靠浮层里的结论、页面上的报错提示与接口返回来判断，然后如实告诉用户。
   */
  const SubmitFlow = {
    /** 浮层候选：MUI 弹层 / 对话框 / 遮罩 / 弹窗 / 抽屉 */
    OVERLAY_SEL:
      '.MuiModal-root,.MuiDialog-root,' +
      '[role="dialog"],[aria-modal="true"],[data-state="open"],[data-radix-popper-content-wrapper],' +
      '[class*="modal" i],[class*="dialog" i],[class*="overlay" i],[class*="backdrop" i],' +
      '[class*="popup" i],[class*="toast" i],[class*="drawer" i],[class*="sheet" i],.fixed.inset-0',

    /** 报错提示的元素 */
    ERROR_SEL: '[role="alert"],[class*="toast" i],[class*="alert" i],[class*="snackbar" i],[class*="error" i]',

    /** 当前可见的浮层 */
    overlays() {
      return $$(this.OVERLAY_SEL).filter((el) => {
        if (!el || !el.isConnected || !isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 60 && r.height >= 30;
      });
    },

    /** 提交前拍一张快照：哪些浮层本来就在 */
    snapshot() {
      return new Set(this.overlays());
    },

    /** 报错提示元素的快照 */
    errorSnapshot() {
      return new Set($$(this.ERROR_SEL).filter((el) => isVisible(el)));
    },

    /**
     * 找出挡住路的那个浮层
     * @param {Set} before 提交前的浮层快照（给了才会判断「新出现」）
     * @param {boolean} deep 是否允许全页面找 "Pending Request" 字样（慢，只在必要时用）
     */
    find(before, deep) {
      const cands = this.overlays();
      // 1) 文案命中
      for (const el of cands) {
        if (/pending\s*request/i.test(oneLine(textOf(el)))) return el;
      }
      // 2) 提交后新出现的浮层（取最外层那个：关闭按钮和内容都在它身上）
      if (before) {
        const fresh = cands.filter((el) => !before.has(el));
        if (fresh.length) {
          const outermost = fresh.filter((el) => !fresh.some((o) => o !== el && o.contains(el)));
          return outermost[0] || fresh[0];
        }
      }
      // 3) 兜底：全页面找 "Pending Request" 字样（取最内层元素）
      if (deep) {
        const all = $$('*').filter((el) => /pending\s*request/i.test(el.textContent || ''));
        if (all.length) {
          const inner = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
          const hit = inner[0] || all[0];
          return hit.closest('.MuiModal-root,[role="dialog"],[class*="modal" i],[class*="overlay" i],[class*="popup" i]') || hit;
        }
      }
      return null;
    },

    /** 浮层是不是还在「评分中」 */
    isGrading(el) {
      if (!el || !el.isConnected) return false;
      if (el.querySelector('.MuiCircularProgress-root,[role="progressbar"]')) return true;
      const title = oneLine(textOf(el.querySelector('#modal-title') || el));
      return /grading|pending\s*request|submitting/i.test(title);
    },

    /**
     * 读浮层里的结论：correct / incorrect / needs-grading / ''
     * 注意：不能用整块 textContent 去匹配单词边界 —— 站点把结论和标题放在相邻元素里，
     * textContent 会粘成 "IncorrectResult"，\b 就对不上了。所以逐个元素读。
     */
    readState(el) {
      if (!el || !el.isConnected) return '';
      const parts = [];
      const push = (e) => {
        const t = oneLine(textOf(e));
        if (t) parts.push(t);
      };
      push(el);
      for (const e of el.querySelectorAll('*')) push(e);
      for (const t of parts) {
        if (/^incorrect\b/i.test(t)) return 'incorrect';
        if (/^correct\b/i.test(t)) return 'correct';
        if (/^needs\s+grading\b/i.test(t)) return 'needs-grading';
      }
      return '';
    },

    /**
     * 等浮层给出最终结论
     * @returns {Promise<{state: string, text: string}>}
     *   state: correct | incorrect | needs-grading | other | timeout | gone
     */
    async waitResult(el, timeout) {
      const t0 = Date.now();
      const max = timeout || 25000;
      while (Date.now() - t0 < max) {
        if (!el || !el.isConnected) return { state: 'gone', text: '' };
        const state = this.readState(el);
        if (state) return { state, text: state };
        if (!this.isGrading(el)) {
          const title = oneLine(textOf(el.querySelector('#modal-title') || el));
          return { state: 'other', text: truncate(title, 60) };
        }
        // 没有转圈、只是标题写着 pending 之类：别死等
        const spinning = el.querySelector('.MuiCircularProgress-root,[role="progressbar"]');
        if (!spinning && Date.now() - t0 > 10000) {
          const title = oneLine(textOf(el.querySelector('#modal-title') || el));
          return { state: 'other', text: truncate(title, 60) };
        }
        await sleep(200);
      }
      return { state: 'timeout', text: '' };
    },

    /** 找浮层的关闭按钮 */
    findCloseButton(el) {
      if (!el) return null;
      // 站点用的是 MUI：右上角一个只放了 CloseIcon 的圆钮（平时 opacity:0）
      const icon = el.querySelector('[data-testid="CloseIcon"]');
      if (icon) {
        const btn = icon.closest('button');
        if (btn) return btn;
      }
      // 通用兜底：aria-label / title / 文本
      const closers = $$('button,[role="button"],[aria-label],a[href]', el).filter((b) => {
        const label = oneLine(b.getAttribute('aria-label') || b.getAttribute('title') || textOf(b) || '');
        if (!label) return false;
        if (/^(close|dismiss|关闭|關閉)$/i.test(label)) return true;
        return /^[×✕✖⨯]$/.test(label);
      });
      return closers[closers.length - 1] || null;
    },

    /** 关掉浮层：关闭按钮 → Escape → 点遮罩。返回实际用的方式 */
    close(el) {
      if (!el || !el.isConnected) return 'none';
      // 1) 关闭按钮
      const btn = this.findCloseButton(el);
      if (btn) {
        try {
          btn.click();
        } catch (e) {
          /* ignore */
        }
        return 'button';
      }
      // 2) Escape
      try {
        const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        document.dispatchEvent(ev);
        window.dispatchEvent(ev);
      } catch (e) {
        /* ignore */
      }
      // 3) 点遮罩（父层盖满整屏时才算）
      const back = el.parentElement;
      if (back && back !== document.body && back !== document.documentElement) {
        const cs = getComputedStyle(back);
        const r = back.getBoundingClientRect();
        if ((cs.position === 'fixed' || cs.position === 'absolute') && r.width >= window.innerWidth * 0.7) {
          try {
            back.click();
          } catch (e) {
            /* ignore */
          }
          return 'backdrop';
        }
      }
      return 'escape';
    },

    /** 提交之后新出现的报错提示（浮层里的内容另有专门的判断，不在这里重复报） */
    detectError(before) {
      const fresh = $$(this.ERROR_SEL).filter(
        (el) => isVisible(el) && !before.has(el) && !el.closest('.MuiModal-root,.MuiDialog-root,[role="dialog"]')
      );
      for (const el of fresh) {
        const t = oneLine(textOf(el));
        if (t && /error|fail|invalid|unsuccess|错误|失败|无效|抱歉/i.test(t)) return truncate(t, 160);
      }
      return '';
    },

    /** 提交接口返回里有没有错误（NetTap 旁听到的 tRPC 响应） */
    rpcError(before) {
      for (const r of NetTap.records) {
        if (before.has(r)) continue;
        if (!/submi|answer|attempt|upsert|contest|grade/i.test(r.procedure || '')) continue;
        const j = r.json;
        if (!j || typeof j !== 'object') continue;
        let s;
        try {
          s = JSON.stringify(j);
        } catch (e) {
          continue;
        }
        if (/"error"\s*:\s*\{/.test(s) || /"error"\s*:\s*"[^"]/.test(s) || /"success"\s*:\s*false/.test(s)) {
          return truncate(oneLine(s), 160);
        }
      }
      return '';
    },

    /**
     * 提交之后：等浮层 → 等它出结论 → 关掉 → 判断成败
     * @param {object} q 这道题
     * @param {object} pre {overlays, errors, rpc} 提交前的快照
     */
    async settle(q, pre) {
      const out = { dialog: '', err: '', ready: false, state: '', blocked: false };

      // 1) 等浮层出现
      let overlay = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 5000) {
        overlay = this.find(pre.overlays, false);
        if (overlay) break;
        await sleep(120);
      }

      if (overlay) {
        // 2) 等它给结论（评分中会转圈，等它出 Result / Needs grading）
        const res = await this.waitResult(overlay, 25000);
        out.state = res.state;
        // 3) 关掉它 —— 不关掉下一题就提交不了
        out.dialog = this.close(overlay);
        await sleep(500);
        const t1 = Date.now();
        while (Date.now() - t1 < 3000 && this.find(pre.overlays, false)) await sleep(150);
        if (this.find(pre.overlays, false)) {
          out.dialog += '+stuck';
          out.blocked = true;
        }
      }

      // 4) 等页面不再被浮层挡住
      out.ready = await this.waitReady(pre, 5000);

      // 5) 判定这次提交成没成功
      out.err = this.detectError(pre.errors) || this.rpcError(pre.rpc);
      return out;
    },

    /** 页面是否已经不再被新浮层挡住 */
    async waitReady(pre, timeout) {
      const t0 = Date.now();
      while (Date.now() - t0 < (timeout || 4000)) {
        if (!this.find(pre ? pre.overlays : null, false)) return true;
        await sleep(150);
      }
      return false;
    },
  };

  /* ============================ 8.6 站点的 Test 二次验证 ============================ */
  /**
   * 练习题页的 IDE 右上角有一个橙色的「Tests」按钮：点它跑一遍站点的单元测试，
   * 失败了还能点开每个错题，看期望输出 / 实际输出 / 备注。
   *
   * 站点没有公开这些面板的结构契约（换版本就会变），所以这里靠「文案 + 结构特征」认，
   * 不认某一个固定 class：
   *   · 橙色按钮：<a aria-label="Run tests">
   *   · 测试总览面板：标题写着 Tests，里面有 "N Test Total / N Passed / N Failed"
   *   · 每张测试卡的「View Results」按钮
   *   · 结果弹窗：每条用例一行，失败的那条能展开成 Name/Description/Expected/Actual/Notes
   *
   * 真页实测（2026-11-10，Countdown Fix 练习）：
   *   点 Tests → 约 3~4 秒出总览 → 点 View Results → 点失败那条 → 展开出期望/实际/备注。
   */
  const Testers = {
    /** 橙色「Tests」按钮 */
    runButton() {
      return document.querySelector('[aria-label="Run tests"]');
    },

    /** 这一页能不能做 Test 验证 */
    available() {
      try {
        return !!this.runButton();
      } catch (e) {
        return false;
      }
    },

    /**
     * 等一会儿再看有没有 Tests 按钮。
     * 练习题页的 IDE 是异步挂载的：刚进页面时可能只有「Loading…」，
     * 这时候直接说「不能验证」就白白浪费了一次验证机会。
     */
    async waitAvailable(timeout) {
      const t0 = Date.now();
      while (Date.now() - t0 < (timeout || 5000)) {
        if (this.available()) return true;
        await sleep(250);
      }
      return false;
    },

    /**
     * 点 Tests，等总览面板出结果。
     * @returns {{ok: boolean, reason?: string, summary?: object}}
     */
    async run(timeout) {
      const btn = this.runButton();
      if (!btn) return { ok: false, reason: 'no-button' };
      const limit = timeout || 30000;
      const t0 = Date.now();

      try {
        btn.click();
      } catch (e) {
        return { ok: false, reason: 'click-failed' };
      }

      // 1) 等总览面板冒出来
      let panel = null;
      while (Date.now() - t0 < limit) {
        panel = document.querySelector('.la0T6q_root');
        if (panel) break;
        await sleep(200);
      }
      if (!panel) return { ok: false, reason: 'no-panel' };

      // 2) 等它把数字跑出来（"1 Test Total / 0 Passed / 1 Failed / 0 Timeout"）
      let summary = null;
      while (Date.now() - t0 < limit) {
        const text = String(textOf(panel) || '');
        if (/Test Total/i.test(text)) {
          summary = this.readSummary(panel);
          break;
        }
        // 这一页压根没配测试：别傻等
        if (/no tests?|没有测试/i.test(text)) {
          summary = this.readSummary(panel);
          summary.tests = 0;
          summary.none = true;
          break;
        }
        panel = document.querySelector('.la0T6q_root') || panel;
        await sleep(250);
      }
      if (!summary) {
        summary = this.readSummary(panel);
        summary.none = !summary.tests;
      }
      return { ok: true, summary };
    },

    /** 从总览面板里读数字：测试卡里有「N Tests Total / N Passed / N Failed」 */
    readSummary(panel) {
      const root = panel || document.querySelector('.la0T6q_root');
      const out = { suites: 0, tests: 0, passed: 0, failed: 0, timeout: 0, none: false };
      if (!root) return out;
      const num = (s) => {
        const m = String(s || '').match(/(\d+)/);
        return m ? Number(m[1]) : 0;
      };
      const total = root.querySelector('.la0T6q_testSummaryText');
      if (total) out.suites = num(textOf(total));
      root.querySelectorAll('.la0T6q_testCard').forEach((card) => {
        const tt = card.querySelector('.la0T6q_testCardTotalTests');
        if (tt) out.tests += num(textOf(tt));
        card.querySelectorAll('.la0T6q_testCardBadge').forEach((b) => {
          const t = oneLine(textOf(b) || '').toLowerCase();
          const v = num(textOf(b));
          if (/passed/.test(t)) out.passed += v;
          else if (/failed/.test(t)) out.failed += v;
          else if (/timeout/.test(t)) out.timeout += v;
        });
      });
      // 兜底：总览上的徽章也算一遍
      if (!out.tests) {
        root.querySelectorAll('.la0T6q_testSummaryBadge').forEach((b) => {
          const t = oneLine(textOf(b) || '').toLowerCase();
          const v = num(textOf(b));
          if (/passed/.test(t)) out.passed += v;
          else if (/failed/.test(t)) out.failed += v;
          else if (/timeout/.test(t)) out.timeout += v;
        });
        const tt = root.querySelector('.la0T6q_testSummaryText');
        out.tests = out.passed + out.failed + out.timeout;
        if (tt && !out.suites) out.suites = num(textOf(tt));
      }
      return out;
    },

    /**
     * 读出每个错题的具体信息（期望输出 / 实际输出 / 备注）。
     * 流程：点 View Results → 等结果弹窗 → 展开每一条 FAILED → 读详情。
     * @returns {Array<{name:string,description:string,expected:string,actual:string,notes:string}>}
     */
    async readFailures(timeout) {
      const out = [];
      const limit = timeout || 20000;
      const vr = document.querySelector('.la0T6q_testCardButton');
      if (!vr) return out;
      try {
        vr.click();
      } catch (e) {
        return out;
      }

      const t0 = Date.now();
      let box = null;
      while (Date.now() - t0 < limit) {
        box = document.querySelector('.agmXLG_testResultsContainer');
        if (box && /test_/i.test(String(textOf(box) || ''))) break;
        box = null;
        await sleep(250);
      }
      if (!box) return out;

      const items = Array.prototype.slice.call(box.querySelectorAll('.agmXLG_testItem'));
      for (const it of items) {
        const head = it.querySelector('.agmXLG_testHeader');
        const failed =
          (head && head.className && /agmXLG_failed/.test(String(head.className))) ||
          /FAILED/i.test(String(textOf(it) || ''));
        if (!failed) continue;

        const icon = it.querySelector('.agmXLG_expandIcon');
        if (icon) {
          try {
            icon.click();
          } catch (e) {
            /* ignore */
          }
          await sleep(350);
        }

        const rows = {};
        it.querySelectorAll('.agmXLG_detailRow').forEach((row) => {
          const lab = oneLine((row.querySelector('.agmXLG_detailLabel') || {}).textContent || '').replace(/:\s*$/, '');
          const val = (row.querySelector('.agmXLG_detailValue') || {}).textContent || '';
          if (lab) rows[lab] = val;
        });

        let name = rows['Name'] || '';
        if (!name) {
          name = oneLine((it.querySelector('.agmXLG_testName') || {}).textContent || '')
            .replace(/(FAILED|PASSED|TIMEOUT)$/i, '')
            .trim();
        }
        out.push({
          name: name,
          description: rows['Description'] || '',
          expected: rows['Expected'] || '',
          actual: rows['Actual'] || '',
          notes: rows['Notes'] || '',
        });
      }
      return out;
    },

    /** 把站点的两个面板都关掉（不然会挡住 IDE，后面的提交点不到） */
    close() {
      // 先关结果弹窗
      const cb = document.querySelector('.agmXLG_closeButton');
      if (cb) {
        try {
          cb.click();
        } catch (e) {
          /* ignore */
        }
      }
      // 再关 Tests 总览面板：右上角那个白色圆钮（<svg data-testid="CloseIcon">）
      const svgs = Array.prototype.slice.call(document.querySelectorAll('svg[data-testid="CloseIcon"]')).filter((s) => {
        if (s.closest('.agmXLG_testCreationModal')) return false; // 结果弹窗自己的
        if (s.closest('.Gw0Yra_closeButton')) return false; // 编辑器标签页的
        if (s.closest('[aria-label="Close"]')) return false; // 站点公告条的
        return true;
      });
      for (const s of svgs) {
        const target = s.parentElement || s;
        try {
          target.click();
        } catch (e) {
          /* ignore */
        }
        break;
      }
      return !document.querySelector('.la0T6q_root');
    },

    /**
     * 一次完整的验证：跑测试 → 有失败就读详情 → 关面板。
     * @returns {{state:'passed'|'failed'|'none'|'error', summary?:object, failures?:Array, msg?:string}}
     */
    async verify(timeout) {
      if (!this.available()) return { state: 'none', msg: 'no-button' };
      const run = await this.run(timeout);
      if (!run.ok) return { state: 'error', msg: run.reason || 'run-failed' };
      const summary = run.summary || { tests: 0, passed: 0, failed: 0, timeout: 0 };
      if (!summary.tests) {
        this.close();
        return { state: 'none', summary };
      }
      if (!summary.failed && !summary.timeout) {
        this.close();
        return { state: 'passed', summary };
      }
      const failures = await this.readFailures();
      this.close();
      return { state: 'failed', summary, failures };
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
