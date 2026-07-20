import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

// Undo-scope parity: an insert session (enter insert → <Esc>) collapses to a
// single undo unit, matching Vim's "one undo per change" semantics.
//
// Oracle limitation: the headless nvim driver seeds the buffer with
// `nvim_buf_set_lines` (which is itself undoable) and feeds the whole key
// sequence through a single `feedkeys` call. Multi-change undo sequences and
// content-seeded commands therefore cannot be isolated reliably — `u` can walk
// past the seeded content or coalesce separately-typed changes, and some
// sequences stall the headless driver entirely. The active cases below are
// restricted to single-change insert sessions from an empty buffer, where the
// post-`u` state is unambiguous and matches Vim exactly. The remaining
// spec-listed scenarios (cw/o undo, <C-r>, counted insert) are covered by the
// focused behavioral tests in modal-editor.test.ts ("insert-session undo
// scope") and are recorded here as skipped oracle gaps, not pi-vim divergences.
const UNDO_SCOPE_PARITY_CASES: NvimParityCase[] = [
  {
    name: "i<text><Esc> u undoes the whole insert session in one step",
    initial: {
      text: "",
      cursor: { line: 0, col: 0 },
      mode: "normal",
    },
    keys: ["i", ..."hello world foo".split(""), "\x1b", "u"],
  },
  {
    name: "i<text><Esc> u leaves the cursor at the change start",
    initial: {
      text: "",
      cursor: { line: 0, col: 0 },
      mode: "normal",
    },
    keys: ["i", ..."a few words here".split(""), "\x1b", "u"],
  },
];

describe("nvim parity undo scope", () => {
  for (const testCase of UNDO_SCOPE_PARITY_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }

  // The spec's remaining parity scenarios (cw/o/<C-r>/counted insert undo)
  // cannot be isolated through the headless oracle: `set_lines` seeding is
  // undoable and single-batch `feedkeys` coalesces undo blocks (and some
  // sequences stall the driver). Their one-step undo behavior is asserted
  // behaviorally in modal-editor.test.ts. They are recorded here as known
  // oracle-level parity gaps rather than pi-vim divergences.
  it.skip("cw<text><Esc> u undoes delete+insert in one step (oracle gap)", () => {});
  it.skip("o<text><Esc> u undoes open-line+text in one step (oracle gap)", () => {});
  it.skip("<C-r> restores the whole change (oracle gap)", () => {});
});
