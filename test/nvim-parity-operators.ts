import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const OPERATOR_MOTION_FINAL_STATE_CASES: NvimParityCase[] = [
  {
    name: "dw - deletes to the next word start",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["d", "w"],
  },
  {
    name: "de - deletes through the current word end",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["d", "e"],
  },
  {
    name: "db - deletes back to the previous word start",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 7 } },
    keys: ["d", "b"],
  },
  {
    name: "d$ - deletes through line end from line start",
    initial: { text: "foo bar", cursor: { line: 0, col: 0 } },
    keys: ["d", "$"],
  },
  {
    name: "d0 - deletes back to absolute line start",
    initial: { text: "  foo bar baz", cursor: { line: 0, col: 8 } },
    keys: ["d", "0"],
  },
  {
    name: "d^ - deletes back to first non-blank",
    initial: { text: "  foo bar baz", cursor: { line: 0, col: 8 } },
    keys: ["d", "^"],
  },
  {
    name: "dW - deletes to the next WORD start",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 0 } },
    keys: ["d", "W"],
  },
  {
    name: "dE - deletes through the current WORD end",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 0 } },
    keys: ["d", "E"],
  },
  {
    name: "dB - deletes back to the previous WORD start",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 14 } },
    keys: ["d", "B"],
  },
  {
    name: "cw - changes whitespace to the next word start",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 3 } },
    keys: ["c", "w", "Z", "\x1b"],
  },
  {
    name: "ce - changes through the current word end",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["c", "e", "Z", "\x1b"],
  },
  {
    name: "cb - changes back to the previous word start",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 7 } },
    keys: ["c", "b", "Z", "\x1b"],
  },
  {
    name: "c$ - changes through line end",
    initial: { text: "  foo bar baz", cursor: { line: 0, col: 2 } },
    keys: ["c", "$", "Z", "\x1b"],
  },
  {
    name: "c0 - changes back to absolute line start",
    initial: { text: "  foo bar baz", cursor: { line: 0, col: 8 } },
    keys: ["c", "0", "Z", "\x1b"],
  },
  {
    name: "c^ - changes back to first non-blank",
    initial: { text: "  foo bar baz", cursor: { line: 0, col: 8 } },
    keys: ["c", "^", "Z", "\x1b"],
  },
  {
    name: "cW - changes through the current WORD end",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 0 } },
    keys: ["c", "W", "Z", "\x1b"],
  },
  {
    name: "cE - changes through the current WORD end",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 0 } },
    keys: ["c", "E", "Z", "\x1b"],
  },
  {
    name: "cB - changes back to the previous WORD start",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 14 } },
    keys: ["c", "B", "Z", "\x1b"],
  },
  {
    name: "yw - yanks to the next word start",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["y", "w"],
  },
  {
    name: "ye - yanks through the current word end",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["y", "e"],
  },
  {
    name: "y$ - yanks through line end",
    initial: { text: "  foo bar baz", cursor: { line: 0, col: 2 } },
    keys: ["y", "$"],
  },
  {
    name: "yW - yanks to the next WORD start",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 0 } },
    keys: ["y", "W"],
  },
  {
    name: "yE - yanks through the current WORD end",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 0 } },
    keys: ["y", "E"],
  },
];

describe("nvim parity operators with motions", () => {
  for (const testCase of OPERATOR_MOTION_FINAL_STATE_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
