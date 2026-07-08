import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const ESC = "\x1b";

const DOT_REPEAT_FINAL_STATE_CASES: NvimParityCase[] = [
  {
    name: ". repeats a single-key edit",
    initial: { text: "abcdef", cursor: { line: 0, col: 0 } },
    keys: ["x", "."],
  },
  {
    name: "plain . preserves the original edit count",
    initial: { text: "abcdef", cursor: { line: 0, col: 0 } },
    keys: ["2", "x", "."],
  },
  {
    name: "count before . replaces the original edit count",
    initial: { text: "abcdef", cursor: { line: 0, col: 0 } },
    keys: ["2", "x", "3", "."],
  },
  {
    name: "plain . after counted . preserves the replacement count",
    initial: { text: "abcdefghijklm", cursor: { line: 0, col: 0 } },
    keys: ["x", "3", ".", "."],
  },
  {
    name: "plain . after counted . replaces an original edit count",
    initial: { text: "abcdefghijklm", cursor: { line: 0, col: 0 } },
    keys: ["2", "x", "3", ".", "."],
  },
  {
    name: "count before . replaces an operator prefix count",
    initial: {
      text: "one two three four five six seven",
      cursor: { line: 0, col: 0 },
    },
    keys: ["2", "d", "w", "3", "."],
  },
  {
    name: "count before . replaces an operator motion count",
    initial: {
      text: "one two three four five six seven",
      cursor: { line: 0, col: 0 },
    },
    keys: ["d", "2", "w", "3", "."],
  },
  {
    name: "count before . applies to d$ line range",
    initial: {
      text: "abc def\nghi jkl\nmno pqr",
      cursor: { line: 0, col: 4 },
    },
    keys: ["d", "$", "j", "0", "2", "."],
  },
  {
    name: "count before . keeps d$ linewise register before EOF",
    initial: {
      text: "abc def\nghi jkl\nmno pqr\nstu vwx",
      cursor: { line: 0, col: 4 },
    },
    keys: ["d", "$", "j", "0", "2", "."],
  },
  {
    name: "count before . keeps d$ charwise register at EOF",
    initial: {
      text: "abc def\nghi jkl\nmno pqr",
      cursor: { line: 0, col: 4 },
    },
    keys: ["d", "$", "j", "0", "4", "l", "2", "."],
  },
  {
    name: "count before . applies to c$ line range",
    initial: {
      text: "abc def\nghi jkl\nmno pqr",
      cursor: { line: 0, col: 4 },
    },
    keys: ["c", "$", ESC, "j", "0", "2", "."],
  },
  {
    name: "count before . keeps d0 repeat active",
    initial: {
      text: "abc def\nghi jkl\nmno pqr",
      cursor: { line: 1, col: 4 },
    },
    keys: ["d", "0", "j", "4", "l", "2", "."],
  },
  {
    name: "count before . keeps d^ repeat active",
    initial: {
      text: "  abc def\n  ghi jkl\n  mno pqr",
      cursor: { line: 1, col: 6 },
    },
    keys: ["d", "^", "j", "6", "l", "2", "."],
  },
  {
    name: ". repeats captured insert text",
    initial: { text: "X", cursor: { line: 0, col: 0 } },
    keys: ["i", "a", "b", "c", ESC, "0", "."],
  },
  {
    name: "count before . repeats insert text count times",
    initial: { text: "", cursor: { line: 0, col: 0 } },
    keys: ["i", "X", ESC, "3", "."],
  },
  {
    name: "count before . repeats an open-line command count times",
    initial: { text: "a", cursor: { line: 0, col: 0 } },
    keys: ["o", "X", ESC, "3", "."],
  },
  {
    name: "count before . repeats an open-line-above command count times",
    initial: { text: "a", cursor: { line: 0, col: 0 } },
    keys: ["O", "X", ESC, "3", "."],
  },
  {
    name: ". repeats charwise put from the unnamed register",
    initial: { text: "abc", cursor: { line: 0, col: 0 }, register: "X" },
    keys: ["p", "."],
  },
  {
    name: "count before . replaces a counted charwise put",
    initial: { text: "abc", cursor: { line: 0, col: 0 }, register: "X" },
    keys: ["2", "p", "3", "."],
  },
  {
    name: ". repeats normalized line join",
    initial: { text: "a\nb\nc", cursor: { line: 0, col: 0 } },
    keys: ["J", "."],
  },
  {
    name: "count before . replaces counted line join",
    initial: { text: "a\nb\nc\nd\ne", cursor: { line: 0, col: 0 } },
    keys: ["2", "J", "3", "."],
  },
  {
    name: ". repeats replace character",
    initial: { text: "abc", cursor: { line: 0, col: 0 }, register: "keep" },
    keys: ["r", "Z", "l", "."],
  },
  {
    name: ". repeats a completed no-op replace command",
    initial: { text: "ab", cursor: { line: 0, col: 0 }, register: "keep" },
    keys: ["r", "a", "l", "."],
  },
];

describe("nvim parity dot repeat", () => {
  for (const testCase of DOT_REPEAT_FINAL_STATE_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
