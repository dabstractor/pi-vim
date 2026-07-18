# spec: put (`p`/`P`) cursor location fix (2026-07-18)

## problem

After a put, the cursor lands wherever the underlying
readline editor left it after typing the register contents
(end of the last typed line for line-wise; one past the last
character for char-wise). Vim instead repositions the cursor
on the put text. Reported symptom: `yyp` leaves the cursor at
the **end** of the duplicated line instead of its **start**.

The inserted text is already correct in every case — only the
final cursor position is wrong.

## verified Vim/nvim reference behavior

Confirmed against the `nvim` oracle (`test/nvim-oracle.ts`,
NVIM v0.12.4):

### line-wise (register ends in `\n`)
- `p` — text inserted below the cursor line; cursor on the
  **first non-blank** of the **first** inserted line
  (`cursorLine + 1`).
- `P` — text inserted above the cursor line; cursor on the
  **first non-blank** of the **first** inserted line
  (`cursorLine`).
- Holds for `{count}p`/`{count}P` and multi-line registers:
  the target is always the *first* pasted line, not the last.

### char-wise (no trailing `\n`)
- single-line register — cursor on the **last inserted
  grapheme**.
- multi-line register (contains `\n`) — cursor on the
  **first inserted grapheme** (first line).
- Holds for `{count}` (repeats concatenate on one line).

## root cause

`putAfter()` / `putBefore()` in `index.ts` feed the register
through `super.handleInput(...)` keystrokes (`CTRL_E`,
`NEWLINE`, `ESC_RIGHT`, …) and never reposition the cursor
afterwards, so it inherits readline's end-of-typed-text
position.

## fix

Reposition the cursor after the existing keystroke insertion
(text mechanics unchanged):

1. **line-wise `p`** — capture `startLine` before the loop;
   after inserting, `moveCursorToLineStart(startLine + 1)` then
   `moveCursorToFirstNonWhitespace()`.
2. **line-wise `P`** — capture `startLine`; after inserting,
   `moveCursorToLineStart(startLine)` then
   `moveCursorToFirstNonWhitespace()`.
3. **char-wise** — capture `insertStartAbs =
   getAbsoluteIndexFromCursor()` right before the type loop
   (after the optional `ESC_RIGHT` for `p`) and `totalLen =
   text.length * safeCount`. After inserting, call a new
   helper:
   - multi-line register (`text.includes("\n")`) →
     `moveCursorToAbsoluteIndex(insertStartAbs)` (first
     inserted grapheme).
   - single-line register →
     `moveCursorToAbsoluteIndex(insertStartAbs + totalLen -
     lastGraphemeLen)` where `lastGraphemeLen` comes from
     `getLineGraphemes(text)` (grapheme-safe, count-safe).

All three reuse existing helpers (`moveCursorToLineStart`,
`moveCursorToFirstNonWhitespace`, `moveCursorToAbsoluteIndex`,
`getLineGraphemes`).

## intentional divergence (documented)

Line-wise put of a register whose **first line is all
whitespace**: Vim's `^` lands on the last char of an
all-whitespace line, but this extension's shared
`findFirstNonWhitespaceColumn()` (used by `^`, `I`, `_`, …)
returns `0`. Put therefore lands at col 0, **consistent with
the existing `^` divergence**. Fixing the shared helper is out
of scope (it would change `^`/`I`/`cc`); the divergence is
made explicit in tests and the README "known differences"
table.

## tests

### unit (`test/modal-editor.test.ts`)
- update the two existing char-wise cursor assertions that
  currently encode the bug:
  - `p` reads OS clipboard `"SYS"` on `"ab"`: col `4 → 3`
    (on the last `S`).
  - `P` reads OS clipboard `"SYS"` on `"ab"`: col `3 → 2`.
- add focused cases asserting cursor + text + mode + register:
  - `yyp` single line → cursor on first non-blank of the new
    line (start).
  - `yy` + `P` → cursor on first non-blank of inserted line.
  - `{count}p` / `{count}P` line-wise → first pasted line.
  - leading-whitespace register → first non-blank column.
  - char-wise `p`/`P` single-line → last inserted grapheme.
  - char-wise `p`/`P` multi-line register → first inserted
    grapheme.
  - char-wise count → last grapheme of the concatenated run.
  - grapheme-safe: char-wise `p` of an astral char (e.g.
    `"😀"`) lands on the grapheme start.
  - line-wise all-whitespace first line → col 0 (documents the
    documented divergence vs Vim's last-char).
- existing line-wise text assertions stay green (cursor moves,
  text unchanged).

### nvim parity (`test/nvim-parity-put-join.ts`)
- unskip the four `PUT_PARITY_CASES` (remove them from
  `KNOWN_NVIM_PUT_PARITY_GAPS`); they now pass.
- add curated line-wise cases (multi-line register, count,
  leading whitespace) and a char-wise multi-line case.
- add a skipped case marking the all-whitespace-first-line
  divergence.

## README
- "put / paste" section: note the cursor-placement semantics
  (first non-blank for line-wise; last inserted char for
  single-line char-wise; first inserted char for multi-line
  char-wise).
- "known differences from full Vim": add the all-whitespace
  first-line divergence row, tied to `^`.

## definition of done
- `npm run check` (lint + typecheck + full test) green.
- `npm run test:nvim` green with the four put cases unskipped.
- README + divergence documented.
