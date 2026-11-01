
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
      const kindLabel = { class: '课程首页', item: '教学条目', quiz: '测验', gameroom: '实时竞赛', course: '公开课程', ide: 'IDE', generic: '普通页面' }[scan.kind] || scan.kind;
      UI.status(n ? `识别到 ${n} 道题 · ${kindLabel}` : `未识别到题目 · ${kindLabel}`);
      if (verbose) {
        UI.setTab('solve');
        if (!n) UI.toast('这一页没有可自动作答的题目');
        else UI.toast(`识别到 ${n} 道题`);
      }
      return scan;
    },

    async solveOne(q) {
      if (App.busy) return;
      if (!this.ensureKey()) return;
      App.busy = true;
      q.status = 'running';
      q.error = '';
      UI.refreshCard(q);
      UI.status('正在生成答案…', 'busy');
      try {
        const answer = await Solvers.solveOne(q, App.scan || { context: PageModel.contextText(), title: PageModel.title(), kind: PageModel.kind }, App.scan ? App.scan.questions.indexOf(q) : 0);
        q.answer = answer;
        q.status = 'done';
        UI.status('答案已生成');
        UI.toast('已生成：' + truncate(UI.answerPreview(q).replace(/\n/g, ' '), 60));
        if (Store.get('autoSubmit')) {
          const r = await Appliers.apply(q);
          if (r.ok) await Appliers.submit(q);
        }
      } catch (e) {
        q.status = 'error';
        q.error = e.message || String(e);
        q.supportedModels = (e && e.supportedModels) || null;
        UI.status('生成失败：' + q.error, 'err');
        UI.toast('生成失败：' + q.error, 3600);
      } finally {
        App.busy = false;
        UI.refreshCard(q);
      }
    },

    /** 服务端说只支持某些模型名时，一键切过去并重试当前题 */
    async useModel(model, q) {
      Store.set({ model });
      UI.updateSub();
      UI.renderSettings();
      UI.toast('模型改为 ' + model, 1600);
      if (q) {
        q.supportedModels = null;
        q.error = '';
        await this.solveOne(q);
      }
    },

    async solveAll() {
      if (App.busy) return;
      if (!this.ensureKey()) return;
      let scan = App.scan;
      if (!scan || !scan.questions.length) scan = await this.scan(false);
      if (!scan.questions.length) return;

      App.busy = true;
      this.setBusy(true);
      const total = scan.questions.length;
      UI.status(`批量生成 0/${total}…`, 'busy');
      try {
        const res = await Solvers.solveAll(scan.questions, scan, {
          onBefore: (q, i) => {
            q.status = 'running';
            UI.refreshCard(q);
            UI.status(`批量生成 ${i + 1}/${total}…`, 'busy');
          },
          onDone: (q) => {
            UI.refreshCard(q);
          },
          onError: (q) => {
            UI.refreshCard(q);
          },
        });
        UI.status(`完成：成功 ${res.ok} · 失败 ${res.fail}`, res.fail ? 'err' : undefined);
        if (res.ok) UI.toast(`已生成 ${res.ok} 道答案`);
      } finally {
        App.busy = false;
        this.setBusy(false);
      }
    },

    async fillOne(q) {
      if (!q.answer) {
        UI.toast('先点「生成」');
        return;
      }
      const r = await Appliers.apply(q);
      UI.toast(r.msg || (r.ok ? '已填入' : '填入失败'), r.ok ? 1800 : 3200);
      UI.status(r.msg || '', r.ok ? undefined : 'err');
      if (r.ok && Store.get('autoSubmit')) {
        const s = await Appliers.submit(q);
        if (s.ok) UI.toast(s.msg);
      }
      return r;
    },

    async fillAll() {
      const scan = App.scan;
      if (!scan || !scan.questions.length) {
        UI.toast('先扫描页面');
        return;
      }
      let ok = 0;
      let skip = 0;
      for (const q of scan.questions) {
        if (!q.answer) {
          skip++;
          continue;
        }
        const r = await Appliers.apply(q);
        if (r.ok) ok++;
        await sleep(220);
      }
      UI.status(`已填入 ${ok} 题` + (skip ? ` · ${skip} 题没有答案` : ''));
      UI.toast(`已填入 ${ok} 题` + (skip ? `，${skip} 题需要先生成` : ''));
    },

    setBusy(on) {
      const r = UI.refs;
      ['btn-scan', 'btn-solve', 'btn-fill'].forEach((k) => {
        if (r[k]) r[k].disabled = !!on;
      });
    },

    ensureKey() {
      const cfg = Store.get();
      if (!cfg.apiKey) {
        UI.setTab('cfg');
        UI.status('请先填写 API Key', 'err');
        UI.toast('先在「设置」里填 API Key 和模型');
        try {
          UI.refs.cfg.querySelector('[data-k="apiKey"]').focus();
        } catch (e) {
          /* ignore */
        }
        return false;
      }
      if (!cfg.model) {
        UI.setTab('cfg');
        UI.toast('请填写模型名，例如 gpt-4o-mini');
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
        '你是 JuiceMind 学习平台上的学习助手，回答学生的提问。',
        '如果问题涉及当前页面上的题目，请直接给出答案与关键步骤。',
        `解释用${cfg.language === 'en' ? 'English' : '中文'}。`,
      ].join('\n');
      const ctx = PageModel.contextText(3000);
      const messages = [{ role: 'system', content: sys }];
      if (ctx) messages.push({ role: 'system', content: '以下是当前页面内容（供参考）：\n' + ctx });
      for (const m of App.chat.slice(-8)) messages.push({ role: m.role, content: m.content });

      const bubble = UI.appendChat('assistant', '');
      UI.status('思考中…', 'busy');
      let acc = '';
      try {
        const res = await LLM.chat({
          messages,
          stream: !!cfg.stream,
          json: false,
          onDelta: (piece) => {
            acc += piece;
            bubble.textContent = acc;
            UI.scrollChatToEnd();
          },
        });
        if (!acc && res && res.text) {
          // 服务端没走流式（或没有增量），直接用整段结果
          acc = res.text;
          bubble.textContent = acc;
        }
        if (!acc) {
          const res2 = await LLM.chat({ messages, stream: false, json: false });
          acc = res2.text;
          bubble.textContent = acc;
        }
        if (!acc) acc = '（模型没有返回内容）';
        App.chat.push({ role: 'assistant', content: acc });
        UI.status('就绪');
      } catch (e) {
        bubble.remove();
        App.chat.push({ role: 'assistant', content: '【请求失败】' + e.message });
        UI.appendChat('assistant', '【请求失败】' + e.message);
        UI.status('请求失败：' + e.message, 'err');
      } finally {
        App.busy = false;
      }
    },

    /* ------------------------- 连接测试 ------------------------- */

    async testConnection() {
      UI.saveSettings();
      const cfg = Store.get();
      if (!cfg.apiKey) {
        UI.toast('先填 API Key');
        return;
      }
      UI.status('正在测试连接…', 'busy');
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
        UI.status('连接正常：' + truncate(oneLine(res.text), 40));
        UI.toast('连接成功 ✓ ' + (res.model || cfg.model), 2600);
      } catch (e) {
        UI.status('连接失败：' + e.message, 'err');
        UI.toast('连接失败：' + e.message, 4200);
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
          UI.status('首次使用：填写 API Key 与模型');
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

      // 快捷键
      window.addEventListener(
        'keydown',
        (e) => {
          if (!e.altKey) return;
          const k = (e.key || '').toLowerCase();
          if (k === 'j') {
            e.preventDefault();
            const collapsed = UI.$wrap.getAttribute('data-collapsed') === 'true';
            UI.setCollapsed(!collapsed);
          } else if (k === 'enter') {
            e.preventDefault();
            Actions.solveAll();
          } else if (k === 's' && e.shiftKey) {
            e.preventDefault();
            Actions.scan(true);
          }
        },
        true
      );

      // 调试入口
      try {
        W.__JMAI__ = { UI, Actions, PageModel, Solvers, Appliers, ParsonsHelper, LLM, NetTap, Store, Theme, VERSION };
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
