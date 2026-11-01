// ==UserScript==
// @name         JuiceMind AI 答题助手
// @namespace    https://juicemind.com/
// @version      1.2.0
// @description  为 JuiceMind 学习平台提供 AI 辅助答题：自动识别教程/选择题/简答/编程/Parsons 等页面形式，调用外部大模型 API 生成答案并填入。玻璃拟态悬浮窗，跟随站点配色。
// @author       you
// @match        https://play.juicemind.com/*
// @match        https://classes.juicemind.com/*
// @match        https://*.juicemind.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   * JuiceMind AI 答题助手
   * -------------------------------------------------------------------------
   * 结构总览：
   *   0. 工具函数           utils
   *   1. 配置持久化         Store
   *   2. 主题感知           Theme        —— 读取站点 CSS 变量，跟随亮/暗色
   *   3. 网络嗅探           NetTap       —— 旁听 tRPC 响应，作为结构化内容来源
   *   4. 页面模型           PageModel    —— 按页面形态选择读取方案
   *   5. 大模型客户端       LLM          —— OpenAI 兼容协议 / GM_xmlhttpRequest 免 CORS
   *   6. 题型求解器         Solvers      —— 组卷、解析、落盘（填答案）
   *   7. 界面               UI           —— Shadow DOM 玻璃悬浮窗
   *   8. 启动               Bootstrap
   * ========================================================================= */

  const VERSION = '1.2.0';
  const LOG_PREFIX = '[JM-AI]';

  /* ============================ 0. 工具函数 ============================ */

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function debounce(fn, ms) {
    let t = 0;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /** 归一化文本：压缩空白、去零宽字符、统一引号 */
  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/[\u200b-\u200f\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** 单行归一化 */
  function oneLine(s) {
    return norm(s).replace(/\n+/g, ' ').trim();
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  /** 取元素可见文本（优先 innerText，尊重布局；回退 textContent） */
  function textOf(el) {
    if (!el) return '';
    try {
      const t = el.innerText;
      if (t && t.trim()) return t;
    } catch (e) {
      /* ignore */
    }
    return el.textContent || '';
  }

  /** 从一段文本中剔除若干片段（用于把选项文字从题干里剥掉） */
  function stripParts(text, parts) {
    let out = String(text || '');
    const sorted = parts
      .filter(Boolean)
      .map((p) => oneLine(p))
      .sort((a, b) => b.length - a.length);
    for (const p of sorted) {
      if (p.length < 2) continue;
      out = out.split(p).join('\n');
    }
    return norm(out);
  }

  /** 去掉题干首行的全大写小标签，例如 "QUESTION 1 · MULTIPLE CHOICE" */
  function stripLabelLine(text) {
    const t = norm(text);
    const lines = t.split('\n');
    if (lines.length > 1 && lines[0].length <= 60 && /^[A-Z0-9\s·:：\-–—()#'".]+$/.test(lines[0])) {
      lines.shift();
    }
    return norm(lines.join('\n'));
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function uid(p = 'q') {
    return p + '_' + Math.random().toString(36).slice(2, 9);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** 解析 #rgb / #rrggbb / rgb() / rgba() 为 {r,g,b,a}；失败返回 null */
  function parseColor(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return null;
    if (s.startsWith('#')) {
      let h = s.slice(1);
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      if (h.length !== 6) return null;
      const n = parseInt(h, 16);
      if (!Number.isFinite(n)) return null;
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    const m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      }
    }
    if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
    if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
    return null;
  }

  /** 相对亮度（0=黑，1=白） */
  function relLuminance(rgb) {
    if (!rgb) return 1;
    const f = (c) => {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
  }

  /** 词集合，用于选项模糊匹配 */
  function tokenSet(s) {
    return new Set(
      String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1)
    );
  }

  /** 简易相似度：Jaccard + 包含关系加权 */
  function similarity(a, b) {
    const A = oneLine(a).toLowerCase();
    const B = oneLine(b).toLowerCase();
    if (!A || !B) return 0;
    if (A === B) return 1;
    if (A.includes(B) || B.includes(A)) {
      const ratio = Math.min(A.length, B.length) / Math.max(A.length, B.length);
      return 0.75 + 0.25 * ratio;
    }
    const sa = tokenSet(A);
    const sb = tokenSet(B);
    if (!sa.size || !sb.size) return 0;
    let inter = 0;
    for (const w of sa) if (sb.has(w)) inter++;
    return inter / (sa.size + sb.size - inter);
  }

  function log(...args) {
    if (Store.get('debug')) console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  /* ============================ 1. 配置持久化 ============================ */

  const DEFAULT_CONFIG = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    maxTokens: 2048,
    extraHeaders: '',
    jsonMode: true, // 请求 response_format=json_object，失败自动降级
    language: 'zh', // 解释语言：zh | en
    reasoning: false, // 是否请求「先思考再作答」（纯提示词层面）
    autoSubmit: false, // 填入后是否自动点提交
    autoRun: false, // 进入新页面是否自动扫描并生成
    stream: true, // 对话页流式输出
    debug: false,
    systemPrompt: '', // 自定义追加提示词
    contextChars: 6000, // 送给模型的页面上下文上限
  };

  const STORE_KEY = 'jm_ai_config_v1';
  const UI_KEY = 'jm_ai_ui_v1';

  const Store = {
    _cache: null,
    _gmAvailable: typeof GM_getValue === 'function' && typeof GM_setValue === 'function',

    get(key) {
      if (!this._cache) this._cache = this._load();
      return key == null ? Object.assign({}, this._cache) : this._cache[key];
    },

    _load() {
      let raw = null;
      try {
        raw = this._gmAvailable ? GM_getValue(STORE_KEY, null) : localStorage.getItem(STORE_KEY);
      } catch (e) {
        raw = null;
      }
      let parsed = {};
      if (raw) {
        try {
          parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
          parsed = {};
        }
      }
      return Object.assign({}, DEFAULT_CONFIG, parsed || {});
    },

    set(patch) {
      this._cache = Object.assign(this._load(), patch || {});
      const raw = JSON.stringify(this._cache);
      try {
        if (this._gmAvailable) GM_setValue(STORE_KEY, raw);
        else localStorage.setItem(STORE_KEY, raw);
      } catch (e) {
        warn('保存配置失败', e);
      }
      return this._cache;
    },

    reset() {
      this._cache = Object.assign({}, DEFAULT_CONFIG);
      this.set(this._cache);
      return this._cache;
    },

    /** 界面状态（位置、折叠、标签页）与配置分开存 */
    ui(patch) {
      let cur = {};
      try {
        const raw = this._gmAvailable ? GM_getValue(UI_KEY, null) : localStorage.getItem(UI_KEY);
        cur = raw ? JSON.parse(raw) : {};
      } catch (e) {
        cur = {};
      }
      const next = Object.assign({}, cur, patch || {});
      try {
        const raw = JSON.stringify(next);
        if (this._gmAvailable) GM_setValue(UI_KEY, raw);
        else localStorage.setItem(UI_KEY, raw);
      } catch (e) {
        /* ignore */
      }
      return next;
    },

    uiGet() {
      try {
        const raw = this._gmAvailable ? GM_getValue(UI_KEY, null) : localStorage.getItem(UI_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (e) {
        return {};
      }
    },
  };

  /* ============================ 2. 主题感知 ============================ */

  const Theme = {
    palette: null,

    read() {
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      const pick = (name, fallback) => {
        const v = (cs.getPropertyValue(name) || '').trim();
        return v || fallback;
      };

      // 亮暗判定：优先读站点自己的 --background 亮度；读不到才退回类名/系统偏好
      const bgRaw = pick('--background', '');
      const bgRgb = parseColor(bgRaw);
      const prefersDark =
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) || false;
      let dark;
      if (bgRgb) dark = relLuminance(bgRgb) < 0.42;
      else if (root.classList.contains('dark') || root.getAttribute('data-theme') === 'dark' || (document.body && document.body.classList.contains('dark'))) dark = true;
      else dark = prefersDark;

      const p = {
        dark,
        primary: pick('--primary-color', '#4f46e5'),
        secondary: pick('--secondary-color', '#9333ea'),
        background: pick('--background', dark ? '#0a0a0a' : '#ffffff'),
        surface: pick('--surface', dark ? '#1a1a1a' : '#ffffff'),
        textPrimary: pick('--text-primary', dark ? '#ffffff' : '#1a1a1a'),
        textSecondary: pick('--text-secondary', dark ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.7)'),
        textMuted: pick('--text-muted', dark ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.5)'),
        border: pick('--border', dark ? 'rgba(79,70,229,.3)' : 'rgba(79,70,229,.2)'),
        success: pick('--success', '#10b981'),
        error: pick('--error', '#ef4444'),
      };
      this.palette = p;
      return p;
    },

    /** 监听站点亮暗切换 */
    observe(cb) {
      const fire = debounce(() => cb(this.read()), 120);
      const mo = new MutationObserver(fire);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
      if (document.body) {
        mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
      }
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', fire);
    },
  };

  /* ============================ 3. 网络嗅探 ============================ */

  /**
   * 旁听站点自身的 tRPC 响应。教学页面的题目结构、选项、代码模板等
   * 往往已经在页面初始化时由 tRPC 拉到浏览器里，直接复用比重建请求更安全。
   * 这里只读不写：不修改请求，不影响业务。
   */
  const NetTap = {
    records: [], // {url, procedure, json, at}
    max: 40,

    start() {
      if (this._started) return;
      this._started = true;
      try {
        this._patchFetch();
        this._patchXHR();
      } catch (e) {
        warn('网络嗅探启动失败（不影响主流程）', e);
      }
    },

    _patchFetch() {
      const orig = W.fetch;
      if (typeof orig !== 'function' || orig.__jmPatched) return;
      const self = this;
      const wrapped = function (input, init) {
        const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
        const p = orig.apply(this, arguments);
        if (url && /\/api\/trpc\//.test(url)) {
          p.then((res) => {
            try {
              const clone = res.clone();
              clone.text().then((t) => self._absorb(url, t)).catch(() => {});
            } catch (e) {
              /* ignore */
            }
          }).catch(() => {});
        }
        return p;
      };
      wrapped.__jmPatched = true;
      W.fetch = wrapped;
    },

    _patchXHR() {
      const self = this;
      const XO = W.XMLHttpRequest;
      if (!XO || XO.__jmPatched) return;
      const open = XO.prototype.open;
      const send = XO.prototype.send;
      XO.prototype.open = function (method, url) {
        this.__jmUrl = url;
        return open.apply(this, arguments);
      };
      XO.prototype.send = function () {
        const url = this.__jmUrl || '';
        if (/\/api\/trpc\//.test(String(url))) {
          this.addEventListener('load', () => {
            try {
              self._absorb(String(url), this.responseText);
            } catch (e) {
              /* ignore */
            }
          });
        }
        return send.apply(this, arguments);
      };
      XO.__jmPatched = true;
    },

    _absorb(url, text) {
      if (!text || text.length > 3_000_000) return;
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        return;
      }
      const proc = this._procName(url);
      this.records.unshift({ url, procedure: proc, json, at: Date.now() });
      if (this.records.length > this.max) this.records.length = this.max;
      log('tRPC 捕获', proc);
    },

    _procName(url) {
      const m = String(url).match(/\/api\/trpc\/([^?&#]+)/);
      if (!m) return '';
      return decodeURIComponent(m[1]).replace(/,$/, '');
    },

    /** 深度遍历已捕获的 JSON，收集所有看起来像「题目节点」的对象 */
    collectNodes() {
      const found = [];
      const seen = new Set();
      const walk = (v, depth) => {
        if (!v || depth > 14) return;
        if (Array.isArray(v)) {
          for (const it of v) walk(it, depth + 1);
          return;
        }
        if (typeof v !== 'object') return;
        if (seen.has(v)) return;
        seen.add(v);
        if (this._looksLikeNode(v)) found.push(v);
        for (const k in v) {
          if (Object.prototype.hasOwnProperty.call(v, k)) walk(v[k], depth + 1);
        }
      };
      for (const r of this.records) walk(r.json, 0);
      return found;
    },

    _looksLikeNode(o) {
      if (!o || typeof o !== 'object') return false;
      const t = o.type || o.nodeType || o.kind || o.__typename || o.name;
      if (typeof t !== 'string') return false;
      return /multipleChoice|shortAnswer|freeText|codeSubmission|codeFreeText|parsons|fillInTheBlank|dragAndDrop|tableSelect/i.test(t);
    },

    /** 找形如 markdown / 纯文本的课程内容（用于给模型补充上下文） */
    collectText() {
      const out = [];
      const seen = new Set();
      const walk = (v, depth) => {
        if (!v || depth > 12) return;
        if (Array.isArray(v)) {
          for (const it of v) walk(it, depth + 1);
          return;
        }
        if (typeof v !== 'object') return;
        if (seen.has(v)) return;
        seen.add(v);
        for (const k in v) {
          if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
          const val = v[k];
          if (typeof val === 'string' && /^(content|markdown|body|instructions|prompt|text)$/i.test(k) && val.length > 40) {
            out.push(val);
          } else {
            walk(val, depth + 1);
          }
        }
      };
      for (const r of this.records) walk(r.json, 0);
      return out;
    },
  };

  /* ============================ 4. 路由监听 ============================ */

  const Router = {
    _href: '',
    _cbs: [],

    on(cb) {
      this._cbs.push(cb);
    },

    start() {
      this._href = location.href;
      const fire = () => {
        if (location.href === this._href) return;
        this._href = location.href;
        const href = this._href;
        this._cbs.forEach((cb) => {
          try {
            cb(href);
          } catch (e) {
            warn('路由回调异常', e);
          }
        });
      };
      const wrap = (name) => {
        const orig = history[name];
        if (typeof orig !== 'function') return;
        history[name] = function () {
          const r = orig.apply(this, arguments);
          setTimeout(fire, 0);
          return r;
        };
      };
      wrap('pushState');
      wrap('replaceState');
      window.addEventListener('popstate', fire);
      setInterval(fire, 700); // SPA 兜底
    },
  };


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


  /* ============================ 6. 大模型客户端 ============================ */

  const PRESETS = {
    openai: {
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    },
    deepseek: {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      // 官方名 + 自建/网关常见别名，全部只是「建议」，模型框任意填写
      models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash'],
    },
    moonshot: {
      label: 'Moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k',
      models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0905-preview'],
    },
    openrouter: {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o-mini',
      models: ['openai/gpt-4o-mini', 'deepseek/deepseek-chat', 'anthropic/claude-sonnet-4'],
    },
    ollama: { label: 'Ollama(本地)', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', models: ['qwen2.5:7b', 'llama3.1:8b'] },
    custom: { label: '自定义', baseUrl: '', model: '', models: [] },
  };

  /** 模型下拉的所有建议值（去重） */
  function modelSuggestions() {
    const set = new Set();
    Object.keys(PRESETS).forEach((k) => (PRESETS[k].models || []).forEach((m) => set.add(m)));
    ['gpt-4o-mini', 'deepseek-v4.1-flash', 'deepseek-flash', 'deepseek-v4-pro'].forEach((m) => set.add(m));
    return Array.from(set);
  }

  /** 从服务端报错里抠出「supported API model names are X, Y」 */
  function parseSupportedModels(msg) {
    const s = String(msg || '');
    const m =
      s.match(/supported (?:api )?model(?: name)?s? (?:are|is)\s*:?\s*([^()\]]+)/i) ||
      s.match(/available models?\s*:?\s*([^()\]]+)/i) ||
      s.match(/model(?: name)? (?:must be|should be) one of\s*:?\s*([^()\]]+)/i);
    if (!m) return null;
    const list = m[1]
      .split(/[,，、]|\bor\b|\band\b/i)
      .map((x) => x.trim().replace(/^["'`]|["'`]$/g, '').replace(/[.,;:]+$/, '').trim())
      .filter((x) => x && x.length < 80 && /^[\w.\-:/@]+$/.test(x));
    return list.length ? list.slice(0, 8) : null;
  }

  const LLM = {
    _active: null,

    endpoint(baseUrl) {
      let u = String(baseUrl || '').trim().replace(/\/+$/, '');
      if (!u) throw new Error('未配置 API Base URL');
      if (/\/chat\/completions$/.test(u)) return u;
      return u + '/chat/completions';
    },

    headers() {
      const cfg = Store.get();
      const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (cfg.apiKey) h.Authorization = 'Bearer ' + cfg.apiKey.trim();
      // 自定义头：每行 "Key: Value"
      if (cfg.extraHeaders) {
        String(cfg.extraHeaders)
          .split('\n')
          .forEach((line) => {
            const i = line.indexOf(':');
            if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
          });
      }
      if (/openrouter\.ai/.test(cfg.baseUrl)) {
        h['HTTP-Referer'] = location.origin;
        h['X-Title'] = 'JuiceMind AI Assistant';
      }
      return h;
    },

    abort() {
      if (this._active) {
        try {
          this._active.abort();
        } catch (e) {
          /* ignore */
        }
        this._active = null;
      }
    },

    /**
     * @param {object} opts
     * @param {Array}  opts.messages
     * @param {boolean} opts.stream
     * @param {boolean} opts.json       请求 JSON 输出
     * @param {function} opts.onDelta   流式增量回调
     * @param {number} opts.timeout
     */
    async chat(opts) {
      const cfg = Store.get();
      const messages = opts.messages;
      const wantJson = opts.json !== false && cfg.jsonMode;
      let body = {
        model: cfg.model,
        messages,
        temperature: Number(cfg.temperature),
        max_tokens: Number(cfg.maxTokens),
        stream: !!opts.stream,
      };
      if (wantJson) body.response_format = { type: 'json_object' };
      if (!opts.stream) delete body.stream;

      const url = this.endpoint(cfg.baseUrl);
      const timeout = opts.timeout || (opts.stream ? 180000 : 120000);

      try {
        return await this._send(url, body, { stream: !!opts.stream, onDelta: opts.onDelta, timeout, json: wantJson });
      } catch (err) {
        // 降级 1：部分服务不支持 response_format
        if (body.response_format) {
          log('JSON 模式失败，降级重试', err.message);
          delete body.response_format;
          return await this._send(url, body, { stream: !!opts.stream, onDelta: opts.onDelta, timeout, json: false });
        }
        // 降级 2：推理模型不接受 temperature / max_tokens
        if (/temperature|max_tokens|unsupported|invalid/i.test(err.message || '')) {
          log('参数不兼容，改用推理模型参数', err.message);
          const b2 = Object.assign({}, body);
          delete b2.temperature;
          delete b2.max_tokens;
          b2.max_completion_tokens = Number(cfg.maxTokens);
          return await this._send(url, b2, { stream: !!opts.stream, onDelta: opts.onDelta, timeout, json: false });
        }
        throw err;
      }
    },

    async _send(url, body, opt) {
      const headers = this.headers();
      const payload = JSON.stringify(body);
      if (typeof GM_xmlhttpRequest === 'function') {
        return this._viaGM(url, headers, payload, opt);
      }
      return this._viaFetch(url, headers, payload, opt);
    },

    /** GM 通道：绕过 CORS，支持 onprogress 拼流 */
    _viaGM(url, headers, payload, opt) {
      return new Promise((resolve, reject) => {
        let received = 0;
        let text = '';
        const parser = opt.stream ? this._sseParser(opt.onDelta) : null;

        const req = GM_xmlhttpRequest({
          method: 'POST',
          url,
          headers,
          data: payload,
          timeout: opt.timeout,
          onprogress: (res) => {
            if (!opt.stream) return;
            const chunk = res.responseText.slice(received);
            received = res.responseText.length;
            parser(chunk);
          },
          onload: (res) => {
            this._active = null;
            if (res.status >= 200 && res.status < 300) {
              if (opt.stream) {
                // 兜底：把剩余未消费的内容再喂一次
                const rest = res.responseText.slice(received);
                if (rest) parser(rest);
                let text = parser.text;
                // 服务端忽略了 stream=true 时，按普通补全解析，避免白白再请求一次
                if (!text) {
                  try {
                    text = this._parseCompletion(res.responseText).text;
                  } catch (e) {
                    text = '';
                  }
                }
                resolve({ text, raw: res.responseText, usage: null });
              } else {
                resolve(this._parseCompletion(res.responseText));
              }
            } else {
              reject(this._httpError(res.status, res.responseText));
            }
          },
          onerror: (res) => {
            this._active = null;
            reject(new Error('网络错误：' + (res && res.error ? res.error : '无法连接到 ' + url)));
          },
          ontimeout: () => {
            this._active = null;
            reject(new Error('请求超时（' + Math.round(opt.timeout / 1000) + 's）'));
          },
          onabort: () => {
            this._active = null;
            reject(new Error('已取消'));
          },
        });
        this._active = {
          abort: () => {
            try {
              req.abort();
            } catch (e) {
              /* ignore */
            }
          },
        };
        if (opt.stream && parser) parser.reset();
      });
    },

    /** fetch 通道：站点若允许 CORS 则可用；否则依赖 GM 通道 */
    async _viaFetch(url, headers, payload, opt) {
      const ctrl = new AbortController();
      this._active = ctrl;
      const timer = setTimeout(() => ctrl.abort(), opt.timeout);
      try {
        const res = await fetch(url, { method: 'POST', headers, body: payload, signal: ctrl.signal });
        if (!res.ok) {
          const t = await res.text();
          throw this._httpError(res.status, t);
        }
        if (!opt.stream) {
          const t = await res.text();
          return this._parseCompletion(t);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const parser = this._sseParser(opt.onDelta);
        parser.reset();
        let rawAll = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value, { stream: true });
          rawAll += chunk;
          parser(chunk);
        }
        let text = parser.text;
        if (!text) {
          try {
            text = this._parseCompletion(rawAll).text;
          } catch (e) {
            text = '';
          }
        }
        return { text, raw: rawAll, usage: null };
      } finally {
        clearTimeout(timer);
        this._active = null;
      }
    },

    _parseCompletion(text) {
      let j;
      try {
        j = JSON.parse(text);
      } catch (e) {
        throw new Error('响应不是合法 JSON：' + text.slice(0, 200));
      }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      const choice = (j.choices || [])[0] || {};
      const content = (choice.message && choice.message.content) || choice.text || '';
      return { text: String(content), raw: text, usage: j.usage || null, model: j.model };
    },

    _httpError(status, bodyText) {
      let msg = '';
      try {
        const j = JSON.parse(bodyText);
        msg = (j.error && (j.error.message || j.error.code)) || j.message || '';
      } catch (e) {
        msg = String(bodyText || '').slice(0, 300);
      }
      const hint =
        status === 401
          ? '（API Key 无效或未填写）'
          : status === 403
          ? '（无权限：模型名或区域受限）'
          : status === 404
          ? '（接口地址不存在，检查 Base URL 是否含 /v1）'
          : status === 429
          ? '（限流或余额不足）'
          : '';
      const supported = parseSupportedModels(msg);
      const tail = supported && supported.length ? '（该接口支持的模型：' + supported.join(' / ') + '）' : '';
      const err = new Error('HTTP ' + status + ' ' + hint + ' ' + msg + tail);
      if (supported && supported.length) err.supportedModels = supported;
      err.status = status;
      return err;
    },

    /** SSE 增量解析器；parser.text 累积全文 */
    _sseParser(onDelta) {
      let buf = '';
      const parser = (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.search(/\r?\n/)) >= 0) {
          const eol = buf[idx] === '\r' ? 2 : 1;
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + eol);
          if (!line || line.startsWith(':')) continue;
          if (!/^data:/.test(line)) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            parser.done = true;
            continue;
          }
          try {
            const j = JSON.parse(data);
            const d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
            const piece = d && (d.content || '');
            if (piece) {
              parser.text += piece;
              if (onDelta) onDelta(piece);
            }
          } catch (e) {
            /* 半包，等下一块 */
          }
        }
      };
      parser.text = '';
      parser.reset = () => {
        buf = '';
        parser.text = '';
      };
      return parser;
    },

    /** 从模型输出里抠出 JSON 对象（容忍 ```json 围栏与前后废话） */
    extractJson(text) {
      if (!text) return null;
      let s = String(text).trim();
      s = s.replace(/^\uFEFF/, '');
      // 围栏
      const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
      if (fence) s = fence[1].trim();
      const tryParse = (str) => {
        try {
          return JSON.parse(str);
        } catch (e) {
          return undefined;
        }
      };
      let v = tryParse(s);
      if (v !== undefined) return v;

      // 花括号配对扫描
      const start = s.indexOf('{');
      if (start >= 0) {
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let i = start; i < s.length; i++) {
          const c = s[i];
          if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') inStr = true;
          else if (c === '{') depth++;
          else if (c === '}') {
            depth--;
            if (depth === 0) {
              const sub = s.slice(start, i + 1);
              v = tryParse(sub);
              if (v !== undefined) return v;
              // 修复尾逗号再试
              v = tryParse(sub.replace(/,\s*([}\]])/g, '$1'));
              if (v !== undefined) return v;
              break;
            }
          }
        }
      }
      return null;
    },
  };


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


  /* ============================ 9. 界面 ============================ */

  const App = {
    scan: null,
    tab: 'solve',
    busy: false,
    chat: [],
    mounted: false,
  };

  function rgba(color, alpha) {
    const rgb = parseColor(color);
    if (!rgb) return color; // 已经是关键字等无法解析的写法，原样使用
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  position: fixed; z-index: 2147483000; width: 392px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px; line-height: 1.5; color: var(--jm-text);
  -webkit-font-smoothing: antialiased;
}
.panel {
  display: flex; flex-direction: column; overflow: hidden;
  height: min(72vh, 640px);
  border-radius: 20px;
  background: linear-gradient(155deg, var(--jm-glass-1) 0%, var(--jm-glass-2) 100%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  backdrop-filter: blur(24px) saturate(180%);
  border: 1px solid var(--jm-border);
  box-shadow: 0 18px 50px -12px var(--jm-shadow), 0 2px 8px rgba(0,0,0,.06), inset 0 1px 0 var(--jm-hi);
  transition: opacity .16s ease, transform .16s ease;
}
.wrap[data-collapsed="true"] .panel { display: none; }
.wrap[data-collapsed="true"] .fab { display: grid; }
.fab {
  display: none; width: 52px; height: 52px; border-radius: 18px; border: 1px solid var(--jm-border);
  background: linear-gradient(135deg, var(--jm-primary), var(--jm-secondary));
  color: #fff; font-weight: 700; font-size: 15px; letter-spacing: .3px; cursor: pointer;
  box-shadow: 0 10px 26px -8px var(--jm-shadow);
  place-items: center;
}
.fab:hover { transform: translateY(-1px); }

/* 头部 */
.hd { display: flex; align-items: center; gap: 10px; padding: 12px 12px 10px 14px; cursor: grab; user-select: none; }
.hd:active { cursor: grabbing; }
.logo {
  width: 28px; height: 28px; flex: 0 0 auto; border-radius: 10px; display: grid; place-items: center;
  background: linear-gradient(135deg, var(--jm-primary), var(--jm-secondary));
  color: #fff; font-size: 11px; font-weight: 800; letter-spacing: .5px;
  box-shadow: 0 6px 16px -4px var(--jm-shadow);
}
.hd-txt { flex: 1 1 auto; min-width: 0; }
.ttl { font-size: 13px; font-weight: 650; letter-spacing: .2px; }
.sub { font-size: 11px; color: var(--jm-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hd-btns { display: flex; gap: 4px; }
.icon {
  width: 26px; height: 26px; border-radius: 8px; border: 1px solid transparent; background: transparent;
  color: var(--jm-muted); cursor: pointer; font-size: 14px; line-height: 1; display: grid; place-items: center;
}
.icon:hover { background: var(--jm-chip); color: var(--jm-text); border-color: var(--jm-border); }

/* 标签页 */
.tabs { display: flex; gap: 4px; padding: 0 12px 8px; }
.tab {
  flex: 1 1 0; padding: 7px 6px; border-radius: 10px; border: 1px solid transparent; background: transparent;
  color: var(--jm-muted); font-size: 12.5px; font-family: inherit; cursor: pointer;
}
.tab:hover { color: var(--jm-text); }
.tab.on { background: var(--jm-chip); color: var(--jm-accent-text); font-weight: 600; border-color: var(--jm-border); }

.body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; padding: 0 12px 4px; }
.pane { display: none; padding-bottom: 8px; }
.pane.on { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.pane[data-pane="solve"], .pane[data-pane="cfg"] { overflow-y: auto; }
.body::-webkit-scrollbar, .pane::-webkit-scrollbar, .chat-log::-webkit-scrollbar, .answer::-webkit-scrollbar { width: 8px; }
.body::-webkit-scrollbar-thumb, .pane::-webkit-scrollbar-thumb, .chat-log::-webkit-scrollbar-thumb, .answer::-webkit-scrollbar-thumb {
  background: var(--jm-scroll); border-radius: 8px;
}

/* 通用控件 */
.btn {
  border: 1px solid var(--jm-border); background: var(--jm-card); color: var(--jm-text);
  border-radius: 10px; padding: 6px 11px; font-size: 12px; font-family: inherit; cursor: pointer;
  transition: transform .1s ease, background .15s ease;
}
.btn:hover { background: var(--jm-chip); }
.btn:active { transform: scale(.98); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn.primary {
  background: linear-gradient(135deg, var(--jm-primary), var(--jm-secondary)); color: #fff; border-color: transparent;
  box-shadow: 0 6px 16px -6px var(--jm-shadow);
}
.btn.ghost { background: transparent; }
.btn.danger { color: var(--jm-error); border-color: var(--jm-error-border); }
.row { display: flex; gap: 6px; flex-wrap: wrap; }
.bar { display: flex; gap: 6px; padding: 2px 0 10px; }

/* 题目卡片 */
.empty { color: var(--jm-muted); font-size: 12.5px; padding: 18px 6px; text-align: center; line-height: 1.7; }
.q {
  border: 1px solid var(--jm-border); border-radius: 14px; padding: 10px 11px; margin-bottom: 8px;
  background: var(--jm-card); transition: border-color .15s ease, background .15s ease;
}
.q.done { border-color: var(--jm-ok-border); }
.q.error { border-color: var(--jm-error-border); }
.q-hd { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.badge {
  font-size: 10.5px; padding: 2px 7px; border-radius: 999px; background: var(--jm-chip);
  color: var(--jm-accent-text); border: 1px solid var(--jm-border); white-space: nowrap;
}
.badge.code { background: rgba(16,185,129,.12); color: var(--jm-success); border-color: rgba(16,185,129,.3); }
.badge.mcq { background: rgba(79,70,229,.12); color: var(--jm-primary); border-color: var(--jm-primary-border); }
.badge.parsons { background: rgba(245,158,11,.14); color: #b45309; border-color: rgba(245,158,11,.35); }
.idx { font-size: 11px; color: var(--jm-muted); }
.q-prompt {
  font-size: 12.5px; color: var(--jm-text); margin: 2px 0 7px;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.opts { display: flex; flex-direction: column; gap: 3px; margin-bottom: 7px; }
.opt { display: flex; gap: 6px; font-size: 12px; color: var(--jm-text-2); }
.opt .k { color: var(--jm-muted); flex: 0 0 16px; font-weight: 600; }
.opt.pick .k, .opt.pick { color: var(--jm-primary); font-weight: 600; }
.answer {
  border-radius: 10px; border: 1px dashed var(--jm-border); background: var(--jm-code-bg);
  padding: 7px 9px; font-family: "Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; white-space: pre-wrap; word-break: break-word; max-height: 132px; overflow: auto;
  margin-bottom: 7px; color: var(--jm-text);
}
.explain { font-size: 11.5px; color: var(--jm-muted); margin-bottom: 7px; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-bottom: 7px; }
.btn.chip { padding: 3px 9px; font-size: 11.5px; border-radius: 999px; font-family: "Roboto Mono", ui-monospace, monospace; }
.q-ft { display: flex; gap: 5px; align-items: center; }
.spacer { flex: 1 1 auto; }
.msg { font-size: 11px; color: var(--jm-muted); }
.msg.ok { color: var(--jm-success); }
.msg.err { color: var(--jm-error); }
.spin {
  width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--jm-border);
  border-top-color: var(--jm-primary); animation: jmspin .7s linear infinite; display: inline-block;
}
@keyframes jmspin { to { transform: rotate(360deg); } }

/* 对话 */
.chat-log { display: flex; flex-direction: column; gap: 8px; padding: 2px 0 8px; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.cmsg { border-radius: 12px; padding: 8px 10px; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
.cmsg.user { background: var(--jm-chip); align-self: flex-end; max-width: 88%; }
.cmsg.ai { background: var(--jm-card); border: 1px solid var(--jm-border); }
.cmsg.sys { color: var(--jm-muted); font-size: 11.5px; background: transparent; padding: 2px; }
.chat-in { display: flex; gap: 6px; align-items: flex-end; padding-top: 4px; }
.chat-in textarea {
  flex: 1 1 auto; resize: none; min-height: 38px; max-height: 120px; padding: 8px 10px;
  border-radius: 11px; border: 1px solid var(--jm-border); background: var(--jm-input-bg);
  color: var(--jm-text); font-family: inherit; font-size: 12.5px; outline: none;
}
.chat-in textarea:focus { border-color: var(--jm-primary); }

/* 设置 */
.field { margin-bottom: 9px; }
.field label { display: block; font-size: 11.5px; color: var(--jm-muted); margin-bottom: 3px; }
.field input[type="text"], .field input[type="password"], .field input[type="number"], .field select, .field textarea {
  width: 100%; padding: 7px 9px; border-radius: 10px; border: 1px solid var(--jm-border);
  background: var(--jm-input-bg); color: var(--jm-text); font-family: inherit; font-size: 12.5px; outline: none;
}
.field textarea { resize: vertical; min-height: 54px; font-family: "Roboto Mono", monospace; font-size: 11.5px; }
.field input:focus, .field select:focus, .field textarea:focus { border-color: var(--jm-primary); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.check { display: flex; align-items: center; gap: 7px; font-size: 12.5px; margin-bottom: 7px; color: var(--jm-text-2); }
.check input { accent-color: var(--jm-primary); width: 14px; height: 14px; }
.hint { font-size: 11px; color: var(--jm-muted); line-height: 1.6; margin: 2px 0 8px; }
.sep { height: 1px; background: var(--jm-border); margin: 10px 0; }

/* 底部状态 */
.ft {
  display: flex; align-items: center; gap: 7px; padding: 8px 14px; border-top: 1px solid var(--jm-border);
  font-size: 11px; color: var(--jm-muted); background: var(--jm-card);
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--jm-success); flex: 0 0 auto; }
.dot.busy { background: var(--jm-primary); animation: jmpulse 1.1s ease-in-out infinite; }
.dot.err { background: var(--jm-error); }
@keyframes jmpulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
.ft-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.toast {
  position: absolute; left: 50%; bottom: 46px; transform: translateX(-50%) translateY(6px);
  background: var(--jm-toast-bg); color: var(--jm-toast-text); padding: 7px 12px; border-radius: 10px;
  font-size: 12px; opacity: 0; pointer-events: none; transition: all .18s ease; max-width: 86%;
  box-shadow: 0 8px 24px -8px rgba(0,0,0,.4); white-space: pre-wrap; text-align: center;
}
.toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }
`;

  const UI = {
    host: null,
    root: null,
    $: {},

    mount() {
      if (this.host) return;
      const host = document.createElement('div');
      host.id = 'jm-ai-host';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      wrap.innerHTML = `
        <div class="panel">
          <div class="hd">
            <div class="logo">AI</div>
            <div class="hd-txt">
              <div class="ttl">JuiceMind 助手</div>
              <div class="sub" data-ref="sub">未配置 API</div>
            </div>
            <div class="hd-btns">
              <button class="icon" data-ref="btn-collapse" title="收起 (Alt+J)">–</button>
              <button class="icon" data-ref="btn-hide" title="隐藏">×</button>
            </div>
          </div>
          <div class="tabs">
            <button class="tab on" data-tab="solve">答题</button>
            <button class="tab" data-tab="chat">对话</button>
            <button class="tab" data-tab="cfg">设置</button>
          </div>
          <div class="body">
            <div class="pane on" data-pane="solve">
              <div class="bar">
                <button class="btn primary" data-ref="btn-scan">扫描页面</button>
                <button class="btn" data-ref="btn-solve">生成全部</button>
                <button class="btn" data-ref="btn-fill">填入全部</button>
              </div>
              <div data-ref="qlist"><div class="empty">点击「扫描页面」识别当前页面的题目<br/><span style="opacity:.7">支持教程+题目、选择题、简答、编程、排序、填空</span></div></div>
            </div>
            <div class="pane" data-pane="chat">
              <div class="chat-log" data-ref="chatlog"></div>
              <div class="chat-in">
                <textarea data-ref="chat-in" placeholder="问点什么…（可自动带上当前页面内容）"></textarea>
                <button class="btn primary" data-ref="btn-send">发送</button>
              </div>
            </div>
            <div class="pane" data-pane="cfg" data-ref="cfg"></div>
          </div>
          <div class="ft"><span class="dot" data-ref="dot"></span><span class="ft-txt" data-ref="ft">就绪</span></div>
          <div class="toast" data-ref="toast"></div>
        </div>
        <button class="fab">AI</button>
      `;
      shadow.appendChild(style);
      shadow.appendChild(wrap);
      document.documentElement.appendChild(host);

      this.host = host;
      this.root = shadow;
      this.$wrap = wrap;
      this.$(shadow, wrap);

      this.applyPalette(Theme.read());
      Theme.observe((p) => this.applyPalette(p));
      this.bind();
      this.restorePos();
      this.renderSettings();
      this.updateSub();
      App.mounted = true;
    },

    $(shadow, wrap) {
      const map = {};
      wrap.querySelectorAll('[data-ref]').forEach((el) => {
        map[el.getAttribute('data-ref')] = el;
      });
      map.tabs = Array.from(wrap.querySelectorAll('.tab'));
      map.panes = Array.from(wrap.querySelectorAll('.pane'));
      this.refs = map;
    },

    applyPalette(p) {
      const host = this.host;
      if (!host) return;
      const s = host.style;
      const dark = !!p.dark;
      s.setProperty('--jm-primary', p.primary);
      s.setProperty('--jm-secondary', p.secondary);
      s.setProperty('--jm-text', p.textPrimary);
      s.setProperty('--jm-text-2', p.textSecondary);
      s.setProperty('--jm-muted', p.textMuted);
      s.setProperty('--jm-success', p.success);
      s.setProperty('--jm-error', p.error);
      s.setProperty('--jm-border', dark ? rgba(p.primary, 0.32) : rgba(p.primary, 0.18));
      s.setProperty('--jm-primary-border', rgba(p.primary, dark ? 0.45 : 0.3));
      s.setProperty('--jm-error-border', rgba(p.error, 0.42));
      s.setProperty('--jm-ok-border', rgba(p.success, 0.45));
      s.setProperty('--jm-glass-1', dark ? 'rgba(28,28,32,.86)' : 'rgba(255,255,255,.78)');
      s.setProperty('--jm-glass-2', dark ? 'rgba(16,16,18,.78)' : 'rgba(255,255,255,.6)');
      s.setProperty('--jm-card', dark ? 'rgba(255,255,255,.045)' : rgba(p.primary, 0.045));
      s.setProperty('--jm-chip', dark ? 'rgba(255,255,255,.09)' : rgba(p.primary, 0.09));
      s.setProperty('--jm-input-bg', dark ? 'rgba(0,0,0,.28)' : 'rgba(255,255,255,.66)');
      s.setProperty('--jm-code-bg', dark ? 'rgba(0,0,0,.3)' : rgba(p.primary, 0.04));
      s.setProperty('--jm-hi', dark ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.75)');
      s.setProperty('--jm-shadow', dark ? 'rgba(0,0,0,.65)' : rgba(p.primary, 0.28));
      s.setProperty('--jm-scroll', dark ? 'rgba(255,255,255,.16)' : rgba(p.primary, 0.22));
      s.setProperty('--jm-accent-text', dark ? '#c7d2fe' : p.primary);
      s.setProperty('--jm-toast-bg', dark ? 'rgba(30,30,34,.96)' : 'rgba(17,24,39,.92)');
      s.setProperty('--jm-toast-text', '#fff');
      s.setProperty('--jm-dark', dark ? '1' : '0');
    },

    /* ------------------------- 位置与折叠 ------------------------- */

    restorePos() {
      const ui = Store.uiGet();
      const wrap = this.$wrap;
      const m = 16;
      if (ui.collapsed) wrap.setAttribute('data-collapsed', 'true');
      let left = ui.left;
      let top = ui.top;
      if (typeof left !== 'number' || typeof top !== 'number') {
        left = window.innerWidth - 392 - 24;
        top = window.innerHeight - 560;
      }
      left = Math.min(Math.max(m, left), Math.max(m, window.innerWidth - 120));
      top = Math.min(Math.max(m, top), Math.max(m, window.innerHeight - 120));
      wrap.style.left = left + 'px';
      wrap.style.top = top + 'px';
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
    },

    savePos() {
      const wrap = this.$wrap;
      Store.ui({
        left: parseFloat(wrap.style.left) || 0,
        top: parseFloat(wrap.style.top) || 0,
      });
    },

    setCollapsed(v) {
      this.$wrap.setAttribute('data-collapsed', v ? 'true' : 'false');
      Store.ui({ collapsed: !!v });
      if (!v) this.restorePos();
    },

    /* ------------------------- 事件绑定 ------------------------- */

    bind() {
      const r = this.refs;
      const wrap = this.$wrap;

      // 标签页
      r.tabs.forEach((t) => {
        t.addEventListener('click', () => this.setTab(t.getAttribute('data-tab')));
      });

      // 折叠 / 隐藏
      r['btn-collapse'].addEventListener('click', () => this.setCollapsed(true));
      wrap.querySelector('.fab').addEventListener('click', () => this.setCollapsed(false));
      r['btn-hide'].addEventListener('click', () => this.setCollapsed(true));

      // 主体按钮
      r['btn-scan'].addEventListener('click', () => Actions.scan(true));
      r['btn-solve'].addEventListener('click', () => Actions.solveAll());
      r['btn-fill'].addEventListener('click', () => Actions.fillAll());

      // 对话
      r['btn-send'].addEventListener('click', () => Actions.sendChat());
      r['chat-in'].addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          Actions.sendChat();
        }
      });

      // 拖拽
      const hd = wrap.querySelector('.hd');
      let dragging = false;
      let sx = 0;
      let sy = 0;
      let ox = 0;
      let oy = 0;
      hd.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        const rect = wrap.getBoundingClientRect();
        ox = rect.left;
        oy = rect.top;
        hd.setPointerCapture(e.pointerId);
      });
      hd.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const m = 8;
        let left = ox + (e.clientX - sx);
        let top = oy + (e.clientY - sy);
        left = Math.min(Math.max(m, left), window.innerWidth - 60);
        top = Math.min(Math.max(m, top), window.innerHeight - 40);
        wrap.style.left = left + 'px';
        wrap.style.top = top + 'px';
      });
      const stop = () => {
        if (!dragging) return;
        dragging = false;
        this.savePos();
      };
      hd.addEventListener('pointerup', stop);
      hd.addEventListener('pointercancel', stop);

      window.addEventListener('resize', debounce(() => this.restorePos(), 200));
    },

    setTab(name) {
      App.tab = name;
      this.refs.tabs.forEach((t) => t.classList.toggle('on', t.getAttribute('data-tab') === name));
      this.refs.panes.forEach((p) => p.classList.toggle('on', p.getAttribute('data-pane') === name));
    },

    /* ------------------------- 状态 ------------------------- */

    status(msg, kind) {
      const ft = this.refs.ft;
      const dot = this.refs.dot;
      ft.textContent = msg;
      dot.className = 'dot' + (kind === 'busy' ? ' busy' : kind === 'err' ? ' err' : '');
    },

    toast(msg, ms) {
      const t = this.refs.toast;
      t.textContent = msg;
      t.classList.add('on');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => t.classList.remove('on'), ms || 2200);
    },

    updateSub() {
      const cfg = Store.get();
      const el = this.refs.sub;
      if (!el) return;
      const hasKey = !!cfg.apiKey;
      el.textContent = (hasKey ? cfg.model || '未设置模型' : '未配置 API Key') + (cfg.autoSubmit ? ' · 自动提交' : '');
    },

    /* ------------------------- 题目列表 ------------------------- */

    renderQuestions() {
      const box = this.refs.qlist;
      const scan = App.scan;
      if (!scan || !scan.questions || !scan.questions.length) {
        const kind = App.scan ? App.scan.kind : PageModel.kind;
        const tips = {
          class: '当前是课程首页：请从左侧导航点开一个条目（教程/题目）再扫描。',
          quiz: '当前是测验页：进入题目后再扫描。',
          gameroom: '当前是实时竞赛：进入题目后再扫描。',
          generic: '没找到可作答的控件。若页面还在加载，稍等再扫描；也可以在「对话」里直接提问。',
        };
        box.innerHTML = `<div class="empty">${tips[kind] || '这一页没有检测到题目。<br/>如果是纯教程页，可直接用「对话」提问或让 AI 解释。'}</div>`;
        return;
      }

      const frag = document.createDocumentFragment();
      scan.questions.forEach((q, i) => frag.appendChild(this.renderQuestionCard(q, i)));
      box.innerHTML = '';
      box.appendChild(frag);
    },

    renderQuestionCard(q, i) {
      const card = document.createElement('div');
      card.className = 'q' + (q.status === 'done' ? ' done' : q.status === 'error' ? ' error' : '');
      card.dataset.qid = q.id;

      const hd = document.createElement('div');
      hd.className = 'q-hd';
      const badge = document.createElement('span');
      badge.className = 'badge ' + (q.type === 'code' ? 'code' : q.type === 'parsons' ? 'parsons' : q.type === 'mcq' || q.type === 'multiselect' ? 'mcq' : '');
      badge.textContent = TYPE_LABEL[q.type] || q.type;
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = '#' + (i + 1);
      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      hd.append(badge, idx, spacer);

      const st = document.createElement('span');
      st.className = 'msg';
      if (q.status === 'running') st.innerHTML = '<span class="spin"></span>';
      else if (q.status === 'done') {
        st.className = 'msg ok';
        st.textContent = '已生成';
      } else if (q.status === 'error') {
        st.className = 'msg err';
        st.textContent = '失败';
      }
      hd.appendChild(st);

      const prompt = document.createElement('div');
      prompt.className = 'q-prompt';
      prompt.textContent = q.prompt || '（未识别到题干）';

      card.append(hd, prompt);

      if (q.options && q.options.length) {
        const opts = document.createElement('div');
        opts.className = 'opts';
        const pickedLabels = this.pickedLabels(q);
        q.options.slice(0, 8).forEach((o) => {
          const row = document.createElement('div');
          row.className = 'opt' + (pickedLabels.has(o.label) ? ' pick' : '');
          const k = document.createElement('span');
          k.className = 'k';
          k.textContent = o.label;
          const t = document.createElement('span');
          t.textContent = truncate(oneLine(o.text), 120);
          row.append(k, t);
          opts.appendChild(row);
        });
        card.appendChild(opts);
      }

      if (q.answer) {
        const ans = document.createElement('div');
        ans.className = 'answer';
        ans.textContent = this.answerPreview(q);
        card.appendChild(ans);
        if (q.answer.explanation) {
          const ex = document.createElement('div');
          ex.className = 'explain';
          ex.textContent = truncate(q.answer.explanation, 220);
          card.appendChild(ex);
        }
      }

      if (q.error) {
        const err = document.createElement('div');
        err.className = 'explain';
        err.style.color = 'var(--jm-error)';
        err.textContent = q.error;
        card.appendChild(err);
      }

      // 服务端明确说了"只支持这几个模型名"时，给一键切换
      if (q.supportedModels && q.supportedModels.length) {
        const row = document.createElement('div');
        row.className = 'chips';
        const label = document.createElement('span');
        label.className = 'msg';
        label.textContent = '改用：';
        row.appendChild(label);
        q.supportedModels.forEach((m) => {
          const b = document.createElement('button');
          b.className = 'btn chip';
          b.textContent = m;
          b.title = '改用 ' + m + ' 并重试这题';
          b.addEventListener('click', () => Actions.useModel(m, q));
          row.appendChild(b);
        });
        card.appendChild(row);
      }

      const ft = document.createElement('div');
      ft.className = 'q-ft';
      const bSolve = document.createElement('button');
      bSolve.className = 'btn primary';
      bSolve.textContent = q.answer ? '重新生成' : '生成';
      bSolve.addEventListener('click', () => Actions.solveOne(q));
      const bFill = document.createElement('button');
      bFill.className = 'btn';
      bFill.textContent = '填入';
      bFill.disabled = !q.answer;
      bFill.addEventListener('click', () => Actions.fillOne(q));
      const bFocus = document.createElement('button');
      bFocus.className = 'btn ghost';
      bFocus.textContent = '定位';
      bFocus.addEventListener('click', () => {
        try {
          q.container.scrollIntoView({ behavior: 'smooth', block: 'center' });
          q.container.style.outline = '2px solid var(--jm-primary)';
          setTimeout(() => (q.container.style.outline = ''), 1200);
        } catch (e) {
          /* ignore */
        }
      });
      ft.append(bSolve, bFill, bFocus);
      card.appendChild(ft);
      return card;
    },

    pickedLabels(q) {
      const set = new Set();
      if (!q.answer || !q.options) return set;
      for (const v of q.answer.answers || []) {
        const opt = Appliers.matchOption(q, v);
        if (opt) set.add(opt.label);
      }
      return set;
    },

    answerPreview(q) {
      const a = q.answer;
      if (!a) return '';
      // 选择题显示「字母 + 选项原文」，比只显示一个 A 有用得多
      if ((q.type === 'mcq' || q.type === 'multiselect') && q.options && q.options.length) {
        const picked = this.pickedLabels(q);
        if (picked.size) {
          return [...picked]
            .map((l) => {
              const o = q.options.find((x) => x.label === l);
              return l + '. ' + oneLine(o ? o.text : '');
            })
            .join('\n');
        }
      }
      const joined = (a.answers || []).join('\n');
      return truncate(joined, q.type === 'code' ? 420 : 260);
    },

    refreshCard(q) {
      const old = this.refs.qlist.querySelector('[data-qid="' + q.id + '"]');
      if (!old) return;
      const idx = App.scan.questions.indexOf(q);
      const fresh = this.renderQuestionCard(q, idx);
      old.replaceWith(fresh);
    },

    /* ------------------------- 对话 ------------------------- */

    renderChat() {
      const log = this.refs.chatlog;
      log.innerHTML = '';
      if (!App.chat.length) {
        const hint = document.createElement('div');
        hint.className = 'cmsg sys';
        hint.textContent = '可以直接提问，例如「解释这一页的教程」「这题为什么选 B」。发送时会自动附带当前页面内容。';
        log.appendChild(hint);
      }
      for (const m of App.chat) {
        const d = document.createElement('div');
        d.className = 'cmsg ' + (m.role === 'user' ? 'user' : m.role === 'assistant' ? 'ai' : 'sys');
        d.textContent = m.content || '';
        log.appendChild(d);
      }
      this.scrollChatToEnd();
      return log;
    },

    appendChat(role, content) {
      const log = this.renderChat();
      const d = document.createElement('div');
      d.className = 'cmsg ' + (role === 'user' ? 'user' : role === 'assistant' ? 'ai' : 'sys');
      d.textContent = content;
      log.appendChild(d);
      this.scrollChatToEnd();
      return d;
    },

    scrollChatToEnd() {
      const log = this.refs && this.refs.chatlog;
      if (log) log.scrollTop = log.scrollHeight;
    },

    /* ------------------------- 设置 ------------------------- */

    renderSettings() {
      const box = this.refs.cfg;
      const cfg = Store.get();
      box.innerHTML = `
        <div class="field">
          <label>服务商预设</label>
          <select data-k="preset">
            ${Object.keys(PRESETS)
              .map((k) => `<option value="${k}">${PRESETS[k].label}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field">
          <label>API Base URL</label>
          <input type="text" data-k="baseUrl" value="${escapeHtml(cfg.baseUrl)}" placeholder="https://api.openai.com/v1" />
        </div>
        <div class="field">
          <label>API Key</label>
          <input type="password" data-k="apiKey" value="${escapeHtml(cfg.apiKey)}" placeholder="sk-..." />
        </div>
        <div class="field">
          <label>模型</label>
          <input type="text" data-k="model" value="${escapeHtml(cfg.model)}" placeholder="任意模型名，例如 deepseek-v4.1-flash" list="jm-model-list" autocomplete="off" />
          <datalist id="jm-model-list">
            ${modelSuggestions().map((m) => `<option value="${escapeHtml(m)}"></option>`).join('')}
          </datalist>
          <div class="hint" style="margin:4px 0 0">模型名是自由文本，下拉只是常见名字的建议；服务端报「supported model names」时按它给的填。</div>
        </div>
        <div class="grid2">
          <div class="field">
            <label>温度</label>
            <input type="number" step="0.1" min="0" max="2" data-k="temperature" value="${cfg.temperature}" />
          </div>
          <div class="field">
            <label>最大 tokens</label>
            <input type="number" step="128" min="256" max="32768" data-k="maxTokens" value="${cfg.maxTokens}" />
          </div>
        </div>
        <div class="field">
          <label>上下文长度（字）</label>
          <input type="number" step="500" min="1000" max="30000" data-k="contextChars" value="${cfg.contextChars}" />
        </div>
        <div class="field">
          <label>解释语言</label>
          <select data-k="language">
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <label class="check"><input type="checkbox" data-k="jsonMode" ${cfg.jsonMode ? 'checked' : ''}/> JSON 输出模式（更稳的答案解析）</label>
        <label class="check"><input type="checkbox" data-k="autoSubmit" ${cfg.autoSubmit ? 'checked' : ''}/> 填入后自动点提交</label>
        <label class="check"><input type="checkbox" data-k="autoRun" ${cfg.autoRun ? 'checked' : ''}/> 进入新页面自动扫描并生成</label>
        <label class="check"><input type="checkbox" data-k="stream" ${cfg.stream ? 'checked' : ''}/> 对话流式输出</label>
        <label class="check"><input type="checkbox" data-k="debug" ${cfg.debug ? 'checked' : ''}/> 控制台调试日志</label>
        <div class="field">
          <label>补充提示词（可选）</label>
          <textarea data-k="systemPrompt" placeholder="例如：回答尽量简短；代码用 Python 3。">${escapeHtml(cfg.systemPrompt)}</textarea>
        </div>
        <div class="sep"></div>
        <div class="row">
          <button class="btn primary" data-act="save">保存</button>
          <button class="btn" data-act="test">测试连接</button>
          <button class="btn danger" data-act="reset">恢复默认</button>
        </div>
        <div class="hint">v${VERSION} · 配置只存在本地（Tampermonkey 存储）。请求经 GM 通道发出，不受页面 CORS 限制。</div>
      `;

      const presetSel = box.querySelector('[data-k="preset"]');
      const modelInput = box.querySelector('[data-k="model"]');
      const guessPreset = Object.keys(PRESETS).find((k) => PRESETS[k].baseUrl && PRESETS[k].baseUrl === cfg.baseUrl) || 'custom';
      presetSel.value = guessPreset;
      let prevPreset = guessPreset;
      modelInput.addEventListener('input', () => {
        modelInput.dataset.edited = '1';
      });
      presetSel.addEventListener('change', () => {
        const p = PRESETS[presetSel.value];
        const prev = PRESETS[prevPreset];
        if (p && p.baseUrl) {
          box.querySelector('[data-k="baseUrl"]').value = p.baseUrl;
          // 只有模型框没被手动改过（或还是上一个预设的默认值）才覆盖，避免冲掉用户填的模型名
          const untouched = !modelInput.dataset.edited || !modelInput.value.trim() || modelInput.value === (prev && prev.model);
          if (p.model && untouched) modelInput.value = p.model;
          else if (p.model && p.model !== modelInput.value) this.toast('保留了你的模型名：' + modelInput.value);
        }
        prevPreset = presetSel.value;
      });

      box.querySelector('[data-act="save"]').addEventListener('click', () => this.saveSettings());
      box.querySelector('[data-act="test"]').addEventListener('click', () => Actions.testConnection());
      box.querySelector('[data-act="reset"]').addEventListener('click', () => {
        Store.reset();
        this.renderSettings();
        this.updateSub();
        this.toast('已恢复默认配置');
      });
    },

    saveSettings() {
      const box = this.refs.cfg;
      const read = (k) => {
        const el = box.querySelector('[data-k="' + k + '"]');
        if (!el) return undefined;
        return el.type === 'checkbox' ? el.checked : el.value;
      };
      const patch = {
        baseUrl: String(read('baseUrl') || '').trim(),
        apiKey: String(read('apiKey') || '').trim(),
        model: String(read('model') || '').trim(),
        temperature: Number(read('temperature')) || 0,
        maxTokens: Number(read('maxTokens')) || 2048,
        contextChars: Number(read('contextChars')) || 6000,
        language: read('language'),
        jsonMode: read('jsonMode'),
        autoSubmit: read('autoSubmit'),
        autoRun: read('autoRun'),
        stream: read('stream'),
        debug: read('debug'),
        systemPrompt: read('systemPrompt'),
      };
      Store.set(patch);
      this.updateSub();
      this.toast('已保存');
      this.status('配置已保存');
    },
  };


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
