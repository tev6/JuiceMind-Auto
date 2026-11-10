// ==UserScript==
// @name         JuiceMind AI 答题助手
// @namespace    https://juicemind.com/
// @icon         https://raw.githubusercontent.com/tev6/JuiceMind-Auto/main/assets/icon/png/icon-app-128.png
// @updateURL    https://raw.githubusercontent.com/tev6/JuiceMind-Auto/main/juicemind-ai-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/tev6/JuiceMind-Auto/main/juicemind-ai-assistant.user.js
// @supportURL   https://github.com/tev6/JuiceMind-Auto/issues
// @version      1.14.2
// @description  为 JuiceMind 学习平台提供 AI 辅助答题：自动识别教程/选择题/简答/编程/Parsons 等页面形式，调用外部大模型 API 生成答案并填入。玻璃拟态悬浮窗，跟随站点配色。
// @author       tev6
// @match        https://play.juicemind.com/*
// @match        https://classes.juicemind.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      api.moonshot.cn
// @connect      openrouter.ai
// @connect      api.x.ai
// @connect      generativelanguage.googleapis.com
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* @match 只覆盖应用端域名（play / classes）。
 * 营销站 juicemind.com 只有介绍页、没有题目，不再往那里注入面板。
 * 以后若新增应用端子域名，在上面的 @match 里补一行即可。 */

/* @connect 逐个列出内置服务商的域名，再留一条 @connect * 兜住自定义端点。
 * Tampermonkey 官方建议两者并列：只写 @connect * 时，某些版本与
 * 「@connect 模式：严格」设置下仍会逐次弹跨域授权窗；写全已知域名可避免。
 * 换服务商或用本地 Ollama 时，靠 @connect * 放行。 */

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

  const VERSION = '1.14.2';
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
    maxTokens: 2048, // 答案生成的上限
    summaryTokens: 4096, // 页面总结 / 对话的上限（总结一整页要写的比较多）
    codeWaitSec: 5, // 代码写进编辑器后等几秒再提交（3~10 秒）
    extraHeaders: '',
    explain: false, // 是否让模型返回解析（更耗 token，默认关）
    jsonMode: true, // 请求 response_format=json_object，失败自动降级
    language: 'zh', // 旧字段：解释语言，保留兼容（新逻辑见 outputLangCustom）
    uiLang: 'zh', // 界面语言：右上角一键切换，同时决定模型输出语言（默认中文）
    outputLangCustom: false, // 是否单独设置大模型输出语言
    outputLang: 'zh', // 仅当 outputLangCustom 为真时生效
    reasoning: false, // 是否请求「先思考再作答」（纯提示词层面）
    autoSubmit: false, // 填入后是否自动点提交
    autoRun: false, // 进入新页面是否自动扫描并生成
    hidePanel: false, // 默认不显示悬浮窗，只用 Alt+J 唤出
    stream: true, // 对话页流式输出
    anim: true, // 界面动画（关闭后所有过渡/动画停用）
    batchSolve: true, // 整页一次请求答完（省 token）；关掉则逐题请求
    humanType: true, // 代码题拟人写入：逐字敲、随机节奏、偶发退格与光标移动
    typingWpm: 75, // 拟人写入的平均速度（WPM，15~120）
    debug: false,
    systemPrompt: '', // 自定义追加提示词
    contextChars: 2400, // 送给模型的页面上下文上限（按题截取，不再整页发送）
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

  /* ---- 语言：界面文案 + 大模型输出语言 ---- */

  /** 界面语言：zh | en（右上角一键切换） */
  function curLang() {
    return Store.get('uiLang') === 'en' ? 'en' : 'zh';
  }

  /** 行内文案：把两套语言写在一起，随界面语言返回 */
  function L(zh, en) {
    return curLang() === 'en' ? en : zh;
  }

  /** 大模型输出语言：勾选了「独立设置」用 outputLang，否则跟随界面语言 */
  function outputLanguage() {
    const cfg = Store.get();
    const code = cfg.outputLangCustom ? cfg.outputLang : cfg.uiLang;
    return code === 'en' ? 'en' : 'zh';
  }

  /** 提示词里用的语言名 */
  function outputLanguageName() {
    return outputLanguage() === 'en' ? 'English' : '中文';
  }

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

  /**
   * 供应商预设。models 只是「下拉建议」，模型框任意填写。
   * 名单按 2026-11 各家公开模型（DeepSeek / Kimi / OpenAI / xAI / Google / Anthropic / OpenRouter）整理，
   * 新模型出来后改这里即可，不影响运行。
   */
  const PRESETS = {
    openai: {
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-6.1-sol',
      models: ['gpt-6.1-terra-pro', 'gpt-6.1-terra', 'gpt-6.1-sol-pro', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-4.1', 'gpt-4o-mini'],
    },
    deepseek: {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      models: ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-flash', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.2'],
    },
    moonshot: {
      label: 'Moonshot / Kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k3.1-pro',
      models: ['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking', 'moonshot-v1-32k'],
    },
    openrouter: {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4.1-flash',
      models: [
        'deepseek/deepseek-v4.1-flash',
        'deepseek/deepseek-v4-pro',
        'openai/gpt-6.1-sol',
        'moonshotai/kimi-k3.1-pro',
        'anthropic/claude-sonnet-5.5',
        'google/gemini-3.8-flash',
        'x-ai/grok-4.7',
      ],
    },
    xai: {
      label: 'xAI Grok',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.7',
      models: ['grok-4.7', 'grok-4.6', 'grok-4.5'],
    },
    google: {
      label: 'Google Gemini（OpenAI 兼容）',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3.8-flash',
      models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon'],
    },
    ollama: {
      label: 'Ollama(本地)',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
      models: ['qwen2.5:7b', 'qwen3:8b', 'llama3.1:8b'],
    },
    custom: { label: '自定义', baseUrl: '', model: '', models: [] },
  };

  /** 某个预设的模型建议（不给预设则返回全部去重） */
  function modelSuggestions(presetKey) {
    const set = new Set();
    const keys = presetKey && PRESETS[presetKey] ? [presetKey] : Object.keys(PRESETS);
    keys.forEach((k) => (PRESETS[k].models || []).forEach((m) => set.add(m)));
    if (!presetKey) ['gpt-6.1-sol', 'deepseek-v4.1-flash', 'kimi-k3.1-pro', 'deepseek-flash', 'deepseek-v4-pro'].forEach((m) => set.add(m));
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

    /** 本会话用量（只做展示，不做计价） */
    stats: { requests: 0, prompt: 0, completion: 0, total: 0 },

    resetStats() {
      this.stats = { requests: 0, prompt: 0, completion: 0, total: 0 };
    },

    addUsage(usage) {
      if (!usage) return;
      const p = Number(usage.prompt_tokens) || 0;
      const c = Number(usage.completion_tokens) || 0;
      const t = Number(usage.total_tokens) || p + c;
      if (!t) return;
      this.stats.requests += 1;
      this.stats.prompt += p;
      this.stats.completion += c;
      this.stats.total += t;
    },

    /** 可重试的错误：限流、网关、超时、网络抖动 */
    isRetryable(err) {
      if (!err) return false;
      if (err.name === 'AbortError') return false;
      const s = Number(err.status) || 0;
      if ([408, 409, 425, 429, 500, 502, 503, 504].includes(s)) return true;
      if (!s && /network|failed to fetch|timeout|超时|连接|networkerror/i.test(err.message || '')) return true;
      return false;
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
      // 输出预算：答案走 maxTokens，总结/对话走 summaryTokens，由调用方指定
      const budget = Number(opts.maxTokens) || Number(cfg.maxTokens) || 2048;
      let body = {
        model: cfg.model,
        messages,
        temperature: Number(cfg.temperature),
        max_tokens: Math.max(64, Math.min(budget, 32768)),
        stream: !!opts.stream,
      };
      if (wantJson) body.response_format = { type: 'json_object' };
      if (!opts.stream) delete body.stream;
      // 流式也要 usage：OpenAI 兼容实现支持 stream_options.include_usage
      if (opts.stream) body.stream_options = { include_usage: true };

      const url = this.endpoint(cfg.baseUrl);
      const timeout = opts.timeout || (opts.stream ? 180000 : 120000);
      // 已经吐出增量后就不重试了，否则会重复追加内容
      let emitted = false;
      const onDelta = opts.onDelta
        ? (piece) => {
            emitted = true;
            opts.onDelta(piece);
          }
        : undefined;

      // 降级链要能一路往下走：以前「去掉 response_format」那步自己再抛一次，
      // 后面「推理模型不接受 temperature / max_tokens」那档就永远轮不到，
      // 于是又大又新的模型直接 400。
      const variants = [{ body: body, json: wantJson, tag: '原样' }];
      if (wantJson) {
        const b1 = Object.assign({}, body);
        delete b1.response_format;
        variants.push({ body: b1, json: false, tag: '去掉 response_format' });
      }
      const b2 = Object.assign({}, body);
      delete b2.response_format;
      delete b2.temperature;
      delete b2.max_tokens;
      b2.max_completion_tokens = Math.max(512, Number(cfg.maxTokens) || 4096);
      variants.push({ body: b2, json: false, tag: '推理模型参数' });

      let lastErr = null;
      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        try {
          return await this._withRetry(() => this._send(url, v.body, { stream: !!opts.stream, onDelta, timeout, json: v.json }), () => emitted);
        } catch (err) {
          lastErr = err;
          if (err && err.name === 'AbortError') throw err;
          // 只有「参数不被接受」才值得换一种写法再试；401/429 之类直接上抛
          const paramIssue = /response_format|temperature|max_tokens|max_completion_tokens|unsupported|invalid|not supported|unrecognized/i.test(err.message || '');
          if (i >= variants.length - 1 || !paramIssue) break;
          log('参数不被接受，改用「' + v.tag + '」再试一次', err.message);
        }
      }
      throw lastErr;
    },

    /** 最多重试 2 次，指数退避 + 抖动；已开始输出则不再重试 */
    async _withRetry(fn, hasEmitted, retries) {
      const max = retries == null ? 2 : retries;
      let attempt = 0;
      for (;;) {
        try {
          return await fn();
        } catch (err) {
          attempt++;
          if (attempt > max || !this.isRetryable(err) || (hasEmitted && hasEmitted())) throw err;
          const wait = Math.min(8000, 700 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 250);
          log('请求失败，' + wait + 'ms 后重试（第 ' + attempt + '/' + max + ' 次）', err.message);
          if (this.onRetry) {
            try {
              this.onRetry(err, attempt, max);
            } catch (e) {
              /* ignore */
            }
          }
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    },

    async _send(url, body, opt) {
      const headers = this.headers();
      if (opt.stream) headers.Accept = 'text/event-stream';
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
                if (parser.usage) this.addUsage(parser.usage);
                resolve({ text, raw: res.responseText, usage: parser.usage || null, finishReason: parser.finishReason || '' });
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
            const e = new Error('已取消');
            e.name = 'AbortError';
            reject(e);
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
        if (parser.usage) this.addUsage(parser.usage);
        return { text, raw: rawAll, usage: parser.usage || null, finishReason: parser.finishReason || '' };
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
      const msg = choice.message || {};
      const content = msg.content || choice.text || '';
      this.addUsage(j.usage);
      return {
        text: String(content),
        raw: text,
        usage: j.usage || null,
        model: j.model,
        // 推理模型会把思考放进 reasoning_content，正文留空；
        // finish_reason = length 说明输出被 max_tokens 截断了
        finishReason: choice.finish_reason || '',
        reasoning: String(msg.reasoning_content || choice.reasoning || ''),
      };
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
            if (j.usage) parser.usage = j.usage;
            const ch = j.choices && j.choices[0];
            if (ch && ch.finish_reason) parser.finishReason = ch.finish_reason;
            const d = ch && (ch.delta || ch.message);
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
      parser.finishReason = '';
      parser.reset = () => {
        buf = '';
        parser.text = '';
      };
      return parser;
    },

    /** 把被 max_tokens 截断的 JSON 补完整（模型话说到一半就没了） */
    repairJson(s) {
      const stack = [];
      let inStr = false;
      let esc = false;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') stack.pop();
      }
      if (!stack.length && !inStr) return s;
      let out = s;
      if (inStr) out += '"';
      for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
      return out;
    },

    /** 从模型输出里抠出 JSON（容忍 ```json 围栏、前后废话、顶层数组、被截断的尾巴） */
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

      // 括号配对扫描：既认对象也认数组（模型有时直接给 [{...},{...}]）
      for (const pair of [['{', '}'], ['[', ']']]) {
        const open = pair[0];
        const close = pair[1];
        const start = s.indexOf(open);
        if (start < 0) continue;
        let depth = 0;
        let inStr = false;
        let esc = false;
        let end = -1;
        for (let i = start; i < s.length; i++) {
          const c = s[i];
          if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') inStr = true;
          else if (c === open) depth++;
          else if (c === close) {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        const sub = end >= 0 ? s.slice(start, end + 1) : s.slice(start);
        v = tryParse(sub);
        if (v !== undefined) return v;
        // 修复尾逗号再试
        v = tryParse(sub.replace(/,\s*([}\]])/g, '$1'));
        if (v !== undefined) return v;
        // 输出被截断：把缺的部分补上再试
        v = tryParse(this.repairJson(sub));
        if (v !== undefined) return v;
      }
      return null;
    },
  };


  /* ============================ 7. 题型求解器 ============================ */

  const ANSWER_SCHEMA = `只输出一个 JSON 对象，不要 Markdown 围栏、不要多余文字：
{"type":"mcq|multiselect|short|free|code|parsons|blank","answers":[...],"explanation":"可选"}
- mcq: ["B"]；multiselect: ["A","C"]
- short/free: 可直接填入的段落数组
- code: 完整可运行代码全文（保留缩进，含题目给的原代码）
- parsons: 行号数组（从 0 开始，按正确顺序）
- blank: 按空位从左到右`;

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
      UI.status(L(`代码已写入，等 ${sec} 秒让页面同步…`, `Code written — waiting ${sec}s for the page to sync…`), 'busy');
      await sleep(sec * 1000);
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
    flow: false, // 一键全流程正在跑
    stopMark: 0, // 每按一次「停止」加一，长流程靠它判断用户是不是中途叫停了
    chat: [],
    mounted: false,
  };

  function rgba(color, alpha) {
    const rgb = parseColor(color);
    if (!rgb) return color; // 已经是关键字等无法解析的写法，原样使用
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  /** 平台判断：Mac 上 Alt 显示为 ⌥，快捷键也走 e.code 以免 Option 组合键变成字符 */
  const IS_MAC = /mac|iphone|ipad|ipod/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '');
  const KB = (k) => (IS_MAC ? '⌥' + k : 'Alt+' + k);

  /** 插件图标：两行正在被写下的文字 + 一支斜切光标。
   *  设计稿在 assets/icon/（含 16px 像素对位版与各尺寸 PNG）。
   *  图形用 currentColor，白色描边跟着 .logo / .fab 的紫色渐变底走。 */
  const LOGO_SVG = (size) =>
    '<svg viewBox="0 0 32 32" width="' + size + '" height="' + size + '" fill="currentColor" aria-hidden="true" focusable="false">' +
    '<rect x="2" y="10" width="16" height="4" rx="2"/>' +
    '<rect x="2" y="18" width="12" height="4" rx="2"/>' +
    '<path d="M22 6h4l2 20h-4z"/>' +
    '</svg>';

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
.wrap[data-collapsed="true"] .panel {
  opacity: 0; visibility: hidden; pointer-events: none;
  transform: scale(.94) translateY(8px);
  transition: opacity .16s ease, transform .2s cubic-bezier(.2,.8,.25,1), visibility 0s linear .2s;
}
.wrap .panel {
  transform-origin: bottom right;
  transition: opacity .18s ease, transform .22s cubic-bezier(.2,.8,.25,1), visibility 0s linear 0s;
}
.wrap[data-collapsed="true"] .fab {
  display: grid; opacity: 1; transform: scale(1);
  transition: opacity .16s ease .04s, transform .2s cubic-bezier(.2,.8,.25,1) .04s;
}
.fab { opacity: 0; transform: scale(.86); }
.wrap[data-hidden="true"] { display: none !important; }
.wrap.dragging { transition: none; }
.wrap.dragging .panel { cursor: grabbing; }
.drag-grip {
  width: 14px; height: 14px; flex: 0 0 auto; margin-right: -2px; opacity: .5;
  background-image: radial-gradient(currentColor 1.1px, transparent 1.2px);
  background-size: 5px 5px; color: var(--jm-muted);
}
.ft { cursor: grab; }
.fab {
  display: none; position: absolute; left: 0; top: 0;
  width: 52px; height: 52px; border-radius: 18px; border: 1px solid var(--jm-border);
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

@keyframes jm-in { from { opacity: 0; transform: translateY(6px) scale(.995); } to { opacity: 1; transform: none; } }
@keyframes jm-fade { from { opacity: 0; } to { opacity: 1; } }
.q { animation: jm-in .2s cubic-bezier(.2,.8,.25,1) both; }
.cmsg { animation: jm-fade .18s ease both; }
.tab-ind {
  position: absolute; top: 0; height: 0; left: 0; width: 0; border-radius: 10px;
  background: var(--jm-chip); box-shadow: inset 0 0 0 1px var(--jm-border);
  transition: transform .24s cubic-bezier(.3,.7,.3,1), width .24s cubic-bezier(.3,.7,.3,1), opacity .18s ease;
  pointer-events: none; z-index: 0;
}
.tabs { position: relative; }

/* 关闭动画 */
.wrap[data-anim="off"] *, .wrap[data-anim="off"] *::before, .wrap[data-anim="off"] *::after {
  transition: none !important; animation: none !important;
}

/* 语言开关：更顺滑的滑块 */
.lang-switch .knob { transition: transform .24s cubic-bezier(.4,0,.2,1), box-shadow .2s ease; }
.lang-switch:active .knob { box-shadow: 0 1px 8px -1px var(--jm-shadow); }

.tab {
  flex: 1 1 0; padding: 7px 6px; border-radius: 10px; border: 1px solid transparent; background: transparent;
  color: var(--jm-muted); font-size: 12.5px; font-family: inherit; cursor: pointer;
}
.tab:hover { color: var(--jm-text); }
.tab.on { background: transparent; color: var(--jm-accent-text); font-weight: 600; border-color: transparent; }

.body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; padding: 0 12px 4px; }
.pane { display: none; padding-bottom: 8px; }
.pane.on { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.pane[data-pane="solve"], .pane[data-pane="cfg"] { overflow-y: auto; }
.pane {
  padding-right: 12px;              /* 内容与右侧滚动条之间留 12px */
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--jm-scroll) transparent;
}
.chat-log { padding-right: 12px; }
.body { padding-right: 4px; }
.pane::-webkit-scrollbar, .chat-log::-webkit-scrollbar { width: 8px; }
.pane::-webkit-scrollbar-track, .chat-log::-webkit-scrollbar-track { background: transparent; }
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
/* 一键全流程：单独一行、整行宽度，作为最主要的那个动作 */
.cta { padding: 2px 0 8px; }
.btn.go {
  width: 100%; padding: 10px 12px; font-size: 13px; font-weight: 700; border-radius: 12px;
  background: linear-gradient(135deg, var(--jm-primary), var(--jm-secondary)); color: #fff; border-color: transparent;
  box-shadow: 0 8px 18px -8px var(--jm-shadow);
}
.btn.go:hover { filter: brightness(1.07); }
.btn.go:active { transform: scale(.995); }

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

/* 折叠 / 展开 */
.chev { margin-left: 2px; }
.q-hd.clickable { cursor: pointer; border-radius: 8px; margin: -2px -4px 0; padding: 2px 4px; transition: background .14s ease; }
.q-hd.clickable:hover { background: var(--jm-chip); }
.q-hd.clickable:focus-visible { outline: 2px solid var(--jm-primary); outline-offset: 1px; }
.q.expanded { border-color: var(--jm-primary-border); box-shadow: 0 3px 12px -8px var(--jm-shadow); }
.q:not(.expanded) .q-prompt { -webkit-line-clamp: 2; }
.q-prompt { -webkit-line-clamp: 3; }
.q.expanded .q-prompt { -webkit-line-clamp: unset; display: block; }
.opts .opt:nth-child(n+7) { display: none; }
.q.expanded .opts .opt:nth-child(n+7) { display: flex; }

/* Markdown */
.md { font-size: 12.5px; line-height: 1.6; color: var(--jm-text); white-space: normal; word-break: break-word; }
.md > *:first-child { margin-top: 0; }
.md > *:last-child { margin-bottom: 0; }
.md p { margin: 6px 0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 10px 0 5px; font-size: 13px; font-weight: 650; line-height: 1.35; }
.md h1 { font-size: 15px; }
.md h2 { font-size: 14px; }
.md ul, .md ol { margin: 5px 0; padding-left: 19px; }
.md li { margin: 2px 0; }
.md blockquote {
  margin: 6px 0; padding: 3px 10px; border-left: 2px solid var(--jm-primary);
  background: var(--jm-chip); border-radius: 0 8px 8px 0; color: var(--jm-text-2);
}
.md code {
  font-family: "Roboto Mono", ui-monospace, monospace; font-size: 11.5px;
  background: var(--jm-chip); border-radius: 5px; padding: 1px 5px; color: var(--jm-primary);
}
.md a { color: var(--jm-primary); text-decoration: underline; }
.md hr { border: none; border-top: 1px solid var(--jm-border); margin: 10px 0; }
.md table { border-collapse: collapse; margin: 7px 0; font-size: 11.5px; width: 100%; }
.md th, .md td { border: 1px solid var(--jm-border); padding: 4px 7px; text-align: left; }
.md th { background: var(--jm-chip); font-weight: 600; }

/* 代码块 + 复制 */
.md-code { border: 1px solid var(--jm-border); border-radius: 10px; overflow: hidden; margin: 7px 0; background: var(--jm-code-bg); }
.md-code-bar {
  display: flex; align-items: center; gap: 6px; padding: 4px 6px 4px 9px;
  background: var(--jm-chip); border-bottom: 1px solid var(--jm-border);
}
.md-lang { flex: 1 1 auto; font-size: 10.5px; color: var(--jm-muted); font-family: "Roboto Mono", monospace; }
.md-code pre { margin: 0; padding: 8px 10px; overflow: auto; max-height: 320px; }
.md-code code {
  background: none; padding: 0; color: var(--jm-text); font-size: 11.5px;
  font-family: "Roboto Mono", ui-monospace, monospace; white-space: pre;
}
.copy-btn {
  border: 1px solid var(--jm-border); background: transparent; color: var(--jm-muted);
  border-radius: 7px; padding: 2px 7px; font-size: 10.5px; font-family: inherit; cursor: pointer; line-height: 1.5;
}
.copy-btn:hover { color: var(--jm-text); background: var(--jm-chip); }
.copy-btn.ok { color: var(--jm-success); border-color: var(--jm-ok-border); }
.answer-wrap { position: relative; }
.answer-wrap .copy-btn { position: absolute; top: 5px; right: 5px; }
.answer { padding-right: 52px; }

/* 对话 */
.chat-log { display: flex; flex-direction: column; gap: 8px; padding: 2px 0 8px; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.cmsg { border-radius: 12px; padding: 8px 10px; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
.cmsg.user { background: var(--jm-chip); align-self: flex-end; max-width: 88%; }
.cmsg.ai { background: var(--jm-card); border: 1px solid var(--jm-border); }
.cmsg.sys { color: var(--jm-muted); font-size: 11.5px; background: transparent; padding: 2px; }
.cmsg.ai.streaming::after { content: '▍'; margin-left: 1px; color: var(--jm-primary); animation: jmblink 1s steps(2, start) infinite; }
@keyframes jmblink { 50% { opacity: 0; } }
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
.ft-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.ft-usage { flex: 0 0 auto; font-variant-numeric: tabular-nums; opacity: .8; font-size: 10.5px; }
.ft-stop {
  flex: 0 0 auto; border: 1px solid var(--jm-error-border); background: transparent; color: var(--jm-error);
  border-radius: 7px; padding: 1px 8px; font-size: 10.5px; font-family: inherit; cursor: pointer; line-height: 1.6;
}
.ft-stop:hover { background: var(--jm-error); color: #fff; }

.logo svg, .fab svg { display: block; }
.logo { color: #fff; }
/* 总结：落在对话区里的一条回答，底部挂复制按钮 */
.sum-msg .sum-body { white-space: normal; }
.sum-copy { margin-top: 8px; font-size: 11px; padding: 3px 9px; }
.fab { touch-action: none; }

/* 语言开关：拨动样式 */
.lang-switch {
  position: relative; width: 58px; height: 22px; flex: 0 0 auto;
  display: inline-flex; align-items: stretch;
  padding: 0; border-radius: 11px; cursor: pointer; font-family: inherit;
  border: 1px solid var(--jm-border); background: var(--jm-chip);
  font-size: 9.5px; font-weight: 700; color: var(--jm-text-2); letter-spacing: 0;
}
.lang-switch .knob {
  position: absolute; top: 0; left: 0; width: 28px; height: 20px; border-radius: 10px;
  background: linear-gradient(135deg, var(--jm-primary), var(--jm-secondary));
  box-shadow: 0 1px 4px -1px var(--jm-shadow);
}
.lang-switch[data-lang="en"] .knob { transform: translateX(28px); }
.lang-switch span {
  position: relative; z-index: 1; flex: 1 1 0; display: flex;
  align-items: center; justify-content: center; line-height: 1;
}
.lang-switch[data-lang="zh"] .lz, .lang-switch[data-lang="en"] .le { color: #fff; }

/* 高级设置折叠 */
details.adv { margin: 10px 0 2px; border-top: 1px dashed var(--jm-border); padding-top: 8px; }
details.adv > summary {
  cursor: pointer; list-style: none; font-size: 11.5px; font-weight: 600; color: var(--jm-muted);
  display: flex; align-items: center; gap: 5px; padding: 2px 0;
}
details.adv > summary::-webkit-details-marker { display: none; }
details.adv > summary::before { content: '▸'; font-size: 10px; transition: transform .15s ease; }
details.adv[open] > summary::before { transform: rotate(90deg); }
details.adv[open] > summary { color: var(--jm-primary); }
details.adv .adv-body { padding-top: 6px; }
.field.check.sub { display: block; margin-left: 16px; margin-bottom: 9px; }
.range-field input[type="range"] {
  width: 100%; margin: 4px 0 2px; accent-color: var(--jm-primary); cursor: pointer;
}
.range-field.disabled { opacity: .45; }
.range-field.disabled input { cursor: not-allowed; }
.wpm-val { color: var(--jm-primary); font-weight: 700; font-variant-numeric: tabular-nums; }
.check.sub label { display: block; margin: 2px 0 4px; }
.check.sub select { width: 100%; }
.check.sub.disabled { opacity: .45; }
.toast {
  position: absolute; left: 50%; bottom: 46px; transform: translateX(-50%) translateY(6px);
  background: var(--jm-toast-bg); color: var(--jm-toast-text); padding: 7px 12px; border-radius: 10px;
  font-size: 12px; opacity: 0; pointer-events: none; transition: all .18s ease; max-width: 86%;
  box-shadow: 0 8px 24px -8px rgba(0,0,0,.4); white-space: pre-wrap; text-align: center;
}
.toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }
`;

  /* ------------------------- 复制 ------------------------- */

  function copyText(text) {
    const s = String(text == null ? '' : text);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(s).catch(() => fallbackCopy(s));
        return true;
      }
    } catch (e) {
      /* ignore */
    }
    return fallbackCopy(s);
  }

  function fallbackCopy(s) {
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  function copyBtn(getText, label) {
    const b = document.createElement('button');
    b.className = 'copy-btn';
    b.type = 'button';
    b.textContent = label || L('复制', 'Copy');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const ok = copyText(getText());
      const old = b.textContent;
      b.textContent = ok ? L('已复制', 'Copied') : L('复制失败', 'Copy failed');
      b.classList.toggle('ok', ok);
      setTimeout(() => {
        b.textContent = old;
        b.classList.remove('ok');
      }, 1200);
      if (ok && UI && UI.toast) UI.toast(L('已复制', 'Copied'));
    });
    return b;
  }

  /* ------------------------- Markdown ------------------------- */

  const MD = {
    /** 行内标记：`code` **粗** *斜* _斜_ ~~删除~~ [链接](url) */
    inline(text) {
      const frag = document.createDocumentFragment();
      const src = String(text == null ? '' : text);
      const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(__[^_\n]+__)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/g;
      let last = 0;
      let m;
      const pushText = (t) => {
        if (t) frag.appendChild(document.createTextNode(t));
      };
      while ((m = re.exec(src))) {
        pushText(src.slice(last, m.index));
        const tok = m[0];
        let el;
        if (m[1]) {
          el = document.createElement('code');
          el.textContent = tok.slice(1, -1);
        } else if (m[2] || m[4]) {
          el = document.createElement('strong');
          el.textContent = tok.slice(2, -2);
        } else if (m[3] || m[5]) {
          el = document.createElement('em');
          el.textContent = tok.slice(1, -1);
        } else if (m[6]) {
          el = document.createElement('del');
          el.textContent = tok.slice(2, -2);
        } else {
          const mm = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
          el = document.createElement('a');
          el.textContent = mm[1];
          el.href = mm[2];
          el.target = '_blank';
          el.rel = 'noopener noreferrer';
        }
        frag.appendChild(el);
        last = m.index + tok.length;
      }
      pushText(src.slice(last));
      return frag;
    },

    codeBlock(code, lang) {
      const wrap = document.createElement('div');
      wrap.className = 'md-code';
      const bar = document.createElement('div');
      bar.className = 'md-code-bar';
      const l = document.createElement('span');
      l.className = 'md-lang';
      l.textContent = lang || 'text';
      bar.append(l, copyBtn(() => code, L('复制代码', 'Copy code')));
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      codeEl.textContent = code;
      pre.appendChild(codeEl);
      wrap.append(bar, pre);
      return wrap;
    },

    /** 把一段 Markdown 渲染成 DOM（不解析原始 HTML，全部按文本处理） */
    render(src) {
      const frag = document.createDocumentFragment();
      const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
      const buf = [];
      const flush = () => {
        if (!buf.length) return;
        const p = document.createElement('p');
        p.appendChild(this.inline(buf.join('\n')));
        frag.appendChild(p);
        buf.length = 0;
      };

      let i = 0;
      while (i < lines.length) {
        const line = lines[i];

        // 代码围栏
        const fence = line.match(/^\s*```+\s*([\w+#.\-]*)\s*$/);
        if (fence) {
          flush();
          i++;
          const code = [];
          while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) code.push(lines[i++]);
          i++; // 跳过收尾围栏
          frag.appendChild(this.codeBlock(code.join('\n'), fence[1]));
          continue;
        }

        if (!line.trim()) {
          flush();
          i++;
          continue;
        }

        // 标题
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
          flush();
          const el = document.createElement('h' + Math.min(h[1].length, 6));
          el.appendChild(this.inline(h[2]));
          frag.appendChild(el);
          i++;
          continue;
        }

        // 分隔线
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
          flush();
          frag.appendChild(document.createElement('hr'));
          i++;
          continue;
        }

        // 表格
        if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) {
          flush();
          const cells = (l) =>
            l
              .replace(/^\s*\|/, '')
              .replace(/\|\s*$/, '')
              .split('|')
              .map((c) => c.trim());
          const table = document.createElement('table');
          const thead = document.createElement('thead');
          const tr = document.createElement('tr');
          cells(line).forEach((c) => {
            const th = document.createElement('th');
            th.textContent = c;
            tr.appendChild(th);
          });
          thead.appendChild(tr);
          table.appendChild(thead);
          const tbody = document.createElement('tbody');
          i += 2;
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
            const row = document.createElement('tr');
            cells(lines[i]).forEach((c) => {
              const td = document.createElement('td');
              td.textContent = c;
              row.appendChild(td);
            });
            tbody.appendChild(row);
            i++;
          }
          table.appendChild(tbody);
          frag.appendChild(table);
          continue;
        }

        // 无序列表
        if (/^\s*[-*+]\s+/.test(line)) {
          flush();
          const ul = document.createElement('ul');
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            const li = document.createElement('li');
            li.appendChild(this.inline(lines[i].replace(/^\s*[-*+]\s+/, '')));
            ul.appendChild(li);
            i++;
          }
          frag.appendChild(ul);
          continue;
        }

        // 有序列表
        if (/^\s*\d+[.)]\s+/.test(line)) {
          flush();
          const ol = document.createElement('ol');
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
            const li = document.createElement('li');
            li.appendChild(this.inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')));
            ol.appendChild(li);
            i++;
          }
          frag.appendChild(ol);
          continue;
        }

        // 引用
        if (/^\s*>\s?/.test(line)) {
          flush();
          const quote = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
          const bq = document.createElement('blockquote');
          bq.appendChild(this.render(quote.join('\n')));
          frag.appendChild(bq);
          continue;
        }

        buf.push(line);
        i++;
      }
      flush();
      return frag;
    },
  };


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
      shadow.appendChild(style);
      shadow.appendChild(wrap);
      document.documentElement.appendChild(host);

      this.host = host;
      this.root = shadow;
      this.$wrap = wrap;
      this.renderShell();

      this.applyPalette(Theme.read());
      Theme.observe((p) => this.applyPalette(p));
      this.restorePos();
      this.updateSub();
      // 开了「隐藏悬浮窗」的：启动即不显示，只等 Alt+J
      if (Store.get('hidePanel')) this.setHidden(true);
      App.mounted = true;
    },

    /** 重建整个面板骨架（切换语言时也走这里） */
    renderShell() {
      const wrap = this.$wrap;
      wrap.innerHTML = `
        <div class="panel">
          <div class="hd" data-drag="handle" title="${L('按住拖动', 'Drag to move')}">
            <span class="drag-grip"></span>
            <div class="logo">${LOGO_SVG(19)}</div>
            <div class="hd-txt">
              <div class="ttl">${L('JuiceMind 助手', 'JuiceMind Assistant')}</div>
              <div class="sub" data-ref="sub">${L('未配置 API', 'API not configured')}</div>
            </div>
            <div class="hd-btns">
              <button class="lang-switch" data-ref="btn-lang" data-lang="${curLang()}" title="${L('切换中英文（界面与模型输出）', 'Switch language (UI & model output)')}">
                <span class="knob"></span><span class="lz">中</span><span class="le">EN</span>
              </button>
              <button class="icon" data-ref="btn-hide" title="${L('关闭', 'Close')}">×</button>
            </div>
          </div>
          <div class="tabs">
            <span class="tab-ind" data-ref="tab-ind"></span>
            <button class="tab on" data-tab="solve">${L('答题', 'Solve')}</button>
            <button class="tab" data-tab="chat">${L('对话', 'Chat')}</button>
            <button class="tab" data-tab="cfg">${L('设置', 'Settings')}</button>
          </div>
          <div class="body">
            <div class="pane on" data-pane="solve">
              <div class="cta">
                <button class="btn go" data-ref="btn-auto">${L('一键完成本页', 'Complete this page')}</button>
              </div>
              <div class="bar">
                <button class="btn primary" data-ref="btn-scan">${L('扫描页面', 'Scan page')}</button>
                <button class="btn" data-ref="btn-solve" hidden>${L('生成全部', 'Generate all')}</button>
                <button class="btn" data-ref="btn-fill" hidden>${L('填入全部', 'Fill all')}</button>
              </div>
              <div data-ref="qlist"><div class="empty">${L('点击「扫描页面」识别当前页面的题目', 'Click "Scan page" to find questions on this page')}<br/><span style="opacity:.7">${L('支持教程+题目、选择题、简答、编程、排序、填空', 'Tutorial + questions, multiple choice, short answer, coding, Parsons, fill-in-blank')}</span></div></div>
            </div>
            <div class="pane" data-pane="chat">
              <div class="bar">
                <button class="btn primary" data-ref="btn-summary">${L('总结本页', 'Summarize page')}</button>
              </div>
              <div class="chat-log" data-ref="chatlog"></div>
              <div class="chat-in">
                <textarea data-ref="chat-in" placeholder="${L('问点什么…（可自动带上当前页面内容）', 'Ask anything… (page content is attached)')}"></textarea>
                <button class="btn primary" data-ref="btn-send">${L('发送', 'Send')}</button>
              </div>
            </div>
            <div class="pane" data-pane="cfg" data-ref="cfg"></div>
          </div>
          <div class="ft"><span class="dot" data-ref="dot"></span><span class="ft-txt" data-ref="ft">${L('就绪', 'Ready')}</span><span class="ft-usage" data-ref="usage"></span><button class="ft-stop" data-ref="btn-stop" hidden>${L('停止', 'Stop')}</button></div>
          <div class="toast" data-ref="toast"></div>
        </div>
        <button class="fab" title="${L('打开助手', 'Open assistant')} (${KB('J')})">${LOGO_SVG(26)}</button>
      `;

      this.$(this.root, wrap);
      this.bind();
      this.renderSettings();
      this.renderQuestions();
      this.renderChat();
      this.applyAnim();
      this.setTab(App.tab || 'solve', true);
      this.updateSub();
      this.updateUsage();
      this.moveTabIndicator(true);
    },

    /** 切换界面语言：重绘骨架 + 配置，保持当前状态 */
    toggleLang() {
      const next = curLang() === 'en' ? 'zh' : 'en';
      Store.set({ uiLang: next });
      this.renderShell();
      this.status(next === 'en' ? 'Language: English' : '语言：中文');
      this.toast(next === 'en' ? 'Switched to English' : '已切换为中文');
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
      if (!v) {
        this.$wrap.removeAttribute('data-hidden');
        this.restorePos();
      }
    },

    /** 整窗隐藏：不显示面板也不显示圆钮，只能 Alt+J 叫回来 */
    setHidden(v) {
      if (v) {
        this.$wrap.setAttribute('data-hidden', 'true');
      } else {
        this.$wrap.removeAttribute('data-hidden');
        this.$wrap.setAttribute('data-collapsed', 'false');
        this.restorePos();
      }
    },

    isHidden() {
      return this.$wrap.getAttribute('data-hidden') === 'true';
    },

    /** Alt+J 的统一入口：隐藏 → 显示；显示中且开了「隐藏悬浮窗」→ 隐藏；否则收成圆钮 */
    toggleVisible() {
      const cfg = Store.get();
      if (this.isHidden()) {
        this.setHidden(false);
        return true;
      }
      const collapsed = this.$wrap.getAttribute('data-collapsed') === 'true';
      if (cfg.hidePanel) {
        this.setHidden(true);
        return false;
      }
      this.setCollapsed(!collapsed);
      return !collapsed;
    },

    /* ------------------------- 事件绑定 ------------------------- */

    bind() {
      const r = this.refs;
      const wrap = this.$wrap;

      // 标签页
      r.tabs.forEach((t) => {
        t.addEventListener('click', () => this.setTab(t.getAttribute('data-tab')));
      });

      // 关闭（只保留这一个；原先的「–」收起与它等价，已移除）
      const hideOne = () => {
        if (Store.get('hidePanel')) this.setHidden(true);
        else this.setCollapsed(true);
      };
      r['btn-hide'].addEventListener('click', hideOne);
      // 中英文一键切换（同时决定模型输出语言）
      if (r['btn-lang']) r['btn-lang'].addEventListener('click', () => this.toggleLang());

      // 主体按钮
      r['btn-scan'].addEventListener('click', () => Actions.scan(true));
      r['btn-solve'].addEventListener('click', () => Actions.solveAll());
      r['btn-fill'].addEventListener('click', () => Actions.fillAll());
      r['btn-auto'].addEventListener('click', () => Actions.autoFlow());
      r['btn-stop'].addEventListener('click', () => Actions.stop());

      // 总结（结果直接落在对话区里）
      r['btn-summary'].addEventListener('click', () => Actions.summarize());

      // 对话
      r['btn-send'].addEventListener('click', () => Actions.sendChat());
      r['chat-in'].addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          Actions.sendChat();
        }
      });

      // 拖拽：头部 / 底部都能拖，document 级监听，鼠标与触屏通用
      const panel = wrap.querySelector('.panel');
      const fab = wrap.querySelector('.fab');
      let drag = null;
      let fabMoved = false;

      const beginDrag = (e, fromFab) => {
        const rect = wrap.getBoundingClientRect();
        drag = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top, fab: !!fromFab, moved: false };
        if (fromFab) fabMoved = false;
        wrap.classList.add('dragging');
        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('pointercancel', onUp, true);
      };

      const onMove = (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
          drag.moved = true;
          if (drag.fab) fabMoved = true;
        }
        const m = 8;
        let left = drag.ox + dx;
        let top = drag.oy + dy;
        left = Math.min(Math.max(m, left), window.innerWidth - 60);
        top = Math.min(Math.max(m, top), window.innerHeight - 40);
        wrap.style.left = left + 'px';
        wrap.style.top = top + 'px';
        if (e.cancelable) e.preventDefault();
      };

      const onUp = () => {
        if (!drag) return;
        drag = null;
        wrap.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onUp, true);
        this.savePos();
      };

      // 面板：头部 / 底部可拖
      panel.addEventListener(
        'pointerdown',
        (e) => {
          if (e.button !== 0 && e.pointerType === 'mouse') return;
          const handle = e.target.closest('[data-drag="handle"], .ft');
          if (!handle) return;
          if (e.target.closest('button, a, input, textarea, select, .copy-btn')) return;
          beginDrag(e, false);
          e.preventDefault();
        },
        true
      );

      // 收起后的圆钮：也能拖；拖过的这一次不当作点击
      fab.addEventListener(
        'pointerdown',
        (e) => {
          if (e.button !== 0 && e.pointerType === 'mouse') return;
          beginDrag(e, true);
          e.preventDefault();
        },
        true
      );
      fab.addEventListener('click', (e) => {
        if (fabMoved) {
          fabMoved = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        this.setCollapsed(false);
      });

      window.addEventListener('resize', debounce(() => this.restorePos(), 200));
    },

    setTab(name, instant) {
      App.tab = name;
      this.refs.tabs.forEach((t) => t.classList.toggle('on', t.getAttribute('data-tab') === name));
      this.refs.panes.forEach((p) => p.classList.toggle('on', p.getAttribute('data-pane') === name));
      this.moveTabIndicator(!!instant);
    },

    /** 让色块贴到当前标签下面；instant=true 时不播放滑动动画 */
    moveTabIndicator(instant) {
      const ind = this.refs && this.refs['tab-ind'];
      const active = this.refs.tabs.find((t) => t.classList.contains('on'));
      if (!ind || !active) return;
      const w = active.offsetWidth;
      if (!w) {
        ind.style.opacity = '0';
        return;
      }
      const apply = () => {
        ind.style.top = active.offsetTop + 'px';
        ind.style.height = active.offsetHeight + 'px';
        ind.style.width = w + 'px';
        ind.style.transform = 'translateX(' + active.offsetLeft + 'px)';
        ind.style.opacity = '1';
      };
      if (instant) {
        // 先禁用过渡 → 落位 → 强制回流 → 恢复，避免出现「从最左侧滑过去」的假动画
        ind.style.transition = 'none';
        apply();
        void ind.offsetWidth;
        ind.style.transition = '';
      } else {
        apply();
      }
    },

    /** 应用/取消界面动画 */
    applyAnim() {
      if (!this.$wrap) return;
      const on = Store.get('anim') !== false;
      this.$wrap.setAttribute('data-anim', on ? 'on' : 'off');
    },

    /* ------------------------- 状态 ------------------------- */

    status(msg, kind) {
      const ft = this.refs.ft;
      const dot = this.refs.dot;
      ft.textContent = msg;
      dot.className = 'dot' + (kind === 'busy' ? ' busy' : kind === 'err' ? ' err' : '');
    },

    /** 忙碌时显示「停止」按钮 */
    setStopVisible(on) {
      const b = this.refs && this.refs['btn-stop'];
      if (b) b.hidden = !on;
    },

    /** 页脚用量：token 数与请求次数 */
    updateUsage() {
      const el = this.refs && this.refs.usage;
      if (!el || typeof LLM === 'undefined' || !LLM.stats) return;
      const s = LLM.stats;
      if (!s.total) {
        el.textContent = '';
        return;
      }
      const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
      el.textContent = k(s.total) + ' tok · ' + s.requests + L(' 次', ' req');
      el.title = L('本会话累计：', 'This session: ') + L('输入 ', 'in ') + s.prompt + ' / ' + L('输出 ', 'out ') + s.completion + ' tokens' + L('，共 ' + s.requests + ' 次请求', ', ' + s.requests + ' requests');
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
      el.textContent = (hasKey ? cfg.model || L('未设置模型', 'no model') : L('未配置 API Key', 'API key missing')) + (cfg.autoSubmit ? L(' · 自动提交', ' · auto-submit') : '');
    },

    /* ------------------------- 题目列表 ------------------------- */

    renderQuestions() {
      const box = this.refs.qlist;
      const scan = App.scan;
      if (!scan || !scan.questions || !scan.questions.length) {
        const kind = App.scan ? App.scan.kind : PageModel.kind;
        const tips = {
          class: L('当前是课程首页：请从左侧导航点开一个条目（教程/题目）再扫描。', 'This is the course home: open an item from the left nav, then scan.'),
          quiz: L('当前是测验页：进入题目后再扫描。', 'This is the quiz overview: open a question first.'),
          gameroom: L('当前是实时竞赛：进入题目后再扫描。', 'This is a live game: open a question first.'),
          generic: L('没找到可作答的控件。若页面还在加载，稍等再扫描；也可以在「对话」里直接提问。', 'No answerable widgets found. If the page is still loading, wait and scan again — or just ask in Chat.'),
        };
        box.innerHTML = `<div class="empty">${tips[kind] || L('这一页没有检测到题目。<br/>如果是纯教程页，可以直接用「总结」或「对话」。', 'No questions detected on this page.<br/>On a tutorial page, use Summary or Chat instead.')}</div>`;
        return;
      }

      const frag = document.createDocumentFragment();
      scan.questions.forEach((q, i) => frag.appendChild(this.renderQuestionCard(q, i)));
      box.innerHTML = '';
      box.appendChild(frag);
      this.syncSolveButtons();
    },

    /**
     * 三个动作按进度依次出现：先扫描，扫出题目才有「生成全部」，
     * 生成出答案才有「填入全部」。「扫描页面」一直留着，随时可以重扫。
     */
    syncSolveButtons() {
      const qs = (App.scan && App.scan.questions) || [];
      const bSolve = this.refs['btn-solve'];
      const bFill = this.refs['btn-fill'];
      if (bSolve) bSolve.hidden = !qs.length;
      if (bFill) bFill.hidden = !qs.some((q) => !!q.answer);
    },

    /** 展开状态（按题目 id 记住，重渲染不丢） */
    _expanded: new Set(),

    isExpanded(q) {
      return this._expanded.has(q.id);
    },

    toggleExpand(q) {
      const on = !this.isExpanded(q);
      if (on) this._expanded.add(q.id);
      else this._expanded.delete(q.id);
      const idx = App.scan ? App.scan.questions.indexOf(q) : 0;
      const old = this.refs.qlist.querySelector('[data-qid="' + q.id + '"]');
      if (old) old.replaceWith(this.renderQuestionCard(q, idx));
    },

    renderQuestionCard(q, i) {
      const expanded = this.isExpanded(q);
      const card = document.createElement('div');
      const bad = q.status === 'error' || q.submitStatus === 'error' || q.submitStatus === 'wrong';
      card.className = 'q' + (q.status === 'done' || q.submitStatus === 'submitted' || q.submitStatus === 'skipped' ? ' done' : bad ? ' error' : '') + (expanded ? ' expanded' : '');
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
      if (q.submitStatus === 'submitted') {
        st.className = 'msg ok';
        st.textContent = L('已提交', 'submitted');
      } else if (q.submitStatus === 'skipped') {
        st.className = 'msg';
        st.textContent = L('已提交过·跳过', 'already submitted — skipped');
      } else if (q.submitStatus === 'wrong') {
        st.className = 'msg err';
        st.textContent = L('已提交·答错', 'submitted, incorrect');
      } else if (q.submitStatus === 'error') {
        st.className = 'msg err';
        st.textContent = L('提交失败', 'submit failed');
      } else if (q.status === 'running') st.innerHTML = '<span class="spin"></span>';
      else if (q.status === 'done') {
        st.className = 'msg ok';
        st.textContent = L('已生成', 'done');
      } else if (q.status === 'error') {
        st.className = 'msg err';
        st.textContent = L('失败', 'failed');
      }
      hd.appendChild(st);

      // 展开 / 收起
      const chev = document.createElement('button');
      chev.className = 'icon chev';
      chev.type = 'button';
      chev.title = expanded ? L('收起', 'Collapse') : L('展开', 'Expand');
      chev.textContent = expanded ? '▴' : '▾';
      chev.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleExpand(q, card, chev);
      });
      hd.appendChild(chev);

      // 整个顶部区域都能点开/收起（按钮、链接除外）
      hd.classList.add('clickable');
      hd.setAttribute('role', 'button');
      hd.tabIndex = 0;
      const toggleFromHead = (e) => {
        if (e && e.target && e.target.closest('button, a, input, textarea, select')) return;
        this.toggleExpand(q, card, chev);
      };
      hd.addEventListener('click', toggleFromHead);
      hd.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.toggleExpand(q, card, chev);
        }
      });

      const prompt = document.createElement('div');
      prompt.className = 'q-prompt';
      prompt.textContent = q.prompt || L('（未识别到题干）', '(no prompt found)');
      prompt.title = q.prompt || '';

      card.append(hd, prompt);

      if (q.options && q.options.length) {
        const opts = document.createElement('div');
        opts.className = 'opts';
        const pickedLabels = this.pickedLabels(q);
        q.options.slice(0, 24).forEach((o) => {
          const row = document.createElement('div');
          row.className = 'opt' + (pickedLabels.has(o.label) ? ' pick' : '');
          const k = document.createElement('span');
          k.className = 'k';
          k.textContent = o.label;
          const t = document.createElement('span');
          t.textContent = expanded ? oneLine(o.text) : truncate(oneLine(o.text), 120);
          row.append(k, t);
          opts.appendChild(row);
        });
        card.appendChild(opts);
      }

      if (q.answer) {
        const wrap = document.createElement('div');
        wrap.className = 'answer-wrap';
        const ans = document.createElement('div');
        ans.className = 'answer';
        ans.textContent = this.answerPreview(q);
        wrap.append(ans, copyBtn(() => (q.answer.answers || []).join('\n'), L('复制答案', 'Copy answer')));
        card.appendChild(wrap);
        if (q.answer.explanation) {
          const ex = document.createElement('div');
          ex.className = 'explain';
          ex.textContent = expanded ? q.answer.explanation : truncate(q.answer.explanation, 220);
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

      // 提交出问题：答案已经交出去了改不了，但必须让用户知道
      if (q.submitError) {
        const err = document.createElement('div');
        err.className = 'explain';
        err.style.color = 'var(--jm-error)';
        err.textContent = L('提交问题：', 'Submit issue: ') + q.submitError;
        card.appendChild(err);
      }

      // 服务端明确说了"只支持这几个模型名"时，给一键切换
      if (q.supportedModels && q.supportedModels.length) {
        const row = document.createElement('div');
        row.className = 'chips';
        const label = document.createElement('span');
        label.className = 'msg';
        label.textContent = L('改用：', 'Use: ');
        row.appendChild(label);
        q.supportedModels.forEach((m) => {
          const b = document.createElement('button');
          b.className = 'btn chip';
          b.textContent = m;
          b.title = L('改用 ', 'Switch to ') + m + L(' 并重试这题', ' and retry');
          b.addEventListener('click', () => Actions.useModel(m, q));
          row.appendChild(b);
        });
        card.appendChild(row);
      }

      const ft = document.createElement('div');
      ft.className = 'q-ft';
      const bSolve = document.createElement('button');
      bSolve.className = 'btn primary';
      bSolve.textContent = q.answer || q.status === 'error' ? L('重新生成', 'Regenerate') : L('生成', 'Generate');
      bSolve.addEventListener('click', () => Actions.solveOne(q));
      const bFill = document.createElement('button');
      bFill.className = 'btn';
      bFill.textContent = L('填入', 'Fill');
      bFill.disabled = !q.answer;
      bFill.addEventListener('click', () => Actions.fillOne(q));
      const bFocus = document.createElement('button');
      bFocus.className = 'btn ghost';
      bFocus.textContent = L('定位', 'Locate');
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
      this.syncSolveButtons();
    },

    /* ------------------------- 总结（落在对话区里） ------------------------- */

    /** 总结正文底部的复制按钮 */
    summaryCopyBtn(text) {
      const b = document.createElement('button');
      b.className = 'btn ghost sum-copy';
      b.textContent = L('复制总结', 'Copy summary');
      b.addEventListener('click', () => {
        copyText(text || '');
        this.toast(L('已复制总结', 'Summary copied'));
      });
      return b;
    },

    /** 开一个「正在总结」的气泡，边生成边往里填 */
    startSummaryBubble() {
      const log = this.renderChat();
      // 聊天区还是空的，先把「可以直接提问」的提示撤掉，别和总结挤在一起
      const hint = log.querySelector('.cmsg.sys');
      if (hint) hint.remove();
      const d = document.createElement('div');
      d.className = 'cmsg ai streaming sum-msg';
      const body = document.createElement('div');
      body.className = 'sum-body md';
      d.appendChild(body);
      log.appendChild(d);
      this.scrollChatToEnd();
      return d;
    },

    /** 流式更新总结正文（80ms 节流） */
    updateSummaryBubble(bubble, text) {
      bubble._sumPending = text;
      if (bubble._sumTimer) return;
      bubble._sumTimer = setTimeout(() => {
        bubble._sumTimer = 0;
        const body = bubble.querySelector('.sum-body');
        if (!body) return;
        body.innerHTML = '';
        body.appendChild(MD.render(bubble._sumPending || ''));
        this.scrollChatToEnd();
      }, 80);
    },

    /** 总结定稿：去掉光标，底部挂上复制按钮 */
    finishSummaryBubble(bubble, text) {
      const body = bubble.querySelector('.sum-body');
      if (body) {
        body.innerHTML = '';
        body.appendChild(MD.render(text || ''));
      }
      bubble.classList.remove('streaming');
      const old = bubble.querySelector('.sum-copy');
      if (old) old.remove();
      bubble.appendChild(this.summaryCopyBtn(text));
      this.scrollChatToEnd();
    },

    /* ------------------------- 对话 ------------------------- */

    /** 填充一条消息的气泡内容：AI 用 Markdown，用户/系统用纯文本 */
    fillBubble(bubble, role, content) {
      bubble.textContent = '';
      if (role === 'assistant') {
        bubble.classList.add('md');
        bubble.appendChild(MD.render(content || ''));
      } else {
        bubble.classList.remove('md');
        bubble.textContent = content || '';
      }
      return bubble;
    },

    renderChat() {
      const log = this.refs.chatlog;
      log.innerHTML = '';
      if (!App.chat.length) {
        const hint = document.createElement('div');
        hint.className = 'cmsg sys';
        hint.textContent = L('可以直接提问，例如「解释这一页的教程」「这题为什么选 B」。发送时会自动附带当前页面内容。', 'Ask anything, e.g. "explain this page" or "why is B correct?". Page content is attached automatically.');
        log.appendChild(hint);
      }
      for (const m of App.chat) {
        const d = document.createElement('div');
        d.className = 'cmsg ' + (m.role === 'user' ? 'user' : m.role === 'assistant' ? 'ai' : 'sys');
        if (m.kind === 'summary') {
          // 总结也是一条「回答」，正文单独放一个子元素，方便在下面挂复制按钮
          d.classList.add('sum-msg');
          const body = document.createElement('div');
          body.className = 'sum-body md';
          body.appendChild(MD.render(m.content || ''));
          d.appendChild(body);
          d.appendChild(this.summaryCopyBtn(m.content));
        } else {
          this.fillBubble(d, m.role, m.content);
        }
        log.appendChild(d);
      }
      this.scrollChatToEnd();
      return log;
    },

    appendChat(role, content) {
      const log = this.renderChat();
      const d = document.createElement('div');
      d.className = 'cmsg ' + (role === 'user' ? 'user' : role === 'assistant' ? 'ai' : 'sys');
      this.fillBubble(d, role, content);
      log.appendChild(d);
      this.scrollChatToEnd();
      return d;
    },

    /** 流式更新：按 Markdown 重渲染（节流） */
    updateBubble(bubble, text) {
      bubble._mdPending = text;
      if (bubble._mdTimer) return;
      bubble._mdTimer = setTimeout(() => {
        bubble._mdTimer = 0;
        this.fillBubble(bubble, 'assistant', bubble._mdPending || '');
        this.scrollChatToEnd();
      }, 80);
    },

    scrollChatToEnd() {
      const log = this.refs && this.refs.chatlog;
      if (log) log.scrollTop = log.scrollHeight;
    },

    /* ------------------------- 设置 ------------------------- */

    renderSettings() {
      const box = this.refs.cfg;
      const cfg = Store.get();
      const outLang = cfg.outputLangCustom ? cfg.outputLang : cfg.uiLang;
      box.innerHTML = `
        <div class="field">
          <label>${L('服务商预设', 'Provider preset')}</label>
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
          <label>${L('模型', 'Model')}</label>
          <input type="text" data-k="model" value="${escapeHtml(cfg.model)}" placeholder="${L('任意模型名，例如 deepseek-v4.1-flash', 'Any model name, e.g. deepseek-v4.1-flash')}" list="jm-model-list" autocomplete="off" />
          <datalist id="jm-model-list">
            ${modelSuggestions().map((m) => `<option value="${escapeHtml(m)}"></option>`).join('')}
          </datalist>
          <div class="hint" style="margin:4px 0 0">${L('模型名是自由文本，下拉只是常见名字的建议；服务端报「supported model names」时按它给的填。', 'The model name is free text; the dropdown only suggests common names. If the server lists "supported model names", use one of those.')}</div>
        </div>
        <label class="check"><input type="checkbox" data-k="stream" ${cfg.stream ? 'checked' : ''}/> ${L('对话流式输出', 'Stream chat replies')}</label>
        <label class="check"><input type="checkbox" data-k="batchSolve" ${cfg.batchSolve !== false ? 'checked' : ''}/> ${L('批量答题（一次请求答完整页，省 token）', 'Batch answers (one request per page, fewer tokens)')}</label>
        <label class="check"><input type="checkbox" data-k="hidePanel" ${cfg.hidePanel ? 'checked' : ''}/> ${L('隐藏悬浮窗（只用 Alt+J 唤出）', 'Hide panel (Alt+J only)')}</label>
        <label class="check"><input type="checkbox" data-k="anim" ${cfg.anim !== false ? 'checked' : ''}/> ${L('界面动画（关闭后所有过渡停用）', 'UI animations (turn off for instant switches)')}</label>
        <label class="check"><input type="checkbox" data-k="humanType" ${cfg.humanType !== false ? 'checked' : ''}/> ${L('代码题拟人写入（逐字敲、随机节奏、偶发退格）', 'Human-like code typing (char by char, random pace)')}</label>
        <div class="field range-field ${cfg.humanType === false ? 'disabled' : ''}" data-ref="wpm-field">
          <label>${L('平均打字速度', 'Average typing speed')} <span class="wpm-val" data-ref="wpm-val">${Number(cfg.typingWpm) || 75}</span> WPM</label>
          <input type="range" min="15" max="120" step="5" data-k="typingWpm" value="${Number(cfg.typingWpm) || 75}" />
          <div class="hint" style="margin:2px 0 0">${L('15 = 很慢（边想边敲），120 = 很快；平均速度会贴近这个值。', '15 = very slow, 120 = very fast; the average pace tracks this value.')}</div>
        </div>
        <div class="field">
          <label>${L('代码写入后等待（秒）', 'Wait after writing code (seconds)')}</label>
          <input type="number" step="1" min="3" max="10" data-k="codeWaitSec" value="${Number(cfg.codeWaitSec) || 5}" />
          <div class="hint" style="margin:4px 0 0">${L('代码写进编辑器后，等这么久再点提交（3~10 秒）。用于防止程序还没同步就提交，导致站点弹提示框。', 'After the code is written into the editor, wait this long before submitting (3–10 s). It keeps the site from popping up a warning because the program had not synced yet.')}</div>
        </div>

        <details class="adv">
          <summary>${L('高级设置', 'Advanced')}</summary>
          <div class="adv-body">
            <label class="check"><input type="checkbox" data-k="jsonMode" ${cfg.jsonMode ? 'checked' : ''}/> ${L('JSON 输出模式（更稳的答案解析）', 'JSON output mode (more reliable parsing)')}</label>
            <label class="check"><input type="checkbox" data-k="debug" ${cfg.debug ? 'checked' : ''}/> ${L('控制台调试日志', 'Console debug logs')}</label>
            <label class="check"><input type="checkbox" data-k="explain" ${cfg.explain ? 'checked' : ''}/> ${L('生成解析（更耗 token）', 'Generate explanations (costs more tokens)')}</label>
            <label class="check"><input type="checkbox" data-k="outputLangCustom" ${cfg.outputLangCustom ? 'checked' : ''}/> ${L('独立设置大模型输出语言', 'Set model output language separately')}</label>
            <div class="field check sub ${cfg.outputLangCustom ? '' : 'disabled'}" data-ref="outlang-field">
              <label>${L('大模型输出语言', 'Model output language')}</label>
              <select data-k="outputLang" ${cfg.outputLangCustom ? '' : 'disabled'}>
                <option value="zh" ${outLang === 'zh' ? 'selected' : ''}>${L('中文', 'Chinese')}</option>
                <option value="en" ${outLang === 'en' ? 'selected' : ''}>${L('English', 'English')}</option>
              </select>
              <div class="hint" style="margin:4px 0 0">${L('不勾选时，模型输出跟随界面语言（右上角开关）。', 'When unchecked, model output follows the UI language (top-right switch).')}</div>
            </div>
            <div class="field">
              <label>${L('解释语言（答案里的「为什么」）', 'Explanation language (the "why")')}</label>
              <select data-k="language">
                <option value="zh" ${cfg.language === 'en' ? '' : 'selected'}>${L('中文', 'Chinese')}</option>
                <option value="en" ${cfg.language === 'en' ? 'selected' : ''}>English</option>
              </select>
            </div>
            <div class="grid2">
              <div class="field">
                <label>${L('温度', 'Temperature')}</label>
                <input type="number" step="0.1" min="0" max="2" data-k="temperature" value="${cfg.temperature}" />
              </div>
              <div class="field">
                <label>${L('答案生成最大 tokens', 'Max tokens (answers)')}</label>
                <input type="number" step="128" min="256" max="32768" data-k="maxTokens" value="${cfg.maxTokens}" />
              </div>
            </div>
            <div class="field">
              <label>${L('页面总结最大 tokens', 'Max tokens (page summary)')}</label>
              <input type="number" step="256" min="512" max="32768" data-k="summaryTokens" value="${cfg.summaryTokens}" />
              <div class="hint" style="margin:4px 0 0">${L('总结一整页要写 300~500 字，默认 4096；对话回复也用这个值。', 'A page summary runs 300–500 characters, so 4096 by default; chat replies use the same value.')}</div>
            </div>
            <div class="field">
              <label>${L('上下文长度（字）', 'Context length (chars)')}</label>
              <input type="number" step="500" min="1000" max="30000" data-k="contextChars" value="${cfg.contextChars}" />
            </div>
            <div class="field">
              <label>${L('补充提示词（可选）', 'Extra prompt (optional)')}</label>
              <textarea data-k="systemPrompt" placeholder="${L('例如：回答尽量简短；代码用 Python 3。', 'e.g. keep answers short; code in Python 3.')}">${escapeHtml(cfg.systemPrompt)}</textarea>
            </div>
          </div>
        </details>

        <div class="sep"></div>
        <div class="row">
          <button class="btn primary" data-act="save">${L('保存', 'Save')}</button>
          <button class="btn" data-act="test">${L('测试连接', 'Test connection')}</button>
          <button class="btn danger" data-act="reset">${L('恢复默认', 'Reset')}</button>
        </div>
        <div class="hint">v${VERSION} · ${L('配置只存在本地（Tampermonkey 存储）。请求经 GM 通道发出，不受页面 CORS 限制。', 'Config stays local (Tampermonkey storage). Requests go through the GM channel, so page CORS does not apply.')}</div>
      `;

      // 「独立设置输出语言」联动：不勾选时下拉禁用并显示跟随值
      const custom = box.querySelector('[data-k="outputLangCustom"]');
      const sel = box.querySelector('[data-k="outputLang"]');
      const field = box.querySelector('[data-ref="outlang-field"]');
      const wpmRange = box.querySelector('[data-k="typingWpm"]');
      const wpmVal = box.querySelector('[data-ref="wpm-val"]');
      if (wpmRange) {
        wpmRange.addEventListener('input', () => {
          if (wpmVal) wpmVal.textContent = wpmRange.value;
        });
      }
      const humanCheck = box.querySelector('[data-k="humanType"]');
      const wpmField = box.querySelector('[data-ref="wpm-field"]');
      if (humanCheck && wpmField) {
        humanCheck.addEventListener('change', () => {
          wpmField.classList.toggle('disabled', !humanCheck.checked);
          if (wpmRange) wpmRange.disabled = !humanCheck.checked;
        });
      }
      custom.addEventListener('change', () => {
        sel.disabled = !custom.checked;
        if (field) field.classList.toggle('disabled', !custom.checked);
        if (!custom.checked) sel.value = Store.get('uiLang');
      });
      const presetSel = box.querySelector('[data-k="preset"]');
      const modelInput = box.querySelector('[data-k="model"]');
      const guessPreset = Object.keys(PRESETS).find((k) => PRESETS[k].baseUrl && PRESETS[k].baseUrl === cfg.baseUrl) || 'custom';
      presetSel.value = guessPreset;
      let prevPreset = guessPreset;
      modelInput.addEventListener('input', () => {
        modelInput.dataset.edited = '1';
      });
      this.renderModelDatalist(guessPreset);
      presetSel.addEventListener('change', () => {
        const p = PRESETS[presetSel.value];
        const prev = PRESETS[prevPreset];
        this.renderModelDatalist(presetSel.value);
        if (p && p.baseUrl) {
          box.querySelector('[data-k="baseUrl"]').value = p.baseUrl;
          // 只有模型框没被手动改过（或还是上一个预设的默认值）才覆盖，避免冲掉用户填的模型名
          const untouched = !modelInput.dataset.edited || !modelInput.value.trim() || modelInput.value === (prev && prev.model);
          if (p.model && untouched) modelInput.value = p.model;
          else if (p.model && p.model !== modelInput.value) this.toast(L('保留了你的模型名：', 'Kept your model name: ') + modelInput.value);
        }
        prevPreset = presetSel.value;
      });

      box.querySelector('[data-act="save"]').addEventListener('click', () => this.saveSettings());
      box.querySelector('[data-act="test"]').addEventListener('click', () => Actions.testConnection());
      box.querySelector('[data-act="reset"]').addEventListener('click', () => {
        Store.reset();
        this.renderSettings();
        this.updateSub();
        this.toast(L('已恢复默认配置', 'Defaults restored'));
      });
    },

    /** 模型建议按当前服务商刷新（只是建议，不影响手动输入） */
    renderModelDatalist(presetKey) {
      const dl = this.refs.cfg && this.refs.cfg.querySelector('#jm-model-list');
      if (!dl) return;
      dl.innerHTML = modelSuggestions(presetKey)
        .map((m) => '<option value="' + escapeHtml(m) + '"></option>')
        .join('');
    },

    saveSettings() {
      const box = this.refs.cfg;
      const read = (k) => {
        const el = box.querySelector('[data-k="' + k + '"]');
        if (!el) return undefined;
        return el.type === 'checkbox' ? el.checked : el.value;
      };
      // 只写页面上真实存在的字段：被暂时隐藏的开关（autoSubmit / autoRun）保持原值
      const patch = {};
      const put = (k, v) => {
        if (v !== undefined) patch[k] = v;
      };
      put('baseUrl', String(read('baseUrl') || '').trim());
      put('apiKey', String(read('apiKey') || '').trim());
      put('model', String(read('model') || '').trim());
      put('temperature', Number(read('temperature')) || 0);
      put('maxTokens', Number(read('maxTokens')) || 2048);
      put('summaryTokens', Number(read('summaryTokens')) || 4096);
      put('codeWaitSec', Math.max(3, Math.min(10, Number(read('codeWaitSec')) || 5)));
      put('contextChars', Number(read('contextChars')) || 6000);
      put('language', read('language'));
      put('outputLangCustom', read('outputLangCustom'));
      put('outputLang', read('outputLang') || Store.get('uiLang'));
      put('jsonMode', read('jsonMode'));
      put('stream', read('stream'));
      put('hidePanel', read('hidePanel'));
      put('anim', read('anim'));
      put('humanType', read('humanType'));
      put('batchSolve', read('batchSolve'));
      put('typingWpm', Number(read('typingWpm')) || 75);
      put('debug', read('debug'));
      put('explain', read('explain'));
      put('systemPrompt', read('systemPrompt'));
      Store.set(patch);
      this.applyAnim();
      this.updateSub();
      this.toast(L('已保存', 'Saved'));
      this.status(L('配置已保存', 'Settings saved'));
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

    /**
     * 生成答案。
     * @param {Array} [only] 只生成这些题的答案（已提交过的题不用白花 token）
     */
    async solveAll(only) {
      if (App.busy) return;
      const scan = App.scan;
      if (!scan || !scan.questions.length) {
        UI.toast(L('先扫描页面', 'Scan the page first'));
        return;
      }
      if (!this.ensureKey()) return;

      const qs = only || scan.questions;
      if (!qs.length) {
        UI.toast(L('没有需要生成答案的题', 'No question needs an answer'));
        return;
      }
      if (Store.get('batchSolve') !== false && qs.length > 1) {
        try {
          await this.solveAllBatch(scan, qs);
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
    async solveAllBatch(scan, only) {
      const qs = only || scan.questions;
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
        //    只给「还没提交过」的题生成答案 —— 已经交过的题不白花 token
        await this.solveAll(openQs);
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
