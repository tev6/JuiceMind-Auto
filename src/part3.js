
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
