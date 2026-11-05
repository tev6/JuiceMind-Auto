[中文](README.zh-CN.md) | English

# JuiceMind AI Answering Assistant

A Tampermonkey script for [play.juicemind.com](https://play.juicemind.com): it finds the questions on the page, calls a large language model API to generate answers, then fills them back in and submits everything automatically.

[![CI](https://github.com/tev6/JuiceMind-Auto/actions/workflows/ci.yml/badge.svg)](https://github.com/tev6/JuiceMind-Auto/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.12.1-blue)](https://github.com/tev6/JuiceMind-Auto/commits/main)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![The panel: questions scanned and answers generated](docs/img/panel-en.png)

## Contents

- [Features](#features)
- [Install](#install)
- [Configure](#configure)
- [Usage](#usage)
- [FAQ](#faq)
- [Development](#development)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License and Disclaimer](#license-and-disclaimer)

## Features

| Feature | What it does |
| --- | --- |
| **Complete the whole page** | detect → generate → fill in → submit, the same flow for every question |
| **Batch answers** | one request answers the whole page — 70% less input token on a 5-question page |
| **Token savings** | context trimmed per question, parsing off by default, max tokens follow the question type |
| **Human-like typing** | code questions are typed into the editor character by character, with a random pace and pauses — not one big replacement |
| **Quick-study notes** | a tutorial page condenses into notes: one-line summary, key points, glossary, pitfalls, self-check |
| **Chat** | Markdown rendering, streaming replies, one-click copy of code blocks |
| **Chinese / English switch** | one toggle in the title bar switches the UI text and the model output language together |
| **Question types** | multiple choice / multi-select / short answer / essay / fill-in-blank, plus CodeMirror coding exercises and the embedded IDE |
| **Floating panel** | drag it around, collapse it into a round button, and watch the session token usage in the footer |

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser (Chrome / Edge / Firefox).
2. Click the link below. Tampermonkey opens an install page — press "Install":

   **https://raw.githubusercontent.com/tev6/JuiceMind-Auto/main/juicemind-ai-assistant.user.js**

3. Open any JuiceMind lesson page. The panel shows up on the right side. If you don't see it, press `Alt + J`.

> The script only runs on the app domains `play.juicemind.com` and `classes.juicemind.com`. The marketing site `juicemind.com` has nothing but an intro page, so no panel is injected there.

## Configure

Open "Settings" in the panel:

| What to fill in | Example |
| --- | --- |
| API Base URL | `https://api.deepseek.com/v1` (or pick a "Provider preset" and it fills itself) |
| API Key | `sk-...` (your own key) |
| Model | e.g. `deepseek-flash` |

Click "Save", then "Test connection". Once it says success, you're good.

> Any OpenAI-compatible API works: OpenAI / DeepSeek / Moonshot / OpenRouter / xAI / Gemini / local Ollama.

**Tampermonkey pops up a dialog when you test the connection?** It normally shouldn't — the script already declares its cross-origin permission. If it does, your Tampermonkey is set to strict mode, or you're running an old copy of the script: click **Always allow domain** to allow just that one API domain, or **Always allow** to stop seeing it.

**Advanced settings** live in a collapsed section at the bottom of the settings page — temperature, max tokens, context length, extra prompt, explanation language, and "Set model output language separately". Unchecked by default, the model output follows the language switch in the top right; check it to pick the output language on its own.

## Usage

| Scenario | How |
| --- | --- |
| **Complete the whole page** | Click **"Complete this page"** |
| Solve many questions | `Scan page` → `Generate all` → `Fill all` |
| Solve one question | `Scan page` → on that question's card click `Generate` → `Fill` |
| Tutorial-only page | Switch to "Summary" for quick-study notes in one click, or ask about a concept in "Chat" |

**Complete this page** (since v1.12.0): the full-width button at the top of the quiz page. For every question it does four things — fill in the answer, click submit, wait for the result, close the popup.
**Note**: the AI you call can be wrong too. Answers can't be changed after submission, but the script still tells you when one comes back wrong.

A `submitted, incorrect` badge means the submission went through but the site marked the answer wrong.
A `submit failed` badge means it did not go through (no button found, the button was still disabled, an API error, and so on).

Generation still answers the whole page in one request; only filling in and submitting happen question by question.

### Shortcuts

| Keys | What it does |
| --- | --- |
| `Alt + J` (`⌥ J` on Mac) | collapse / expand the panel |
| `Alt + Enter` | generate all |
| `Alt + Shift + S` | scan the page |

### Panel details

If the scan is collapsed, click the area above it to expand and see the full question, every option, and the complete answer

The footer shows the token usage of this session. While a request is running, click "Stop" on the right of the footer to interrupt it; whatever was already generated stays.

The panel can be dragged: drag the title bar or the bottom edge to move it, and when collapsed it becomes a round button you can also drag.

## FAQ

**No panel appears** — the script isn't enabled, or you're not on `play.juicemind.com` / `classes.juicemind.com`. Refresh and press `Alt + J`.

**401 / 403** — the key or the Base URL is wrong.

**`HTTP 400 ... supported API model names are ...`** — the model name you typed isn't one this API knows.

**Nothing gets scanned** — wait for the page to finish loading, then scan.

**Tampermonkey asks to allow a cross-origin resource** — click `Always allow domain` for that one API domain, see "Configure".

**Answers can't be changed after submission** — that's how the site works. `submitted, incorrect` means it went through but the answer was wrong; all you can do is know the result.

## Development

- `src/part1..6.js` are the source shards; merged together they become `juicemind-ai-assistant.user.js`
- How the script picks elements and how it writes into the editor: see [notes/site-analysis.md](notes/site-analysis.md)
- After editing `src/`, run `node scripts/build.mjs` to rebuild the bundle; CI checks that the two match
- Students update automatically: the script header carries `@updateURL`, and Tampermonkey pulls the new version whenever the version number changes
- Local tests: `npm i` → `npm test` (154 jsdom cases), `npm run test:ui` (drag / hide / streaming / one-click flow — needs a local Chrome)
- README images: `npm run shots` renders them from a local mock page, so they carry no personal data
- Real-page acceptance and screenshots: put the item IDs into `test/items.local.json` (template: `test/items.example.json`; that file is not committed), then run `node test/real.js` / `node test/shots-real.js`

## Contributing

The author tested this script on the APCSP course inside JuiceMind, and has not verified it against other JuiceMind courses. So the author cannot promise it runs the same way on every course.

Pull requests and issues are welcome — to add support for other courses, report a problem, or suggest an improvement.

## Changelog

The full history lives in [CHANGELOG.en.md](CHANGELOG.en.md).

- **1.12.1** — completed the `@connect` domain declarations, so Tampermonkey stops asking for cross-origin permission on known providers
- **1.12.0** — **new "Complete this page"** — detect → generate → fill in → submit, looping over every question
- **1.11.1** — small maintenance pass, minor fixes
- **1.11.0** — batch answering: one request answers the whole page (no auto-submit yet); the prompt kept shrinking (500→240 tokens). On a 5-question page the input dropped from 1966 to 587 tokens (−70%).
- **1.10.0** — **token savings**: the context is trimmed per question, parsing is off by default, max tokens follow the question type. Measured roughly −90% per multiple-choice question and −55% per short answer.

## License and Disclaimer

MIT License — see [LICENSE](LICENSE).

For study and discussion only. Please follow your school's academic integrity rules.
