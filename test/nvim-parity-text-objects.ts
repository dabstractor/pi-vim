import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const WORD_TEXT_OBJECT_CASES: NvimParityCase[] = [
  {
    name: "diw deletes the inner word",
    initial: { text: "alpha beta gamma", cursor: { line: 0, col: 7 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "daw deletes the word plus following whitespace",
    initial: { text: "alpha beta gamma", cursor: { line: 0, col: 7 } },
    keys: ["d", "a", "w"],
  },
  {
    name: "diW deletes the inner WORD",
    initial: { text: "cmd --flag=value next", cursor: { line: 0, col: 7 } },
    keys: ["d", "i", "W"],
  },
  {
    name: "daW deletes the WORD plus following whitespace",
    initial: { text: "cmd --flag=value next", cursor: { line: 0, col: 7 } },
    keys: ["d", "a", "W"],
  },
];

const QUOTE_TEXT_OBJECT_CASES: NvimParityCase[] = [
  {
    name: 'di" deletes inside double quotes',
    initial: { text: 'say("hello world")', cursor: { line: 0, col: 6 } },
    keys: ["d", "i", '"'],
  },
  {
    name: 'da" deletes around double quotes',
    initial: { text: 'say("hello")', cursor: { line: 0, col: 6 } },
    keys: ["d", "a", '"'],
  },
  {
    name: "di' deletes inside single quotes",
    initial: { text: "call('value')", cursor: { line: 0, col: 7 } },
    keys: ["d", "i", "'"],
  },
  {
    name: "da` deletes around backticks",
    initial: { text: "run(`cmd`)", cursor: { line: 0, col: 6 } },
    keys: ["d", "a", "`"],
  },
];

const DELIMITED_TEXT_OBJECT_CASES: NvimParityCase[] = [
  {
    name: "di( deletes inside parentheses",
    initial: { text: "call(foo, bar) tail", cursor: { line: 0, col: 7 } },
    keys: ["d", "i", "("],
  },
  {
    name: "da( deletes around parentheses",
    initial: { text: "call(foo) tail", cursor: { line: 0, col: 6 } },
    keys: ["d", "a", "("],
  },
  {
    name: "di[ deletes inside brackets",
    initial: { text: "list[one, two] tail", cursor: { line: 0, col: 6 } },
    keys: ["d", "i", "["],
  },
  {
    name: "da[ deletes around brackets",
    initial: { text: "list[one, two] tail", cursor: { line: 0, col: 6 } },
    keys: ["d", "a", "["],
  },
  {
    name: "di{ deletes inside braces",
    initial: { text: "map{key: value} tail", cursor: { line: 0, col: 6 } },
    keys: ["d", "i", "{"],
  },
  {
    name: "da{ deletes around braces",
    initial: { text: "map{key: value} tail", cursor: { line: 0, col: 6 } },
    keys: ["d", "a", "{"],
  },
];

const TEXT_OBJECT_FINAL_STATE_CASES: NvimParityCase[] = [
  ...WORD_TEXT_OBJECT_CASES,
  ...QUOTE_TEXT_OBJECT_CASES,
  ...DELIMITED_TEXT_OBJECT_CASES,
];

describe("nvim parity text objects", () => {
  for (const testCase of TEXT_OBJECT_FINAL_STATE_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
