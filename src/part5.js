
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

/* 折叠 / 展开 */
.chev { margin-left: 2px; }
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
    b.textContent = label || '复制';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const ok = copyText(getText());
      const old = b.textContent;
      b.textContent = ok ? '已复制' : '复制失败';
      b.classList.toggle('ok', ok);
      setTimeout(() => {
        b.textContent = old;
        b.classList.remove('ok');
      }, 1200);
      if (ok && UI && UI.toast) UI.toast('已复制');
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
      bar.append(l, copyBtn(() => code, '复制代码'));
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
                <button class="btn ghost" data-ref="btn-expand" disabled>展开全部</button>
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
      r['btn-expand'].addEventListener('click', () => {
        const qs = (App.scan && App.scan.questions) || [];
        const allOn = qs.length > 0 && qs.every((q) => this.isExpanded(q));
        this.expandAll(!allOn);
      });

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
      this.syncExpandBtn();
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
      this.syncExpandBtn();
    },

    expandAll(on) {
      const qs = (App.scan && App.scan.questions) || [];
      qs.forEach((q) => {
        if (on) this._expanded.add(q.id);
        else this._expanded.delete(q.id);
      });
      this.renderQuestions();
    },

    syncExpandBtn() {
      const b = this.refs['btn-expand'];
      if (!b) return;
      const qs = (App.scan && App.scan.questions) || [];
      const allOn = qs.length > 0 && qs.every((q) => this.isExpanded(q));
      b.textContent = allOn ? '收起全部' : '展开全部';
      b.disabled = !qs.length;
    },

    renderQuestionCard(q, i) {
      const expanded = this.isExpanded(q);
      const card = document.createElement('div');
      card.className = 'q' + (q.status === 'done' ? ' done' : q.status === 'error' ? ' error' : '') + (expanded ? ' expanded' : '');
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

      // 展开 / 收起
      const chev = document.createElement('button');
      chev.className = 'icon chev';
      chev.type = 'button';
      chev.title = expanded ? '收起' : '展开';
      chev.textContent = expanded ? '▴' : '▾';
      chev.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleExpand(q, card, chev);
      });
      hd.appendChild(chev);

      const prompt = document.createElement('div');
      prompt.className = 'q-prompt';
      prompt.textContent = q.prompt || '（未识别到题干）';
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
        wrap.append(ans, copyBtn(() => (q.answer.answers || []).join('\n'), '复制答案'));
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
        hint.textContent = '可以直接提问，例如「解释这一页的教程」「这题为什么选 B」。发送时会自动附带当前页面内容。';
        log.appendChild(hint);
      }
      for (const m of App.chat) {
        const d = document.createElement('div');
        d.className = 'cmsg ' + (m.role === 'user' ? 'user' : m.role === 'assistant' ? 'ai' : 'sys');
        this.fillBubble(d, m.role, m.content);
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
