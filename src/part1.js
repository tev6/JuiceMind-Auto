// ==UserScript==
// @name         JuiceMind AI 答题助手
// @namespace    https://juicemind.com/
// @updateURL    https://raw.githubusercontent.com/tev6/JuiceMind-Auto/main/juicemind-ai-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/tev6/JuiceMind-Auto/main/juicemind-ai-assistant.user.js
// @supportURL   https://github.com/tev6/JuiceMind-Auto/issues
// @version      1.10.0
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

  const VERSION = '1.10.0';
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
