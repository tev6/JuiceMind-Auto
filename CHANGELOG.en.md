# Changelog

The full version history. The README only keeps the most recent versions; new ones move here.

## 1.13.0

- **Already-submitted pages are now skipped instead of failing.**
  Once a question is handed in, the site moves it to `Needs grading` or `Graded`, and
  *Submit Answer* stays **disabled** for good (`disabled` comes from the page's `canSubmit`).
  The script used to wait for the button to unlock and end with "the submit button stayed disabled",
  which looks like a bug but simply means there was nothing left to submit.
  It now recognises the state first:
  - the question's own submit bar shows `Review pending` / `View grade` / `Unsubmit` → that question is in;
  - the progress panel badge says `Needs grading` / `Graded` and the question's button is inert → same.
  When it recognises it, it **fills nothing and never touches the button** — it just says
  "this one was already submitted" and marks the card "already submitted — skipped".
- If the whole page is already in, the model is not even called (no wasted tokens): the script says
  "this page was already submitted — nothing to submit".
- "Fill all" also skips questions that are already in, so their stored answers are left alone.

## 1.12.3

- **Fixes the two errors that broke answering**: *Submit button is still disabled* and *The model did not return parseable JSON*.
  - Before submitting, the script no longer looks at the button once: it waits until the page really accepts the answer (in the site, an enabled button means `selectedChoices` is non-empty — the only signal the page gives). If the page missed the first click, the option is clicked again.
  - Selecting an option no longer falls back to "assign `.checked` and dispatch events" — that also rewrites React's internal value tracker, so the next real click is discarded as "value unchanged" and the site state never changes. It now performs a real click and verifies the result.
  - The submit button is looked up again every time, so a node React has already replaced is never reused.
- **Output budget raised**: `max_tokens` for a multiple-choice question goes from 120 to 1024 (`max_tokens` is only a ceiling — a bigger one does not make the model write more). Reasoning models used to spend the whole budget thinking, leaving the answer empty, which is exactly what produced "did not return parseable JSON".
- A failed parse now retries once with a bigger budget; JSON cut off mid-way is repaired; a top-level array is accepted.
- Errors now say what actually happened: empty content, output truncated by `max_tokens`, or simply not JSON.
- Fixed the model-parameter fallback chain: when dropping `response_format` failed a second time, the reasoning-model fallback was unreachable.

## 1.9.1

- Human-like typing gained an "average typing speed" slider (15–120 WPM).
- The expand button on an answer card now makes the whole top area clickable (including Enter/Space).

## 1.9.0

- **New "human-like typing" for code questions** — it types into the editor character by character (random pace, pauses at line ends, other human-ish details), so the collaboration stream shows many small increments instead of one big replacement; can be turned off in settings.

## 1.8.1

- Fixed the double-layered tab highlight (the active tab's own background is gone).
- Fixed the fake slide-in animation of the tab bar when switching languages.

## 1.8.0

- Added animations and a toggle for them in settings.
- JSON output mode and console logs moved into advanced settings.
- Adjusted the scrollbar position.

## 1.7.1

- Fixed the text/slider misalignment on the language switch.
- Fixed the summary still mixing in Chinese in English mode; answers follow the output language, explanations follow the explanation language.

## 1.7.0

- Added the Chinese/English switch.
- Removed the stray "–" button.
- Restructured settings with an "Advanced" section.
- The summary tab now streams.

## 1.6.0

- Added the "Summary" tab.
- `⌥J` works on Mac.
- The round button can be dragged when collapsed.
- The title bar switched to a vector icon.

## 1.5.0

- **Automatic updates for students**.
- Automatic retry on failed requests.
- Token usage and a "Stop" button in the footer.
- Added `scripts/build.mjs` with CI checking the bundle against src.

## 1.4.0

- Streaming chat replies and a draggable panel.
- Added a "hide panel" setting.
- Added an English README.

## 1.3.0

- **Markdown rendering in chat**.
- One-click copy for chat code blocks and answer cards.
- Scan results can be expanded.
- More provider models.

## 1.2.0

- Fixed model-name detection.

## 1.1.0

- Fixed the coding exercise page not being scanned.

## 1.0.0

- **First release**.
