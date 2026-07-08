import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModalEditor } from "../index.js";
import {
  createEditorWithSpy,
  createMultiLineEditor,
  sendKeys,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const ESC = "\x1b";
const CTRL_R = "\x12";
const BRACKETED_PASTE = "\x1b[200~pasted\x1b[201~";

type EditorCtorArgs = ConstructorParameters<typeof ModalEditor>;

type MutableEditorState = {
  state?: { lines: string[]; cursorLine: number; cursorCol: number };
};

type AutocompleteProvider = {
  getSuggestions(
    lines: string[],
    line: number,
    col: number,
  ): Promise<{
    items: { value: string; label: string }[];
    prefix: string;
  } | null>;
  applyCompletion(
    lines: string[],
    line: number,
    col: number,
    item: unknown,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
};

type AutocompleteEditor = ModalEditor & {
  setAutocompleteProvider(provider: AutocompleteProvider): void;
  isShowingAutocomplete(): boolean;
};

function makeSubmitEditor(): { editor: ModalEditor; submits: string[] } {
  const submits: string[] = [];
  const submitKeybindings = {
    matches: (data: string, action: string) =>
      action === "tui.input.submit" && data === "\r",
    getKeys: () => [] as string[],
  } as unknown as EditorCtorArgs[2];
  const editor = new ModalEditor(stubTui, stubTheme, submitKeybindings);
  (editor as unknown as { onSubmit: (text: string) => void }).onSubmit = (
    text: string,
  ) => submits.push(text);
  editor.setClipboardFn(() => undefined);
  editor.setClipboardReadFn(() => null);
  return { editor, submits };
}

function makeInterruptEditor(initialText: string): {
  editor: ModalEditor;
  setCursor(cursor: { line: number; col: number }): void;
  getEscapeLeaks(): number;
} {
  const keybindings = {
    matches: (data: string, action: string) =>
      action === "app.interrupt" && data === ESC,
    getKeys: () => [] as string[],
  } as unknown as EditorCtorArgs[2];
  const editor = new ModalEditor(stubTui, stubTheme, keybindings);
  editor.setClipboardFn(() => undefined);
  editor.setClipboardReadFn(() => null);
  editor.setText(initialText);
  editor.handleInput(ESC);

  let escapeLeaks = 0;
  (editor as unknown as { onEscape?: () => void }).onEscape = () => {
    escapeLeaks++;
  };

  const mutable = editor as unknown as MutableEditorState;
  const setCursor = ({ line, col }: { line: number; col: number }) => {
    if (!mutable.state) throw new Error("editor state unavailable");
    mutable.state.cursorLine = line;
    mutable.state.cursorCol = col;
  };
  setCursor({ line: 0, col: 0 });

  return { editor, setCursor, getEscapeLeaks: () => escapeLeaks };
}

function setRawEditorText(editor: ModalEditor, text: string): void {
  const mutable = editor as unknown as MutableEditorState;
  if (!mutable.state) throw new Error("editor state unavailable");
  mutable.state.lines = text.length === 0 ? [""] : text.split("\n");
  mutable.state.cursorLine = 0;
  mutable.state.cursorCol = 0;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("dot repeat review regressions", () => {
  it("does not record insert-mode submit as repeatable input", () => {
    const { editor, submits } = makeSubmitEditor();

    editor.handleInput(ESC);
    sendKeys(editor, ["i", "h", "i", "\r"]);
    assert.deepEqual(submits, ["hi"]);
    assert.equal(editor.getText(), "");
    assert.equal(editor.getMode(), "insert");

    sendKeys(editor, ["o", "k", ESC, "."]);

    assert.deepEqual(submits, ["hi"]);
    assert.equal(editor.getText(), "ok");
    assert.equal(editor.getMode(), "normal");
  });

  it("keeps failed char-motion replay atomic and does not leak Escape", () => {
    const { editor, setCursor, getEscapeLeaks } = makeInterruptEditor(
      "a,b foo\nno comma line\nlast line",
    );

    sendKeys(editor, ["c", "f", ",", "d", "d", ESC]);
    assert.equal(editor.getText().split("\n")[0], "ddb foo");

    setCursor({ line: 1, col: 0 });
    const before = editor.getText();
    sendKeys(editor, ["."]);

    assert.equal(editor.getText(), before);
    assert.equal(getEscapeLeaks(), 0);
  });

  it("keeps rejected counted text-object replay atomic", () => {
    const { editor, setCursor, getEscapeLeaks } =
      makeInterruptEditor("(abc) tail");

    setCursor({ line: 0, col: 1 });
    sendKeys(editor, ["c", "i", "(", "x", ESC]);
    assert.equal(editor.getText(), "(x) tail");

    const before = editor.getText();
    sendKeys(editor, ["3", "."]);

    assert.equal(editor.getText(), before);
    assert.equal(getEscapeLeaks(), 0);
  });

  it("preserves redo history after failed replay rollback", () => {
    const { editor, setCursor, getEscapeLeaks } =
      makeInterruptEditor("(abc) tail");

    setCursor({ line: 0, col: 1 });
    sendKeys(editor, ["c", "i", "(", "x", ESC]);
    const changed = editor.getText();

    sendKeys(editor, ["u"]);
    const undone = editor.getText();
    assert.notEqual(undone, changed);

    sendKeys(editor, ["3", "."]);
    assert.equal(editor.getText(), undone);
    assert.equal(getEscapeLeaks(), 0);

    sendKeys(editor, [CTRL_R]);
    assert.equal(editor.getText(), changed);
  });

  it("drops stale recording when normal-mode bracketed paste cancels d/r", () => {
    for (const pending of ["d", "r"] as const) {
      const { editor } = createEditorWithSpy("abcdef");

      sendKeys(editor, [pending]);
      editor.handleInput(BRACKETED_PASTE);
      sendKeys(editor, ["x", "."]);

      assert.equal(editor.getText(), "cdef", pending);
    }
  });

  it("invalidates repeat state across host setText resets", () => {
    const { editor } = createEditorWithSpy("");

    sendKeys(editor, ["i", "o", "l", "d"]);
    editor.setText("");
    sendKeys(editor, ["n", "e", "w", ESC, "."]);

    assert.equal(editor.getText(), "new");
  });

  it("records identity text changes as the latest repeatable command", () => {
    const { editor } = createEditorWithSpy("Xfoo bar");

    sendKeys(editor, ["x", "0", "c", "w", "f", "o", "o", " ", ESC]);
    assert.equal(editor.getText(), "foo bar");

    sendKeys(editor, ["w", "."]);

    assert.equal(editor.getText(), "foo foo ");
  });

  it("repeats multiline O inserts in original line groups", () => {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
    editor.setClipboardFn(() => undefined);
    editor.setClipboardReadFn(() => null);
    editor.setText("orig");
    editor.handleInput(ESC);

    sendKeys(editor, ["O", "\x1b[200~a\nb\x1b[201~", ESC, "3", "."]);

    assert.equal(editor.getText(), "a\na\nb\na\nb\na\nb\nb\norig");
  });

  it("cancels repeat recording for programmatic insertTextAtCursor changes", () => {
    const { editor } = createMultiLineEditor("alpha beta");
    const beforeRepeat = () => editor.getText();

    sendKeys(editor, ["c", "w"]);
    editor.insertTextAtCursor("[Image #1] ");
    sendKeys(editor, [ESC, "w"]);

    const before = beforeRepeat();
    sendKeys(editor, ["."]);

    assert.equal(editor.getText(), before);
  });

  it("cancels repeat recording for async autocomplete Tab acceptance", async () => {
    const { editor } = createMultiLineEditor("");
    const autocompleteEditor = editor as AutocompleteEditor;

    autocompleteEditor.setAutocompleteProvider({
      async getSuggestions(lines, line, col) {
        const before = (lines[line] ?? "").slice(0, col);
        const match = before.match(/^\/(\w*)$/);
        if (!match || !"help".startsWith(match[1] ?? "")) return null;
        return {
          items: [{ value: "/help", label: "/help" }],
          prefix: `/${match[1]}`,
        };
      },
      applyCompletion(lines, line, col, _item, prefix) {
        const current = lines[line] ?? "";
        const before = current.slice(0, col - prefix.length);
        const after = current.slice(col);
        const inserted = "/help ";
        const next = [...lines];
        next[line] = before + inserted + after;
        return {
          lines: next,
          cursorLine: line,
          cursorCol: (before + inserted).length,
        };
      },
    });

    sendKeys(editor, ["i", "/", "h", "e"]);
    await wait(40);
    assert.equal(autocompleteEditor.isShowingAutocomplete(), true);

    sendKeys(editor, ["\t", ESC]);
    assert.equal(editor.getText(), "/help ");

    setRawEditorText(editor, "");
    sendKeys(editor, ["."]);
    await wait(60);

    assert.equal(editor.getText(), "");
  });
});
