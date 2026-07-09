# manual QA test cases

Hand-run acceptance pass for the behavior this branch adds on top of the
released command surface. The automated suites (`npm test`,
`npm run test:nvim`) already pin the buffer-level semantics. This file exists
for what a headless harness cannot see: the real terminal, the real Pi
prompt, a real paste, a real autocomplete, and a real wrapping extension.

Run it top to bottom. Every case seeds its own buffer and ends with the same
reset.

## how to run

cwd: the repo checkout root (the directory holding `package.json`).

Launch Pi with only this extension loaded, so package notices, skills, and
other extensions cannot obscure the prompt:

```bash
pi --no-session --no-extensions --no-skills --no-prompt-templates \
  --no-themes --no-context-files -e ./index.ts
```

One session serves every case except the ones that ask for a fresh session.
Quit with `<Esc>` then `:q!`.

### notation

- `<Esc>`, `<Enter>`, `<Tab>`, `<C-r>`, `<Space>` are the named keys;
  everything else is the literal character. Spaces between keys separate
  them and are not keystrokes.
- `type "abc"` means enter those characters as text (you must already be in
  insert mode).
- **seed** builds the starting buffer, **keys** is the case under test,
  **expect** is what you should see, **reset** restores an empty prompt.

### seeding a multi-line prompt

`<Enter>` submits the Pi prompt, so never use it to add a line. Build extra
lines from normal mode with `o` (open below):

```text
i           type "abc def"    <Esc>     # line 1
o           type "ghi jkl"    <Esc>     # line 2
o           type "mno pqr"    <Esc>     # line 3
gg 0                                    # line 1, column 0
```

Cases below call this three-line buffer **the 3-line seed**.

### reset (cleanup)

Between cases, from any mode:

```text
<Esc> gg dG
```

The prompt is left empty, cursor on line 1 column 0.

`.` replays the most recent recorded change **in the session**. Reset clears
the buffer, not that memory, and seeding with `o` records a change of its
own. So a case whose expectation is "`.` does nothing" must start from a
freshly launched Pi, not from a reset. Cases A4, A5 and A6 say so
explicitly.

---

## group A — TTY-only (priority)

No unit or parity test can reach these: they need a terminal, Pi's own prompt
widgets, or a second extension in the process. Run this group first.

### A1 — footer mode label echoes pending commands

- seed: `i` type `"abc def"` `<Esc>` `gg 0`
- keys: press `2`, then `d`. Stop and read the footer.
- expect: the bottom-right footer reads ` NORMAL 2d_ `. Press `w` to
  complete the operator; the footer returns to ` NORMAL `.
- keys: press `r`, read the footer, then `<Esc>`.
- expect: ` NORMAL r_ ` while the replace waits for its character.
- keys: press `:`, read the footer, type `q`, read it again, then `<Esc>`.
- expect: ` EX _ ` then ` EX q_ `. `<Esc>` leaves EX without quitting.
- reset: `<Esc> gg dG`

### A2 — footer mode label truncates without splitting a grapheme

- seed: `i` type `"abc"` `<Esc>` `gg 0`
- keys: resize the terminal to roughly 20 columns, press `2` `d`, read the
  footer. Shrink to roughly 10 columns and read it again. Press `<Esc>`.
- expect: the ` NORMAL ` keyword always survives. Once the full label
  overflows, an ellipsis `…` follows the keyword and as much of the pending
  command tail as fits is kept; at the narrowest widths the label degrades to
  ` NORMAL …`. No half-rendered character ever appears.
- keys: reset, seed `i` type `"日本語"` `<Esc>`, and narrow the terminal
  again.
- expect: the prompt text is truncated at a character boundary — a wide
  character is dropped whole, never sliced.
- reset: `<Esc> gg dG`, restore the terminal width.

### A3 — cursor shape follows the mode

- seed: `i` type `"abc"` `<Esc>`
- keys: press `i`, then `<Esc>`, then `i` again. Then quit: `<Esc> :q!`
- expect: the terminal cursor is a block in normal mode and a bar in insert
  mode. Exactly one cursor is visible at a time — the reverse-video software
  cursor must not double up with the terminal's own cursor. After `:q!` the
  shell cursor is visible again and back to its usual shape.
- notes: needs a terminal with DECSCUSR support. Without it the software
  cursor stays and the shape never changes; that is the documented fallback,
  not a failure. Relaunch Pi to continue.

### A4 — a real paste cancels a pending operator

- fresh session.
- seed: copy `HELLO` to the system clipboard, then `i` type `"abc def"`
  `<Esc>` `gg 0`
- keys: press `d` (footer shows ` NORMAL d_ `), then paste with the
  terminal's paste shortcut. Then press `.`.
- expect: the paste is never consumed as a motion. The pending `d` is
  cancelled, `HELLO` is not inserted, the buffer still reads `abc def`, and
  `.` does nothing — a cancelled operator is not recorded as repeatable.
- notes: repeat with a pending `r` instead of `d`; same outcome.
- reset: `<Esc> gg dG`

### A5 — accepting an autocomplete suggestion cancels the insert recording

- fresh session.
- keys: press `<Esc>` then `i`, type `/hel`, press `<Tab>` to accept the
  suggestion, press `<Esc>`, then press `.`.
- expect: `<Tab>` completes to `/help `. Pressing `.` then changes nothing —
  the completion is a host-side text change, so the in-flight insert
  recording is discarded rather than replayed.
- notes: needs Pi's live autocomplete; the suggestion list is what makes this
  TTY-only.
- reset: `<Esc> gg dG`

### A6 — submitting is not a repeatable command

- fresh session.
- keys: press `<Esc>` then `i`, type `hi`, press `<Enter>`.
- expect: `hi` is submitted to Pi, the prompt is empty, and the editor is
  still in insert mode.
- keys: type `ok`, press `<Esc>`, then press `.`.
- expect: the buffer reads `ok` and stays `ok`. `.` is a no-op: the submit
  cancelled the insert recording, so there is no recorded change to replay,
  and nothing is submitted a second time.
- reset: `<Esc> gg dG`

### A7 — a wrapping extension's text injection cancels the recording

- own session, launched from the repo checkout root:

  ```bash
  pi --no-session --no-extensions --no-skills --no-prompt-templates \
    --no-themes --no-context-files \
    -e ./index.ts -e ../pi-image-attachments/index.ts
  ```

  `pi-vim` must load first; see the wrapping section of `README.md`.
- seed: `i` type `"alpha beta"` `<Esc>` `gg 0`
- keys: press `c` `w` (insert mode, `alpha` gone), then paste or drag an
  image path so the wrapper injects its `[Image #1] ` placeholder. Press
  `<Esc>`, then `w`, then `.`.
- expect: the placeholder appears. `.` changes nothing — the host injected
  text mid-change, so the recording is dropped rather than replaying a change
  pi-vim did not author.
- reset: `<Esc> gg dG`, then quit and relaunch the single-extension session.

---

## group B — put cursor position

Parity-tested against nvim, but cursor placement is what a user feels rather
than what a buffer assertion shows. Check it by eye.

### B1 — `p` leaves the cursor on the last pasted character

- seed: `i` type `"XYabc"` `<Esc>` `gg 0` `2 x` — the buffer is now `abc`,
  the register holds `XY`, and the cursor is on `a`.
- keys: `p`
- expect: buffer `aXYbc`, cursor on the `Y` — the last pasted character, not
  the `b` after it.
- reset: `<Esc> gg dG`

### B2 — `P` leaves the cursor on the last pasted character

- seed: as B1, then `l` (cursor on `b`).
- keys: `P`
- expect: buffer `aXYbc`, cursor on the `Y`.
- reset: `<Esc> gg dG`

### B3 — `p` lands on a multi-codepoint grapheme, not inside it

- seed: `i` type `"😀abc"` `<Esc>` `gg 0` `x` — buffer `abc`, register holds
  the emoji.
- keys: `p`
- expect: buffer `a😀bc`. The cursor block covers the whole emoji and the
  emoji renders unbroken.
- reset: `<Esc> gg dG`

---

## group C — counted line-end operators

### C1 — `2d$` deletes charwise through the next line end

- seed: the 3-line seed, then `l l l l` (cursor on the `d` of `def`).
- keys: `2 d $`
- expect: two lines remain, `abc ` and `mno pqr`, cursor on the trailing
  space of line 1. The deleted text is charwise (no trailing newline), so a
  following `p` pastes `def` / `ghi jkl` back inline.
- reset: `<Esc> gg dG`

### C2 — `2d$` from column zero deletes whole lines

- seed: the 3-line seed (cursor at column 0).
- keys: `2 d $`
- expect: only `mno pqr` remains. At or before the first non-blank column a
  counted `d$` is linewise, so a following `p` pastes the two lines back
  below the current line.
- reset: `<Esc> gg dG`

### C3 — `2c$` is never linewise

- seed: the 3-line seed (cursor at column 0).
- keys: `2 c $`, type `Z`, `<Esc>`
- expect: two lines, `Z` and `mno pqr`. Unlike `d$`, a counted `c$` from
  column 0 stays charwise: the text is replaced in place, the lines are not
  removed.
- reset: `<Esc> gg dG`

### C4 — an overflowing count clamps; a count on the last line aborts

- seed: the 3-line seed, then `l l l l` (cursor on the `d` of `def`).
- keys: `5 d $`
- expect: only `abc ` remains — the count clamps to the last line.
- keys: reset, seed again, then `G 0 l l` (cursor on the last line), then
  `2 d $`
- expect: nothing happens. With two or more lines requested and no line
  below, the operator aborts as a no-op.
- reset: `<Esc> gg dG`

### C5 — `d0`, `d^`, `c0`, `c^` consume a count and ignore it

- seed: `i` type `"abc def"` `<Esc>` `gg 0` `l l l l` (cursor on `d`).
- keys: `2 d 0`
- expect: buffer `def`, cursor on `d`. The `2` is swallowed; the delete back
  to column 0 still runs exactly once.
- keys: reset, seed `i` type `"   abc def"` (three leading spaces) `<Esc>`
  `gg 0`, move the cursor onto the `d` of `def`, then `2 d ^`
- expect: buffer `   def`, cursor on `d` — deleted back to the first
  non-blank, count ignored.
- notes: `2 c 0` and `2 c ^` behave the same and leave you in insert mode.
- reset: `<Esc> gg dG`

---

## group D — dot repeat

### D1 — `.` repeats the last change

- seed: `i` type `"abcdef"` `<Esc>` `gg 0`
- keys: `x .`
- expect: buffer `cdef`. Each further `.` deletes one more character.
- reset: `<Esc> gg dG`

### D2 — a plain `.` keeps the original count; a new count replaces it

- seed: `i` type `"abcdef"` `<Esc>` `gg 0`
- keys: `2 x .`
- expect: buffer `ef` — the repeat re-ran the count-2 delete.
- keys: reset, seed again, then `2 x 3 .`
- expect: buffer `f` — the leading `3` replaced the recorded count of 2.
- reset: `<Esc> gg dG`

### D3 — `.` repeats an operator with its motion

- seed: `i` type `"one two three four five six seven"` `<Esc>` `gg 0`
- keys: `2 d w 3 .`
- expect: buffer `six seven`. The `3` replaced the operator's recorded count,
  so the repeat deleted three words.
- reset: `<Esc> gg dG`

### D4 — `.` replays inserted text

- seed: `i` type `"abc"` `<Esc>` `gg 0`
- keys: `i`, type `XY`, `<Esc>`, then `.`
- expect: buffer `XXYYabc`, cursor on the second `X`. The repeat re-inserts
  the recorded `XY` at the cursor.
- reset: `<Esc> gg dG`

### D5 — `{count}.` repeats an open-line command count times

- seed: `i` type `"abc"` `<Esc>` `gg 0`
- keys: `o`, type `hi`, `<Esc>`, then `3 .`
- expect: five lines — `abc` followed by four `hi` lines. Each repeat opens
  its own line rather than appending to one.
- reset: `<Esc> gg dG`

### D6 — `.` repeats a counted substitute together with its text

- seed: `i` type `"abcdefgh"` `<Esc>` `gg 0`
- keys: `3 s`, type `X`, `<Esc>`, then `.`
- expect: buffer `Xfgh`. `3s` replaced `abc` with `X`, and `.` replayed the
  same counted substitute over `def`.
- reset: `<Esc> gg dG`

### D7 — `.` repeats a join and a replace

- seed: four lines `a`, `b`, `c`, `d`; cursor `gg 0`.
- keys: `J .`
- expect: two lines, `a b c` and `d`, cursor on the space before `c`.
- keys: reset, seed `i` type `"ab"` `<Esc>` `gg 0`, then `r a l .`
- expect: buffer `aa`. Replacing `a` with `a` changes nothing but is still a
  completed change, so it stays repeatable.
- reset: `<Esc> gg dG`

### D8 — `.` after an intervening yank puts the freshly yanked text

- seed: `i` type `"Xab cd ef"` `<Esc>` `gg 0` `x` — buffer `ab cd ef`,
  register holds `X`.
- keys: `p w y w 0 .`
- expect: buffer `acd Xb cd ef`. The yank is not itself a change, so `.`
  still repeats the put — but the put now reads the register the yank
  overwrote. This surprises people; it is what nvim does.
- reset: `<Esc> gg dG`

### D9 — a motion is not a repeatable change

- seed: `i` type `"a.bcd"` `<Esc>` `gg 0`
- keys: `x f . .`
- expect: buffer `bcd`. The `x` deleted `a`; `f.` found no dot to the right
  and did not move; the final `.` repeated the `x`, not the motion.
- reset: `<Esc> gg dG`

### D10 — a cancelled operator is not recorded

- seed: `i` type `"abc"` `<Esc>` `gg 0`
- keys: `x d . .`
- expect: buffer `c`. The first `.` was consumed as an invalid motion and
  cancelled the pending `d`; the second `.` repeated the earlier `x`.
- reset: `<Esc> gg dG`

### D11 — `.` composes with undo and redo

- seed: `i` type `"abcdef"` `<Esc>` `gg 0`
- keys: `x u .`
- expect: buffer `bcdef` — `u` restored the `a`, `.` deleted it again.
- keys: reset, seed again, then `x . u`
- expect: buffer `bcdef` — `u` undid only the repeat.
- keys: reset, seed again, then `x . u <C-r>`
- expect: buffer `cdef` — redo restores the repeated delete, so the repeat
  did not clobber the redo stack.
- reset: `<Esc> gg dG`

### D12 — a repeat that cannot replay leaves the buffer untouched

- seed: two lines, `a,b foo` then `no comma line`; cursor `gg 0`.
- keys: `c f ,`, type `dd`, `<Esc>` — line 1 becomes `ddb foo`. Then `j 0`,
  then `.`
- expect: line 2 is unchanged. There is no comma to change to, so the replay
  aborts as a whole: no stray `dd` is inserted, no partial delete lands, and
  the editor stays in normal mode (no `<Esc>` leaks into the buffer).
- reset: `<Esc> gg dG`

---

## group E — `.` as a command argument

`.` is the repeat command only when normal mode is idle. A command already
waiting for a character argument takes the `.` as that argument.

### E1 — `f.` takes the dot as its target

- seed: `i` type `"a.b"` `<Esc>` `gg 0`
- keys: `f .`
- expect: the cursor moves onto the `.`; nothing is repeated.
- notes: on `a.b.c.d`, `3 f .` lands on the third dot. `F.` and `t.` behave
  the same way with respect to the argument.
- reset: `<Esc> gg dG`

### E2 — `df.` deletes through the dot

- seed: `i` type `"ab.cd"` `<Esc>` `gg 0`
- keys: `d f .`
- expect: buffer `cd`.
- reset: `<Esc> gg dG`

### E3 — `r.` replaces with a dot

- seed: `i` type `"ab"` `<Esc>` `gg 0`
- keys: `r .`
- expect: buffer `.b`.
- notes: `2 r .` on `abcd` gives `..cd`.
- reset: `<Esc> gg dG`

### E4 — dot repeat still fires after a dot argument

- seed: `i` type `"ab.cd.ef"` `<Esc>` `gg 0`
- keys: `d f . .`
- expect: buffer `ef`. `df.` deleted `ab.`, and the following `.` repeated
  that whole change over `cd.`.
- reset: `<Esc> gg dG`

---

## group F — a failed char motion aborts the operator

### F1 — `c{motion}` with no match stays in normal mode

- seed: `i` type `"abcdef"` `<Esc>` `gg 0`
- keys: `c t z` (there is no `z`), then `x`
- expect: `ctz` does nothing — no insert mode, no deletion. The following `x`
  then deletes `a`, proving the editor never left normal mode. Before this
  branch `ctz` entered insert mode and the `x` would have been typed into the
  buffer.
- reset: `<Esc> gg dG`

### F2 — the same motion succeeds when there is a match

- seed: `i` type `"one two"` `<Esc>` `gg 0`
- keys: `c t <Space>`, type `Z`, `<Esc>`
- expect: buffer `Z two`.
- reset: `<Esc> gg dG`

---

## group G — visual mode

The selection semantics are parity-tested against real nvim in
`test/nvim-parity-visual.ts`. What no automated test can check is that the
footer, the cursor, and the *absence* of a selection highlight all behave as
documented in a real terminal. G1 and G2 are TTY-only; treat them as
priority alongside group A.

### G1 — the footer names the visual mode (TTY-only)

- seed: `i` type `"hello"` `<Esc>` `gg 0`
- keys: `v`, then `V`, then `<Esc>`
- expect: the footer reads ` VISUAL `, then ` V-LINE `, then ` NORMAL `. The
  label color matches the normal-mode color in both visual modes.
- reset: `<Esc> gg dG`

### G2 — the selection is not highlighted (TTY-only, known limitation)

- seed: `i` type `"hello"` `<Esc>` `gg 0`
- keys: `v l l`
- expect: the block cursor sits on the third `l`. The characters `ell`
  between the anchor and the cursor render as **ordinary text** — there is no
  highlight. This is the documented limitation, not a bug; the case exists so
  a future highlight change has something to flip.
- reset: `<Esc> gg dG`

### G3 — `d` deletes the character-wise selection

- seed: `i` type `"hello"` `<Esc>` `gg 0` `l` (cursor on `e`)
- keys: `v l l d`
- expect: buffer `ho`, cursor on the `o` (the first character after the
  deleted span), mode `NORMAL`.
- reset: `<Esc> gg dG`

### G4 — `y` rewinds the cursor to the start of the selection

- seed: `i` type `"hello"` `<Esc>` `gg 0` `l l l` (cursor on the second `l`)
- keys: `v h h y`
- expect: buffer unchanged, cursor back on `e` (the start of the selection),
  mode `NORMAL`. A following `$ p` pastes `ell` after the last character.
- reset: `<Esc> gg dG`

### G5 — `c` opens insert mode over the selection

- seed: `i` type `"hello"` `<Esc>` `gg 0` `l`
- keys: `v l c`, type `X`, `<Esc>`
- expect: buffer `hXlo`, footer returns to ` NORMAL `.
- reset: `<Esc> gg dG`

### G6 — `o` swaps the ends of the selection

- seed: `i` type `"hello"` `<Esc>` `gg 0` `l`
- keys: `v l l o l d`
- expect: buffer `heo`. `o` moves the cursor back to the anchor end, so the
  following `l` shrinks the selection from the left instead of growing it.
- reset: `<Esc> gg dG`

### G7 — `V` selects whole lines and `d` removes them

- seed: the 3-line seed, then `j` (cursor on line 2).
- keys: `V j d`
- expect: only `abc def` remains. The register holds two whole lines, so a
  following `p` re-inserts them below line 1.
- reset: `<Esc> gg dG`

### G8 — uppercase operators force a line-wise edit

- seed: the 3-line seed, cursor on line 1 column 2.
- keys: `v D`
- expect: line 1 is gone entirely even though the selection was
  character-wise and one character wide.
- reset: `<Esc> gg dG`

### G9 — a count applies to the motion, not to `v`

- seed: `i` type `"hello"` `<Esc>` `gg 0`
- keys: `v 2 l d`
- expect: buffer `lo`. While the count is pending the footer reads
  ` VISUAL 2_ `.
- reset: `<Esc> gg dG`

### G10 — `Esc` leaves visual mode without reaching Pi

- seed: `i` type `"hello"` `<Esc>` `gg 0`
- keys: `v`, then `<Esc>`
- expect: the footer returns to ` NORMAL ` and the agent is **not**
  interrupted. Pressing `<Esc>` once more from idle normal mode does abort the
  agent, which is the pre-existing behavior.
- reset: `<Esc> gg dG`

### G11 — inert keys do nothing while a selection is live

- seed: `i` type `"hello"` `<Esc>` `gg 0` `x` — buffer `ello`, register `h`.
- keys: `v`, then in turn `u`, `<C-r>`, `p`, `P`, `r`, `J`, `:`, `i`, `a`,
  `A`, `I`, `.`, `~`, `>`, `<`, `Z`
- expect: after every one of those keys the buffer is still `ello` and the
  footer still reads ` VISUAL `. In particular `u` does not undo the `x`, `p`
  does not paste `h`, `:` does not open the EX mini-mode, `i` does not enter
  insert mode, and `Z` is not typed into the buffer.
- reset: `<Esc> gg dG`

### G12 — a visual edit takes itself out of dot repeat

No fresh session needed here: the visual delete is exactly what clears the
repeat memory, so whatever the seed recorded is irrelevant.

- seed: `i` type `"hello world"` `<Esc>` `gg 0`
- keys: `x` (buffer `ello world`), then `v l d` (buffer `lo world`), then `.`
- expect: the final `.` does nothing — the buffer stays `lo world`. The
  visual delete cleared the stored repeatable `x` rather than leaving it
  armed. Control: on a fresh seed, `x` then `.` gives `llo world`, so `.`
  really was armed before the visual edit.
- reset: `<Esc> gg dG`

---

## coverage map

| area | automated | manual only |
|---|---|---|
| put cursor position | `npm test`, `npm run test:nvim` | grapheme rendering (B3) |
| counted `d$` / `c$` / `d0` / `d^` | `npm run test:nvim` | — |
| dot repeat semantics | `npm test`, `npm run test:nvim` | — |
| `.` as a command argument | `npm test`, `npm run test:nvim` | — |
| failed char-motion abort | `npm test` | — |
| visual-mode selection semantics | `npm test`, `npm run test:nvim` | — |
| visual-mode footer + missing highlight | `test/modal-editor.test.ts` (label string only) | G1, G2 |
| footer mode label | `test/mode-label.test.ts` (fitting only) | A1, A2 |
| cursor shape / software cursor | `test/cursor-shape.test.ts` (strings only) | A3 |
| paste cancels a pending command | `test/dot-repeat-review.test.ts` (simulated) | A4 |
| autocomplete cancels a recording | `test/dot-repeat-review.test.ts` (simulated) | A5 |
| submit is not repeatable | `test/dot-repeat-review.test.ts` | A6 |
| host text injection cancels | `test/dot-repeat-review.test.ts` (simulated) | A7 |

Group A is the priority. Everything below it has a green automated
counterpart and is here to catch a difference between the harness and a real
terminal.
