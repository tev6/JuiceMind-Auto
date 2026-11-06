
  /* ============================ 10. 动作编排 ============================ */

  const Actions = {
    async scan(verbose) {
      if (App.busy) return;
      PageModel.scope = null;
      let scan = PageModel.scan();
      // 练习题页的 IDE 是异步挂载的：刚进页面时可能只看到「Loading…」
      if (!scan.questions.length && $('[data-testid="ide-panel"]') && !$('.cm-editor,.monaco-editor')) {
        for (let i = 0; i < 8 && !$('.cm-editor,.monaco-editor'); i++) await sleep(500);
        PageModel.scope = null;
        scan = PageModel.scan();
      }
      App.scan = scan;
      UI.renderQuestions();
      const n = scan.questions.length;
      const kinds = {
        class: L('课程首页', 'course home'),
        item: L('教学条目', 'lesson item'),
        quiz: L('测验', 'quiz'),
        gameroom: L('实时竞赛', 'live game'),
        course: L('公开课程', 'public course'),
        ide: 'IDE',
        generic: L('普通页面', 'page'),
      };
      const kindLabel = kinds[scan.kind] || scan.kind;
      UI.status(n ? L(`识别到 ${n} 道题`, `${n} question(s) found`) + ' · ' + kindLabel : L('未识别到题目', 'No questions found') + ' · ' + kindLabel);
      if (verbose) {
        UI.setTab('solve');
        if (!n) UI.toast(L('这一页没有可自动作答的题目', 'No auto-answerable questions here'));
        else UI.toast(L(`识别到 ${n} 道题`, `${n} question(s) found`));
      }
      return scan;
    },

    async solveOne(q) {
      if (App.busy) return;
      if (!this.ensureKey()) return;
      App.busy = true;
      UI.setStopVisible(true);
      q.status = 'running';
      q.error = '';
      UI.refreshCard(q);
      UI.status(L('正在生成答案…', 'Generating…'), 'busy');
      try {
        const answer = await Solvers.solveOne(q, App.scan || { context: PageModel.contextText(), title: PageModel.title(), kind: PageModel.kind }, App.scan ? App.scan.questions.indexOf(q) : 0);
        q.answer = answer;
        q.status = 'done';
        UI.status(L('答案已生成', 'Answer ready'));
        UI.toast(L('已生成：', 'Done: ') + truncate(UI.answerPreview(q).replace(/\n/g, ' '), 60));
        if (Store.get('autoSubmit')) {
          const r = await Appliers.apply(q);
          if (r.ok) await Appliers.submit(q);
        }
      } catch (e) {
        q.status = 'error';
        q.error = e.message || String(e);
        q.supportedModels = (e && e.supportedModels) || null;
        UI.status(L('生成失败：', 'Failed: ') + q.error, 'err');
        UI.toast(L('生成失败：', 'Failed: ') + q.error, 3600);
      } finally {
        App.busy = false;
        UI.setStopVisible(false);
        UI.updateUsage();
        UI.refreshCard(q);
      }
    },

    /** 用户点「停止」：中断当前请求，保留已生成的内容 */
    stop() {
      const wasBusy = App.busy;
      HumanTyping.cancel();
      LLM.abort();
      App.busy = false;
      App.stopMark++;
      this.setBusy(false);
      UI.setStopVisible(false);
      UI.status(wasBusy ? L('已停止', 'Stopped') : L('就绪', 'Ready'));
      if (wasBusy) UI.toast(L('已停止当前请求', 'Request stopped'));
    },

    /** 服务端说只支持某些模型名时，一键切过去并重试当前题 */
    async useModel(model, q) {
      Store.set({ model });
      UI.updateSub();
      UI.renderSettings();
      UI.toast(L('模型改为 ', 'Model set to ') + model, 1600);
      if (q) {
        q.supportedModels = null;
        q.error = '';
        await this.solveOne(q);
      }
    },

    async solveAll() {
      if (App.busy) return;
      const scan = App.scan;
      if (!scan || !scan.questions.length) {
        UI.toast(L('先扫描页面', 'Scan the page first'));
        return;
      }
      if (!this.ensureKey()) return;

      const qs = scan.questions;
      if (Store.get('batchSolve') !== false && qs.length > 1) {
        try {
          await this.solveAllBatch(scan);
          return;
        } catch (e) {
          log('批量作答失败，改用逐题', e && e.message);
          UI.toast(L('批量失败，改用逐题生成', 'Batch failed, falling back to per-question'), 2400);
        }
      }

      App.busy = true;
      this.setBusy(true);
      UI.setStopVisible(true);
      let ok = 0;
      let fail = 0;
      try {
        for (let i = 0; i < qs.length; i++) {
          if (!App.busy) break;
          const q = qs[i];
          UI.status(L(`批量生成 ${i + 1}/${qs.length}…`, `Generating ${i + 1}/${qs.length}…`), 'busy');
          q.status = 'running';
          q.error = '';
          UI.refreshCard(q);
          try {
            q.answer = await Solvers.solveOne(q, scan, i);
            q.status = 'done';
            ok++;
          } catch (e) {
            q.status = 'error';
            q.error = (e && e.message) || String(e);
            q.supportedModels = (e && e.supportedModels) || null;
            fail++;
          }
          UI.refreshCard(q);
        }
      } finally {
        App.busy = false;
        this.setBusy(false);
        UI.setStopVisible(false);
        UI.updateUsage();
      }
      UI.status(L(`完成：成功 ${ok} · 失败 ${fail}`, `Done: ${ok} ok · ${fail} failed`), fail ? 'err' : undefined);
      if (ok) UI.toast(L(`已生成 ${ok} 道答案`, `${ok} answer(s) generated`));
    },

    /** 一次请求答完整页 */
    async solveAllBatch(scan) {
      const qs = scan.questions;
      App.busy = true;
      this.setBusy(true);
      UI.setStopVisible(true);
      qs.forEach((q) => {
        q.status = 'running';
        q.error = '';
        UI.refreshCard(q);
      });
      UI.status(L(`批量生成中（${qs.length} 题一次请求）…`, `Generating all ${qs.length} in one request…`), 'busy');

      try {
        const res = await Solvers.solveBatch(qs, scan);
        const byIdx = new Map(res.answers.map((a) => [a.idx, a.answer]));
        let ok = 0;
        const failed = [];
        qs.forEach((q, i) => {
          const a = byIdx.get(i);
          if (a) {
            q.answer = a;
            q.status = 'done';
            q.error = '';
            ok++;
          } else {
            q.status = 'error';
            q.error = L('这次批量没有返回这道题，点卡片上的「重新生成」单独重试', 'Not returned by the batch — hit Regenerate on this card');
            failed.push(i + 1);
          }
          UI.refreshCard(q);
        });
        UI.updateUsage();
        if (failed.length) {
          UI.status(L(`完成：${ok} 题成功，${failed.length} 题未返回`, `Done: ${ok} ok, ${failed.length} missing`), 'err');
          UI.toast(L(`${failed.length} 题未返回，可点卡片重新生成`, `${failed.length} missing — regenerate on the card`), 3600);
        } else {
          UI.status(L(`完成：${ok} 题（1 次请求）`, `Done: ${ok} answer(s) in one request`));
          UI.toast(L(`已生成 ${ok} 道答案（1 次请求）`, `${ok} answer(s) in one request`));
        }
        return { ok, failed };
      } finally {
        App.busy = false;
        this.setBusy(false);
        UI.setStopVisible(false);
        UI.updateUsage();
      }
    },

    async fillOne(q) {
      if (!q.answer) {
        UI.toast(L('先点「生成」', 'Generate first'));
        return;
      }
      const r = await Appliers.apply(q);
      UI.toast(r.msg || (r.ok ? L('已填入', 'Filled') : L('填入失败', 'Fill failed')), r.ok ? 1800 : 3200);
      UI.status(r.msg || '', r.ok ? undefined : 'err');
      if (r.ok && Store.get('autoSubmit')) {
        const s = await Appliers.submit(q);
        if (s.skipped) UI.toast(s.msg, 3200);
        else if (s.ok) UI.toast(s.msg);
      }
      return r;
    },

    async fillAll() {
      const scan = App.scan;
      if (!scan || !scan.questions.length) {
        UI.toast(L('先扫描页面', 'Scan the page first'));
        return;
      }
      let ok = 0;
      let skip = 0;
      let done = 0;
      for (const q of scan.questions) {
        if (!q.answer) {
          skip++;
          continue;
        }
        // 已经交过的题不去动它的答案
        if (Appliers.submitState(q) !== 'open') {
          done++;
          continue;
        }
        const r = await Appliers.apply(q);
        if (r.ok) ok++;
        await sleep(220);
      }
      const tail = skip ? L(` · ${skip} 题没有答案`, ` · ${skip} without answers`) : '';
      const tailDone = done ? L(` · ${done} 题已经提交过（跳过）`, ` · ${done} already submitted (skipped)`) : '';
      UI.status(L(`已填入 ${ok} 题`, `Filled ${ok}`) + tail + tailDone);
      UI.toast(L(`已填入 ${ok} 题`, `Filled ${ok}`) + (skip ? L(`，${skip} 题需要先生成`, `; ${skip} need generating first`) : '') + (done ? L(`，${done} 题已经提交过`, `; ${done} already submitted`) : ''));
    },

    /**
     * 一键完成：检测 → 生成 → 逐题填入 → 逐题提交。
     * 每道题走同一套流程：填入 → 提交 → 关掉站点的 Pending 弹层 → 判断这次提交成没成功。
     * 生成阶段沿用 v1.11 的批量作答（一次请求答完整页，省 token）；填入与提交逐题做，
     * 因为提交是「一道题一次」的动作，而且提交后答案就改不了了，必须逐题确认结果。
     */
    async autoFlow() {
      if (App.busy || App.flow) return;
      if (!this.ensureKey()) return;

      App.flow = true;
      const mark = App.stopMark; // 用户中途按「停止」时用它判断
      const stat = { total: 0, filled: 0, submitted: 0, wrong: 0, skipped: 0, failed: [], blocked: false };
      try {
        // 1) 检测
        const scan = await this.scan(false);
        const qs = (scan && scan.questions) || [];
        stat.total = qs.length;
        if (!qs.length) {
          UI.toast(L('这一页没有可自动作答的题目', 'No auto-answerable questions here'));
          return;
        }

        // 1.5) 已经交过的题：不填、不碰按钮，也别白花 token
        const openQs = qs.filter((q) => Appliers.submitState(q) === 'open');
        if (!openQs.length) {
          const msg = Appliers.skippedMsg(Appliers.submitState(qs[0]));
          stat.skipped = qs.length;
          qs.forEach((q) => {
            q.submitStatus = 'skipped';
            UI.refreshCard(q);
          });
          UI.status(msg, 'err');
          UI.toast(msg, 4200);
          return stat;
        }
        const doneCount = qs.length - openQs.length;
        if (doneCount) {
          UI.toast(L(`其中 ${doneCount} 题已经提交过，会跳过`, `${doneCount} already submitted — will be skipped`), 2600);
        }

        // 2) 生成（批量优先，批量失败自动回退逐题）
        await this.solveAll();
        if (App.stopMark !== mark) {
          UI.status(L('已停止', 'Stopped'));
          return;
        }

        // 3) 逐题：填入 → 提交 → 关弹层 → 查错
        App.busy = true;
        this.setBusy(true);
        UI.setStopVisible(true);
        for (let i = 0; i < qs.length; i++) {
          if (!App.busy || App.stopMark !== mark) break;
          const q = qs[i];
          UI.status(L(`第 ${i + 1}/${qs.length} 题：填入并提交…`, `Question ${i + 1}/${qs.length}: filling and submitting…`), 'busy');

          // 已经交过的题：不填、不碰按钮，直接说清楚
          const st = Appliers.submitState(q);
          if (st !== 'open') {
            q.submitStatus = 'skipped';
            q.submitError = '';
            stat.skipped++;
            UI.refreshCard(q);
            continue;
          }

          if (!q.answer) {
            q.submitStatus = 'error';
            q.submitError = q.error || L('没有可用答案', 'no answer available');
            stat.failed.push({ n: i + 1, stage: L('生成', 'generate'), msg: q.submitError });
            UI.refreshCard(q);
            continue;
          }

          const r = await Appliers.apply(q);
          if (!r.ok) {
            q.submitStatus = 'error';
            q.submitError = r.msg;
            stat.failed.push({ n: i + 1, stage: L('填入', 'fill'), msg: r.msg });
            UI.refreshCard(q);
            continue;
          }
          stat.filled++;

          const s = await Appliers.submit(q);
          if (s.skipped) {
            // 中途才发现这题交过了：不碰按钮，如实标出来
            q.submitStatus = 'skipped';
            q.submitError = '';
            stat.skipped++;
          } else if (s.ok) {
            q.submitStatus = s.wrong ? 'wrong' : 'submitted';
            q.submitError = '';
            stat.submitted++;
            if (s.wrong) stat.wrong++;
          } else {
            q.submitStatus = 'error';
            q.submitError = s.err || s.msg;
            stat.failed.push({ n: i + 1, stage: L('提交', 'submit'), msg: q.submitError });
            // 弹窗关不掉 → 页面被挡住，后面的题也提交不了，就地停下
            if (s.blocked) {
              stat.blocked = true;
              UI.refreshCard(q);
              break;
            }
          }
          UI.refreshCard(q);
          await sleep(200);
        }
      } finally {
        App.flow = false;
        App.busy = false;
        this.setBusy(false);
        UI.setStopVisible(false);
        UI.updateUsage();
      }

      // 汇总：答案提交后改不了了，有问题必须说清楚
      const head = L(`完成：已提交 ${stat.submitted}/${stat.total}`, `Done: ${stat.submitted}/${stat.total} submitted`);
      const extra = stat.wrong ? L(`，${stat.wrong} 题被判为不正确`, `, ${stat.wrong} marked incorrect`) : '';
      const skipNote = stat.skipped
        ? L(`，跳过 ${stat.skipped} 题（已经提交过）`, `, ${stat.skipped} skipped (already submitted)`)
        : '';
      if (!stat.failed.length && stat.skipped && stat.skipped === stat.total) {
        const msg = L('这一页已经提交过了，没有可提交的内容', 'This page was already submitted — nothing to submit');
        UI.status(msg, 'err');
        UI.toast(msg, 4200);
        return stat;
      }
      if (stat.failed.length) {
        const detail = stat.failed.map((f) => `#${f.n} ${f.stage}: ${f.msg}`).join(' | ');
        UI.status(head + extra + skipNote + L(`，${stat.failed.length} 题有问题`, `, ${stat.failed.length} problem(s)`), 'err');
        UI.toast(head + extra + skipNote + L(`，${stat.failed.length} 题有问题`, `, ${stat.failed.length} problem(s)`), 5200);
        log('自动提交完成，有问题：', detail);
      } else {
        UI.status(head + extra + skipNote, stat.wrong ? 'err' : undefined);
        UI.toast(head + extra + skipNote, stat.wrong ? 4200 : 3000);
      }
      return stat;
    },

    setBusy(on) {
      const r = UI.refs;
      ['btn-scan', 'btn-solve', 'btn-fill', 'btn-auto'].forEach((k) => {
        if (r[k]) r[k].disabled = !!on;
      });
    },

    ensureKey() {
      const cfg = Store.get();
      if (!cfg.apiKey) {
        UI.setTab('cfg');
        UI.status(L('请先填写 API Key', 'API key required'), 'err');
        UI.toast(L('先在「设置」里填 API Key 和模型', 'Set API key and model in Settings first'));
        try {
          UI.refs.cfg.querySelector('[data-k="apiKey"]').focus();
        } catch (e) {
          /* ignore */
        }
        return false;
      }
      if (!cfg.model) {
        UI.setTab('cfg');
        UI.toast(L('请填写模型名，例如 gpt-4o-mini', 'Enter a model name, e.g. gpt-4o-mini'));
        return false;
      }
      return true;
    },

    /* ------------------------- 对话 ------------------------- */

    async sendChat() {
      if (App.busy) return;
      const input = UI.refs['chat-in'];
      const text = (input.value || '').trim();
      if (!text) return;
      if (!this.ensureKey()) return;
      input.value = '';
      App.chat.push({ role: 'user', content: text });
      UI.renderChat();

      App.busy = true;
      const cfg = Store.get();
      const sys = [
        'You are a study assistant on the JuiceMind learning platform. Answer the student\'s question.',
        'If the question is about the current page, give the answer and key steps directly.',
        `Answer in ${outputLanguageName()}.`,
      ].join('\n');
      const ctx = PageModel.contextText(3000);
      const messages = [{ role: 'system', content: sys }];
      if (ctx) messages.push({ role: 'system', content: '以下是当前页面内容（供参考）：\n' + ctx });
      for (const m of App.chat.slice(-8)) messages.push({ role: m.role, content: m.content });

      const bubble = UI.appendChat('assistant', '');
      bubble.classList.add('streaming');
      UI.setStopVisible(true);
      UI.status(L('思考中…', 'Thinking…'), 'busy');
      let acc = '';
      let firstDelta = true;
      const budget = Number(Store.get('summaryTokens')) || 4096;
      try {
        const res = await LLM.chat({
          messages,
          stream: !!cfg.stream,
          json: false,
          maxTokens: budget,
          onDelta: (piece) => {
            if (firstDelta) {
              firstDelta = false;
              UI.status(L('接收中…', 'Receiving…'), 'busy');
            }
            acc += piece;
            UI.updateBubble(bubble, acc);
          },
        });
        if (!acc && res && res.text) {
          // 服务端没走流式（或没有增量），直接用整段结果
          acc = res.text;
          UI.updateBubble(bubble, acc);
        }
        if (!acc) {
          const res2 = await LLM.chat({ messages, stream: false, json: false, maxTokens: budget });
          acc = res2.text;
          UI.updateBubble(bubble, acc);
        }
        if (!acc) acc = L('（模型没有返回内容）', '(model returned nothing)');
        UI.fillBubble(bubble, 'assistant', acc);
        App.chat.push({ role: 'assistant', content: acc });
        UI.status(L('就绪', 'Ready'));
      } catch (e) {
        const stopped = e && e.name === 'AbortError';
        if (stopped && acc) {
          // 主动停止：保留已生成的部分
          UI.fillBubble(bubble, 'assistant', acc + '\n\n_' + L('（已停止）', '(stopped)') + '_');
          App.chat.push({ role: 'assistant', content: acc + '\n\n_' + L('（已停止）', '(stopped)') + '_' });
          UI.status(L('已停止', 'Stopped'));
        } else {
          bubble.remove();
          App.chat.push({ role: 'assistant', content: '【' + L('请求失败', 'Request failed') + '】' + e.message });
          UI.appendChat('assistant', '【' + L('请求失败', 'Request failed') + '】' + e.message);
          UI.status(L('请求失败：', 'Request failed: ') + e.message, 'err');
        }
      } finally {
        bubble.classList.remove('streaming');
        App.busy = false;
        UI.setStopVisible(false);
        UI.updateUsage();
      }
    },

    /* ------------------------- 总结 ------------------------- */

    /** 把当前页正文压缩成速学笔记（结果作为一条聊天消息） */
    async summarize() {
      if (App.busy) return;
      if (!this.ensureKey()) return;
      const ctx = PageModel.contextText(Math.max(Number(Store.get('contextChars')) || 6000, 8000));
      if (!ctx || ctx.length < 80) {
        UI.toast(L('这一页没有可总结的正文', 'No text to summarize on this page'));
        return;
      }

      App.busy = true;
      UI.setStopVisible(true);
      UI.setTab('chat');
      UI.status(L('正在总结本页…', 'Summarizing…'), 'busy');
      const bubble = UI.startSummaryBubble();

      const outEn = outputLanguage() === 'en';
      const sys = outEn
        ? [
            'You are a study assistant. Turn the course text the user provides into quick-study notes, so a student can grasp the key points without reading the whole page.',
            'Use ONLY the provided text. Never add facts that are not in it.',
            'Output strictly in the Markdown structure below. No preamble, no closing remarks.',
            '',
            '## One-line summary',
            '(one sentence on what this page teaches)',
            '',
            '## Key points',
            '- (4-8 bullets, each with a one-line explanation)',
            '',
            '## Glossary',
            '| Term | Meaning |',
            '| --- | --- |',
            '(3-8 rows)',
            '',
            '## Pitfalls',
            '- (2-4 bullets; write "No obvious pitfalls" if there really are none)',
            '',
            '## Self-check',
            '1. (2-3 questions, put the answer in parentheses)',
            '',
            'Write everything in ENGLISH, including all headings, table headers and the content itself. Never mix in Chinese characters. Total length 250-400 words.',
          ].join('\n')
        : [
            '你是学习助手。把用户给出的课程正文整理成「速学笔记」，帮助学生不用读完原文也能抓住重点。',
            '只依据正文，不要补充正文里没有的内容；正文没提的不要写。',
            '严格按下面的 Markdown 结构输出，不要开场白、不要结束语：',
            '',
            '## 一句话总结',
            '（一句话概括这页讲什么）',
            '',
            '## 核心要点',
            '- （4~8 条，每条一句话解释）',
            '',
            '## 关键术语',
            '| 术语 | 含义 |',
            '| --- | --- |',
            '（3~8 行）',
            '',
            '## 易错点',
            '- （2~4 条；确实没有就写「无明显易错点」）',
            '',
            '## 自测',
            '1. （2~3 个问题，答案放在括号里）',
            '',
            '全部用中文书写，包括所有小标题、表头与正文，不要夹杂英文句子。总长度 300~500 字。',
          ].join('\n');

      const messages = [
        { role: 'system', content: sys },
        {
          role: 'user',
          content: outEn
            ? 'Course title: ' + PageModel.title() + '\n\nContent:\n' + ctx + '\n\n(Reply entirely in English.)'
            : '课程标题：' + PageModel.title() + '\n\n正文：\n' + ctx + '\n\n（全部用中文回复。）',
        },
      ];

      let acc = '';
      let first = true;
      try {
        const res = await LLM.chat({
          messages,
          stream: true, // 总结固定走流式：边生成边显示
          json: false,
          maxTokens: Number(Store.get('summaryTokens')) || 4096,
          onDelta: (piece) => {
            if (first) {
              first = false;
              UI.status(L('接收中…', 'Receiving…'), 'busy');
            }
            acc += piece;
            UI.updateSummaryBubble(bubble, acc);
          },
        });
        if (!acc && res && res.text) {
          acc = res.text;
          UI.updateSummaryBubble(bubble, acc);
        }
        if (!acc) throw new Error(L('模型没有返回内容', 'Model returned nothing'));
        UI.finishSummaryBubble(bubble, acc);
        App.chat.push({ role: 'assistant', content: acc, kind: 'summary' });
        UI.status(L('总结完成', 'Summary ready'));
        UI.toast(L('总结完成', 'Summary ready'));
      } catch (e) {
        if (e && e.name === 'AbortError') {
          if (acc) {
            UI.finishSummaryBubble(bubble, acc);
            App.chat.push({ role: 'assistant', content: acc, kind: 'summary' });
          } else {
            bubble.remove();
          }
          UI.status(L('已停止', 'Stopped'));
        } else {
          bubble.remove();
          UI.status(L('总结失败：', 'Summary failed: ') + e.message, 'err');
          UI.toast(L('总结失败：', 'Summary failed: ') + e.message, 3600);
        }
      } finally {
        App.busy = false;
        UI.setStopVisible(false);
        UI.updateUsage();
      }
    },

    /* ------------------------- 连接测试 ------------------------- */

    async testConnection() {
      UI.saveSettings();
      const cfg = Store.get();
      if (!cfg.apiKey) {
        UI.toast(L('先填 API Key', 'Set API key first'));
        return;
      }
      UI.status(L('正在测试连接…', 'Testing connection…'), 'busy');
      try {
        const res = await LLM.chat({
          messages: [
            { role: 'system', content: '只回复 OK 两个字母。' },
            { role: 'user', content: 'ping' },
          ],
          stream: false,
          json: false,
          timeout: 45000,
        });
        UI.updateUsage();
        UI.status(L('连接正常：', 'Connection OK: ') + truncate(oneLine(res.text), 40));
        UI.toast(L('连接成功 ✓ ', 'Connected ✓ ') + (res.model || cfg.model), 2600);
      } catch (e) {
        UI.status(L('连接失败：', 'Connection failed: ') + e.message, 'err');
        UI.toast(L('连接失败：', 'Connection failed: ') + e.message, 4200);
      }
    },
  };

  /* ============================ 11. 启动 ============================ */

  function waitForContent(timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const sel = WIDGET_SELECTORS.join(',') + ',.ProseMirror,.monaco-editor';
      const tick = () => {
        let has = false;
        try {
          has = !!document.querySelector(sel);
        } catch (e) {
          has = false;
        }
        if (has || Date.now() - t0 > (timeout || 15000)) resolve(has);
        else setTimeout(tick, 400);
      };
      tick();
    });
  }

  const Bootstrap = {
    async start() {
      NetTap.start();
      Router.start();

      const mountWhenReady = () => {
        if (document.body) UI.mount();
        else setTimeout(mountWhenReady, 100);
      };
      mountWhenReady();

      // 首次使用引导
      setTimeout(() => {
        const cfg = Store.get();
        if (!cfg.apiKey && UI.refs) {
          UI.setTab('cfg');
          UI.status(L('首次使用：填写 API Key 与模型', 'First run: fill in API key and model'));
        }
      }, 600);

      Router.on(async () => {
        log('路由变化', location.pathname);
        App.scan = null;
        PageModel.scope = null;
        App.chat = [];
        if (UI.refs) {
          UI.renderQuestions();
          UI.renderChat();
        }
        if (Store.get('autoRun')) {
          await waitForContent(12000);
          await sleep(400);
          await Actions.scan(false);
          if (App.scan && App.scan.questions.length) await Actions.solveAll();
        }
      });

      // 请求重试时给出可见反馈
      LLM.onRetry = (err, n, max) => {
        if (UI.refs) UI.status(L('请求失败，重试中 ', 'Retrying ') + n + '/' + max + '…', 'busy');
      };

      // 快捷键：用 e.code 判断物理键位，Mac 的 Option+J 会变成字符（∆），不能靠 e.key
      window.addEventListener(
        'keydown',
        (e) => {
          if (!e.altKey) return;
          const code = e.code || '';
          const key = (e.key || '').toLowerCase();
          if (code === 'KeyJ' || key === 'j') {
            e.preventDefault();
            UI.toggleVisible();
          } else if (code === 'Enter' || key === 'enter') {
            e.preventDefault();
            Actions.solveAll();
          } else if ((code === 'KeyS' || key === 's') && e.shiftKey) {
            e.preventDefault();
            Actions.scan(true);
          }
        },
        true
      );

      // 调试入口
      try {
        W.__JMAI__ = { App, UI, Actions, PageModel, Solvers, HumanTyping, Appliers, ParsonsHelper, LLM, NetTap, Store, Theme, MD, copyText, PRESETS, modelSuggestions, IS_MAC, curLang, outputLanguage, outputLanguageName, VERSION };
      } catch (e) {
        /* ignore */
      }

      // 首次自动扫描（页面可能还在渲染，等内容出现）
      if (Store.get('autoRun')) {
        await waitForContent(15000);
        await sleep(500);
        await Actions.scan(false);
      }

      log('已就绪 v' + VERSION);
    },
  };

  Bootstrap.start();
})();
