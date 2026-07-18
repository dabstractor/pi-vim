import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const PUT_PARITY_CASES: NvimParityCase[] = [
  {
    name: "p puts a character-wise register after the cursor",
    initial: { text: "ab", cursor: { line: 0, col: 0 }, register: "X" },
    keys: ["p"],
  },
  {
    name: "P puts a character-wise register before the cursor",
    initial: { text: "ab", cursor: { line: 0, col: 0 }, register: "X" },
    keys: ["P"],
  },
  {
    name: "p puts a line-wise register below the current line",
    initial: { text: "a\nb", cursor: { line: 0, col: 0 }, register: "X\n" },
    keys: ["p"],
  },
  {
    name: "P puts a line-wise register above the current line",
    initial: { text: "a\nb", cursor: { line: 1, col: 0 }, register: "X\n" },
    keys: ["P"],
  },
  {
    name: "yyp leaves the cursor on the first non-blank of the new line",
    initial: { text: "example", cursor: { line: 0, col: 0 } },
    keys: ["y", "y", "p"],
  },
  {
    name: "p of a line-wise register lands on the first pasted line, not the last",
    initial: {
      text: "a\nb\nc",
      cursor: { line: 0, col: 0 },
      register: "X\nY\n",
    },
    keys: ["p"],
  },
  {
    name: "{count}p of a line-wise register keeps the cursor on the first pasted line",
    initial: { text: "x", cursor: { line: 0, col: 0 }, register: "L\n" },
    keys: ["3", "p"],
  },
  {
    name: "p of a line-wise register lands on the first non-blank column",
    initial: {
      text: "a\nb",
      cursor: { line: 0, col: 0 },
      register: "    ind\n",
    },
    keys: ["p"],
  },
  {
    name: "p of a multi-line character-wise register lands on the first inserted char",
    initial: { text: "ab\ncd", cursor: { line: 0, col: 1 }, register: "X\nY" },
    keys: ["p"],
  },
  {
    name: "{count}p of a character-wise register lands on the last inserted char",
    initial: { text: "X", cursor: { line: 0, col: 0 }, register: "ab" },
    keys: ["3", "p"],
  },
];

// Intentional divergence from Vim, kept consistent with the shared
// `findFirstNonWhitespaceColumn()` helper used by `^` / `I` / `_`: Vim lands on
// the last char of an all-whitespace line, this extension lands at col 0.
// Documented in README "known differences from full Vim". Each case below is
// skipped because it encodes this divergence.
const PUT_DIVERGENCE_CASES: NvimParityCase[] = [
  {
    name: "p of a line-wise register with an all-whitespace first line lands at col 0",
    initial: {
      text: "a\nb",
      cursor: { line: 0, col: 0 },
      register: "   \nX\n",
    },
    keys: ["p"],
  },
];

const JOIN_PARITY_CASES: NvimParityCase[] = [
  {
    name: "J joins the next line with a separating space",
    initial: {
      text: "foo\nbar",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["J"],
  },
  {
    name: "J trims leading whitespace from the right line",
    initial: {
      text: "foo\n  bar",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["J"],
  },
  {
    name: "J preserves trailing whitespace on the left line",
    initial: {
      text: "foo  \nbar",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["J"],
  },
  {
    name: "gJ joins without whitespace normalization",
    initial: {
      text: "foo\nbar",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["g", "J"],
  },
  {
    name: "gJ preserves leading whitespace on the right line",
    initial: {
      text: "foo\n  bar",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["g", "J"],
  },
  {
    name: "3J joins three lines with normalization",
    initial: {
      text: "a\nb\nc\nd",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["3", "J"],
  },
  {
    name: "3gJ joins three lines without normalization",
    initial: {
      text: "a\nb\nc\nd",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["3", "g", "J"],
  },
  {
    name: "J on the last line is a no-op",
    initial: {
      text: "foo\nbar",
      cursor: { line: 1, col: 0 },
      register: "keep",
    },
    keys: ["J"],
  },
];

describe("nvim parity put", () => {
  for (const testCase of PUT_PARITY_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }

  for (const testCase of PUT_DIVERGENCE_CASES) {
    it.skip(
      `intentional divergence (matches ^ all-whitespace behavior): ${testCase.name}`,
    );
  }
});

describe("nvim parity joins", () => {
  for (const testCase of JOIN_PARITY_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
