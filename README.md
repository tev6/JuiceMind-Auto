[中文](README.zh-CN.md) | English

# JuiceMind AI Answering Assistant

A Tampermonkey script for [play.juicemind.com](https://play.juicemind.com): it finds the questions on the page, calls a large language model API to generate answers, then fills them back in and submits everything automatically.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser (Chrome / Edge / Firefox).
2. Click the link below. Tampermonkey opens an install page — press "Install":

   **https://raw.githubusercontent.com/tev6/JuiceMind-Auto/main/juicemind-ai-assistant.user.js**

3. Open any JuiceMind lesson page. The panel shows up on the right side. If you don't see it, press `Alt + J`.

> The script only runs on the app domains `play.juicemind.com` and `classes.juicemind.com`. The marketing site `juicemind.com` has nothing but an intro page, so no panel is injected there.

## Configure (about 30 seconds)

Open "Settings" in the panel:

| What to fill in | Example |
| --- | --- |
| API Base URL | `https://api.deepseek.com/v1` (or pick a "Provider preset" and it fills itself) |
| API Key | `sk-...` (your own key) |
| Model | e.g. `deepseek-flash` |

Click "Save", then "Test connection". Once it says success, you're good.

> Any OpenAI-compatible API works: OpenAI / DeepSeek / Moonshot / OpenRouter / local Ollama.

## Usage

| Scenario | How |
| --- | --- |
| **Complete the whole page** | Click **"Complete this page"**: detect → generate → fill in → submit, the same flow for every question |
| Solve many questions | `Scan page` → `Generate all` → `Fill all` |
| Solve one question | `Scan page` → on that question's card click `Generate` → `Fill` |
| Tutorial-only page | Switch to "Summary" for quick-study notes in one click, or ask about a concept in "Chat" |

**Complete this page** (since v1.12.0): the full-width button at the top of the quiz page. For every question it does four things — fill in the answer, click submit, wait for the result, close the popup.
**Note**: the AI you call can be wrong too. Answers can't be changed after submission, but the script still tells you when one comes back wrong.

A `submitted, incorrect` badge means the submission went through but the site marked the answer wrong.
A `submit failed` badge means it did not go through (no button found, the button was still disabled, an API error, and so on).

Generation still answers the whole page in one request; only filling in and submitting happen question by question.

Shortcuts: `Alt + J` (`⌥ J` on Mac) collapse/expand · `Alt + Enter` generate all · `Alt + Shift + S` scan.

**One switch for Chinese and English**: the `中 / EN` toggle in the title bar switches the whole plugin (UI text + model output language) at once, so you don't have to change settings item by item.

**Summary**: switch to the "Summary" tab and click "Summarize page". The notes show up while they are generated (streaming), condensing this lesson into quick-study notes — one-line summary, key points, glossary, pitfalls, ready to copy.

If the scan is collapsed, click the area above it to expand and see the full question, every option, and the complete answer.

The footer shows the token usage of this session. While a request is running, click "Stop" on the right of the footer to interrupt it; whatever was already generated stays.

The panel can be dragged: drag the title bar or the bottom edge to move it, and when collapsed it becomes a round button you can also drag.

Supported question types: multiple choice / multi-select / short answer / essay / fill-in-blank, plus CodeMirror coding exercises and the embedded IDE.

**Advanced settings**: a collapsed section at the bottom of the settings page — temperature, max tokens, context length, extra prompt, explanation language, and "Set model output language separately". Unchecked by default, the model output follows the language switch in the top right; check it to pick the output language on its own.

## FAQ

**No panel appears** — the script isn't enabled, or you're not on `play.juicemind.com` / `classes.juicemind.com`. Refresh and press `Alt + J`.

**401 / 403** — the key or the Base URL is wrong.

**`HTTP 400 ... supported API model names are ...`** — the model name you typed isn't one this API knows.

**Nothing gets scanned** — wait for the page to finish loading, then scan.

## Want to modify the script?

- `src/part1..6.js` are the source shards; merged together they become `juicemind-ai-assistant.user.js`
- How the script picks elements and how it writes into the editor: see [notes/site-analysis.md](notes/site-analysis.md)
- After editing `src/`, run `node scripts/build.mjs` to rebuild the bundle; CI checks that the two match
- Students update automatically: the script header carries `@updateURL`, and Tampermonkey pulls the new version whenever the version number changes
- Local tests: `npm i` → `npm test` (154 jsdom cases), `npm run test:ui` (drag / hide / streaming / one-click flow — needs a local Chrome)
- Real-page acceptance and screenshots: put the item IDs into `test/items.local.json` (template: `test/items.example.json`; that file is not committed), then run `node test/real.js` / `node test/shots-real.js`

## Contributing

The author tested this script on the APCSP course inside JuiceMind, and has not verified it against other JuiceMind courses. So the author cannot promise it runs the same way on every course.

Pull requests and issues are welcome — to add support for other courses, report a problem, or suggest an improvement.

## Changelog

- **1.12.0** — **new "Complete this page"** — detect → generate → fill in → submit, looping over every question
- **1.11.1** — small maintenance pass, minor fixes
- **1.11.0** — batch answering: one request answers the whole page (no auto-submit yet); the prompt kept shrinking (500→240 tokens). On a 5-question page the input dropped from 1966 to 587 tokens (−70%).
- **1.10.0** — **token savings**: the context is trimmed per question, parsing is off by default, max tokens follow the question type. Measured roughly −90% per multiple-choice question and −55% per short answer.
- **1.9.1** — human-like typing gained an "average typing speed" slider; the expand button on an answer card now makes the whole top area clickable.
- **1.9.0** — **new "human-like typing" for code questions** — it types into the editor character by character (random pace, pauses at line ends, other human-ish details), so the collaboration stream shows many small increments instead of one big replacement; can be turned off in settings.
- **1.8.1** — fixed the double-layered tab highlight and the fake slide-in animation when switching languages.
- **1.8.0** — added animations and a toggle for them in settings. JSON output mode and console logs moved into advanced settings. Adjusted the scrollbar position.
- **1.7.1** — fixed the text/slider misalignment on the language switch and the summary still mixing in Chinese in English mode; answers follow the output language, explanations follow the explanation language.
- **1.7.0** — added the Chinese/English switch, removed the stray "–" button, restructured settings with an "Advanced" section, and made the summary stream.
- **1.6.0** — added the "Summary" tab, `⌥J` on Mac, a draggable round button when collapsed, and a vector icon in the title bar.
- **1.5.0** — **automatic updates for students**, automatic retry on failed requests, token usage and a "Stop" button in the footer, plus `scripts/build.mjs` with CI checking the bundle against src.
- **1.4.0** — streaming chat replies, a draggable panel, a "hide panel" setting, and an English README.
- **1.3.0** — **Markdown rendering in chat**, one-click copy for chat code blocks and answer cards, expandable scan results, and more provider models.
- **1.2.0** — fixed model-name detection
- **1.1.0** — fixed the coding exercise page not being scanned
- **1.0.0** — **first release**.

## Disclaimer

For study and discussion only. Please follow your school's academic integrity rules.
