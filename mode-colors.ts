import type { ModeColorSettings } from "./settings.js";

const MODE_COLORS = {
  insert: "borderMuted",
  normal: "borderAccent",
  ex: "warning",
} as const;
const TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export type ModeColorKey = keyof typeof MODE_COLORS;
export type ModeColorizers = Record<ModeColorKey, (s: string) => string>;
export type ThemeLike = { fg(token: string, text: string): string };

export function resolveModeColors(
  colors?: ModeColorSettings,
): Required<ModeColorSettings> {
  return {
    insert: colors?.insert ?? MODE_COLORS.insert,
    normal: colors?.normal ?? MODE_COLORS.normal,
    ex: colors?.ex ?? MODE_COLORS.ex,
  };
}

function colorizeWithTheme(
  theme: ThemeLike,
  token: string,
  fallback: string,
  text: string,
): string {
  const trimmedToken = token.trim();
  if (TOKEN.test(trimmedToken)) {
    try {
      return theme.fg(trimmedToken, text);
    } catch {
      return theme.fg(fallback, text);
    }
  }
  return theme.fg(fallback, text);
}

export function buildModeColorizers(
  theme: ThemeLike,
  colors: Required<ModeColorSettings>,
  transform: (text: string) => string = (text) => text,
): ModeColorizers {
  const colorizer = (mode: ModeColorKey) => (text: string) =>
    colorizeWithTheme(theme, colors[mode], MODE_COLORS[mode], transform(text));
  return {
    insert: colorizer("insert"),
    normal: colorizer("normal"),
    ex: colorizer("ex"),
  };
}
