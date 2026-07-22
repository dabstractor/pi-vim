# input hot-path benchmark: dot-repeat recording

Dot-repeat records the last change by watching the key stream, so a small
amount of bookkeeping now runs on **every dispatched keystroke** — not only on
change commands. `prepareRepeatRecordingForInput` runs before dispatch
(`index.ts` in `handleInputCore`, just above the mode branches) and
`finishRepeatRecordingAfterInput` runs in the trailing `finally`. (A handful of
inputs — filtered bracketed-paste bytes and mid-flight ex-line bytes — return
earlier and skip both.) This document measures what that per-key path costs, so
the README's "sub-µs word motions" claim can be read against numbers rather
than taken on faith.

The headline: the per-key repeat bookkeeping (and the other input-path guards
added alongside it) adds a fixed, sub-microsecond cost per keystroke — about
**35 ns** on the cheapest key — and is lost in the noise on motions that walk
any real distance. Typing latency stays where it was.

## what "base" and "head" mean

- **head** — the current tip of this branch.
- **base** — the commit immediately before dot-repeat landed, i.e. the parent
  of `feat(repeat): add dot-repeat (.) for the last change` (`7e0d320`), which
  is `feat(operators): support counted d$/c$ and count-ignoring d0/d^/c^`
  (`bbbf63e`). At base, neither recording helper exists and `handleInput` does
  no per-key repeat bookkeeping.

The delta between the two is therefore the **aggregate** per-input branch cost
added since that tip. The repeat recording is its always-on component, but the
other input-path work added in the same window (visual-mode and ex-line guards,
bracketed-paste stripping in normal mode) sits on the same path and is folded
in, not factored out — and any unrelated speedup elsewhere on the path offsets
it (see `motion_w_50`'s negative delta below). So read each number as the
combined branch delta, not an isolated profile of the recording. Isolating
recording alone would need a head build with recording compiled out; that is
out of scope here.

## harness

`script/hotpath-compare.ts` drives `ModalEditor` through the public
`handleInput` surface only, so the same harness runs against any build old
enough to predate the operations it measures. It imports its entry point from
the `PIVIM_ENTRY` environment variable (default: this checkout's `index.ts`),
times each operation with `performance.now()`, and prints per-operation
median/p95 in µs/op as JSON. Rendering is excluded, matching
`script/perf-bench.ts`.

Five operations, chosen to bracket the input path:

| operation | what it is | why |
| --- | --- | --- |
| `noop_key` | unbound printable `z` in normal mode, 20k loop | cheapest key; a fixed per-input cost shows up as the largest fraction here |
| `motion_h_4k` | `h` one column left on a 4k-column line, 4k loop | dominated by the column walk; a control — recording should vanish into it |
| `motion_w_50` | `w` on a 50-word line, reset each op | a cheap real motion, small enough to see per-input overhead |
| `insert_type` | sustained typing in one INSERT session, 1k keys | each key appends to the open recording; the line grows identically in both builds so the delta isolates the append |
| `insert_edit` | `i` `x` `Esc`, fresh editor per op | full recording lifecycle: open on `i`, append, finalize on Esc |

`insert_type` grows a 0→1000-character line, so its absolute µs/op reflects the
host editor's string insert on a lengthening line, not keypress latency. Only
its base-vs-head delta is meaningful here — both builds pay the identical string
cost, leaving the recording append as the difference.

## results

Median of per-run medians over 5 rounds, base and head alternated each round so
machine drift lands on both evenly. Node v24.15.0, Apple M2 Pro, darwin-arm64;
timings are machine-dependent, deltas less so.

| operation | base µs/op | head µs/op | Δ µs/op | Δ % |
| --- | ---: | ---: | ---: | ---: |
| `noop_key` | 0.600 | 0.636 | +0.035 | +5.8% |
| `motion_h_4k` | 413.5 | 414.2 | +0.70 | +0.17% |
| `motion_w_50` | 1.376 | 1.374 | −0.002 | −0.1% |
| `insert_type` | 8.29 | 8.43 | +0.14 | +1.7% |
| `insert_edit` | 11.83 | 12.03 | +0.20 | +1.7% |

Reading them:

- **No-op keys** carry the whole fixed cost with nothing to hide behind: ~35 ns
  per keystroke, 5.8% of a 0.6 µs key. This is the price of the per-key
  bookkeeping running on a key that records nothing.
- **Motions** are unchanged for practical purposes. `motion_w_50` moves by about
  two nanoseconds — the sign is negative, i.e. head is a hair *faster*, which is
  just run-to-run noise around zero. `motion_h_4k` gains 0.7 µs on a 414 µs walk
  (0.17%), i.e. the same fixed per-key cost, now a rounding error against the
  work it sits beside.
- **Insert** typing gains ~0.14–0.20 µs per edit for the append and
  open/finalize bookkeeping — well under a microsecond, and dwarfed by the host
  editor's own insert cost.

Every delta is sub-microsecond. Word motions do not shift out of the range they
were already in: `motion_w_50` sits at 1.37 µs in both builds (a 50-word line;
the scoreboard's shorter 20-word `w` is 1.07 µs), and the boundary-cache motion
path the README highlights is untouched by the recording work. The per-key
repeat path did not regress the hot path.

## reproducing this

From a clean checkout of this branch:

```sh
# head
node --import tsx/esm script/hotpath-compare.ts

# base: the commit before dot-repeat landed, checked out *nested* under this
# checkout so Node resolves this checkout's node_modules with no reinstall.
# Grep the feat subject specifically — this doc's own commit subject also
# contains "add dot-repeat", so a looser --grep='add dot-repeat' resolves to
# *this* commit's parent (a build that already has the recording) and yields a
# bogus near-zero delta.
base="$(git rev-list -1 --grep='feat(repeat): add dot-repeat' HEAD)~1"
git worktree add .tmp/base-checkout "$base"
PIVIM_ENTRY=.tmp/base-checkout/index.ts \
  node --import tsx/esm script/hotpath-compare.ts
git worktree remove .tmp/base-checkout
```

The nesting matters: Node walks *upward* from the entry file for `node_modules`,
so the base checkout must live inside this one (here under the git-ignored
`.tmp/`) to reuse its installed peers. A sibling checkout would need its own
`npm ci` instead. Each run prints JSON; compare the `stats.median` of matching
operations. Absolute numbers move with the machine; the deltas above reproduce.
