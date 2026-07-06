import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

// Dot-repeat parity. `.` is always on; cases run the keys against both
// pi-vim and nvim and assert identical final state.

const REPEAT_PARITY_CASES: NvimParityCase[] = [
  {
    name: "x then . deletes the following char",
    initial: { text: "abcdef", cursor: { line: 0, col: 0 } },
    keys: ["x", "."],
  },
  {
    name: "x mid-line then . deletes the next char",
    initial: { text: "abcdef", cursor: { line: 0, col: 2 } },
    keys: ["x", "."],
  },
  {
    name: "dw then . deletes the next word",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["d", "w", "."],
  },
  {
    name: "de then . deletes through the next word end",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["d", "e", "."],
  },
  {
    name: "dd then . deletes two lines from the top",
    initial: { text: "a\nb\nc\nd", cursor: { line: 0, col: 0 } },
    keys: ["d", "d", "."],
  },
  {
    name: "d$ then j then . deletes the next line tail",
    initial: { text: "ab cd\nef gh", cursor: { line: 0, col: 0 } },
    keys: ["d", "$", "j", "."],
  },
  {
    name: "df{char} then . deletes through the next occurrence",
    initial: { text: "foo,bar,baz", cursor: { line: 0, col: 0 } },
    keys: ["d", "f", ",", "."],
  },
  {
    name: "daw then . deletes the next word with whitespace",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["d", "a", "w", "."],
  },
  {
    name: "r{char} then . replaces the same char in place",
    initial: { text: "hello", cursor: { line: 0, col: 0 } },
    keys: ["r", "X", "."],
  },
  {
    name: "J then . joins the current line with the next twice",
    initial: { text: "a\nb\nc\nd", cursor: { line: 0, col: 0 } },
    keys: ["J", "."],
  },
  {
    name: "2x then 3. replaces the recorded count",
    initial: { text: "abcdef", cursor: { line: 0, col: 0 } },
    keys: ["2", "x", "3", "."],
  },
  {
    name: "x then 3. applies a new count to a count-less change",
    initial: { text: "abcdef", cursor: { line: 0, col: 0 } },
    keys: ["x", "3", "."],
  },
  {
    name: "2dw then 3. replaces a prefix-count operator form",
    initial: { text: "a b c d e f", cursor: { line: 0, col: 0 } },
    keys: ["2", "d", "w", "3", "."],
  },
  {
    name: "d2w then 3. replaces an operator-count form",
    initial: { text: "a b c d e f", cursor: { line: 0, col: 0 } },
    keys: ["d", "2", "w", "3", "."],
  },
  {
    name: ". is a no-op with no prior change",
    initial: { text: "hello", cursor: { line: 0, col: 0 } },
    keys: ["."],
  },
  {
    name: ". after a motion repeats the prior change",
    initial: { text: "hello world", cursor: { line: 0, col: 0 } },
    keys: ["x", "w", "."],
  },
  {
    name: ". after yy repeats the prior change",
    initial: { text: "hello world", cursor: { line: 0, col: 0 } },
    keys: ["x", "y", "y", "."],
  },
  {
    name: ". while an operator is pending cancels and does not repeat",
    initial: { text: "hello world", cursor: { line: 0, col: 0 } },
    keys: ["x", "d", "."],
  },
];

// Known divergences from nvim, tracked as skipped parity cases per AGENTS.md.
const KNOWN_NVIM_PARITY_GAPS = new Set([
  // Phase 2: insert-mode change recording. cw/s/cc/o/O capture free-form
  // insert text, which Phase 1 does not record, so `.` after them replays only
  // the (empty) pre-insert portion or no-ops.
  "cw then . repeats the change",
  "cc then . repeats the change",
  "s then . repeats the change",
  // Dual-count forms collapse to a single count under withReplacedCount; nvim
  // keeps both counts distinct.
  "2d3w then . dual-count form",
  // Pre-existing p/P (put) cursor placement divergence, not a repeat bug:
  // pi-vim lands the cursor AFTER the pasted text while nvim lands it ON the
  // last pasted char. `.` re-evaluates from the cursor, so the gap becomes
  // observable on the second paste. Out of scope for the repeat branch; unskip
  // when put cursor placement is fixed.
  "p then . pastes the register twice",
  "P then . pastes the register twice before",
]);

const REPEAT_PARITY_GAPS: NvimParityCase[] = [
  {
    name: "cw then . repeats the change",
    initial: { text: "foo bar", cursor: { line: 0, col: 0 } },
    keys: ["c", "w", "X", "Y", "\x1b", "."],
  },
  {
    name: "cc then . repeats the change",
    initial: { text: "foo\nbar", cursor: { line: 0, col: 0 } },
    keys: ["c", "c", "Z", "\x1b", "."],
  },
  {
    name: "s then . repeats the change",
    initial: { text: "foo", cursor: { line: 0, col: 0 } },
    keys: ["s", "Q", "\x1b", "."],
  },
  {
    name: "2d3w then . dual-count form",
    initial: { text: "a b c d e f g h i", cursor: { line: 0, col: 0 } },
    keys: ["2", "d", "3", "w", "4", "."],
  },
  {
    name: "p then . pastes the register twice",
    initial: { text: "ab", cursor: { line: 0, col: 0 }, register: "XY" },
    keys: ["p", "."],
  },
  {
    name: "P then . pastes the register twice before",
    initial: { text: "ab", cursor: { line: 0, col: 0 }, register: "XY" },
    keys: ["P", "."],
  },
];

describe("nvim parity dot-repeat (.)", () => {
  for (const testCase of REPEAT_PARITY_CASES) {
    if (KNOWN_NVIM_PARITY_GAPS.has(testCase.name)) {
      it.skip(`known nvim parity gap: ${testCase.name}`);
      continue;
    }
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }

  for (const testCase of REPEAT_PARITY_GAPS) {
    it.skip(`known nvim parity gap: ${testCase.name}`);
    void testCase;
  }
});
