import {
  CustomEditor,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  ClipboardMirror,
  type ClipboardReadFn,
  readClipboardInChildProcess,
  writeClipboardInChildProcess,
} from "./clipboard-mirror.js";
import {
  type ClipboardMirrorPolicy,
  DEFAULT_CLIPBOARD_MIRROR_POLICY,
  type RegisterWriteSource,
  resolveClipboardMirrorPolicy,
} from "./clipboard-policy.js";
import {
  BLOCK_CURSOR_SHAPE,
  type CursorShapeCleanup,
  type CursorShapeRuntime,
  type CursorShapeSequence,
  enableCursorShapeSupport,
  getCursorShapeRuntime,
  hasPromptCursorMarker,
  INSERT_CURSOR_SHAPE,
  stripSoftwareCursorWhenHardwareCursorIsUsed,
} from "./cursor-shape.js";
import {
  isBackspaceLikeInput,
  isCountStarter,
  isDigit,
  isEnterLikeInput,
  isEscapeLikeInput,
  isPrintableChunk,
  isPrintableInput,
} from "./input-keys.js";
import {
  cancelModeChangeCommands,
  createModeChangeHandler,
  setModeChangeCommandRunnerForTests,
} from "./mode-change-command.js";
import {
  buildModeColorizers,
  type ModeColorizers,
  type ModeColorKey,
  resolveModeColors,
} from "./mode-colors.js";
import { fitModeLabel } from "./mode-label.js";
import {
  findCharMotionTarget,
  findFirstNonWhitespaceColumn,
  findParagraphMotionTarget,
  getLineGraphemes,
  reverseCharMotion,
  type WordMotionClass,
} from "./motions.js";
import { readPiVimSettings } from "./settings.js";
import {
  resolveDelimitedTextObjectRange,
  resolveMatchingPairMotionTarget,
  resolveWordTextObjectRange,
  type TextObjectKind,
  type TextObjectRange,
  type WordTextObjectClass,
} from "./text-objects.js";
import type {
  CharMotion,
  LastCharMotion,
  Mode,
  PendingMotion,
  PendingOperator,
} from "./types.js";
import {
  CHAR_MOTION_KEYS,
  CTRL_A,
  CTRL_E,
  CTRL_K,
  CTRL_R,
  CTRL_UNDERSCORE,
  ESC_DOWN,
  ESC_LEFT,
  ESC_RIGHT,
  ESC_UP,
  NEWLINE,
  NORMAL_KEYS,
} from "./types.js";
import {
  clampVisualPosition,
  getInclusiveEndColumn,
  getVisualLineRange,
  isVisualMode,
  orderVisualEndpoints,
  type VisualMode,
  type VisualPosition,
} from "./visual.js";
import {
  WordBoundaryCache,
  type WordMotionDirection,
  type WordMotionTarget,
} from "./word-boundary-cache.js";

export { setModeChangeCommandRunnerForTests };

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const BRACKETED_PASTE_END_TAIL = BRACKETED_PASTE_END.slice(1);
const MAX_COUNT = 9999;
const TEXT_INSERT_REPEAT_KEYS = new Set(["i", "a", "A", "I"]);
const OPEN_LINE_REPEAT_KEYS = new Set(["o", "O"]);
const REPEATABLE_COMMAND_START_KEYS = new Set([
  "d",
  "c",
  "r",
  "p",
  "P",
  "J",
  "g",
  ...TEXT_INSERT_REPEAT_KEYS,
  ...OPEN_LINE_REPEAT_KEYS,
  "D",
  "C",
  "S",
  "s",
  "x",
]);
// Normal-mode commands that must never run while a visual selection is live.
// They are swallowed instead of falling through to the normal-mode dispatch.
const VISUAL_IGNORED_KEYS = new Set([
  "p",
  "P",
  "r",
  "J",
  "u",
  "U",
  "~",
  ">",
  "<",
  ".",
  ":",
  "i",
  "a",
  "A",
  "I",
  "R",
  CTRL_R,
  CTRL_UNDERSCORE,
]);

type EditorSnapshot = {
  text: string;
  cursor: { line: number; col: number };
};

type RepeatRecording = {
  /** Raw key inputs that reconstruct one repeatable normal-mode change. */
  keys: string[];
  /** Replay keys without command counts, used when `{count}.` overrides them. */
  countOverrideKeys: string[];
  /** Buffer mutation version before the command started. */
  startChangeVersion: number;
  /** True while the command is collecting insert-mode input until Escape. */
  captureInsert: boolean;
  /** True when a command completed even if it emitted no mutation event. */
  forceCommit: boolean;
};

type RepeatableCommand = Pick<RepeatRecording, "keys" | "countOverrideKeys">;

type TransitionState = "none" | "undo" | "redo" | "restore";

type ModalEditorInternals = {
  state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
  preferredVisualCol?: number | null;
  lastAction?: string | null;
  historyIndex?: number;
  onChange?: (text: string) => void;
  tui?: { requestRender?: () => void };
  pushUndoSnapshot?: () => void;
  setCursorCol?: (col: number) => void;
};

type CustomEditorConstructorArgs = ConstructorParameters<typeof CustomEditor>;

type ModalEditorOptions = {
  labelColorizers?: ModeColorizers | null;
  borderColorizers?: ModeColorizers | null;
};

export class ModalEditor extends CustomEditor {
  private mode: Mode = "insert";
  private pendingMotion: PendingMotion = null;
  private pendingTextObject: TextObjectKind | null = null;
  private pendingOperator: PendingOperator = null;
  private prefixCount: string = "";
  private operatorCount: string = "";
  private pendingG: boolean = false;
  private pendingGCount: string = "";
  private pendingReplace: boolean = false;
  private visualAnchor: VisualPosition | null = null;
  private pendingExCommand: string | null = null;
  private acceptingBracketedPasteInExCommand: boolean = false;
  private pendingEscWhileAcceptingBracketedPasteInExCommand: boolean = false;
  private lastCharMotion: LastCharMotion | null = null;
  private discardingBracketedPasteInNormalMode: boolean = false;
  private pendingEscWhileDiscardingBracketedPasteInNormalMode: boolean = false;
  private wordBoundaryCache = new WordBoundaryCache();
  private readonly redoStack: EditorSnapshot[] = [];
  private lastRepeatableCommand: RepeatableCommand | null = null;
  private repeatRecording: RepeatRecording | null = null;
  private replayingRepeat: boolean = false;
  private repeatReplayFailed: boolean = false;
  private bufferChangeVersion: number = 0;
  private currentTransition: TransitionState = "none";
  private onChangeHooked: boolean = false;
  private readonly labelColorizers: ModeColorizers | null;
  private readonly borderColorizers: ModeColorizers | null;
  private readonly cursorShapeRuntime: CursorShapeRuntime | null;
  private lastCursorShapeSequence: CursorShapeSequence | null = null;
  private lastLineCache = { l: "", w: 0, label: "", result: "" };

  private unnamedRegister: string = "";
  private preferRegisterForPut = false;
  private clipboardMirrorPolicy: ClipboardMirrorPolicy =
    DEFAULT_CLIPBOARD_MIRROR_POLICY;
  private readonly clipboardMirror = new ClipboardMirror(
    writeClipboardInChildProcess,
  );
  private clipboardReadFn: ClipboardReadFn = readClipboardInChildProcess;
  private quitFn: () => void = () => {};
  private notifyFn: (message: string) => void = () => {};
  private modeChangeFn: (mode: Mode, prevMode: Mode) => void = () => {};

  constructor(
    tui: CustomEditorConstructorArgs[0],
    theme: CustomEditorConstructorArgs[1],
    kb: CustomEditorConstructorArgs[2],
    opts?: ModalEditorOptions,
  ) {
    super(tui, theme, kb);
    this.cursorShapeRuntime = getCursorShapeRuntime(tui);
    this.labelColorizers = opts?.labelColorizers ?? null;
    this.borderColorizers = opts?.borderColorizers ?? null;
    this.installModeBorderColorizer();
  }

  setClipboardFn(fn: (text: string, signal?: AbortSignal) => unknown): void {
    this.clipboardMirror.setWriteFn(
      async (text: string, signal: AbortSignal) => {
        await fn(text, signal);
      },
    );
  }
  setClipboardWriteTimeoutMs(timeoutMs: number): void {
    this.clipboardMirror.setTimeoutMs(timeoutMs);
  }
  setClipboardReadFn(fn: ClipboardReadFn): void {
    this.clipboardReadFn = fn;
  }
  setClipboardMirrorPolicy(policy: ClipboardMirrorPolicy): void {
    this.clipboardMirrorPolicy = policy;
  }
  getClipboardMirrorPolicy(): ClipboardMirrorPolicy {
    return this.clipboardMirrorPolicy;
  }
  setQuitFn(fn: () => void): void {
    this.quitFn = fn;
  }
  setNotifyFn(fn: (message: string) => void): void {
    this.notifyFn = fn;
  }
  setModeChangeFn(fn: (mode: Mode, prevMode: Mode) => void): void {
    this.modeChangeFn = fn;
  }
  getRegister(): string {
    return this.unnamedRegister;
  }
  setRegister(text: string): void {
    this.unnamedRegister = text;
    this.preferRegisterForPut = false;
  }
  getMode(): Mode {
    return this.mode;
  }
  getText(): string {
    return this.getLines().join("\n");
  }

  private getActiveMode(): ModeColorKey {
    if (this.pendingExCommand !== null) return "ex";
    return this.mode === "insert" ? "insert" : "normal";
  }

  private installModeBorderColorizer(): void {
    if (!this.borderColorizers) return;
    let base = this.borderColor;
    const modeBorderColor = (text: string) =>
      (this.borderColorizers?.[this.getActiveMode()] ?? base)(text);
    // Pi assigns its default border color after extension editor construction.
    // Keep a mode-aware getter installed and treat later assignments as the
    // fallback/base color, otherwise syncBorderColorWithMode is overwritten in
    // real sessions even though direct editor tests pass.
    Object.defineProperty(this, "borderColor", {
      get: () => modeBorderColor,
      set(next: unknown) {
        if (typeof next === "function") base = next as typeof base;
      },
    });
  }

  private setMode(mode: Mode = "insert"): void {
    const prev = this.mode;
    this.mode = mode;
    if (prev !== mode) {
      try {
        this.modeChangeFn(mode, prev);
      } catch {
        // mode-change side effects must never break editing
      }
    }
  }

  override setText(text: string): void {
    this.clearRedoStack();
    this.clearRepeatState();
    super.setText(text);
  }

  override insertTextAtCursor(text: string): void {
    this.cancelRepeatableCommand();
    super.insertTextAtCursor(text);
  }

  private captureSnapshot(): EditorSnapshot {
    const cursor = this.getCursor();
    return {
      text: this.getText(),
      cursor: { line: cursor.line, col: cursor.col },
    };
  }

  private requireRedoRestoreState(editor: ModalEditorInternals): {
    lines: string[];
    cursorLine?: number;
    cursorCol?: number;
  } {
    const state = editor.state;
    if (!state || !Array.isArray(state.lines)) {
      throw new Error("Redo restore prerequisite: editor state unavailable");
    }
    return state as {
      lines: string[];
      cursorLine?: number;
      cursorCol?: number;
    };
  }

  private restoreSnapshot(snapshot: EditorSnapshot): void {
    const editor = this as unknown as ModalEditorInternals;
    const state = this.requireRedoRestoreState(editor);

    const lines = snapshot.text.split("\n");
    state.lines = lines.length > 0 ? lines : [""];

    const maxLine = Math.max(0, state.lines.length - 1);
    const cursorLine = Math.max(0, Math.min(snapshot.cursor.line, maxLine));
    const line = state.lines[cursorLine] ?? "";
    const cursorCol = Math.max(0, Math.min(snapshot.cursor.col, line.length));

    state.cursorLine = cursorLine;
    if (typeof editor.setCursorCol === "function") {
      editor.setCursorCol(cursorCol);
    } else {
      state.cursorCol = cursorCol;
      editor.preferredVisualCol = null;
    }

    this.invalidateWordBoundaryCache();

    editor.historyIndex = -1;
    editor.lastAction = null;
    editor.onChange?.(this.getText());
    editor.tui?.requestRender?.();
  }

  private snapshotChanged(a: EditorSnapshot, b: EditorSnapshot): boolean {
    return (
      a.text !== b.text ||
      a.cursor.line !== b.cursor.line ||
      a.cursor.col !== b.cursor.col
    );
  }

  private withTransition<T>(
    transition: Exclude<TransitionState, "none">,
    action: () => T,
  ): T {
    const previousTransition = this.currentTransition;
    this.currentTransition = transition;
    try {
      return action();
    } finally {
      this.currentTransition = previousTransition;
    }
  }

  private performUndo(count: number = this.takeTotalCount(1)): void {
    const maxSteps = Math.max(1, Math.min(MAX_COUNT, count));
    for (let i = 0; i < maxSteps; i++) {
      let changed = false;
      this.withTransition("undo", () => {
        const beforeUndo = this.captureSnapshot();
        super.handleInput(CTRL_UNDERSCORE);
        const afterUndo = this.captureSnapshot();

        if (this.snapshotChanged(beforeUndo, afterUndo)) {
          this.redoStack.push(beforeUndo);
          changed = true;
        }
      });
      if (!changed) break;
    }
  }

  private performRedo(count: number = this.takeTotalCount(1)): void {
    const maxSteps = Math.max(1, Math.min(MAX_COUNT, count));
    const editor = this as unknown as ModalEditorInternals;

    for (let i = 0; i < maxSteps; i++) {
      const snapshot = this.redoStack[this.redoStack.length - 1];
      if (!snapshot) break;

      this.withTransition("redo", () => {
        this.requireRedoRestoreState(editor);
        if (typeof editor.pushUndoSnapshot !== "function") {
          throw new Error(
            "Redo restore prerequisite: pushUndoSnapshot unavailable",
          );
        }
        editor.pushUndoSnapshot();
        this.restoreSnapshot(snapshot);
        this.redoStack.pop();
      });
    }
  }

  private clearRedoStack(): void {
    this.redoStack.length = 0;
  }

  private invalidateWordBoundaryCache(): void {
    this.wordBoundaryCache = new WordBoundaryCache();
  }

  private ensureOnChangeHook(): void {
    if (this.onChangeHooked) return;

    const editor = this as unknown as ModalEditorInternals;
    const originalOnChange = editor.onChange;

    editor.onChange = (text: string) => {
      originalOnChange?.(text);
      this.bufferChangeVersion++;
      this.centralInvalidationCheck();
    };

    this.onChangeHooked = true;
  }

  private centralInvalidationCheck(): void {
    if (this.redoStack.length === 0) return;
    if (this.currentTransition !== "none") return;
    this.clearRedoStack();
  }

  private isRepeatRecordingInProgress(): boolean {
    return (
      this.pendingMotion !== null ||
      this.pendingTextObject !== null ||
      this.pendingOperator !== null ||
      this.pendingG ||
      this.pendingReplace
    );
  }

  private isRepeatableCommandStart(key: string): boolean {
    return REPEATABLE_COMMAND_START_KEYS.has(key);
  }

  private isOperatorCountDigit(key: string): boolean {
    return isDigit(key) && (key !== "0" || this.operatorCount.length > 0);
  }

  private shouldStripKeyFromCountOverride(key: string): boolean {
    if (this.mode === "insert") return false;
    if (this.pendingMotion || this.pendingTextObject || this.pendingReplace) {
      return false;
    }
    if (!this.pendingOperator) return false;
    return this.isOperatorCountDigit(key);
  }

  private shouldCancelInsertRepeatInput(key: string): boolean {
    if (key === "\r") return true;
    return key === "\t" && this.isShowingAutocomplete();
  }

  /**
   * Dot-repeat is recorded by watching the key stream for one normal-mode
   * change. The raw key stream is kept for plain `.`, while a second stream
   * strips normal-mode command counts so `{count}.` can replace the stored
   * count like Vim instead of multiplying it by repeated replay.
   */
  private prepareRepeatRecordingForInput(key: string): void {
    if (this.replayingRepeat || this.pendingExCommand !== null) return;

    // Visual-mode operators are not dot-repeatable; they clear the stored
    // command instead of recording a normal-mode key stream that would replay
    // as something else entirely.
    if (isVisualMode(this.mode)) return;

    if (this.mode === "insert") {
      if (this.shouldCancelInsertRepeatInput(key)) {
        this.clearRepeatState();
        return;
      }
      if (this.repeatRecording?.captureInsert) {
        this.repeatRecording.keys.push(key);
        this.repeatRecording.countOverrideKeys.push(key);
      }
      return;
    }

    if (this.repeatRecording && !this.isRepeatRecordingInProgress()) {
      this.cancelRepeatableCommand();
    }

    if (this.repeatRecording) {
      this.repeatRecording.keys.push(key);
      if (!this.shouldStripKeyFromCountOverride(key)) {
        this.repeatRecording.countOverrideKeys.push(key);
      }
      return;
    }

    if (this.isRepeatRecordingInProgress()) return;
    if (!this.isRepeatableCommandStart(key)) return;

    this.repeatRecording = {
      keys: [...this.prefixCount, key],
      countOverrideKeys: [key],
      startChangeVersion: this.bufferChangeVersion,
      captureInsert: false,
      forceCommit: false,
    };
  }

  private clearRepeatState(): void {
    if (this.replayingRepeat) return;
    this.repeatRecording = null;
    this.lastRepeatableCommand = null;
  }

  private cancelRepeatableCommand(): void {
    if (this.replayingRepeat) {
      this.repeatReplayFailed = true;
      return;
    }
    this.repeatRecording = null;
  }

  private forceCommitRepeatRecording(): void {
    if (this.replayingRepeat || !this.repeatRecording) return;
    this.repeatRecording.forceCommit = true;
  }

  /**
   * Commit only after the watched command has completed and changed the buffer.
   * This naturally ignores motions, yanks, failed edits, and aborted pending
   * commands while keeping insert-mode changes open until Escape returns to
   * normal mode.
   */
  private finishRepeatRecordingAfterInput(): void {
    if (this.replayingRepeat) return;

    const recording = this.repeatRecording;
    if (!recording) return;

    if (this.mode === "insert") {
      recording.captureInsert = true;
      return;
    }

    if (this.isRepeatRecordingInProgress()) return;

    this.repeatRecording = null;
    if (recording.keys.length === 0) return;

    if (
      recording.forceCommit ||
      this.bufferChangeVersion !== recording.startChangeVersion
    ) {
      this.lastRepeatableCommand = {
        keys: [...recording.keys],
        countOverrideKeys: [...recording.countOverrideKeys],
      };
    }
  }

  private isTextInsertRepeatCommand(command: RepeatableCommand): boolean {
    return TEXT_INSERT_REPEAT_KEYS.has(command.countOverrideKeys[0] ?? "");
  }

  private isOpenLineRepeatCommand(command: RepeatableCommand): boolean {
    return OPEN_LINE_REPEAT_KEYS.has(command.countOverrideKeys[0] ?? "");
  }

  private getOpenLineRepeatReplayKeys(
    command: RepeatableCommand,
    overrideCount: number,
  ): string[] {
    if (command.countOverrideKeys[0] !== "O" || overrideCount <= 1) {
      return Array.from(
        { length: overrideCount },
        () => command.countOverrideKeys,
      ).flat();
    }

    return Array.from({ length: overrideCount }, (_, index) =>
      index === 0
        ? command.countOverrideKeys
        : ["j", ...command.countOverrideKeys],
    ).flat();
  }

  private getRepeatReplayKeys(
    command: RepeatableCommand,
    hasOverrideCount: boolean,
    overrideCount: number,
  ): string[] {
    if (!hasOverrideCount) return command.keys;

    if (this.isOpenLineRepeatCommand(command)) {
      return this.getOpenLineRepeatReplayKeys(command, overrideCount);
    }

    if (this.isTextInsertRepeatCommand(command)) {
      const [startKey, ...continuation] = command.countOverrideKeys;
      const finalKey = continuation[continuation.length - 1];
      const hasFinalEscape =
        finalKey !== undefined && isEscapeLikeInput(finalKey);
      const insertKeys = hasFinalEscape
        ? continuation.slice(0, -1)
        : continuation;
      return [
        startKey,
        ...Array.from({ length: overrideCount }, () => insertKeys).flat(),
        ...(hasFinalEscape ? [finalKey] : []),
      ];
    }

    return [...String(overrideCount), ...command.countOverrideKeys];
  }

  /**
   * Replay the last committed change. Plain `.` replays the original command,
   * including its count. A count before `.` replaces the original command count.
   * Replay runs with recording disabled so `.` itself never changes what is
   * stored as the last repeatable command.
   */
  private repeatLastCommand(): void {
    const command = this.lastRepeatableCommand;
    const hasOverrideCount = this.hasPendingCount();
    const overrideCount = this.takeTotalCount(1);
    if (!command || command.keys.length === 0) return;

    const replayKeys = this.getRepeatReplayKeys(
      command,
      hasOverrideCount,
      overrideCount,
    );
    const beforeReplay = this.captureSnapshot();
    const beforeRegister = this.unnamedRegister;
    const beforePreferRegisterForPut = this.preferRegisterForPut;

    this.repeatRecording = null;
    this.repeatReplayFailed = false;
    this.replayingRepeat = true;
    try {
      for (const key of replayKeys) {
        this.handleInput(key);
        if (this.repeatReplayFailed) break;
      }
    } finally {
      this.replayingRepeat = false;
    }

    if (this.repeatReplayFailed) {
      this.clearPendingState();
      this.withTransition("restore", () => {
        this.restoreSnapshot(beforeReplay);
      });
      this.unnamedRegister = beforeRegister;
      this.preferRegisterForPut = beforePreferRegisterForPut;
      this.repeatReplayFailed = false;
      return;
    }

    if (hasOverrideCount) {
      this.lastRepeatableCommand = {
        keys: [...replayKeys],
        countOverrideKeys: [...command.countOverrideKeys],
      };
    }
  }

  private applySyntheticEdit(mutation: () => void): void {
    const editor = this as unknown as ModalEditorInternals;
    if (!editor.state || !Array.isArray(editor.state.lines)) {
      throw new Error("Synthetic edit prerequisite: editor state unavailable");
    }

    if (typeof editor.pushUndoSnapshot !== "function") {
      throw new Error(
        "Synthetic edit prerequisite: pushUndoSnapshot unavailable",
      );
    }

    const textBefore = this.getText();
    const preCursorLine = editor.state.cursorLine;
    const preCursorCol = editor.state.cursorCol;

    mutation();

    if (this.getText() === textBefore) return;

    const postLines = editor.state.lines.slice();
    const postCursorLine = editor.state.cursorLine;
    const postCursorCol = editor.state.cursorCol;
    const postPreferredCol = editor.preferredVisualCol;

    const preLines = textBefore.split("\n");
    editor.state.lines = preLines.length > 0 ? preLines : [""];
    editor.state.cursorLine = preCursorLine;
    editor.state.cursorCol = preCursorCol;
    editor.pushUndoSnapshot();

    editor.state.lines = postLines;
    editor.state.cursorLine = postCursorLine;
    editor.state.cursorCol = postCursorCol;
    editor.preferredVisualCol = postPreferredCol;

    editor.onChange?.(this.getText());
    editor.tui?.requestRender?.();
  }

  private startPendingExCommand(): void {
    this.pendingExCommand = ":";
    this.acceptingBracketedPasteInExCommand = false;
    this.pendingEscWhileAcceptingBracketedPasteInExCommand = false;
  }

  private clearPendingExCommand(): void {
    const shouldDiscardBracketedPasteTail =
      this.acceptingBracketedPasteInExCommand ||
      this.pendingEscWhileAcceptingBracketedPasteInExCommand;

    this.pendingExCommand = null;
    this.acceptingBracketedPasteInExCommand = false;
    this.pendingEscWhileAcceptingBracketedPasteInExCommand = false;

    if (shouldDiscardBracketedPasteTail) {
      this.discardingBracketedPasteInNormalMode = true;
      this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
    }
  }

  private clearPendingState(): void {
    this.pendingMotion = null;
    this.pendingTextObject = null;
    this.pendingOperator = null;
    this.prefixCount = "";
    this.operatorCount = "";
    this.pendingG = false;
    this.pendingGCount = "";
    this.pendingReplace = false;
    this.clearPendingExCommand();
  }

  private normalizePendingExCommandInput(data: string): string | null {
    let chunk = data;
    let normalized = "";

    while (true) {
      if (this.acceptingBracketedPasteInExCommand) {
        if (this.pendingEscWhileAcceptingBracketedPasteInExCommand) {
          if (chunk.startsWith(BRACKETED_PASTE_END_TAIL)) {
            this.pendingEscWhileAcceptingBracketedPasteInExCommand = false;
            this.acceptingBracketedPasteInExCommand = false;
            chunk = chunk.slice(BRACKETED_PASTE_END_TAIL.length);
            if (chunk.length === 0) {
              return normalized.length > 0 ? normalized : null;
            }
            continue;
          }

          normalized += "\x1b";
          this.pendingEscWhileAcceptingBracketedPasteInExCommand = false;
        }

        const end = chunk.indexOf(BRACKETED_PASTE_END);
        if (end !== -1) {
          normalized += chunk.slice(0, end);
          this.acceptingBracketedPasteInExCommand = false;
          chunk = chunk.slice(end + BRACKETED_PASTE_END.length);
          if (chunk.length === 0) {
            return normalized.length > 0 ? normalized : null;
          }
          continue;
        }

        if (isEscapeLikeInput(chunk)) {
          this.pendingEscWhileAcceptingBracketedPasteInExCommand = true;
          return normalized.length > 0 ? normalized : null;
        }

        normalized += chunk;
        return normalized.length > 0 ? normalized : null;
      }

      const start = chunk.indexOf(BRACKETED_PASTE_START);
      if (start === -1) {
        normalized += chunk;
        return normalized.length > 0 ? normalized : null;
      }

      normalized += chunk.slice(0, start);
      chunk = chunk.slice(start + BRACKETED_PASTE_START.length);
      this.acceptingBracketedPasteInExCommand = true;
      if (chunk.length === 0) {
        return normalized.length > 0 ? normalized : null;
      }
    }
  }

  private stripBracketedPasteInNormalMode(data: string): {
    filtered: string | null;
    stripped: boolean;
  } {
    let chunk = data;
    let stripped = false;

    while (true) {
      if (this.discardingBracketedPasteInNormalMode) {
        stripped = true;
        const end = chunk.indexOf(BRACKETED_PASTE_END);
        if (end === -1) {
          return { filtered: null, stripped };
        }
        this.discardingBracketedPasteInNormalMode = false;
        this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
        chunk = chunk.slice(end + BRACKETED_PASTE_END.length);
        if (!chunk) return { filtered: null, stripped };
      }

      const start = chunk.indexOf(BRACKETED_PASTE_START);
      if (start === -1) {
        return { filtered: chunk, stripped };
      }

      stripped = true;
      const end = chunk.indexOf(
        BRACKETED_PASTE_END,
        start + BRACKETED_PASTE_START.length,
      );
      if (end === -1) {
        this.discardingBracketedPasteInNormalMode = true;
        const leading = chunk.slice(0, start);
        return { filtered: leading.length > 0 ? leading : null, stripped };
      }

      chunk =
        chunk.slice(0, start) + chunk.slice(end + BRACKETED_PASTE_END.length);
      if (!chunk) return { filtered: null, stripped };
    }
  }

  handleInput(data: string): void {
    this.ensureOnChangeHook();

    if (this.pendingExCommand !== null) {
      const normalized = this.normalizePendingExCommandInput(data);
      if (normalized === null) return;
      data = normalized;
    } else if (this.mode !== "insert") {
      if (this.discardingBracketedPasteInNormalMode) {
        if (isEscapeLikeInput(data)) {
          if (this.pendingEscWhileDiscardingBracketedPasteInNormalMode) {
            this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
            this.discardingBracketedPasteInNormalMode = false;
            this.clearPendingState();
            this.cancelRepeatableCommand();
            return;
          } else {
            this.pendingEscWhileDiscardingBracketedPasteInNormalMode = true;
            this.clearPendingState();
            this.cancelRepeatableCommand();
            return;
          }
        } else if (this.pendingEscWhileDiscardingBracketedPasteInNormalMode) {
          if (data.startsWith(BRACKETED_PASTE_END_TAIL)) {
            this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
            this.discardingBracketedPasteInNormalMode = false;
            data = data.slice(BRACKETED_PASTE_END_TAIL.length);
            if (data.length === 0) {
              this.clearPendingState();
              this.cancelRepeatableCommand();
              return;
            }
          } else {
            this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
          }
        }
      }

      const { filtered, stripped } = this.stripBracketedPasteInNormalMode(data);
      if (stripped) {
        this.clearPendingState();
        this.cancelRepeatableCommand();
      }
      if (filtered === null) return;
      data = filtered;
    }

    this.prepareRepeatRecordingForInput(data);
    try {
      if (isEscapeLikeInput(data)) {
        this.handleEscape();
        return;
      }

      if ("insert" === this.mode) {
        if (matchesKey(data, Key.shiftAlt("a")) || data === "\x1bA") {
          super.handleInput(CTRL_E);
          return;
        }
        if (matchesKey(data, Key.shiftAlt("i")) || data === "\x1bI") {
          super.handleInput(CTRL_A);
          return;
        }
        if (matchesKey(data, Key.alt("o")) || data === "\x1bo") {
          this.openLineBelow();
          return;
        }
        if (matchesKey(data, Key.shiftAlt("o")) || data === "\x1bO") {
          this.openLineAbove();
          return;
        }
        super.handleInput(data);
        return;
      }

      if (this.pendingReplace) {
        this.pendingReplace = false;
        if (!isPrintableInput(data)) {
          this.prefixCount = "";
          this.operatorCount = "";
          this.cancelRepeatableCommand();
          return;
        }

        const count = this.takeTotalCount(1);
        const cursor = this.getCursor();
        const line = this.getLines()[cursor.line] ?? "";
        const range = this.getGraphemeRangeAtCol(line, cursor.col, count);
        if (!range) {
          this.cancelRepeatableCommand();
          return;
        }

        const before = line.slice(0, range.start);
        const after = line.slice(range.end);
        const replacement = data.repeat(count);
        const lineStartAbs = this.getAbsoluteIndex(cursor.line, 0);
        const text = this.getText();
        const newText =
          text.slice(0, lineStartAbs) +
          before +
          replacement +
          after +
          text.slice(lineStartAbs + line.length);
        const newCursorAbs =
          lineStartAbs + before.length + data.length * (count - 1);
        this.forceCommitRepeatRecording();
        this.replaceTextInBuffer(newText, newCursorAbs);
        return;
      }

      if (this.pendingExCommand !== null) {
        this.handlePendingExCommand(data);
        return;
      }

      if (this.pendingTextObject) {
        this.handlePendingTextObject(data);
        return;
      }

      if (this.pendingMotion) {
        this.handlePendingMotion(data);
        return;
      }

      if (this.pendingOperator === "d") {
        this.handlePendingDelete(data);
        return;
      }

      if (this.pendingOperator === "c") {
        this.handlePendingChange(data);
        return;
      }

      if (this.pendingOperator === "y") {
        this.handlePendingYank(data);
        return;
      }

      if (isVisualMode(this.mode) && this.handleVisualMode(data)) return;

      this.handleNormalMode(data);
    } finally {
      this.finishRepeatRecordingAfterInput();
    }
  }

  private clearUnderlyingPasteStateIfActive(): void {
    const editor = this as unknown as {
      isInPaste?: boolean;
      pasteBuffer?: string;
      pasteCounter?: number;
    };

    if (!editor.isInPaste) return;

    editor.isInPaste = false;
    if (typeof editor.pasteBuffer === "string") {
      editor.pasteBuffer = "";
    }
    if (typeof editor.pasteCounter === "number") {
      editor.pasteCounter = 0;
    }
  }

  private handleEscape(): void {
    if (this.pendingExCommand !== null) {
      this.clearPendingExCommand();
      return;
    }

    if (
      this.pendingMotion ||
      this.pendingTextObject ||
      this.pendingOperator ||
      this.prefixCount ||
      this.operatorCount ||
      this.pendingG ||
      this.pendingGCount ||
      this.pendingReplace
    ) {
      this.clearPendingState();
      this.cancelRepeatableCommand();
      return;
    }
    if (isVisualMode(this.mode)) {
      this.exitVisualMode();
      return;
    }
    if ("insert" === this.mode) {
      this.clearUnderlyingPasteStateIfActive();
      this.setMode("normal");
      if (this.getCursor().col > 0) this.moveCursorBy(-1);
    } else {
      super.handleInput("\x1b"); // pass escape to abort agent
    }
  }

  private deleteLastPendingExCommandGrapheme(): void {
    const current = this.pendingExCommand ?? "";
    const graphemes = getLineGraphemes(current);

    if (graphemes.length <= 1) {
      this.clearPendingExCommand();
      return;
    }

    const previousGrapheme = graphemes[graphemes.length - 2];
    if (!previousGrapheme) {
      this.clearPendingExCommand();
      return;
    }

    this.pendingExCommand = current.slice(0, previousGrapheme.end);
  }

  private handlePendingExCommandControlChunk(data: string): boolean {
    if (
      !data.includes("\r") &&
      !data.includes("\n") &&
      !data.includes("\x7f") &&
      !data.includes("\x08")
    ) {
      return false;
    }

    let printable = "";
    const flushPrintable = () => {
      if (!printable) return;
      this.pendingExCommand += printable;
      printable = "";
    };

    for (const char of data) {
      if (char === "\r" || char === "\n") {
        flushPrintable();
        this.submitPendingExCommand();
        return true;
      }

      if (char === "\x7f" || char === "\x08") {
        flushPrintable();
        this.deleteLastPendingExCommandGrapheme();
        if (this.pendingExCommand === null) {
          return true;
        }
        continue;
      }

      const codePoint = char.codePointAt(0);
      if (codePoint === undefined || codePoint < 32 || codePoint === 127) {
        this.clearPendingExCommand();
        return true;
      }

      printable += char;
    }

    flushPrintable();
    return true;
  }

  private handlePendingExCommand(data: string): void {
    if (isEnterLikeInput(data)) {
      this.submitPendingExCommand();
      return;
    }

    if (isBackspaceLikeInput(data)) {
      this.deleteLastPendingExCommandGrapheme();
      return;
    }

    if (this.handlePendingExCommandControlChunk(data)) {
      return;
    }

    if (!isPrintableChunk(data)) {
      this.clearPendingExCommand();
      this.handleInput(data);
      return;
    }

    this.pendingExCommand += data;
  }

  private hasNonEmptyPrompt(): boolean {
    return this.getText().trim().length > 0;
  }

  private static readonly EX_QUIT_NAMES = new Set([
    "q",
    "qa",
    "quit",
    "qall",
    "quitall",
  ]);

  private submitPendingExCommand(): void {
    const command = this.pendingExCommand?.slice(1).trim() ?? "";
    this.clearPendingExCommand();

    const force = command.endsWith("!");
    const name = force ? command.slice(0, -1) : command;

    if (ModalEditor.EX_QUIT_NAMES.has(name)) {
      if (!force && this.hasNonEmptyPrompt()) {
        this.notifyFn(`Prompt is not empty; use :${command}! to quit anyway`);
        return;
      }

      this.quitFn();
      return;
    }

    if (command) {
      this.notifyFn(`Unsupported ex command: :${command}`);
    }
  }

  private takeTotalCount(defaultValue: number = 1): number {
    const prefixRaw = this.prefixCount;
    const operatorRaw = this.operatorCount;
    this.prefixCount = "";
    this.operatorCount = "";

    if (!prefixRaw && !operatorRaw) return defaultValue;

    const parse = (raw: string): number | null => {
      if (!raw) return null;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      return parsed;
    };

    const prefix = parse(prefixRaw);
    const operator = parse(operatorRaw);

    if (prefix === null && operator === null) return defaultValue;

    const total =
      prefix !== null && operator !== null
        ? prefix * operator
        : (prefix ?? operator ?? defaultValue);

    if (!Number.isFinite(total) || total <= 0) return defaultValue;
    return Math.min(MAX_COUNT, total);
  }

  private hasPendingCount(): boolean {
    return this.prefixCount.length > 0 || this.operatorCount.length > 0;
  }

  private opDigit(data: string): boolean {
    if (!this.isOperatorCountDigit(data)) return false;
    this.operatorCount += data;
    return true;
  }

  private cancelPendingOperator(data: string): void {
    this.pendingOperator = null;
    this.prefixCount = "";
    this.operatorCount = "";
    this.cancelRepeatableCommand();
    if (!isPrintableChunk(data)) {
      super.handleInput(data);
    }
  }

  private handlePendingMotion(data: string): void {
    if (!isPrintableInput(data)) {
      this.pendingMotion = null;
      this.cancelPendingOperator(data);
      return;
    }

    const pendingMotion = this.pendingMotion;
    if (!pendingMotion) return;

    if (this.pendingOperator === "d") {
      if (!this.deleteWithCharMotion(pendingMotion, data)) {
        this.cancelRepeatableCommand();
      }
      this.pendingOperator = null;
    } else if (this.pendingOperator === "c") {
      const changed = this.deleteWithCharMotion(pendingMotion, data);
      this.pendingOperator = null;
      if (changed) {
        this.setMode();
      } else {
        this.cancelRepeatableCommand();
      }
    } else if (this.pendingOperator === "y") {
      this.yankWithCharMotion(pendingMotion, data);
      this.pendingOperator = null;
    } else {
      this.executeCharMotion(pendingMotion, data);
    }

    this.pendingMotion = null;
  }

  private handlePendingTextObject(data: string): void {
    const pendingTextObject = this.pendingTextObject;
    this.pendingTextObject = null;
    if (!pendingTextObject) {
      this.pendingOperator = null;
      this.cancelRepeatableCommand();
      return;
    }

    const hasCount = this.hasPendingCount();

    if (this.pendingOperator === "y" && hasCount) {
      this.cancelPendingOperator(data);
      return;
    }

    if (data === "w" || data === "W") {
      const semanticClass: WordTextObjectClass = data === "W" ? "WORD" : "word";
      const count = this.takeTotalCount(1);
      const range = this.getWordObjectRange(
        pendingTextObject,
        count,
        semanticClass,
      );
      if (!range || !this.pendingOperator) {
        this.pendingOperator = null;
        this.cancelRepeatableCommand();
        return;
      }

      this.applyResolvedTextObjectRange(range);
      return;
    }

    if (hasCount) {
      this.cancelPendingOperator(data);
      return;
    }

    const range = resolveDelimitedTextObjectRange(
      this.getText(),
      this.getDelimitedTextObjectCursorAbs(),
      pendingTextObject,
      data,
    );
    if (!range) {
      this.cancelPendingOperator(data);
      return;
    }

    this.applyResolvedTextObjectRange(range);
  }

  private applyResolvedTextObjectRange(range: TextObjectRange): void {
    const pendingOperator = this.pendingOperator;
    this.pendingOperator = null;

    if (!pendingOperator || range.endAbs < range.startAbs) {
      this.cancelRepeatableCommand();
      return;
    }

    if (range.endAbs === range.startAbs) {
      if (pendingOperator === "c") {
        this.moveCursorToAbsoluteIndex(range.startAbs);
        this.setMode();
      } else {
        this.cancelRepeatableCommand();
      }
      return;
    }

    if (pendingOperator === "d") {
      this.deleteRangeByAbsolute(range.startAbs, range.endAbs);
      return;
    }

    if (pendingOperator === "c") {
      this.deleteRangeByAbsolute(range.startAbs, range.endAbs);
      this.setMode();
      return;
    }

    if (pendingOperator === "y") {
      this.yankRangeByAbsolute(range.startAbs, range.endAbs);
    }
  }

  private handlePendingDelete(data: string): void {
    if (this.opDigit(data)) return;

    if (data === "%") {
      this.applyPercentOp();
      return;
    }

    if (data === "d") {
      const count = this.takeTotalCount(1);
      this.deleteLinewiseByDelta(count - 1);
      this.pendingOperator = null;
      return;
    }

    if (data === "j" || data === "k") {
      const hasDualCount =
        this.prefixCount.length > 0 && this.operatorCount.length > 0;
      const count = this.takeTotalCount(1);
      const delta = hasDualCount ? Math.max(0, count - 1) : count;
      this.deleteLinewiseByDelta(data === "j" ? delta : -delta);
      this.pendingOperator = null;
      return;
    }

    if (data === "G") {
      if (this.prefixCount.length > 0 || this.operatorCount.length > 0) {
        this.cancelPendingOperator(data);
        return;
      }

      this.deleteToBufferEndLinewise();
      this.pendingOperator = null;
      return;
    }

    if (data === "_") {
      const count = this.takeTotalCount(1);
      this.deleteLinewiseByDelta(count - 1);
      this.pendingOperator = null;
      return;
    }

    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    const hasCount = this.hasPendingCount();
    const supportsCountedWordMotion =
      data === "w" ||
      data === "e" ||
      data === "b" ||
      data === "W" ||
      data === "E" ||
      data === "B";
    const supportsCountedTextObject = data === "i" || data === "a";
    const supportsCountedLineEnd = data === "$";
    const supportsIgnoredCountMotion = data === "0" || data === "^";

    if (
      hasCount &&
      !supportsCountedWordMotion &&
      !supportsCountedTextObject &&
      !supportsCountedLineEnd &&
      !supportsIgnoredCountMotion
    ) {
      this.cancelPendingOperator(data);
      return;
    }

    if (supportsCountedTextObject) {
      this.pendingTextObject = data;
      return;
    }

    if (supportsCountedLineEnd) {
      const count = this.takeTotalCount(1);
      if (this.applyLineEndOperator(count, "delete")) {
        this.pendingOperator = null;
        return;
      }
      this.cancelPendingOperator(data);
      return;
    }

    const motionCount = supportsCountedWordMotion ? this.takeTotalCount(1) : 1;
    if (supportsIgnoredCountMotion) this.takeTotalCount(1);
    if (this.deleteWithMotion(data, motionCount)) {
      this.pendingOperator = null;
      return;
    }

    this.cancelPendingOperator(data);
  }

  private handlePendingChange(data: string): void {
    if (this.opDigit(data)) return;

    if (data === "%") {
      this.applyPercentOp();
      return;
    }

    if (data === "c") {
      if (this.prefixCount.length > 0 || this.operatorCount.length > 0) {
        this.cancelPendingOperator(data);
        return;
      }

      this.cutLine();
      this.pendingOperator = null;
      this.setMode();
      return;
    }

    if (data === "_") {
      const count = this.takeTotalCount(1);
      if (count <= 1) {
        this.cutLine();
      } else {
        const currentLine = this.getCursor().line;
        const lines = this.getLines();
        const clampedEnd = Math.min(currentLine + count - 1, lines.length - 1);
        this.writeToRegister(this.getLinewisePayload(currentLine, clampedEnd));
        const before = lines.slice(0, currentLine);
        const after = lines.slice(clampedEnd + 1);
        const newLines = [...before, "", ...after];
        const newText = newLines.join("\n");
        const cursorAbs = before.reduce((acc, l) => acc + l.length + 1, 0);
        this.replaceTextInBuffer(newText, cursorAbs);
      }
      this.pendingOperator = null;
      this.setMode();
      return;
    }

    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    const hasCount = this.hasPendingCount();
    const supportsCountedWordMotion =
      data === "w" ||
      data === "e" ||
      data === "b" ||
      data === "W" ||
      data === "E" ||
      data === "B";
    const supportsCountedTextObject = data === "i" || data === "a";
    const supportsCountedLineEnd = data === "$";
    const supportsIgnoredCountMotion = data === "0" || data === "^";

    if (
      hasCount &&
      !supportsCountedWordMotion &&
      !supportsCountedTextObject &&
      !supportsCountedLineEnd &&
      !supportsIgnoredCountMotion
    ) {
      this.cancelPendingOperator(data);
      return;
    }

    if (supportsCountedTextObject) {
      this.pendingTextObject = data;
      return;
    }

    if (supportsCountedLineEnd) {
      const count = this.takeTotalCount(1);
      if (this.applyLineEndOperator(count, "change")) {
        this.pendingOperator = null;
        this.setMode();
        return;
      }
      this.cancelPendingOperator(data);
      return;
    }

    const motionCount = supportsCountedWordMotion ? this.takeTotalCount(1) : 1;
    if (supportsIgnoredCountMotion) this.takeTotalCount(1);
    const effectiveMotion =
      data === "W" && this.isCursorOnNonWhitespace() ? "E" : data;
    if (this.deleteWithMotion(effectiveMotion, motionCount)) {
      this.pendingOperator = null;
      this.setMode();
      return;
    }

    this.cancelPendingOperator(data);
  }

  private enterVisualMode(mode: VisualMode): void {
    if (!isVisualMode(this.mode)) {
      const cursor = this.getCursor();
      this.visualAnchor = { line: cursor.line, col: cursor.col };
    }
    this.takeTotalCount(1);
    this.setMode(mode);
  }

  private exitVisualMode(): void {
    this.visualAnchor = null;
    this.setMode("normal");
  }

  private getVisualAnchor(): VisualPosition {
    const cursor = this.getCursor();
    return clampVisualPosition(this.visualAnchor ?? cursor, this.getLines());
  }

  /** Absolute `[startAbs, endAbs)` span of the inclusive char-wise selection. */
  private getVisualCharwiseRange(): { startAbs: number; endAbs: number } {
    const { start, end } = orderVisualEndpoints(
      this.getVisualAnchor(),
      this.getCursor(),
    );
    const endLine = this.getLines()[end.line] ?? "";
    return {
      startAbs: this.getAbsoluteIndex(start.line, start.col),
      endAbs:
        this.getAbsoluteIndex(end.line, 0) +
        getInclusiveEndColumn(endLine, end.col),
    };
  }

  private clampCursorToLastGrapheme(): void {
    const { line, col } = this.getCurrentLineAndCol();
    if (col < line.length) return;
    const graphemes = getLineGraphemes(line);
    this.moveCursorToCol(graphemes[graphemes.length - 1]?.start ?? 0);
  }

  /** Replace the selected lines with one empty line, then open insert there. */
  private changeVisualLines(startLine: number, endLine: number): void {
    const lines = this.getLines();
    this.writeToRegister(this.getLinewisePayload(startLine, endLine));

    const before = lines.slice(0, startLine);
    const after = lines.slice(endLine + 1);
    const cursorAbs = before.reduce((abs, line) => abs + line.length + 1, 0);
    this.replaceTextInBuffer([...before, "", ...after].join("\n"), cursorAbs);
  }

  private applyVisualOperator(
    operator: "d" | "y" | "c",
    linewise: boolean,
  ): void {
    this.takeTotalCount(1);
    // Visual edits are excluded from dot-repeat; drop the stale command so `.`
    // cannot replay an older change the user has since moved past.
    this.clearRepeatState();

    // Both branches resolve the selection before dropping the anchor.
    const anchor = this.getVisualAnchor();
    const cursor = this.getCursor();

    if (linewise) {
      const { startLine, endLine } = getVisualLineRange(anchor, cursor);
      this.visualAnchor = null;
      if (operator === "c") {
        this.setMode("insert");
        this.changeVisualLines(startLine, endLine);
        return;
      }
      this.setMode("normal");
      if (operator === "d") {
        this.deleteLineRange(startLine, endLine);
        return;
      }
      this.yankLineRange(startLine, endLine);
      // Vim only pulls the cursor to the start of the yanked lines when it is
      // not already sitting on that end of the selection.
      if (cursor.line >= anchor.line) this.moveCursorToLineStart(startLine);
      return;
    }

    const { startAbs, endAbs } = this.getVisualCharwiseRange();
    this.visualAnchor = null;
    if (operator === "c") {
      this.setMode("insert");
      this.deleteRangeByAbsolute(startAbs, endAbs);
      return;
    }
    this.setMode("normal");
    if (operator === "d") {
      this.deleteRangeByAbsolute(startAbs, endAbs);
      this.clampCursorToLastGrapheme();
      return;
    }
    this.yankRangeByAbsolute(startAbs, endAbs);
    this.moveCursorToAbsoluteIndex(startAbs);
  }

  /** Swap the anchor and the cursor so the other end of the selection moves. */
  private swapVisualEnds(): void {
    const anchor = this.getVisualAnchor();
    const cursor = this.getCursor();
    this.visualAnchor = { line: cursor.line, col: cursor.col };
    this.moveCursorToAbsoluteIndex(
      this.getAbsoluteIndex(anchor.line, anchor.col),
    );
  }

  /**
   * Visual-mode keys that are not motions. Returns true when the key was
   * consumed; motions and counts fall through to the normal-mode dispatch,
   * which moves the cursor and thereby resizes the selection.
   */
  private handleVisualMode(data: string): boolean {
    if (this.pendingG || this.pendingMotion) return false;

    const linewise = this.mode === "visual-line";

    switch (data) {
      case "v":
        if (linewise) this.setMode("visual");
        else this.exitVisualMode();
        return true;
      case "V":
        if (linewise) this.exitVisualMode();
        else this.setMode("visual-line");
        return true;
      case "o":
      case "O":
        this.swapVisualEnds();
        return true;
      case "d":
      case "x":
        this.applyVisualOperator("d", linewise);
        return true;
      case "y":
        this.applyVisualOperator("y", linewise);
        return true;
      case "c":
      case "s":
        this.applyVisualOperator("c", linewise);
        return true;
      case "D":
      case "X":
        this.applyVisualOperator("d", true);
        return true;
      case "Y":
        this.applyVisualOperator("y", true);
        return true;
      case "C":
      case "S":
        this.applyVisualOperator("c", true);
        return true;
      default:
        if (VISUAL_IGNORED_KEYS.has(data)) return true;
        return matchesKey(data, "ctrl+r") || matchesKey(data, "ctrl+_");
    }
  }

  private handleNormalMode(data: string): void {
    if (this.pendingG) {
      if (isDigit(data)) {
        this.pendingGCount += data;
        return;
      }

      this.pendingG = false;
      const hadGCount = this.pendingGCount.length > 0;
      this.pendingGCount = "";

      if (!hadGCount) {
        if (data === "g") {
          const count = this.takeTotalCount(1);
          this.moveCursorToLineStart(count - 1);
          return;
        }

        if (data === "J" && !isVisualMode(this.mode)) {
          this.joinLines(false);
          return;
        }
      }

      this.clearPendingState();
      return;
    }

    if (this.prefixCount.length > 0) {
      if (isDigit(data)) {
        this.prefixCount += data;
        return;
      }

      if (data === "%") {
        this.prefixCount = "";
        this.operatorCount = "";
        return;
      }

      if (data === "d" || data === "y") {
        this.pendingOperator = data;
        return;
      }

      if (data === "c") {
        this.pendingOperator = "c";
        return;
      }

      if (data === "g") {
        this.pendingGCount = "";
        this.pendingG = true;
        return;
      }

      if (data === "G") {
        const count = this.takeTotalCount(1);
        this.moveCursorToLineStart(count - 1);
        return;
      }

      const supportsCountedStandaloneEdit =
        data === "x" ||
        data === "r" ||
        data === "s" ||
        data === "S" ||
        data === "D" ||
        data === "C" ||
        data === "p" ||
        data === "P" ||
        data === "Y" ||
        data === "J" ||
        data === "." ||
        data === "u" ||
        data === CTRL_UNDERSCORE ||
        matchesKey(data, "ctrl+_") ||
        data === CTRL_R ||
        matchesKey(data, "ctrl+r");
      const supportsCountedCharMotion =
        CHAR_MOTION_KEYS.has(data) || data === ";" || data === ",";
      const supportsCountedWordMotion =
        data === "w" ||
        data === "e" ||
        data === "b" ||
        data === "W" ||
        data === "E" ||
        data === "B";
      const supportsCountedParagraphMotion = data === "{" || data === "}";
      const supportsCountedNav =
        data === "h" || data === "j" || data === "k" || data === "l";
      const supportsCountedUnderscore = data === "_";

      if (supportsCountedNav) {
        const count = this.takeTotalCount(1);
        const clamped = Math.min(count, MAX_COUNT);
        if (data === "h") {
          this.moveCursorBy(-clamped);
        } else if (data === "l") {
          this.moveCursorBy(clamped);
        } else {
          const delta = data === "j" ? clamped : -clamped;
          this.moveCursorVertically(delta);
        }
        return;
      }

      if (supportsCountedParagraphMotion) {
        this.executeParagraphMotion(data === "}" ? "forward" : "backward");
        return;
      }

      if (
        !supportsCountedStandaloneEdit &&
        !supportsCountedCharMotion &&
        !supportsCountedWordMotion &&
        !supportsCountedParagraphMotion &&
        !supportsCountedUnderscore
      ) {
        this.prefixCount = "";
        this.operatorCount = "";
      }
    } else if (isCountStarter(data)) {
      this.prefixCount = data;
      return;
    }

    if (data === "J") {
      this.joinLines(true);
      return;
    }

    if (data === "g") {
      this.pendingGCount = "";
      this.pendingG = true;
      return;
    }

    if (data === ":") {
      this.startPendingExCommand();
      return;
    }

    if (data === "G") {
      this.moveCursorToBufferEnd();
      return;
    }

    if (data === "r") {
      this.pendingReplace = true;
      return;
    }

    if (data === "v" || data === "V") {
      this.enterVisualMode(data === "v" ? "visual" : "visual-line");
      return;
    }

    if (data === "d") {
      this.pendingOperator = "d";
      return;
    }

    if (data === "c") {
      this.pendingOperator = "c";
      return;
    }

    if (data === "y") {
      this.pendingOperator = "y";
      return;
    }

    if (data === "p") {
      this.putAfter();
      return;
    }

    if (data === "P") {
      this.putBefore();
      return;
    }

    if (data === "Y") {
      const count = this.takeTotalCount(1);
      this.yankLinewiseByDelta(count - 1);
      return;
    }

    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    if (data === ";" && this.lastCharMotion) {
      this.executeCharMotion(
        this.lastCharMotion.motion,
        this.lastCharMotion.char,
        false,
      );
      return;
    }
    if (data === "," && this.lastCharMotion) {
      this.executeCharMotion(
        reverseCharMotion(this.lastCharMotion.motion),
        this.lastCharMotion.char,
        false,
      );
      return;
    }

    if (
      data === "u" ||
      data === CTRL_UNDERSCORE ||
      matchesKey(data, "ctrl+_")
    ) {
      this.performUndo();
      return;
    }

    if (data === CTRL_R || matchesKey(data, "ctrl+r")) {
      this.performRedo();
      return;
    }

    if (data === ".") {
      this.repeatLastCommand();
      return;
    }

    if (data === "}" || data === "{") {
      this.executeParagraphMotion(data === "}" ? "forward" : "backward");
      return;
    }

    if (data === "^") {
      this.moveCursorToFirstNonWhitespace();
      return;
    }

    if (data === "_") {
      const count = this.takeTotalCount(1);
      if (count > 1) {
        this.moveCursorVertically(count - 1);
      }
      this.moveCursorToFirstNonWhitespace();
      return;
    }

    if (data === "w") {
      const count = this.takeTotalCount(1);
      this.moveWord("forward", "start", count, "word");
      return;
    }
    if (data === "b") {
      this.moveWord("backward", "start", this.takeTotalCount(1), "word");
      return;
    }
    if (data === "e") {
      this.moveWord("forward", "end", this.takeTotalCount(1), "word");
      return;
    }
    if (data === "W") {
      this.moveWord("forward", "start", this.takeTotalCount(1), "WORD");
      return;
    }
    if (data === "%") {
      this.moveToMatchingPairTarget();
      return;
    }
    if (data === "B") {
      this.moveWord("backward", "start", this.takeTotalCount(1), "WORD");
      return;
    }
    if (data === "E") {
      this.moveWord("forward", "end", this.takeTotalCount(1), "WORD");
      return;
    }

    if (Object.hasOwn(NORMAL_KEYS, data)) {
      this.handleMappedKey(data);
      return;
    }

    if (isPrintableChunk(data)) return;
    super.handleInput(data);
  }

  private openLineBelow(): void {
    super.handleInput(CTRL_E);
    super.handleInput(NEWLINE);
  }

  private openLineAbove(): void {
    super.handleInput(CTRL_A);
    super.handleInput(NEWLINE);
    super.handleInput(ESC_UP);
  }

  private handleMappedKey(key: string): void {
    const seq = NORMAL_KEYS[key];
    switch (key) {
      case "i":
        this.setMode();
        break;
      case "a":
        this.setMode();
        if (!this.isCursorAtOrPastEol()) {
          super.handleInput(ESC_RIGHT);
        }
        break;
      case "A":
        this.setMode();
        super.handleInput(CTRL_E);
        break;
      case "I":
        this.setMode();
        this.moveCursorToFirstNonWhitespace();
        break;
      case "$": {
        const { line } = this.getCurrentLineAndCol();
        const graphemes = getLineGraphemes(line);
        this.moveCursorToCol(graphemes[graphemes.length - 1]?.start ?? 0);
        break;
      }
      case "o":
        this.openLineBelow();
        this.setMode();
        break;
      case "O":
        this.openLineAbove();
        this.setMode();
        break;
      case "D":
        this.takeTotalCount(1);
        this.cutToEndOfLine();
        break;
      case "C":
        this.takeTotalCount(1);
        this.cutToEndOfLine();
        this.setMode();
        break;
      case "S":
        this.takeTotalCount(1);
        this.cutCurrentLineContent();
        this.setMode();
        break;
      case "s":
        this.cutCharUnderCursor();
        this.setMode();
        break;
      case "x":
        this.cutCharUnderCursor(true);
        break;
      case "j":
        this.moveCursorVertically(1);
        break;
      case "k":
        this.moveCursorVertically(-1);
        break;
      default:
        if (seq) super.handleInput(seq);
    }
  }

  private executeCharMotion(
    motion: CharMotion,
    targetChar: string,
    saveMotion: boolean = true,
  ): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    const count = this.takeTotalCount(1);
    const targetCol = findCharMotionTarget(
      line,
      col,
      motion,
      targetChar,
      !saveMotion,
      count,
    );

    if (targetCol !== null && saveMotion) {
      this.lastCharMotion = { motion, char: targetChar };
    }

    if (targetCol !== null && targetCol !== col) {
      this.moveCursorToCol(targetCol);
    }
  }

  private executeParagraphMotion(direction: "forward" | "backward"): void {
    const lines = this.getLines();
    const fromLine = this.getCursor().line;
    const count = this.takeTotalCount(1);
    const targetLine = findParagraphMotionTarget(
      lines,
      fromLine,
      direction,
      count,
    );
    this.moveCursorToLineStart(targetLine);
  }

  private tryMoveCursorByState(delta: number): boolean {
    if (delta === 0) return true;

    const editor = this as unknown as {
      state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
      preferredVisualCol?: number;
      tui?: { requestRender?: () => void };
    };

    const state = editor.state;
    if (!state || !Array.isArray(state.lines)) return false;
    if (
      !Number.isInteger(state.cursorLine) ||
      !Number.isInteger(state.cursorCol)
    )
      return false;

    const cursorLine = state.cursorLine as number;
    const cursorCol = state.cursorCol as number;
    const line = state.lines[cursorLine] ?? "";
    if (this.hasMultiCodeUnitGraphemes(line)) return false;

    const target = cursorCol + delta;

    if (target < 0 || target > line.length) return false;

    state.cursorCol = target;
    editor.preferredVisualCol = target;
    editor.tui?.requestRender?.();
    return true;
  }

  private moveCursorBy(delta: number): void {
    if (delta === 0) return;

    if (this.tryMoveCursorByState(delta)) return;

    const seq = delta > 0 ? ESC_RIGHT : ESC_LEFT;
    for (let i = 0; i < Math.abs(delta); i++) {
      super.handleInput(seq);
    }
  }

  private moveCursorVertically(delta: number): void {
    if (delta === 0) return;

    const editor = this as unknown as {
      state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
      preferredVisualCol?: number | null;
      lastAction?: string | null;
      tui?: { requestRender?: () => void };
    };

    const state = editor.state;
    if (!state || !Array.isArray(state.lines) || state.lines.length === 0) {
      const seq = delta > 0 ? ESC_DOWN : ESC_UP;
      for (let i = 0; i < Math.abs(delta); i++) {
        super.handleInput(seq);
      }
      return;
    }

    const currentLine = state.cursorLine ?? 0;
    const targetLine = Math.max(
      0,
      Math.min(currentLine + delta, state.lines.length - 1),
    );
    if (targetLine === currentLine) return;

    const preferredCol = editor.preferredVisualCol ?? state.cursorCol ?? 0;
    const targetLineText = state.lines[targetLine] ?? "";
    editor.lastAction = null;
    state.cursorLine = targetLine;
    state.cursorCol = Math.min(preferredCol, targetLineText.length);
    editor.preferredVisualCol = preferredCol;
    editor.tui?.requestRender?.();
  }

  private moveCursorToCol(col: number): void {
    const editor = this as unknown as {
      state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
      preferredVisualCol?: number | null;
      lastAction?: string | null;
      tui?: { requestRender?: () => void };
    };

    const state = editor.state;
    if (!state || !Array.isArray(state.lines)) return;

    editor.lastAction = null;
    state.cursorCol = col;
    editor.preferredVisualCol = col;
    editor.tui?.requestRender?.();
  }

  private moveCursorToAbsoluteIndex(abs: number): void {
    const editor = this as unknown as {
      state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
      preferredVisualCol?: number | null;
      lastAction?: string | null;
      tui?: { requestRender?: () => void };
    };

    const state = editor.state;
    if (!state || !Array.isArray(state.lines)) return;

    const { line, col } = this.getCursorFromAbsoluteIndex(this.getText(), abs);
    editor.lastAction = null;
    state.cursorLine = line;
    state.cursorCol = col;
    editor.preferredVisualCol = col;
    editor.tui?.requestRender?.();
  }

  private moveCursorToLineStart(lineIndex: number): void {
    const editor = this as unknown as {
      state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
      preferredVisualCol?: number | null;
      lastAction?: string | null;
      tui?: { requestRender?: () => void };
    };

    const state = editor.state;
    if (!state || !Array.isArray(state.lines) || state.lines.length === 0) {
      super.handleInput(CTRL_A);
      return;
    }

    const targetLine = Math.max(0, Math.min(lineIndex, state.lines.length - 1));
    editor.lastAction = null;
    state.cursorLine = targetLine;
    state.cursorCol = 0;
    editor.preferredVisualCol = null;
    editor.tui?.requestRender?.();
  }

  private moveCursorToFirstNonWhitespace(): void {
    const { line } = this.getCurrentLineAndCol();
    const targetCol = findFirstNonWhitespaceColumn(line);
    this.moveCursorToCol(targetCol);
  }

  private moveCursorToBufferEnd(): void {
    const lines = this.getLines();
    this.moveCursorToLineStart(Math.max(0, lines.length - 1));
  }

  private joinLines(normalize: boolean): void {
    const count = this.takeTotalCount(2);
    const steps = Math.max(0, count - 1);
    if (steps === 0) return;

    this.applySyntheticEdit(() => {
      const editor = this as unknown as ModalEditorInternals;
      const state = editor.state;
      if (!state || !Array.isArray(state.lines)) return;

      const currentLine = state.cursorLine ?? 0;
      let joinPoint = state.cursorCol ?? 0;

      for (let i = 0; i < steps; i++) {
        if (currentLine >= state.lines.length - 1) break;

        const left = state.lines[currentLine] ?? "";
        const right = state.lines[currentLine + 1] ?? "";
        let joined: string;

        if (normalize) {
          const trimmedRight = right.trimStart();
          const leftLastChar = left[left.length - 1];
          const leftEndsWithSpace =
            leftLastChar !== undefined && /\s/.test(leftLastChar);
          const needsSeparator = !leftEndsWithSpace && trimmedRight.length > 0;
          joined = needsSeparator
            ? `${left} ${trimmedRight}`
            : left + trimmedRight;
          joinPoint = left.length;
        } else {
          joined = left + right;
          joinPoint = left.length;
        }

        state.lines.splice(currentLine, 2, joined);
      }

      state.cursorLine = currentLine;
      state.cursorCol = joinPoint;
      editor.preferredVisualCol = joinPoint;
    });
  }

  private isWordChar(ch: string): boolean {
    return /\w/.test(ch);
  }

  private charType(
    ch: string | undefined,
    semanticClass: WordMotionClass = "word",
  ): "space" | "word" | "other" {
    if (!ch || /\s/.test(ch)) return "space";
    if (semanticClass === "WORD") return "word";
    if (this.isWordChar(ch)) return "word";
    return "other";
  }

  private resolveWordMotion(
    motion: string,
  ): { motion: "w" | "e" | "b"; semanticClass: WordMotionClass } | null {
    if (motion === "w" || motion === "e" || motion === "b") {
      return { motion, semanticClass: "word" };
    }

    if (motion === "W" || motion === "E" || motion === "B") {
      const normalizedMotion = motion.toLowerCase() as "w" | "e" | "b";
      return { motion: normalizedMotion, semanticClass: "WORD" };
    }

    return null;
  }

  private getAbsoluteIndex(line: number, col: number): number {
    const lines = this.getLines();
    let idx = 0;
    for (let i = 0; i < line; i++) {
      idx += (lines[i] ?? "").length + 1;
    }
    return idx + col;
  }

  private getAbsoluteIndexFromCursor(): number {
    const cursor = this.getCursor();
    return this.getAbsoluteIndex(cursor.line, cursor.col);
  }

  private getMatchingPairMotionTarget() {
    const cursor = this.getCursor();
    const lineStartAbs = this.getAbsoluteIndex(cursor.line, 0);
    return resolveMatchingPairMotionTarget(
      this.getText(),
      this.getAbsoluteIndexFromCursor(),
      lineStartAbs,
      lineStartAbs + (this.getLines()[cursor.line] ?? "").length,
    );
  }

  private moveToMatchingPairTarget(): void {
    const target = this.getMatchingPairMotionTarget();
    if (target) this.moveCursorToAbsoluteIndex(target.targetAbs);
  }

  private applyPercentOp(): void {
    const op = this.pendingOperator;
    const counted = this.hasPendingCount();
    this.clearPendingState();
    if (!op || counted) {
      this.cancelRepeatableCommand();
      return;
    }

    const t = this.getMatchingPairMotionTarget();
    if (!t) {
      this.cancelRepeatableCommand();
      return;
    }

    if (op === "y") {
      this.yankRangeByAbsolute(t.rangeAnchorAbs, t.targetAbs, true);
      return;
    }

    this.deleteRangeByAbsolute(t.rangeAnchorAbs, t.targetAbs, true);
    if (op === "c") {
      this.setMode("insert");
      return;
    }
  }

  private getDelimitedTextObjectCursorAbs(): number {
    const lines = this.getLines();
    const cursor = this.getCursor();
    const line = lines[cursor.line] ?? "";

    if (line.length > 0 && cursor.col >= line.length) {
      return this.getAbsoluteIndex(cursor.line, line.length - 1);
    }

    return this.getAbsoluteIndex(cursor.line, cursor.col);
  }

  private findWordTargetInText(
    text: string,
    abs: number,
    direction: "forward" | "backward",
    target: "start" | "end",
    count: number = 1,
    semanticClass: WordMotionClass = "word",
  ): number {
    const len = text.length;
    if (len === 0) return 0;

    const steps = Math.max(1, Math.min(MAX_COUNT, count));
    let i = Math.max(0, Math.min(abs, len));

    for (let step = 0; step < steps; step++) {
      let next = i;

      if (direction === "forward") {
        if (next >= len) {
          next = len;
        } else if (target === "start") {
          const startType = this.charType(text[next], semanticClass);
          if (startType !== "space") {
            while (
              next < len &&
              this.charType(text[next], semanticClass) === startType
            )
              next++;
          }
          while (
            next < len &&
            this.charType(text[next], semanticClass) === "space"
          )
            next++;
        } else {
          if (next < len - 1) next++;
          while (
            next < len &&
            this.charType(text[next], semanticClass) === "space"
          )
            next++;
          if (next >= len) {
            next = len;
          } else {
            const t = this.charType(text[next], semanticClass);
            while (
              next < len - 1 &&
              this.charType(text[next + 1], semanticClass) === t
            )
              next++;
          }
        }
      } else {
        if (next >= len) next = len - 1;
        if (next > 0) next--;
        while (next > 0 && this.charType(text[next], semanticClass) === "space")
          next--;
        const t = this.charType(text[next], semanticClass);
        while (next > 0 && this.charType(text[next - 1], semanticClass) === t)
          next--;
      }

      if (next === i) break;
      i = next;
    }

    return i;
  }

  private tryFindWordTargetInLine(
    line: string,
    col: number,
    direction: WordMotionDirection,
    target: WordMotionTarget,
    allowSameColumn: boolean = false,
    semanticClass: WordMotionClass = "word",
  ): number | null {
    if (line.length === 0) return null;
    if (col < 0 || col > line.length) return null;

    if (direction === "forward") {
      if (col >= line.length) return null;
    } else {
      if (col <= 0) return null;
      if (!/\S/.test(line.slice(0, col))) return null;
    }

    const targetCol = this.wordBoundaryCache.tryFindTarget(
      line,
      col,
      direction,
      target,
      semanticClass,
    );
    if (targetCol === null) return null;

    if (direction === "forward") {
      if (targetCol >= line.length) return null;
      if (allowSameColumn) {
        if (targetCol < col) return null;
      } else if (targetCol <= col) {
        return null;
      }
      return targetCol;
    }

    if (allowSameColumn) {
      if (targetCol > col) return null;
    } else if (targetCol >= col) {
      return null;
    }

    return targetCol;
  }

  private tryFindWordTargetLineLocal(
    direction: WordMotionDirection,
    target: WordMotionTarget,
    semanticClass: WordMotionClass = "word",
  ): number | null {
    const cursor = this.getCursor();
    const lineIndex = cursor.line;
    const col = cursor.col;
    const lineSnapshot = this.getLines()[lineIndex] ?? "";

    const targetCol = this.tryFindWordTargetInLine(
      lineSnapshot,
      col,
      direction,
      target,
      false,
      semanticClass,
    );
    if (targetCol === null) return null;

    const liveLine = this.getLines()[lineIndex] ?? "";
    const liveCol = this.getCursor().col;
    if (liveLine !== lineSnapshot || liveCol !== col) return null;

    return targetCol;
  }

  private tryMoveWordLineLocal(
    direction: "forward" | "backward",
    target: "start" | "end",
    semanticClass: WordMotionClass = "word",
  ): boolean {
    const col = this.getCursor().col;
    const targetCol = this.tryFindWordTargetLineLocal(
      direction,
      target,
      semanticClass,
    );
    if (targetCol === null || targetCol === col) return false;

    this.moveCursorToCol(targetCol);
    return true;
  }

  private tryWordMotionLineLocalRange(
    motion: "w" | "e" | "b",
    count: number = 1,
    semanticClass: WordMotionClass = "word",
  ): { col: number; targetCol: number; inclusive: boolean } | null {
    const cursor = this.getCursor();
    const lineIndex = cursor.line;
    const col = cursor.col;
    const lineSnapshot = this.getLines()[lineIndex] ?? "";
    const direction: WordMotionDirection =
      motion === "b" ? "backward" : "forward";
    const target: WordMotionTarget = motion === "e" ? "end" : "start";
    const steps = Math.max(1, Math.min(MAX_COUNT, count));

    let currentCol = col;
    for (let step = 0; step < steps; step++) {
      const nextCol = this.tryFindWordTargetInLine(
        lineSnapshot,
        currentCol,
        direction,
        target,
        motion === "e",
        semanticClass,
      );
      if (nextCol === null) return null;
      if (nextCol === currentCol && step < steps - 1) return null;
      currentCol = nextCol;
    }

    const liveLine = this.getLines()[lineIndex] ?? "";
    const liveCol = this.getCursor().col;
    if (liveLine !== lineSnapshot || liveCol !== col) return null;

    return {
      col,
      targetCol: currentCol,
      inclusive: motion === "e",
    };
  }

  private moveWord(
    direction: "forward" | "backward",
    target: "start" | "end",
    count: number = 1,
    semanticClass: WordMotionClass = "word",
  ): void {
    let remaining = Math.max(1, Math.min(MAX_COUNT, count));

    while (remaining > 0) {
      if (this.tryMoveWordLineLocal(direction, target, semanticClass)) {
        remaining--;
        continue;
      }

      const text = this.getText();
      const currentAbs = this.getAbsoluteIndexFromCursor();
      const targetAbs = this.findWordTargetInText(
        text,
        currentAbs,
        direction,
        target,
        remaining,
        semanticClass,
      );
      if (targetAbs !== currentAbs) {
        this.moveCursorToAbsoluteIndex(targetAbs);
      }
      return;
    }
  }

  private shouldMirrorRegisterWrite(source: RegisterWriteSource): boolean {
    if (this.clipboardMirrorPolicy === "never") return false;
    if (this.clipboardMirrorPolicy === "yank") return source === "yank";
    return true;
  }

  private writeToRegister(
    text: string,
    source: RegisterWriteSource = "mutation",
  ): void {
    this.unnamedRegister = text;
    const shouldMirror = text !== "" && this.shouldMirrorRegisterWrite(source);
    this.preferRegisterForPut = text !== "" && !shouldMirror;
    if (!shouldMirror) return;

    this.clipboardMirror.mirror(text);
  }

  private getCurrentLineAndCol(): { line: string; col: number } {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    return { line, col };
  }

  private hasMultiCodeUnitGraphemes(line: string): boolean {
    return getLineGraphemes(line).some(
      (segment) => segment.end - segment.start > 1,
    );
  }

  private getGraphemeRangeAtCol(
    line: string,
    col: number,
    count: number,
    clampToLine: boolean = false,
  ): { start: number; end: number } | null {
    const clampedCol = Math.max(0, Math.min(col, line.length));
    const segments = getLineGraphemes(line);
    const startIndex = segments.findIndex(
      (segment) => clampedCol < segment.end,
    );
    if (startIndex === -1) return null;

    let endIndex = startIndex + Math.max(1, count) - 1;
    if (endIndex >= segments.length) {
      if (!clampToLine) return null;
      endIndex = segments.length - 1;
    }

    const startSegment = segments[startIndex];
    const endSegment = segments[endIndex];
    if (!startSegment || !endSegment) return null;

    return {
      start: startSegment.start,
      end: endSegment.end,
    };
  }

  private isCursorOnNonWhitespace(): boolean {
    const { line, col } = this.getCurrentLineAndCol();
    const ch = line[col];
    return ch !== undefined && !/\s/.test(ch);
  }

  private isCursorAtOrPastEol(): boolean {
    const { line, col } = this.getCurrentLineAndCol();
    return col >= line.length;
  }

  private cutCharUnderCursor(normal: boolean = false): void {
    const count = Math.max(1, Math.min(MAX_COUNT, this.takeTotalCount(1)));
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    const range = this.getGraphemeRangeAtCol(line, cursor.col, count, true);
    if (!range) return;

    const lineStartAbs = this.getAbsoluteIndex(cursor.line, 0);
    const text = this.getText();
    this.writeToRegister(line.slice(range.start, range.end));
    this.replaceTextInBuffer(
      text.slice(0, lineStartAbs + range.start) +
        text.slice(lineStartAbs + range.end),
      lineStartAbs + range.start,
    );
    if (normal) {
      const { line, col } = this.getCurrentLineAndCol();
      if (line && col >= line.length) this.moveCursorBy(-1);
    }
  }

  private cutToEndOfLine(): void {
    const lines = this.getLines();
    const cursorLine = this.getCursor().line;
    const { line, col } = this.getCurrentLineAndCol();

    const hasNextLine = cursorLine < lines.length - 1;
    const deleted =
      col < line.length ? line.slice(col) : hasNextLine ? "\n" : "";

    this.writeToRegister(deleted);
    super.handleInput(CTRL_K);
  }

  private cutCurrentLineContent(): void {
    const lines = this.getLines();
    const cursorLine = this.getCursor().line;
    const { line } = this.getCurrentLineAndCol();

    const hasNextLine = cursorLine < lines.length - 1;
    const deleted = line.length > 0 ? line : hasNextLine ? "\n" : "";

    this.writeToRegister(deleted);
    super.handleInput(CTRL_A);
    super.handleInput(CTRL_K);
  }

  private cutLine(): void {
    this.cutCurrentLineContent();
  }

  private getNormalizedLineRange(
    startLine: number,
    endLine: number,
  ): { start: number; end: number } {
    const lines = this.getLines();
    const last = Math.max(0, lines.length - 1);
    const clampedStart = Math.max(0, Math.min(startLine, last));
    const clampedEnd = Math.max(0, Math.min(endLine, last));
    return {
      start: Math.min(clampedStart, clampedEnd),
      end: Math.max(clampedStart, clampedEnd),
    };
  }

  private getLinewisePayload(startLine: number, endLine: number): string {
    const lines = this.getLines();
    const { start, end } = this.getNormalizedLineRange(startLine, endLine);
    return `${lines.slice(start, end + 1).join("\n")}\n`;
  }

  private getLineDeleteAbsoluteRange(
    startLine: number,
    endLine: number,
  ): { startAbs: number; endAbs: number } {
    const lines = this.getLines();
    const text = this.getText();
    const { start, end } = this.getNormalizedLineRange(startLine, endLine);
    const lastLine = Math.max(0, lines.length - 1);

    let startAbs = this.getAbsoluteIndex(start, 0);
    let endAbs: number;

    if (end < lastLine) {
      const endLineText = lines[end] ?? "";
      endAbs = this.getAbsoluteIndex(end, endLineText.length) + 1;
    } else {
      endAbs = text.length;
      if (start > 0) {
        startAbs = Math.max(0, startAbs - 1);
      }
    }

    return { startAbs, endAbs };
  }

  private deleteLineRange(startLine: number, endLine: number): void {
    const lines = this.getLines();
    if (lines.length === 0) return;

    const payload = this.getLinewisePayload(startLine, endLine);
    const { startAbs, endAbs } = this.getLineDeleteAbsoluteRange(
      startLine,
      endLine,
    );

    this.writeToRegister(payload);

    if (endAbs > startAbs) {
      const text = this.getText();
      const newText = text.slice(0, startAbs) + text.slice(endAbs);
      this.replaceTextInBuffer(newText, startAbs);

      super.handleInput(CTRL_A);
    }
  }

  private yankLineRange(startLine: number, endLine: number): void {
    if (this.getLines().length === 0) return;
    this.writeToRegister(this.getLinewisePayload(startLine, endLine), "yank");
  }

  private deleteLinewiseByDelta(delta: number): void {
    const currentLine = this.getCursor().line;
    this.deleteLineRange(currentLine, currentLine + delta);
  }

  private yankLinewiseByDelta(delta: number): void {
    const currentLine = this.getCursor().line;
    this.yankLineRange(currentLine, currentLine + delta);
  }

  private deleteToBufferEndLinewise(): void {
    this.deleteLineRange(this.getCursor().line, this.getLines().length - 1);
  }

  private yankToBufferEndLinewise(): void {
    this.yankLineRange(this.getCursor().line, this.getLines().length - 1);
  }

  private deleteWithMotion(motion: string, count: number = 1): boolean {
    const cursor = this.getCursor();
    const col = cursor.col;

    if (motion === "$") {
      this.cutToEndOfLine();
      return true;
    }

    if (motion === "0") {
      this.deleteRange(col, 0, false);
      return true;
    }

    if (motion === "^") {
      this.deleteRange(
        col,
        findFirstNonWhitespaceColumn(this.getLines()[cursor.line] ?? ""),
        false,
      );
      return true;
    }

    const wordMotion = this.resolveWordMotion(motion);
    if (wordMotion) {
      const lineLocalRange = this.tryWordMotionLineLocalRange(
        wordMotion.motion,
        count,
        wordMotion.semanticClass,
      );
      if (lineLocalRange) {
        this.deleteRange(
          lineLocalRange.col,
          lineLocalRange.targetCol,
          lineLocalRange.inclusive,
        );
        return true;
      }

      const text = this.getText();
      const currentAbs = this.getAbsoluteIndexFromCursor();
      const targetAbs = this.findWordTargetInText(
        text,
        currentAbs,
        wordMotion.motion === "b" ? "backward" : "forward",
        wordMotion.motion === "e" ? "end" : "start",
        count,
        wordMotion.semanticClass,
      );
      this.deleteRangeByAbsolute(
        currentAbs,
        targetAbs,
        wordMotion.motion === "e",
      );
      return true;
    }

    return false;
  }

  // Handles counted `d$`/`c$`. `$` with a count N descends N-1 lines before
  // going to end of line, so the operator spans multiple lines. Semantics
  // match nvim (verified against the real editor): count 1 delegates to the
  // existing single-line path; on the last line a count >= 2 aborts as a
  // no-op; `d$` (but not `c$`) becomes linewise when the cursor is at or
  // before the first non-blank column.
  private applyLineEndOperator(
    count: number,
    mode: "change" | "delete",
  ): boolean {
    const clampedCount = Math.max(1, Math.min(MAX_COUNT, count));
    if (clampedCount <= 1) {
      this.cutToEndOfLine();
      return true;
    }

    const lines = this.getLines();
    if (lines.length === 0) return false;

    const cursor = this.getCursor();
    const lastLine = lines.length - 1;
    if (cursor.line >= lastLine) return false;

    const targetLine = Math.min(cursor.line + clampedCount - 1, lastLine);
    const text = this.getText();
    const startAbs = this.getAbsoluteIndex(cursor.line, cursor.col);
    const targetLineText = lines[targetLine] ?? "";
    const targetEndAbs = this.getAbsoluteIndex(
      targetLine,
      targetLineText.length,
    );

    const firstNonBlank = findFirstNonWhitespaceColumn(
      lines[cursor.line] ?? "",
    );
    const linewise = mode === "delete" && cursor.col <= firstNonBlank;

    if (linewise) {
      const lineStartAbs = this.getAbsoluteIndex(cursor.line, 0);
      this.writeToRegister(`${text.slice(lineStartAbs, targetEndAbs)}\n`);

      let removeStart = lineStartAbs;
      let removeEnd = targetEndAbs;
      if (targetLine < lastLine) {
        removeEnd = targetEndAbs + 1;
      } else if (cursor.line > 0) {
        removeStart = Math.max(0, lineStartAbs - 1);
      }

      const newText = text.slice(0, removeStart) + text.slice(removeEnd);
      this.replaceTextInBuffer(newText, Math.min(startAbs, newText.length));
      this.moveCursorAfterDeleteToLineEnd(cursor.line, cursor.col);
      return true;
    }

    this.writeToRegister(text.slice(startAbs, targetEndAbs));
    const newText = text.slice(0, startAbs) + text.slice(targetEndAbs);
    this.replaceTextInBuffer(newText, Math.min(startAbs, newText.length));
    if (mode === "delete") {
      this.moveCursorAfterDeleteToLineEnd(cursor.line, cursor.col);
    }
    return true;
  }

  private moveCursorAfterDeleteToLineEnd(
    startLine: number,
    startCol: number,
  ): void {
    const lines = this.getLines();
    const lineIndex = Math.min(startLine, Math.max(0, lines.length - 1));
    if (lineIndex < startLine) {
      this.moveCursorToLineStart(lineIndex);
      return;
    }

    const line = lines[lineIndex] ?? "";
    if (line.length > 0 && startCol >= line.length) {
      const graphemes = getLineGraphemes(line);
      this.moveCursorToCol(graphemes[graphemes.length - 1]?.start ?? 0);
      return;
    }

    this.moveCursorToCol(Math.min(startCol, line.length));
  }

  private deleteWithCharMotion(
    motion: CharMotion,
    targetChar: string,
  ): boolean {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    const count = this.takeTotalCount(1);
    const targetCol = findCharMotionTarget(
      line,
      col,
      motion,
      targetChar,
      false,
      count,
    );

    if (targetCol === null) return false;

    this.lastCharMotion = { motion, char: targetChar };
    this.deleteRange(col, targetCol, true);
    return true;
  }

  private handlePendingYank(data: string): void {
    if (this.opDigit(data)) return;

    if (data === "%") {
      this.applyPercentOp();
      return;
    }

    if (data === "y") {
      const count = this.takeTotalCount(1);
      this.yankLinewiseByDelta(count - 1);
      this.pendingOperator = null;
      return;
    }

    if (data === "j" || data === "k") {
      const hasDualCount =
        this.prefixCount.length > 0 && this.operatorCount.length > 0;
      const count = this.takeTotalCount(1);
      const delta = hasDualCount ? Math.max(0, count - 1) : count;
      this.yankLinewiseByDelta(data === "j" ? delta : -delta);
      this.pendingOperator = null;
      return;
    }

    if (data === "G") {
      if (this.prefixCount.length > 0 || this.operatorCount.length > 0) {
        this.cancelPendingOperator(data);
        return;
      }

      this.yankToBufferEndLinewise();
      this.pendingOperator = null;
      return;
    }

    if (data === "_") {
      const count = this.takeTotalCount(1);
      this.yankLinewiseByDelta(count - 1);
      this.pendingOperator = null;
      return;
    }

    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    if (data === "i" || data === "a") {
      this.pendingTextObject = data;
      return;
    }

    if (this.hasPendingCount()) {
      this.cancelPendingOperator(data);
      return;
    }

    if (this.yankWithMotion(data)) {
      this.pendingOperator = null;
    } else {
      this.cancelPendingOperator(data); // cancel on unrecognised motion
    }
  }

  private yankWithMotion(motion: string): boolean {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    const col = cursor.col;

    if (motion === "$") {
      this.yankRange(col, line.length, false);
      return true;
    }

    if (motion === "0") {
      this.yankRange(col, 0, false);
      return true;
    }

    if (motion === "^") {
      this.yankRange(col, findFirstNonWhitespaceColumn(line), false);
      return true;
    }

    const wordMotion = this.resolveWordMotion(motion);
    if (wordMotion) {
      const lineLocalRange = this.tryWordMotionLineLocalRange(
        wordMotion.motion,
        1,
        wordMotion.semanticClass,
      );
      if (lineLocalRange) {
        this.yankRange(
          lineLocalRange.col,
          lineLocalRange.targetCol,
          lineLocalRange.inclusive,
        );
        return true;
      }

      const text = this.getText();
      const currentAbs = this.getAbsoluteIndexFromCursor();
      const targetAbs = this.findWordTargetInText(
        text,
        currentAbs,
        wordMotion.motion === "b" ? "backward" : "forward",
        wordMotion.motion === "e" ? "end" : "start",
        1,
        wordMotion.semanticClass,
      );
      this.yankRangeByAbsolute(
        currentAbs,
        targetAbs,
        wordMotion.motion === "e",
      );
      return true;
    }

    return false;
  }

  private yankWithCharMotion(motion: CharMotion, targetChar: string): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    const count = this.takeTotalCount(1);
    const targetCol = findCharMotionTarget(
      line,
      col,
      motion,
      targetChar,
      false,
      count,
    );

    if (targetCol === null) return;

    this.lastCharMotion = { motion, char: targetChar };
    this.yankRange(col, targetCol, true);
  }

  private yankRange(col: number, targetCol: number, inclusive: boolean): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const start = Math.min(col, targetCol);
    const rawEnd = Math.max(col, targetCol) + (inclusive ? 1 : 0);
    let end = Math.min(rawEnd, line.length);

    if (inclusive) {
      const targetRange = this.getGraphemeRangeAtCol(
        line,
        Math.max(col, targetCol),
        1,
      );
      end = targetRange?.end ?? end;
    }

    if (end <= start) return;

    this.writeToRegister(line.slice(start, end), "yank");
  }

  private yankRangeByAbsolute(
    currentAbs: number,
    targetAbs: number,
    inclusive: boolean = false,
  ): void {
    const text = this.getText();
    const start = Math.min(currentAbs, targetAbs);
    const rawEnd = Math.max(currentAbs, targetAbs) + (inclusive ? 1 : 0);
    const end = Math.min(rawEnd, text.length);
    if (end <= start) return;
    this.writeToRegister(text.slice(start, end), "yank");
  }

  private getCursorFromAbsoluteIndex(
    text: string,
    abs: number,
  ): { line: number; col: number } {
    const lines = text.length === 0 ? [""] : text.split("\n");
    let remaining = Math.max(0, Math.min(abs, text.length));
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex] ?? "";
      if (remaining <= line.length) return { line: lineIndex, col: remaining };
      remaining -= line.length + 1;
    }
    const lastLine = Math.max(0, lines.length - 1);
    return { line: lastLine, col: (lines[lastLine] ?? "").length };
  }

  private replaceTextInBuffer(text: string, cursorAbs: number): void {
    const editor = this as unknown as {
      state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
      preferredVisualCol?: number | null;
      historyIndex?: number;
      lastAction?: string | null;
      onChange?: (text: string) => void;
      tui?: { requestRender?: () => void };
      pushUndoSnapshot?: () => void;
      autocompleteState?: unknown;
      updateAutocomplete?: () => void;
    };
    const state = editor.state;
    if (!state) return;
    const currentText = this.getText();
    if (currentText !== text) editor.pushUndoSnapshot?.();
    const nextLines = text.length === 0 ? [""] : text.split("\n");
    const { line, col } = this.getCursorFromAbsoluteIndex(text, cursorAbs);
    editor.historyIndex = -1;
    editor.lastAction = null;
    state.lines = nextLines;
    state.cursorLine = line;
    state.cursorCol = col;
    editor.preferredVisualCol = null;
    editor.onChange?.(text);
    if (editor.autocompleteState) editor.updateAutocomplete?.();
    editor.tui?.requestRender?.();
  }

  private deleteRangeByAbsolute(
    currentAbs: number,
    targetAbs: number,
    inclusive: boolean = false,
  ): void {
    const text = this.getText();
    const start = Math.min(currentAbs, targetAbs);
    const rawEnd = Math.max(currentAbs, targetAbs) + (inclusive ? 1 : 0);
    const end = Math.min(rawEnd, text.length);

    if (end <= start) return;

    this.writeToRegister(text.slice(start, end));

    this.replaceTextInBuffer(text.slice(0, start) + text.slice(end), start);
  }

  private getWordObjectRange(
    kind: TextObjectKind,
    count: number = 1,
    semanticClass: WordTextObjectClass = "word",
  ): TextObjectRange | null {
    const lines = this.getLines();
    const cursor = this.getCursor();
    const line = lines[cursor.line] ?? "";
    const lineStartAbs = this.getAbsoluteIndex(cursor.line, 0);

    return resolveWordTextObjectRange(
      line,
      lineStartAbs,
      cursor.col,
      kind,
      count,
      semanticClass,
    );
  }

  private static readonly PUT_SIZE_LIMIT = 512 * 1024; // 512 KB safety cap

  private getPasteRegisterText(): string {
    // A failed or skipped mirror leaves the OS clipboard stale relative to
    // the register, so the register must win until a mirror lands again.
    if (
      this.preferRegisterForPut ||
      this.clipboardMirror.hasPendingWrite() ||
      (this.unnamedRegister !== "" && this.clipboardMirror.lastWriteFailed())
    ) {
      return this.unnamedRegister;
    }

    try {
      const clipboardText = this.clipboardReadFn();
      return clipboardText ?? this.unnamedRegister;
    } catch {
      return this.unnamedRegister;
    }
  }

  private moveCursorToPreviousGraphemeStart(): void {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    const col = Math.max(0, Math.min(cursor.col, line.length));
    if (col <= 0) return;

    const range = this.getGraphemeRangeAtCol(line, col - 1, 1);
    if (range) this.moveCursorToCol(range.start);
  }

  private putAfter(): void {
    const count = this.takeTotalCount(1);
    const text = this.getPasteRegisterText();
    if (!text) return;
    const safeCount = Math.min(
      count,
      Math.max(1, Math.floor(ModalEditor.PUT_SIZE_LIMIT / text.length)),
    );

    if (text.endsWith("\n")) {
      const content = text.slice(0, -1);
      for (let i = 0; i < safeCount; i++) {
        super.handleInput(CTRL_E);
        super.handleInput(NEWLINE);
        for (const char of content) {
          super.handleInput(char === "\n" ? NEWLINE : char);
        }
      }
      return;
    }

    if (!this.isCursorAtOrPastEol()) {
      super.handleInput(ESC_RIGHT);
    }
    for (let i = 0; i < safeCount; i++) {
      for (const char of text) {
        super.handleInput(char === "\n" ? NEWLINE : char);
      }
    }
    this.moveCursorToPreviousGraphemeStart();
  }

  private putBefore(): void {
    const count = this.takeTotalCount(1);
    const text = this.getPasteRegisterText();
    if (!text) return;
    const safeCount = Math.min(
      count,
      Math.max(1, Math.floor(ModalEditor.PUT_SIZE_LIMIT / text.length)),
    );

    if (text.endsWith("\n")) {
      const content = text.slice(0, -1);
      for (let i = 0; i < safeCount; i++) {
        super.handleInput(CTRL_A);
        super.handleInput(NEWLINE);
        super.handleInput(ESC_UP);
        for (const char of content) {
          super.handleInput(char === "\n" ? NEWLINE : char);
        }
      }
      return;
    }

    for (let i = 0; i < safeCount; i++) {
      for (const char of text) {
        super.handleInput(char === "\n" ? NEWLINE : char);
      }
    }
    this.moveCursorToPreviousGraphemeStart();
  }

  private deleteRange(
    col: number,
    targetCol: number,
    inclusive: boolean,
  ): void {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    const lineStartAbs = this.getAbsoluteIndex(cursor.line, 0);
    const start = Math.min(col, targetCol);
    const rawEnd = Math.max(col, targetCol) + (inclusive ? 1 : 0);
    let end = Math.min(rawEnd, line.length);

    if (inclusive) {
      const targetRange = this.getGraphemeRangeAtCol(
        line,
        Math.max(col, targetCol),
        1,
      );
      end = targetRange?.end ?? end;
    }

    this.deleteRangeByAbsolute(lineStartAbs + start, lineStartAbs + end);
  }

  private getDesiredCursorShapeSequence(): CursorShapeSequence {
    return "insert" === this.mode && this.pendingExCommand === null
      ? INSERT_CURSOR_SHAPE
      : BLOCK_CURSOR_SHAPE;
  }

  private syncCursorShapeForRender(lines: string[]): void {
    if (!this.cursorShapeRuntime) return;
    if (!hasPromptCursorMarker(lines)) return;

    if (this.cursorShapeRuntime.getShowHardwareCursor?.() === false) {
      this.lastCursorShapeSequence = null;
      return;
    }

    stripSoftwareCursorWhenHardwareCursorIsUsed(lines);

    const sequence = this.getDesiredCursorShapeSequence();
    if (sequence === this.lastCursorShapeSequence) return;

    this.cursorShapeRuntime.writeCursorShape(sequence);
    this.lastCursorShapeSequence = sequence;
  }

  render(width: number): string[] {
    const lines = super.render(width);
    this.syncCursorShapeForRender(lines);
    if (lines.length === 0) return lines;

    const rawLabel = fitModeLabel(this.getModeLabel(), width);
    const colorize = this.getModeLabelColorizer();
    const label = colorize ? colorize(rawLabel) : rawLabel;
    const last = lines.length - 1;
    const lastLine = lines[last];
    if (lastLine && visibleWidth(lastLine) >= visibleWidth(rawLabel)) {
      const contentWidth = width - visibleWidth(rawLabel);
      const c = this.lastLineCache;
      if (lastLine !== c.l || contentWidth !== c.w || label !== c.label) {
        c.l = lastLine;
        c.w = contentWidth;
        c.label = label;
        c.result = truncateToWidth(lastLine, contentWidth, "") + label;
      }
      lines[last] = c.result;
    } else {
      lines[last] = label;
    }
    return lines;
  }

  private getModeLabelColorizer(): ((s: string) => string) | null {
    return this.labelColorizers?.[this.getActiveMode()] ?? null;
  }

  private getModeLabel(): string {
    if ("insert" === this.mode) return " INSERT ";
    if (this.pendingExCommand !== null) return ` EX ${this.pendingExCommand}_ `;

    const prefixCount = this.prefixCount;
    const operatorCount = this.operatorCount;

    if (isVisualMode(this.mode)) {
      const name = this.mode === "visual" ? "VISUAL" : "V-LINE";
      const pending = `${prefixCount}${this.pendingG ? `g${this.pendingGCount}` : ""}${this.pendingMotion ?? ""}`;
      return pending ? ` ${name} ${pending}_ ` : ` ${name} `;
    }

    if (this.pendingReplace) {
      return prefixCount ? ` NORMAL ${prefixCount}r_ ` : " NORMAL r_ ";
    }
    if (this.pendingOperator && this.pendingMotion) {
      return ` NORMAL ${prefixCount}${this.pendingOperator}${operatorCount}${this.pendingMotion}_ `;
    }
    if (this.pendingOperator) {
      return ` NORMAL ${prefixCount}${this.pendingOperator}${operatorCount}_ `;
    }
    if (this.pendingMotion) return ` NORMAL ${this.pendingMotion}_ `;
    if (this.pendingG) {
      return this.pendingGCount
        ? ` NORMAL g${this.pendingGCount}_ `
        : " NORMAL g_ ";
    }

    const count = `${prefixCount}${operatorCount}`;
    if (count) return ` NORMAL ${count}_ `;
    return " NORMAL ";
  }
}

export default function (pi: ExtensionAPI) {
  let cursorShapeCleanup: CursorShapeCleanup | null = null;

  pi.on("session_start", (_event, ctx) => {
    const piVimSettings = readPiVimSettings(ctx.cwd);
    const clipboardMirrorPolicy = resolveClipboardMirrorPolicy(
      piVimSettings.clipboardMirror,
    );
    if (clipboardMirrorPolicy.warning && ctx.hasUI) {
      ctx.ui.notify(clipboardMirrorPolicy.warning, "warning");
    }

    const t = ctx.ui.theme;
    const modeColors = resolveModeColors(piVimSettings.modeColors);
    const reverseVideo = (s: string) => `\x1b[7m${s}\x1b[27m`;
    const labelColorizers = t
      ? buildModeColorizers(t, modeColors, reverseVideo)
      : null;
    const borderColorizers =
      t && piVimSettings.syncBorderColorWithMode === true
        ? buildModeColorizers(t, modeColors)
        : null;
    const modeChangeHandler = createModeChangeHandler(
      piVimSettings.modeChange,
      (event) => pi.events.emit("pi-vim:mode-change", event),
    );
    ctx.ui.setEditorComponent((tui, theme, kb) => {
      cursorShapeCleanup = enableCursorShapeSupport(tui);
      const editor = new ModalEditor(tui, theme, kb, {
        labelColorizers,
        borderColorizers,
      });
      editor.setClipboardMirrorPolicy(clipboardMirrorPolicy.policy);
      editor.setQuitFn(() => ctx.shutdown());
      editor.setNotifyFn((message) => ctx.ui.notify(message, "warning"));
      editor.setModeChangeFn(modeChangeHandler);
      return editor;
    });
  });

  pi.on("session_shutdown", (event) => {
    try {
      cursorShapeCleanup?.(event);
    } finally {
      cancelModeChangeCommands();
      cursorShapeCleanup = null;
    }
  });
}
