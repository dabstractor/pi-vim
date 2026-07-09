import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_EX_COMMAND_SETTINGS,
  readPiVimBooleanSetting,
  readPiVimClipboardMirrorSetting,
  readPiVimExCommandSetting,
  readPiVimModeChange,
  readPiVimModeColors,
  resolveExCommandSettings,
} from "../settings.js";

describe("piVim mode color settings reader", () => {
  it("returns undefined when mode colors are missing", () => {
    assert.equal(readPiVimModeColors(undefined, undefined), undefined);
    assert.equal(readPiVimModeColors({ piVim: {} }, { piVim: {} }), undefined);
  });

  it("reads partial mode color settings", () => {
    assert.deepEqual(
      readPiVimModeColors(
        { piVim: { modeColors: { insert: " borderMuted " } } },
        {},
      ),
      { insert: "borderMuted" },
    );
  });

  it("reads all three mode color settings", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: {
            modeColors: {
              insert: "muted",
              normal: "primary",
              ex: "warning",
            },
          },
        },
        {},
      ),
      { insert: "muted", normal: "primary", ex: "warning" },
    );
  });

  it("drops non-string mode color leaves", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: { modeColors: { insert: "muted", normal: 42, ex: "warning" } },
        },
        {},
      ),
      { insert: "muted", ex: "warning" },
    );
  });

  it("drops malformed mode color tokens", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: {
            modeColors: {
              insert: "red;evil",
              normal: "_bad",
              ex: "warn-ing_1",
            },
          },
        },
        {},
      ),
      { ex: "warn-ing_1" },
    );
  });

  it("lets project modeColors override global as a setting", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: {
            modeColors: {
              insert: "globalInsert",
              normal: "globalNormal",
              ex: "globalEx",
            },
          },
        },
        { piVim: { modeColors: { ex: "projectEx" } } },
      ),
      { ex: "projectEx" },
    );
  });

  it("does not fall back to global modeColors when project leaves are invalid", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: {
            modeColors: {
              insert: "globalInsert",
              normal: "globalNormal",
              ex: "globalEx",
            },
          },
        },
        {
          piVim: {
            modeColors: {
              insert: "projectInsert",
              normal: 42,
              ex: "red;evil",
            },
          },
        },
      ),
      { insert: "projectInsert" },
    );
  });

  it("treats malformed project modeColors as an override", () => {
    assert.equal(
      readPiVimModeColors(
        { piVim: { modeColors: { insert: "globalInsert" } } },
        { piVim: { modeColors: null } },
      ),
      undefined,
    );
  });
});

describe("piVim boolean settings reader", () => {
  it("returns undefined when boolean setting is missing", () => {
    assert.equal(
      readPiVimBooleanSetting(undefined, undefined, "syncBorderColorWithMode"),
      undefined,
    );
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: {} },
        { piVim: {} },
        "syncBorderColorWithMode",
      ),
      undefined,
    );
  });

  it("reads true and false boolean settings", () => {
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: true } },
        {},
        "syncBorderColorWithMode",
      ),
      true,
    );
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: false } },
        {},
        "syncBorderColorWithMode",
      ),
      false,
    );
  });

  it("ignores invalid boolean settings", () => {
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: "true" } },
        {},
        "syncBorderColorWithMode",
      ),
      undefined,
    );
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: 1 } },
        {},
        "syncBorderColorWithMode",
      ),
      undefined,
    );
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: null } },
        {},
        "syncBorderColorWithMode",
      ),
      undefined,
    );
  });

  it("lets project boolean settings override global", () => {
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: true } },
        { piVim: { syncBorderColorWithMode: false } },
        "syncBorderColorWithMode",
      ),
      false,
    );
  });

  it("treats invalid project boolean settings as an override", () => {
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: true } },
        { piVim: { syncBorderColorWithMode: "false" } },
        "syncBorderColorWithMode",
      ),
      undefined,
    );
  });
});

describe("piVim modeChange settings reader", () => {
  it("returns undefined when modeChange is missing", () => {
    assert.equal(readPiVimModeChange(undefined, undefined), undefined);
    assert.equal(readPiVimModeChange({ piVim: {} }, { piVim: {} }), undefined);
  });

  it("reads partial modeChange settings and trims values", () => {
    assert.deepEqual(
      readPiVimModeChange(
        { piVim: { modeChange: { insert: "  im-select Squirrel  " } } },
        {},
      ),
      { insert: "im-select Squirrel" },
    );
  });

  it("reads both insert and normal commands", () => {
    assert.deepEqual(
      readPiVimModeChange(
        {
          piVim: {
            modeChange: {
              insert: "im-select im.rime.inputmethod.Squirrel.Hans",
              normal: "im-select com.apple.keylayout.ABC",
            },
          },
        },
        {},
      ),
      {
        insert: "im-select im.rime.inputmethod.Squirrel.Hans",
        normal: "im-select com.apple.keylayout.ABC",
      },
    );
  });

  it("drops non-string and empty modeChange leaves", () => {
    assert.deepEqual(
      readPiVimModeChange(
        {
          piVim: { modeChange: { insert: 42, normal: "  " } },
        },
        {},
      ),
      undefined,
    );
    assert.deepEqual(
      readPiVimModeChange(
        { piVim: { modeChange: { insert: "ok", normal: 42 } } },
        {},
      ),
      { insert: "ok" },
    );
  });

  it("ignores project modeChange settings because commands are global-only", () => {
    assert.deepEqual(
      readPiVimModeChange(
        {
          piVim: {
            modeChange: { insert: "global-insert", normal: "global-normal" },
          },
        },
        { piVim: { modeChange: { normal: "project-normal" } } },
      ),
      { insert: "global-insert", normal: "global-normal" },
    );
    assert.deepEqual(
      readPiVimModeChange(
        {},
        { piVim: { modeChange: { insert: "project-insert" } } },
      ),
      undefined,
    );
  });

  it("does not let invalid project modeChange suppress global commands", () => {
    assert.deepEqual(
      readPiVimModeChange(
        { piVim: { modeChange: { insert: "global-insert" } } },
        { piVim: { modeChange: null } },
      ),
      { insert: "global-insert" },
    );
    assert.deepEqual(
      readPiVimModeChange(
        { piVim: { modeChange: { normal: "global-normal" } } },
        { piVim: { modeChange: { insert: "   " } } },
      ),
      { normal: "global-normal" },
    );
  });
});

describe("piVim clipboard mirror settings reader", () => {
  it("returns undefined when global and project settings are missing", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(undefined, undefined),
      undefined,
    );
    assert.equal(readPiVimClipboardMirrorSetting(null, null), undefined);
    assert.equal(readPiVimClipboardMirrorSetting("bad", 42), undefined);
  });

  it("reads global piVim clipboardMirror when project setting is missing", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(
        { piVim: { clipboardMirror: "yank" } },
        {},
      ),
      "yank",
    );
  });

  it("lets project piVim clipboardMirror override global", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(
        { piVim: { clipboardMirror: "never" } },
        { piVim: { clipboardMirror: "all" } },
      ),
      "all",
    );
  });

  it("treats invalid project clipboardMirror as an override instead of falling back to global", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(
        { piVim: { clipboardMirror: "yank" } },
        { piVim: { clipboardMirror: null } },
      ),
      null,
    );
  });

  it("treats malformed project piVim settings as an override instead of falling back to global", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(
        { piVim: { clipboardMirror: "yank" } },
        { piVim: "bad" },
      ),
      "bad",
    );
  });
});

describe("piVim exCommand settings reader", () => {
  it("returns undefined when global and project settings are missing", () => {
    assert.equal(readPiVimExCommandSetting(undefined, undefined), undefined);
    assert.equal(
      readPiVimExCommandSetting({ piVim: {} }, { piVim: {} }),
      undefined,
    );
  });

  it("reads global piVim exCommand when the project setting is missing", () => {
    assert.deepEqual(
      readPiVimExCommandSetting(
        { piVim: { exCommand: { piDispatch: false } } },
        {},
      ),
      { piDispatch: false },
    );
  });

  it("lets project piVim exCommand override global", () => {
    assert.deepEqual(
      readPiVimExCommandSetting(
        { piVim: { exCommand: { piDispatch: true } } },
        { piVim: { exCommand: { piDispatch: false } } },
      ),
      { piDispatch: false },
    );
  });
});

describe("piVim exCommand settings resolver", () => {
  it("defaults to dispatch on and clipboard copy off", () => {
    const resolved = resolveExCommandSettings(undefined);

    assert.deepEqual(resolved.settings, {
      piDispatch: true,
      copyInputToClipboard: false,
    });
    assert.equal(resolved.warning, undefined);
  });

  it("does not hand out the shared defaults object", () => {
    const resolved = resolveExCommandSettings(undefined);

    assert.notEqual(resolved.settings, DEFAULT_EX_COMMAND_SETTINGS);
  });

  it("reads both boolean keys", () => {
    const resolved = resolveExCommandSettings({
      piDispatch: false,
      copyInputToClipboard: true,
    });

    assert.deepEqual(resolved.settings, {
      piDispatch: false,
      copyInputToClipboard: true,
    });
    assert.equal(resolved.warning, undefined);
  });

  it("keeps defaults for keys that are absent", () => {
    const resolved = resolveExCommandSettings({ copyInputToClipboard: true });

    assert.deepEqual(resolved.settings, {
      piDispatch: true,
      copyInputToClipboard: true,
    });
    assert.equal(resolved.warning, undefined);
  });

  it("warns and defaults when the value is not an object", () => {
    for (const value of ["yes", 1, null, [], true]) {
      const resolved = resolveExCommandSettings(value);

      assert.deepEqual(resolved.settings, {
        piDispatch: true,
        copyInputToClipboard: false,
      });
      assert.equal(
        resolved.warning,
        "Invalid piVim.exCommand; expected an object.",
      );
    }
  });

  it("warns and defaults per key when a key is not a boolean", () => {
    const resolved = resolveExCommandSettings({
      piDispatch: "true",
      copyInputToClipboard: 1,
    });

    assert.deepEqual(resolved.settings, {
      piDispatch: true,
      copyInputToClipboard: false,
    });
    assert.equal(
      resolved.warning,
      "Invalid piVim.exCommand piDispatch, copyInputToClipboard; expected a boolean.",
    );
  });

  it("keeps a valid key when a sibling key is invalid", () => {
    const resolved = resolveExCommandSettings({
      piDispatch: false,
      copyInputToClipboard: "on",
    });

    assert.deepEqual(resolved.settings, {
      piDispatch: false,
      copyInputToClipboard: false,
    });
    assert.equal(
      resolved.warning,
      "Invalid piVim.exCommand copyInputToClipboard; expected a boolean.",
    );
  });
});
