# spec: insert-session undo scope (2026-07-20)

One change on this branch (`fix-undo-scope`). Stays in the undo
layer; no new commands, no normal-mode behavior change. Must pass
the existing test suite plus new tests.

## problem

Typing a multi-word sentence in one insert session then pressing
`u` removes one or two words per press instead of the whole
session. Real Vim treats an entire insert session (enter insert →
`<Esc>`) — and a whole change command (`cw`/`cc`/`s`/`o`…) — as a
single undo unit.

This is an **undo-layer** defect, not a repeat defect. There is no
dot-repeat on this branch. Root cause: insert-mode printable chars
are forwarded unchanged to the base editor
(`index.ts:1141` → `Editor.insertCharacter`), whose **fish-style
word coalescing** (pi-tui `dist/components/editor.js`:

```
if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
    this.pushUndoSnapshot();
}
this.lastAction = "type-word";
```

) pushes one snapshot per word. The vim layer's `setMode`
(`index.ts:743`) never opens or closes an undo group, so Vim's
"one undo per change" semantics are never established.

The base editor is shared with the shell/prompt surface, so the
coalescing policy must NOT be changed upstream. The vim layer owns
Vim-style undo breaks.

## scope

Two cases Vim treats as one undo unit; both must be fixed:

1. **Pure insert** (`i`/`I`/`a`/`A`/`o`/`O`, with count forms): no
   buffer mutation precedes the insert. The session itself is the
   change. (`o`/`O` create a newline via `openLineBelow`/`Above`
   at `index.ts:2000`/`2005` → base `addNewLine`, which pushes one
   snapshot; that newline snapshot is the natural group anchor.)
2. **Change-with-insert** (`c{motion}`, `cc`, `s`, `S`, `C`): a
   deletion runs first via `applySyntheticEdit`
   (`index.ts:901`, snapshot at `:930`) or `replaceTextInBuffer`
   (`index.ts:3104`, snapshot at `:3119`), then insert begins.
   The delete **and** the inserted text must be one undo unit.

## behavior

- `i hello world foo<Esc>` then `u` → buffer reverts to pre-`i`
  state in **one** press. A second `u` is a no-op (history
  exhausted, clamp).
- `cw bar baz<Esc>` (on `foo`) then `u` → reverts to `foo` in
  **one** press (both the word-delete and the typed text).
- `o typed line<Esc>` then `u` → removes the opened line and its
  text in **one** press.
- `3i x<Esc>` then `u` → reverts the whole `x x x` insert in one
  press (count insert is one change).
- `<C-r>` after such a `u` restores the entire session/change.
- Cursor after `u` lands on the start of the undone change
  (Vim-compatible placement).
- No regression: existing atomic normal-mode edits (`dd`, `x`,
  `dw`, `p`, `r`) still undo as one unit and still feed the vim
  `redoStack` via `performUndo` (`index.ts:820` region).

## invariant

For every Vim "change", the base `undoStack` ends with **exactly
one** entry attributable to that change, holding the pre-change
buffer/cursor state. All mid-change snapshots (per-word typing,
intermediate newlines/backspaces) are collapsed before the change
becomes observable to `u`.

## implementation approach (recommended)

An undo-group bracket owned by the vim layer. Do **not** touch
pi-tui.

New state + helpers on `ModalEditor`:

- `private changeGroup: { startStackLen: number; startText: string; anchored: boolean } | null`
- `beginChange()`: record `startStackLen = editor.undoStack.stack.length`
  and `startText = this.getText()`. Add `undoStack` (read-only
  `{ stack: unknown[] }`) to `ModalEditorInternals` (`index.ts:98`).
- `endChange()`: if `getText() === startText` (no-op change, e.g.
  `i<Esc>`), do nothing — leave history untouched. Otherwise
  **collapse**: pop the base `undoStack` back to `startStackLen`,
  then ensure the single remaining group entry holds `startText`
  (pre-change state). The first mutating push inside the group
  (`applySyntheticEdit`/`replaceTextInBuffer`/base newline) already
  captured `startText`, so for change-with-insert the existing
  snapshot is reused; for pure insert, `beginChange` pushes the
  anchor (see below). Fire no `onChange` from the collapse itself
  (direct stack pop, not `setText`) so `centralInvalidationCheck`
  is not spuriously tripped.
- Pure-insert anchor: at `setMode("insert")` when `prev !== "insert"`
  and no group is open, open a group and push one snapshot
  immediately (this is the `startText` anchor). For
  change-with-insert the operator path opens the group **before**
  the delete, so the delete's own snapshot is the anchor and the
  insert-entry path must detect an open anchored group and NOT
  push again.

Bracket sites:

- Open at the start of every mutating command: operator dispatch
  (`c`/`d`/`y`/`p`/`~`/`r`/`x` and motion/operator handlers) and
  the pure-insert entries (`i`/`I`/`a`/`A`/`o`/`O`).
- Close at command completion: for pure normal-mode edits, right
  after the mutation; for change-with-insert and pure-insert, on
  the `<Esc>`/`<C-[>` that returns to normal (`handleEscape`,
  `index.ts` region near `:1120`).
- Guard re-entrancy: `performUndo`/`performRedo`
  (`index.ts:820`/`redo` block) and `setText` must close/discard
  any open group so undo/redo/reset never leave a dangling
  bracket.

`redoStack` plumbing is unchanged in shape: `performUndo` already
captures a before-snapshot per step, so coarser base units simply
mean coarser redo units — `u` then `<C-r>` still round-trips the
whole change.

### simpler fallback (explicit divergence, NOT recommended)

Collapse only at `<Esc>`, keyed to the insert-entry stack length,
without a full begin/end group. This fixes case 1 (pure insert) but
leaves case 2 (`cw`/`cc`) undoing in two steps (delete, then text).
If chosen, document the divergence in README and tests per
review-guidelines. Prefer the recommended approach.

## tests

New behavioral cases in `test/modal-editor.test.ts` under
`describe("undo / redo — u / ctrl+r", …)` (`:5759`), plus curated
Vim-parity coverage. Per `doc/review-guidelines.md`, undo/redo
changes MUST cover: redo clearing on real edits, harmless inputs
preserving history, exhausted-history clamp, and stale-redo
prevention. Assert observable state: buffer text, cursor, mode.

Behavioral (`modal-editor.test.ts`):

- pure insert: `i hello world foo<Esc>` → `u` → empty, cursor at
  col 0; second `u` no-op.
- pure insert + redo: same → `u` → `<C-r>` → full text restored.
- change-with-insert: `foo`, `cw` → `bar baz<Esc>` → `u` → `foo`
  in one press.
- `o`/`O` session: `o typed<Esc>` → `u` → line gone in one press.
- count insert: `3i x<Esc>` → `u` → reverts all three in one press.
- no-op preserves history: `i<Esc>` then `u` does not consume a
  real change (buffer unchanged from prior state).
- redo clears on real edit: after `u`, a new insert clears the
  redo path (`<C-r>` no longer restores).
- exhausted-history clamp: `u` at empty history is a no-op.
- no count leak: `<count>u` consumes only its count.
- no regression: `dd` / `x` / `dw` / `p` / `r` still undo as one
  unit each; `3u` undoes 3 separate changes.
- grapheme-safe: insert sentence containing a surrogate-pair emoji
  (`😀 hello world`), `u` reverts whole session, cursor sane.
- cursor placement: after `u` cursor sits at the change start
  (first col of the undone region), not mid-buffer.

Vim parity (new `test/nvim-parity-undo.ts`, or extend
`nvim-parity-edits.ts`/`nvim-parity-mode.ts`):

- `i<text><Esc>` → `u` undoes entire insert in one step (matches
  `nvim`).
- `cw<text><Esc>` → `u` undoes delete+insert in one step.
- `o<text><Esc>` → `u` undoes open-line+text in one step.
- `<C-r>` restores the whole change.

Each parity case must assert against real nvim via the existing
oracle harness (`test/nvim-oracle.ts`); record intentional
divergence explicitly if the fallback approach is taken.

## definition of done

- insert session and change-with-insert both undo as one Vim unit.
- `node --import tsx/esm --test 'test/**/*.test.ts'` passes
  (0 failures).
- `npm run test:nvim` passes with the new parity cases.
- `npx tsc --noEmit` passes.
- `npm run lint` passes.
- pi-tui untouched (no edits under
  `node_modules/@earendil-works/pi-tui`).
- README undo section updated if any user-visible divergence
  remains.
- committed on `fix-undo-scope`.