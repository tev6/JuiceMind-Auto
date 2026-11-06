
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
