# demo-gif storyboard: dot-repeat, visual mode, ex bridge

A shot list for a short demo gif (or asciicast) of pi-vim's three headline vim
behaviors: dot-repeat (`.`), visual mode, and the ex bridge. Each shot gives an
exact seed buffer, the exact keystrokes, and the expected on-screen result, so a
take either matches or it doesn't.

**Recording is manual.** This repo ships no capture tooling — no gif encoder, no
asciinema wrapper, no headless driver. You record the takes yourself in a live
Pi session with whatever screen/terminal recorder you prefer. What the repo does
ship is `script/demo-buffers.ts`: it drives `ModalEditor` through its public
surface and prints the seed and result buffer for every shot below, so you can
pre-load the prompt and verify each take against deterministic ground truth
instead of eyeballing it.

```sh
node --import tsx/esm script/demo-buffers.ts          # human-readable report
node --import tsx/esm script/demo-buffers.ts --json    # machine-readable
```

The numbers in this document are that script's output. If a shot ever drifts,
the script is the source of truth — regenerate and reconcile.

## how to record (manual)

1. Start pi-vim in a Pi session — see the repo `README.md` (`## install`,
   `## wrapping pi-vim`). The prompt is the demo buffer.
2. Terminal: pick a fixed, legible size (≈ 90×24), a large monospace font, and a
   theme with a visible mode footer (` NORMAL `, ` INSERT `, ` VISUAL `,
   ` V-LINE `). The footer is the only on-screen signal of the mode, so keep it
   in frame.
3. Before each shot, put the prompt into the shot's **seed** state: type the seed
   text, press `Esc` to return to NORMAL, and `0` to sit at column 0 (this is how
   the seed column below is produced). Shots that start mid-insert say so.
4. Perform the shot's **keys** at a readable pace and stop. Compare the buffer
   against **result**.
5. `‸` marks the cursor. `<Esc>` is escape, `<Enter>` is a typed submit,
   `<Space>` is the space bar, `<newline>` is a literal newline inside the buffer.

Suggested capture order for one continuous take: the three dot-repeat shots, then
the four visual shots, then the four ex-bridge shots — twelve short beats, each a
few seconds. A recorder that renders keystrokes on screen (e.g. a keycast
overlay) makes the `.` and `:` gestures legible; none is bundled here.

## dot-repeat (`.`)

Reference: `README.md` → `### undo / redo / repeat`. `.` replays the last
repeatable change; a leading count replaces the stored one.

| shot | seed (NORMAL, `‸` = cursor) | keys | result | what the viewer sees |
| --- | --- | --- | --- | --- |
| **D1** repeat a change across a list | `‸one two three four` | `c i w X <Esc>` then `w . w . w .` | `X X X ‸X` | one `ciwX<Esc>` edit, then `w.` walks it down the line — four identical edits from one authored change |
| **D2** counted repeat overrides the stored count | `‸a b c d e f` | `d w` then `2 .` | `‸d e f` | `dw` deletes one word; `2.` replays it as `2dw`, taking two more — the count on `.` wins |
| **D3** implicit-insert typing is repeatable | prompt opens in INSERT; type `deploy`, `<Esc>` → `‸deploy` | `.` | `deplo‸ydeploy` | no `i` was ever pressed — the startup prompt's own typing recorded an `i…<Esc>` change, so `.` re-types it |

D3 is the headline of the implicit-insert work: typing on the startup prompt (or
the fresh prompt after a submit) is dot-repeatable even though the session opened
in INSERT with no change command. A submit (`<Enter>`) is never part of the
recording, so `.` re-types the run and can never resubmit it — worth narrating on
screen, but not separately capturable here since it needs a live submit.

## visual mode

Reference: `README.md` → `### visual mode`. Selections are not highlighted; the
mode footer and the moving block cursor are the on-screen cues, so keep the
footer in frame for every visual shot.

| shot | seed (NORMAL, `‸` = cursor) | keys | result | what the viewer sees |
| --- | --- | --- | --- | --- |
| **V1** characterwise select + delete | `‸hello world` | `v 2 l d` | `‸lo world` | ` VISUAL ` footer; the cursor walks right three columns, then `d` removes `hel` |
| **V2** linewise select + delete | `‸first`<br>`second`<br>`third` | `V j d` | `‸third` | ` V-LINE ` footer; `Vj` spans two whole lines, `d` takes both |
| **V3** visual yank then put | `‸copyme rest` | `v e y $ p` | `copyme restcopym‸e` | `vey` yanks `copyme` and rewinds the cursor to its first char; `$p` pastes the word at line end |
| **V4** visual edits are not dot-repeatable | `‸aa bb cc` | `x` then `v l d` then `.` | `‸bb cc` | `x` is repeatable, but the visual delete clears the stored change, so the trailing `.` is a deliberate no-op — the buffer does not change on the `.` |

V4 documents an intentional difference from full Vim (`README.md` →
`## known differences from full Vim`): rather than letting `.` replay an unrelated
earlier change after a visual edit, pi-vim clears the repeatable command so `.`
does nothing. On screen the teaching beat is that the final `.` moves nothing.

## ex bridge

Reference: `README.md` → `### mode switching` (`#### ex mini-mode`,
`##### pi-command bridge`). The ex line is a bridge to Pi's quit, shell, and
command-registry seams — not vim ex-command semantics. In these shots the
dispatch effect is host-side (Pi runs the command or quits); the script captures
the exact command line handed to Pi and confirms the composed prompt survives.

| shot | seed | keys | dispatched / effect | what the viewer sees |
| --- | --- | --- | --- | --- |
| **E1** quit on an empty prompt | empty prompt, NORMAL | `: q <Enter>` | quit | `:q` in the ex line quits the session when the prompt is empty |
| **E2** shell dispatch | `‸draft prompt` (NORMAL) | `: ! l s <Enter>` | submits `!ls`; prompt restored to `draft prompt` | `:!ls` runs `ls` in Pi's bash mode; the composed prompt reappears untouched afterward |
| **E3** pi-command dispatch | `‸draft prompt` (NORMAL) | `: t r e e <Enter>` | submits `/tree`; prompt restored to `draft prompt` | `:tree` is exactly typing `/tree` and pressing Enter — Pi's command runs, the prompt survives |
| **E4** quit precedence over shell | `‸unsaved text` (NORMAL) | `: q ! <Enter>` | quit (no shell dispatch) | `:q!` force-quits even with prompt text; the leading `!` never reaches the shell because the quit names win first |

E2 and E3 are the bridge's two active seams. E2 is the shell-dispatch work: a
bare leading `!` submits the line verbatim to Pi's bash mode (`:!!cmd` excludes
it from context). E4 is the precedence guard: `:q!` is a quit form, so its `!`
does not dispatch to the shell — the quit-name check runs before the shell
branch. For E2/E3, narrate that the prompt text is snapshotted and restored
around the dispatch, so nothing you were composing is lost.

## keeping this in sync

The seeds, keystrokes, and results above are generated, not hand-tuned. When the
editor's behavior changes, rerun `node --import tsx/esm script/demo-buffers.ts`
and update the tables to match its report. The script constructs each shot on a
fresh editor and reads back `getText()`, `getCursor()`, and `getMode()` — the
same public surface the test suite uses — so it never diverges from the shipped
behavior.
