import { SettingsManager } from "@mariozechner/pi-coding-agent";

export type ClipboardMirrorPolicy = "all" | "yank" | "never";
export type RegisterWriteSource = "mutation" | "yank";

export const DEFAULT_CLIPBOARD_MIRROR_POLICY: ClipboardMirrorPolicy = "all";

export type PiVimSettings = { clipboardMirror?: unknown };

type UnknownRecord = Record<string, unknown>;

function formatInvalidSettingValue(value: unknown) {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  try {
    return `${JSON.stringify(value) ?? type} (type ${type})`;
  } catch {
    return `(type ${type})`;
  }
}

function getPiVimSettings(settings: unknown): UnknownRecord {
  if (typeof settings !== "object" || settings === null) return {};
  const { piVim } = settings as UnknownRecord;
  return typeof piVim === "object" && piVim !== null ? (piVim as UnknownRecord) : {};
}

export function resolveClipboardMirrorPolicy(value: unknown) {
  if (value === undefined) return { policy: DEFAULT_CLIPBOARD_MIRROR_POLICY };

  if (typeof value === "string") {
    const policy = value.trim().toLowerCase();
    if (policy === "all" || policy === "yank" || policy === "never") {
      return { policy: policy as ClipboardMirrorPolicy };
    }
  }

  return {
    policy: DEFAULT_CLIPBOARD_MIRROR_POLICY,
    warning: `Invalid piVim.clipboardMirror value ${formatInvalidSettingValue(value)}; expected one of: all, yank, never. Falling back to all.`,
  };
}

export function readPiVimClipboardMirrorSetting(globalSettings: unknown, projectSettings: unknown): unknown | undefined {
  const projectPiVim = getPiVimSettings(projectSettings);
  if (Object.hasOwn(projectPiVim, "clipboardMirror")) return projectPiVim.clipboardMirror;

  const globalPiVim = getPiVimSettings(globalSettings);
  if (Object.hasOwn(globalPiVim, "clipboardMirror")) return globalPiVim.clipboardMirror;

  return undefined;
}

function readPiVimSettingsFromDisk(cwd: string): PiVimSettings {
  const settings = SettingsManager.create(cwd);
  return {
    clipboardMirror: readPiVimClipboardMirrorSetting(settings.getGlobalSettings(), settings.getProjectSettings()),
  };
}

let piVimSettingsReader = readPiVimSettingsFromDisk;

export function readPiVimSettings(cwd: string) {
  return piVimSettingsReader(cwd);
}

export function setPiVimSettingsReaderForTests(reader: typeof readPiVimSettingsFromDisk) {
  const prev = piVimSettingsReader;
  piVimSettingsReader = reader;

  return () => {
    piVimSettingsReader = prev;
  };
}
