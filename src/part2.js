
  /* ============================ 5. 页面模型 ============================ */

  const PageKind = {
    CLASS: 'class', // 课程/小组首页：左侧导航 + 条目列表
    ITEM: 'item', //  `/classes/:teamId/item/:itemId` 教学条目（教程 / 题目 / 编程）
    QUIZ: 'quiz', //  `/quizzes/:quizId` 测验
    GAMEROOM: 'gameroom', //  `/gameRoom/:id` 实时竞赛
    COURSE: 'course', //  `/course*`、`/course-router*` 公开课程
    IDE: 'ide', //  内嵌 IDE 独立页
    GENERIC: 'generic',
  };

  /**
   * 真实站点的交互节点是 Tiptap 的 React nodeView：
   *   <div class="react-renderer node-multipleChoiceQuestion" contenteditable="false">
   *     <div data-testid="multiple-choice-question" data-node-view-wrapper> ...
   * 注意：renderHTML 里的 data-* 占位属性在 live DOM 里**不会**出现，只能靠 node-<类型> 类名。
   */
  const NODE_TYPE_MAP = {
    multiplechoicequestion: 'mcq',
    multiplechoicequestionv2: 'mcq',
    shortanswer: 'short',
    freetext: 'free',
    codesubmission: 'code',
    codefreetext: 'code',
    parsons: 'parsons',
    fillintheblank: 'blank',
    draganddrop: 'dnd',
    tableselect: 'table',
    ide: 'code', // 课件里的 IDE 块
  };

  /** 旧版/编辑器态才会出现的语义属性（保留兼容） */
  const WIDGET_SELECTORS = [
    '[data-multipleChoiceQuestion]',
    '[data-multipleChoiceQuestionV2]',
    '[data-shortAnswer]',
    '[data-free-text]',
    '[data-code-submission]',
    '[data-code-free-text]',
    '[data-parsons]',
    '[data-fillInTheBlank]',
    '[data-dragAndDrop]',
    '[data-tableSelect]',
  ];

  const TYPE_LABEL = {
    mcq: '选择题',
    multiselect: '多选题',
    short: '简答',
    free: '论述',
    code: '编程',
    parsons: '排序题',
    blank: '填空',
    dnd: '拖拽',
    table: '表格选择',
    unknown: '未知',
  };

  const PageModel = {
    kind: PageKind.GENERIC,
    scope: null,
    questions: [],
    scannedAt: 0,

    detectKind() {
      const path = location.pathname;
      let kind = PageKind.GENERIC;
      if (/^\/classes\/[^/]+\/item\//.test(path)) kind = PageKind.ITEM;
      else if (/^\/classes\/[^/]+\/?$/.test(path)) kind = PageKind.CLASS;
      else if (/^\/quizzes\//.test(path)) kind = PageKind.QUIZ;
      else if (/^\/gameRoom\//.test(path)) kind = PageKind.GAMEROOM;
      else if (/^\/(course|courses)\//.test(path)) kind = PageKind.COURSE;

      // 路径不认识时按 DOM 特征判断
      if (kind === PageKind.GENERIC) {
        if ($('.ProseMirror') || $('.react-renderer')) kind = PageKind.ITEM;
        else if ($('[data-testid="ide-panel"]')) kind = PageKind.IDE;
      }
      // 有正文就用条目视图；只有 IDE、没有正文才算独立 IDE
      if (kind === PageKind.ITEM && !$('.ProseMirror') && $('[data-testid="ide-panel"]')) kind = PageKind.IDE;

      this.kind = kind;
      return kind;
    },

    /** 内容作用域：题目/教程所在的容器（不同页面形态用不同策略） */
    findScope() {
      // 测验 / 实时竞赛：页面上只该看见当前这一题，读「当前题卡片」而不是整页
      if (this.kind === PageKind.QUIZ || this.kind === PageKind.GAMEROOM) {
        const tight = this._tightScope();
        if (tight) {
          this.scope = tight;
          return tight;
        }
      }
      if (this.kind === PageKind.IDE) {
        const panel = $('[data-testid="ide-panel"]');
        if (panel) {
          const host = panel.closest('section,main,div') || panel;
          this.scope = host;
          return host;
        }
      }

      const candidates = [
        '[data-testid="lesson-body-editor"]',
        '.ProseMirror',
        '[data-testid="lesson-content"]',
        '[data-testid="item-content"]',
        'main [role="main"]',
        'main',
        '[role="main"]',
        'article',
        '#main-content',
      ];
      let best = null;
      let bestScore = -1;
      for (const sel of candidates) {
        for (const el of $$(sel)) {
          if (!isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 320) continue;
          const textLen = textOf(el).length;
          const widgetCount = this._countWidgets(el);
          // lesson-body-editor / ProseMirror 就是正文，优先
          const bonus = /lesson-body-editor|ProseMirror/.test(el.getAttribute('data-testid') || '') || el.classList.contains('ProseMirror') ? 4 : 0;
          const score = Math.min(textLen, 20000) / 1000 + widgetCount * 3 + bonus;
          if (score > bestScore) {
            best = el;
            bestScore = score;
          }
        }
      }
      if (!best) best = this._densestContainer();
      this.scope = best;
      return best;
    },

    _countWidgets(el) {
      let n = 0;
      for (const s of WIDGET_SELECTORS) n += el.querySelectorAll(s).length;
      for (const node of el.querySelectorAll('.react-renderer')) {
        if (this._typeOf(node) !== 'unknown') n++;
      }
      return n;
    },

    _densestContainer() {
      let host = document.body;
      let max = 0;
      for (const el of $$('.react-renderer')) {
        let p = el.parentElement;
        for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
          const n = this._countWidgets(p);
          if (n > max) {
            max = n;
            host = p;
          }
        }
      }
      return host;
    },

    /** 只包住「当前一个」可见控件的最近容器（测验/竞赛用） */
    _tightScope() {
      const all = this._allWidgets(document);
      const visible = all.filter((w) => isVisible(w));
      if (!visible.length) return null;
      const first = visible[0];
      let best = first;
      let node = first.parentElement;
      for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
        if (node === document.body || node === document.documentElement) break;
        const n = this._allWidgets(node).filter((w) => isVisible(w)).length;
        if (n === 1) best = node;
        else break; // 再往上就包住别的题了
      }
      return best;
    },

    /** 控件文本减去若干子元素文本（用于剔除选项/编辑器内容） */
    textExcluding(container, excludeEls) {
      let t = textOf(container);
      for (const ex of excludeEls || []) {
        if (!ex) continue;
        const s = textOf(ex);
        if (s && s.length > 3) t = t.split(s).join('\n');
      }
      return norm(t);
    },

    /**
     * 题干抽取策略（从精确到宽松）：
     *   1. 节点上的 data-prompt / data-question 属性
     *   2. 站点的题干容器：data-multipleChoiceTitle / .mcqtitle / short-answer-prompt-editor
     *   3. 语义化类名（含 prompt / question-title）
     *   4. 控件自身文本 − 选项 − 编辑器 − 按钮
     *   5. 祖先文本前缀
     */
    promptOf(container, optionTexts, excludeEls) {
      const direct = container.getAttribute('data-prompt') || container.getAttribute('data-question');
      if (direct && oneLine(direct).length > 4) return norm(direct);

      const titleEl =
        container.querySelector('[data-multipleChoiceTitle],[data-prompt],[data-question]') ||
        container.querySelector('[data-testid="short-answer-prompt-editor"],[data-testid="free-response-item-prompt"]');
      if (titleEl) {
        const t = oneLine(textOf(titleEl));
        if (t.length > 3) return t;
      }

      // 站点 MCQ：.mcqtitle 的第一个就是题干（后面的都是选项行）
      const mcqTitle = container.querySelector('.mcqtitle');
      if (mcqTitle) {
        const t = oneLine(textOf(mcqTitle));
        if (t.length > 3) return t;
      }

      const semantic = container.querySelector(
        '[class*="prompt" i],[class*="question-title" i],[data-testid*="prompt" i],[data-testid*="question" i],legend'
      );
      if (semantic && !(excludeEls || []).includes(semantic)) {
        const t = oneLine(textOf(semantic));
        if (t.length > 4 && t.length < 1500) return t;
      }

      const selfText = textOf(container);
      const own = this.textExcluding(container, excludeEls || []);
      const ownClean = stripParts(own, optionTexts);
      if (ownClean.length >= 8) return truncate(ownClean, 1500);

      let node = container.parentElement;
      for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
        const t = textOf(node);
        if (!t || t.length <= selfText.length + 12) continue;
        const prefix = t.split(selfText)[0] || '';
        const cleaned = stripParts(prefix, optionTexts);
        if (cleaned.length >= 8 && cleaned.length <= 2500) return cleaned;
      }

      return truncate(oneLine(own), 1200);
    },

    /* ------------------------- 选项抽取 ------------------------- */

    extractOptions(container) {
      const out = [];
      const push = (el, clickEl, input) => {
        let raw = oneLine(textOf(el));
        if (!raw) {
          const aria = el.getAttribute && el.getAttribute('aria-label');
          if (aria) raw = oneLine(aria);
        }
        if (!raw) {
          const aria2 = input && input.getAttribute && input.getAttribute('aria-label');
          if (aria2) raw = oneLine(aria2);
        }
        if (!raw) return;
        const label = (raw.match(/^\s*([A-Ha-h])[.)、:：]\s*/) || [])[1];
        out.push({
          index: out.length,
          text: raw.replace(/^\s*([A-Ha-h]|\d{1,2})[.)、:：]\s*/, '').trim() || raw,
          raw,
          label: label ? label.toUpperCase() : String.fromCharCode(65 + out.length),
          el,
          clickEl: clickEl || el,
          input: input || null,
        });
      };

      // 1) 站点真实结构：form 里的 radio/checkbox，每行是 input 的父节点
      const realInputs = $$('form input[type="radio"],form input[type="checkbox"]', container);
      if (realInputs.length) {
        realInputs.forEach((inp) => {
          const row = inp.parentElement || inp;
          // 选项文本在同行 .mcqtitle 里；没找到就用整行
          const labelBox = row.querySelector('.mcqtitle') || row;
          const text = oneLine(textOf(labelBox));
          if (!text) return;
          out.push({
            index: out.length,
            text,
            raw: text,
            label: String.fromCharCode(65 + out.length),
            el: row,
            clickEl: inp,
            input: inp,
          });
        });
        return this._finalizeOptions(out);
      }

      // 2) 编辑器态的结构化选项节点
      let els = $$('[data-multipleChoiceOption]', container);
      if (els.length) {
        els.forEach((el) => push(el, el.querySelector('input,button') || el, el.querySelector('input')));
        return this._finalizeOptions(out);
      }

      // 3) label + radio/checkbox
      const inputs = $$('input[type="radio"],input[type="checkbox"]', container).filter(isVisible);
      if (inputs.length) {
        inputs.forEach((inp) => {
          let lab = null;
          if (inp.id) {
            try {
              lab = container.querySelector('label[for="' + CSS.escape(inp.id) + '"]');
            } catch (e) {
              lab = null;
            }
          }
          if (!lab) lab = inp.closest('label');
          if (!lab) {
            const p = inp.parentElement;
            lab = p && oneLine(textOf(p)).length > oneLine(textOf(inp)).length + 1 ? p : inp.nextElementSibling || p;
          }
          push(lab || inp, lab || inp, inp);
        });
        return this._finalizeOptions(out);
      }

      // 4) 语义化按钮组
      const btns = $$('button,[role="radio"],[role="checkbox"],[role="option"]', container).filter((b) => {
        if (!isVisible(b)) return false;
        const t = oneLine(textOf(b));
        if (!t || t.length > 300) return false;
        return !/^(submit|提交|run|运行|reset|重置|hint|提示|next|下一步|previous|上一步|save|保存|check|检查|show|查看|add image|add option|delete)/i.test(t);
      });
      if (btns.length >= 2) {
        btns.forEach((b) => push(b, b, null));
        return this._finalizeOptions(out);
      }

      return out;
    },

    _finalizeOptions(list) {
      const seen = new Set();
      const out = [];
      for (const o of list) {
        const key = oneLine(o.text).toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        o.index = out.length;
        out.push(o);
      }
      return out;
    },

    /* ------------------------- 编辑器定位 ------------------------- */

    _editorIn(root) {
      const mon = root.querySelector('.monaco-editor');
      if (mon && isVisible(mon)) return { kind: 'monaco', el: mon };
      const cm = root.querySelector('.cm-editor');
      if (cm && isVisible(cm)) return { kind: 'cm', el: cm };
      const resp = root.querySelector('[data-testid="short-answer-response-editor"] [contenteditable="true"]');
      if (resp && isVisible(resp)) return { kind: 'pm', el: resp };
      const ce = root.querySelector('[contenteditable="true"]');
      if (ce && isVisible(ce)) return { kind: 'pm', el: ce };
      const ta = root.querySelector('textarea');
      if (ta && isVisible(ta)) return { kind: 'textarea', el: ta };
      return null;
    },

    findEditor(container) {
      let ed = this._editorIn(container);
      if (ed) return ed;
      // 控件容器可能只包了标题，编辑器在上一层
      let node = container.parentElement;
      for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
        ed = this._editorIn(node);
        if (ed) return ed;
      }
      // 页面级 IDE：普通嵌套找不到时，退到最近的编辑器
      const all = $$('.monaco-editor,.cm-editor').filter(isVisible);
      if (all.length) {
        const cr = container.getBoundingClientRect();
        let best = all[0];
        let bd = Infinity;
        for (const el of all) {
          const r = el.getBoundingClientRect();
          const d = Math.abs(r.top - cr.bottom) + Math.abs(r.left - cr.left) / 4;
          if (d < bd) {
            bd = d;
            best = el;
          }
        }
        if (bd < 1600) return { kind: best.classList.contains('cm-editor') ? 'cm' : 'monaco', el: best };
      }
      return null;
    },

    /* ------------------------- 控件发现 ------------------------- */

    _typeOf(el) {
      if (!el || el.nodeType !== 1) return 'unknown';
      if (el.hasAttribute('data-multipleChoiceQuestion') || el.hasAttribute('data-multipleChoiceQuestionV2')) return 'mcq';
      if (el.hasAttribute('data-code-submission') || el.hasAttribute('data-code-free-text')) return 'code';
      if (el.hasAttribute('data-parsons')) return 'parsons';
      if (el.hasAttribute('data-fillInTheBlank')) return 'blank';
      if (el.hasAttribute('data-shortAnswer')) return 'short';
      if (el.hasAttribute('data-free-text')) return 'free';
      if (el.hasAttribute('data-dragAndDrop')) return 'dnd';
      if (el.hasAttribute('data-tableSelect')) return 'table';

      const cls = typeof el.className === 'string' ? el.className : '';
      const m = cls.match(/(?:^|\s)node-([\w-]+)/);
      if (m) return NODE_TYPE_MAP[m[1].toLowerCase()] || 'unknown';

      const tid = el.getAttribute('data-testid') || '';
      if (tid === 'multiple-choice-question') return 'mcq';
      if (tid === 'short-answer-response-editor') return 'short';
      return 'unknown';
    },

    /** 收集所有候选控件（两套选择器取并集） */
    _allWidgets(root) {
      const r = root || document;
      const hits = [];
      const seen = new Set();
      const add = (el) => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        hits.push(el);
      };
      for (const s of WIDGET_SELECTORS) {
        for (const el of $$(s, r)) add(el);
      }
      for (const el of $$('.react-renderer', r)) {
        if (this._typeOf(el) !== 'unknown') add(el);
      }
      return hits;
    },

    _collectWidgets(scope) {
      const root = scope || document.body;
      const hits = this._allWidgets(root);
      if (!hits.length) return [];
      // 嵌套去重：保留最外层
      const out = [];
      for (const el of hits) {
        if (out.some((o) => o.contains(el))) continue;
        // 显式隐藏的（display:none / hidden / visibility:hidden）一律跳过：
        // 测验页常常把上一题、下一题都留在 DOM 里
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || (el.closest && el.closest('[hidden]'))) continue;
        out.push(el);
      }
      return out;
    },

    /* ------------------------- 扫描 ------------------------- */

    scan() {
      const kind = this.detectKind();
      const scope = this.findScope();
      const questions = [];
      const used = new Set();

      for (const el of this._collectWidgets(scope)) {
        const q = this.buildQuestion(el, this._typeOf(el));
        if (!q) continue;
        questions.push(q);
        used.add(el);
      }

      // 兜底：站点把 IDE / 输入框放在正文之外（例如练习题页）
      for (const q of this._scanLoose(used)) questions.push(q);

      const filtered = questions.filter((q) => {
        if (q.type === 'code' && q.editor) return true;
        if (q.options && q.options.length) return true;
        return (q.prompt || '').length > 6;
      });

      filtered.forEach((q, i) => {
        q.order = i;
        q.id = q.id || uid('q');
      });

      this.questions = filtered;
      this.scannedAt = Date.now();
      return {
        kind,
        title: this.title(),
        context: this.contextText(),
        questions: filtered,
      };
    },

    /** 编辑器上方的前文（编程题的题面通常写在 IDE 上方的段落里） */
    precedingText(el, max) {
      const cap = max || 1500;
      const parts = [];
      const size = () => parts.join('\n').length;
      let node = el;
      for (let depth = 0; depth < 4 && node && size() < cap; depth++) {
        let sib = node.previousElementSibling;
        while (sib && size() < cap) {
          if (!/^(SCRIPT|STYLE|NOSCRIPT)$/.test(sib.tagName)) {
            const t = oneLine(textOf(sib));
            if (t) parts.push(t);
          }
          sib = sib.previousElementSibling;
        }
        node = node.parentElement;
      }
      return truncate(norm(parts.reverse().join('\n')), cap);
    },

    buildQuestion(el, type) {
      if (type === 'unknown') return null;

      let options = [];
      let editor = null;
      let prompt = '';

      if (type === 'mcq') {
        options = this.extractOptions(el);
        const btnCount = $$('form input[type="checkbox"]', el).length;
        if (btnCount > 0) type = 'multiselect';
        else if (el.querySelector('input[type="checkbox"]')) type = 'multiselect';
        prompt = this.promptOfMcq(el, options);
      } else if (type === 'code') {
        editor = this.findEditor(el);
        // IDE 块还没挂载时（页面显示 Loading…）直接跳过，别造一道空题
        if (!editor) return null;
        const isIdeBlock =
          /(^|\s)node-ide(\s|$)/.test(typeof el.className === 'string' ? el.className : '') ||
          !!el.querySelector('[data-testid="ide-panel"]');
        // IDE 块自己的文本是「main.py / History / Submit Answer」这类界面字，题面在它上方的正文里
        const own = stripLabelLine(this.promptOf(el, [], [editor.el]));
        if (isIdeBlock) {
          const before = this.precedingText(el, 1500);
          prompt = before.length >= 40 ? before : own;
        } else {
          prompt = own;
        }
      } else {
        editor = this.findEditor(el);
        const excludes = [];
        if (editor) excludes.push(editor.el);
        for (const b of $$('button,[role="button"]', el)) {
          if (isVisible(b)) excludes.push(b);
        }
        prompt = stripLabelLine(this.promptOf(el, [], excludes));
      }

      // 有 Monaco 的「简答」其实是写代码
      if ((type === 'short' || type === 'free') && editor && editor.kind === 'monaco') type = 'code';

      const q = {
        id: uid('q'),
        type,
        prompt,
        options,
        editor,
        container: el,
        element: el,
        answer: null,
        status: 'idle',
        error: '',
      };
      this._enrich(q);
      return q;
    },

    promptOfMcq(container, options) {
      const titleEl = container.querySelector('[data-multipleChoiceTitle]') || container.querySelector('.mcqtitle');
      if (titleEl) {
        const t = oneLine(textOf(titleEl));
        if (t.length > 3) return stripLabelLine(t);
      }
      return stripLabelLine(this.promptOf(container, options.map((o) => o.raw), []));
    },

    /** 用网络嗅探到的节点补全图片选项 / 代码模板 */
    _enrich(q) {
      try {
        const nodes = NetTap.collectNodes();
        if (!nodes.length) return;
        let best = null;
        let bestScore = 0.25;
        for (const n of nodes) {
          const p = oneLine(n.prompt || n.titleContent || n.question || '');
          if (!p) continue;
          const s = similarity(p, q.prompt);
          if (s > bestScore) {
            bestScore = s;
            best = n;
          }
        }
        if (!best) return;
        q.hint = best;
        if (!q.prompt && best.prompt) q.prompt = oneLine(best.prompt);
        if (best.codeTemplate && q.editor && !q.codeTemplate) q.codeTemplate = String(best.codeTemplate);
        if (Array.isArray(best.choices) && q.options.length === 0) {
          q.options = best.choices.map((c, i) => ({ index: i, text: String(c), raw: String(c), label: String.fromCharCode(65 + i), el: null, clickEl: null, input: null }));
        }
        if (best.data && best.data.solution) q.parsonsData = best.data;
      } catch (e) {
        /* 忽略 */
      }
    },

    /**
     * 原生控件兜底：
     *   - 页面级 IDE（练习题页的 CodeMirror，不在正文节点里）
     *   - 文本域
     *   - 单选/复选组（按容器分组，不能按 name —— 站点每道题都用 name="choices"）
     */
    _scanLoose(used) {
      const out = [];
      const insideUsed = (el) => Array.from(used).some((x) => x.contains(el) || el.contains(x));
      const inNoise = (el) =>
        !!(el.closest && (el.closest('[role="tree"]') || el.closest('header') || el.closest('nav') || el.closest('[data-testid="maintenance-banner"]')));

      // 1) 代码编辑器
      for (const edEl of $$('.monaco-editor,.cm-editor')) {
        if (!isVisible(edEl) || insideUsed(edEl) || inNoise(edEl)) continue;
        // 同一面板里只取最外层的那个编辑器
        if (edEl.closest('.monaco-editor') && edEl !== edEl.closest('.monaco-editor') && edEl.classList.contains('cm-editor')) continue;
        const kind = edEl.classList.contains('cm-editor') ? 'cm' : 'monaco';
        const panel = edEl.closest('[data-testid="ide-panel"]');
        const body = $('[data-testid="lesson-body-editor"]');
        let prompt = '';
        if (body) prompt = truncate(oneLine(textOf(body)), 1500);
        if (!prompt) prompt = this.promptOf(panel || edEl.parentElement || edEl, []);
        out.push({
          id: uid('q'),
          type: 'code',
          prompt: stripLabelLine(prompt),
          options: [],
          editor: { kind, el: edEl },
          container: panel || edEl.parentElement || edEl,
          element: edEl,
          answer: null,
          status: 'idle',
        });
      }

      // 2) 文本域（排除代码编辑器内部）
      for (const ta of $$('textarea')) {
        if (!isVisible(ta) || insideUsed(ta) || inNoise(ta) || ta.closest('.monaco-editor,.cm-editor')) continue;
        const wrap = ta.closest('div') || ta.parentElement;
        out.push({
          id: uid('q'),
          type: 'short',
          prompt: stripLabelLine(this.promptOf(wrap || ta, [])),
          options: [],
          editor: { kind: 'textarea', el: ta },
          container: wrap || ta,
          element: ta,
          answer: null,
          status: 'idle',
        });
      }

      // 3) 单选/复选组：按「最近的题目容器」分组
      const groups = new Map();
      for (const inp of $$('input[type="radio"],input[type="checkbox"]')) {
        if (!isVisible(inp) || insideUsed(inp) || inNoise(inp)) continue;
        const holder =
          inp.closest('form') ||
          inp.closest('.react-renderer') ||
          inp.closest('[data-testid*="question" i]') ||
          inp.closest('fieldset,[role="radiogroup"]') ||
          inp.parentElement.parentElement;
        if (!groups.has(holder)) groups.set(holder, []);
        groups.get(holder).push(inp);
      }
      for (const [holder, inputs] of groups) {
        if (inputs.length < 2) continue;
        const options = this.extractOptions(holder);
        if (options.length < 2) continue;
        out.push({
          id: uid('q'),
          type: inputs[0].type === 'checkbox' ? 'multiselect' : 'mcq',
          prompt: this.promptOfMcq(holder, options),
          options,
          editor: null,
          container: holder,
          element: holder,
          answer: null,
          status: 'idle',
        });
      }

      return out;
    },

    /* ------------------------- 页面上下文 ------------------------- */

    contextText(limit) {
      const cap = limit || Store.get('contextChars') || 6000;
      const scope = this.scope || this.findScope();
      let txt = '';
      if (scope) txt = textOf(scope);
      if (!txt || txt.length < 80) txt = textOf(document.body);
      const noise = /^(JuiceMind|Home|Classes|Classwork|Settings|Profile|Log ?out|Sign ?in|Back|Next|Previous|Submit|Submit Answer|Run|Run Tests|Save|Help|Docs|Menu|Search|Add Image)$/i;
      const lines = txt
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !noise.test(l));
      return truncate(norm(lines.join('\n')), cap);
    },

    title() {
      const h1 = $('[data-testid="lesson-body-editor"] h1') || $('h1');
      const t = h1 ? oneLine(textOf(h1)) : '';
      return t || oneLine(document.title.replace(/[-|].*JuiceMind.*$/i, '')) || 'JuiceMind';
    },
  };
