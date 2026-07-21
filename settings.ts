import { SettingsManager } from "@earendil-works/pi-coding-agent";

export type ModeColorSettings = {
  insert?: string;
  normal?: string;
  visual?: string;
  ex?: string;
};

export type ModeChangeSettings = {
  insert?: string;
  normal?: string;
};

export type ExCommandSettings = {
  piDispatch: boolean;
  copyInputToClipboard: boolean;
};

export type PiVimSettings = {
  clipboardMirror?: unknown;
  exCommand?: unknown;
  globalExCommand?: unknown;
  modeColors?: ModeColorSettings;
  modeChange?: ModeChangeSettings;
  syncBorderColorWithMode?: boolean;
};

export const DEFAULT_EX_COMMAND_SETTINGS: ExCommandSettings = {
  piDispatch: true,
  copyInputToClipboard: false,
};

const M = Symbol(),
  C = ["insert", "normal", "visual", "ex"] as const,
  MC = ["insert", "normal"] as const,
  T = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const rec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function get(s: unknown, k: keyof PiVimSettings): unknown {
  if (!rec(s) || !Object.hasOwn(s, "piVim")) return M;
  const p = s.piVim;
  if (!rec(p)) return p;
  return Object.hasOwn(p, k) ? p[k] : M;
}

function colors(v: unknown) {
  if (!rec(v)) return;
  const r: ModeColorSettings = {};
  for (const k of C) {
    const x = v[k],
      t = typeof x === "string" ? x.trim() : "";
    if (T.test(t)) r[k] = t;
  }
  return Object.keys(r)[0] ? r : undefined;
}

function modeChange(v: unknown): ModeChangeSettings | undefined {
  if (!rec(v)) return;
  const r: ModeChangeSettings = {};
  for (const k of MC) {
    const x = v[k];
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (t.length > 0) r[k] = t;
  }
  return Object.keys(r)[0] ? r : undefined;
}

export function readPiVimClipboardMirrorSetting(g: unknown, p: unknown) {
  let v = get(p, "clipboardMirror");
  if (v !== M) return v;
  v = get(g, "clipboardMirror");
  return v === M ? undefined : v;
}

export function readPiVimExCommandSetting(g: unknown, p: unknown) {
  // The bridge only selects among commands Pi already trusts; it grants no new
  // capability, so a project file may turn it off (unlike modeChange).
  let v = get(p, "exCommand");
  if (v !== M) return v;
  v = get(g, "exCommand");
  return v === M ? undefined : v;
}

export function readPiVimGlobalExCommandSetting(g: unknown, p: unknown) {
  void p;
  // Copying the prompt to the OS clipboard is an exfiltration capability, so
  // only the user-global settings file is trusted. Project settings may be
  // checked into a repo and must not be able to enable clipboard writes.
  const v = get(g, "exCommand");
  return v === M ? undefined : v;
}

export function resolveExCommandSettings(
  value: unknown,
  globalValue: unknown,
): {
  settings: ExCommandSettings;
  warning?: string;
} {
  const settings = { ...DEFAULT_EX_COMMAND_SETTINGS };
  let invalidObject = false;
  const invalid: string[] = [];
  for (const [k, source] of [
    ["piDispatch", value],
    ["copyInputToClipboard", globalValue],
  ] as const) {
    if (source === undefined) continue;
    if (!rec(source)) {
      invalidObject = true;
      continue;
    }
    if (!Object.hasOwn(source, k)) continue;
    const v = source[k];
    if (typeof v === "boolean") settings[k] = v;
    else invalid.push(k);
  }

  if (invalidObject) {
    return {
      settings,
      warning: "Invalid piVim.exCommand; expected an object.",
    };
  }
  if (!invalid[0]) return { settings };
  return {
    settings,
    warning: `Invalid piVim.exCommand ${invalid.join(", ")}; expected a boolean.`,
  };
}

export function readPiVimModeColors(g: unknown, p: unknown) {
  const v = get(p, "modeColors");
  // Project settings are a whole-setting override. If a project checks in an
  // invalid modeColors value, fall back to pi-vim defaults instead of leaking a
  // developer's global colors into that project.
  if (v !== M) return colors(v);
  const w = get(g, "modeColors");
  return colors(w);
}

export function readPiVimModeChange(g: unknown, p: unknown) {
  void p;
  // modeChange executes a shell command, so only the user-global settings file
  // is trusted. Project settings may be checked into a repo; treating them as
  // executable hook config would let a checkout run arbitrary commands when the
  // editor changes mode.
  const v = get(g, "modeChange");
  return modeChange(v);
}

export function readPiVimBooleanSetting(
  g: unknown,
  p: unknown,
  k: "syncBorderColorWithMode",
) {
  const v = get(p, k);
  if (v !== M) return typeof v === "boolean" ? v : undefined;
  const w = get(g, k);
  return typeof w === "boolean" ? w : undefined;
}

function disk(cwd: string): PiVimSettings {
  const s = SettingsManager.create(cwd),
    g = s.getGlobalSettings(),
    p = s.getProjectSettings();
  return {
    clipboardMirror: readPiVimClipboardMirrorSetting(g, p),
    exCommand: readPiVimExCommandSetting(g, p),
    globalExCommand: readPiVimGlobalExCommandSetting(g, p),
    modeColors: readPiVimModeColors(g, p),
    modeChange: readPiVimModeChange(g, p),
    syncBorderColorWithMode: readPiVimBooleanSetting(
      g,
      p,
      "syncBorderColorWithMode",
    ),
  };
}

let reader = disk;
export function readPiVimSettings(cwd: string) {
  return reader(cwd);
}
export function setPiVimSettingsReaderForTests(next: typeof disk) {
  const prev = reader;
  reader = next;
  return () => {
    reader = prev;
  };
}
