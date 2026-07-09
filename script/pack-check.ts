import { execSync } from "node:child_process";
import { posix } from "node:path";

type PackFile = {
  path: string;
};

type PackResult = {
  files: PackFile[];
  size: number;
  unpackedSize: number;
};

type DeterminismResult = {
  passed: boolean;
  details: string[];
};

type ForbiddenMatch = {
  path: string;
  globs: string[];
};

type CheckSummary = {
  name: string;
  passed: boolean;
  details: string[];
};

const REQUIRED_FILES = [
  "LICENSE",
  "README.md",
  "package.json",
  "index.ts",
  "motions.ts",
  "settings.ts",
  "types.ts",
  "word-boundary-cache.ts",
] as const;

const FORBIDDEN_GLOBS = [
  "doc/**",
  "test/**",
  ".pi/**",
  "**/*.patch",
  "**/LOOP.md",
  "**/plan*.md",
  "**/spec*.md",
  "**/report*.md",
] as const;

const FORBIDDEN_REGEX_BY_GLOB: Record<
  (typeof FORBIDDEN_GLOBS)[number],
  RegExp
> = {
  "doc/**": /^doc\//,
  "test/**": /^test\//,
  ".pi/**": /^\.pi\//,
  "**/*.patch": /\.patch$/,
  "**/LOOP.md": /(?:^|\/)LOOP\.md$/,
  "**/plan*.md": /(?:^|\/)plan[^/]*\.md$/,
  "**/spec*.md": /(?:^|\/)spec[^/]*\.md$/,
  "**/report*.md": /(?:^|\/)report[^/]*\.md$/,
};

const THRESHOLDS = {
  // Issue #32 modularization: index.ts module-level subsystems move into
  // sibling modules (cursor-shape, mode-colors, mode-change-command,
  // clipboard-mirror), raising the packed file count 10 -> 14 and adding
  // import/export boilerplate (~2 KB unpacked, measured). Same code
  // otherwise. Keep budgets tight enough to catch accidental docs/tests
  // in the package.
  //
  // Counted line-end operators (Nd$/Nc$ across lines, plus count-ignoring
  // Nd0/Nd^/Nc0/Nc^): index.ts adds applyLineEndOperator +
  // moveCursorAfterDeleteToLineEnd and two operator-dispatch guards.
  // Measured: packed 35341 -> 36099 (+758 B), unpacked 151762 -> 155801
  // (+4039 B). Budgets bumped 35500 -> 36400 and 153000 -> 156500 to fit
  // the feature with ~300 B / ~700 B headroom (test files are excluded
  // from the package, so their new cases do not count).
  //
  // Dot repeat (.): index.ts gains the keystroke-recorder (RepeatRecording
  // capture, count-override replay, failed-replay snapshot rollback, and
  // insertTextAtCursor/Enter/Tab recording-cancel guards), a `.`
  // interception, and repeat rows in the README. Measured: packed 36099 ->
  // 38298 (+2199 B), unpacked 155801 -> 166012 (+10211 B; README + the
  // wider try/finally dispatch surface). Budgets bumped 36400 -> 38700 and
  // 156500 -> 167000 to fit the feature with ~400 B / ~1000 B headroom.
  //
  // Mode-label extraction (Track 2 ModalEditor split): fitModeLabel +
  // takeModeLabelSuffix move from index.ts into a new mode-label.ts module.
  // A pure move (behavior identical), but the new file pays its own import
  // + doc-comment boilerplate and a package file entry, so it grows rather
  // than relieves the budget. Measured: packed 38298 -> 38996 (+698 B),
  // unpacked 166012 -> 167258 (+1246 B), files 15 -> 16. Budgets bumped
  // 38700 -> 39300 and 167000 -> 168000 to fit with ~300 B / ~740 B
  // headroom (test files are excluded from the package). File count is now
  // at the maxFiles cap; the next new module needs a maxFiles bump too.
  //
  // Visual mode (v / V): index.ts gains the visualAnchor state, the
  // handleVisualMode dispatch branch, applyVisualOperator and its helpers,
  // and the VISUAL / V-LINE labels; a new visual.ts holds the pure selection
  // geometry; README gains a visual-mode reference section plus three
  // known-difference rows. Measured: packed 38996 -> 42330 (+3334 B),
  // unpacked 167258 -> 179171 (+11913 B), files 16 -> 17. README is inside
  // the package `files` list, so its ~5 KB of new prose dominates the
  // unpacked growth. Budgets bumped to 42800 / 180000 / 17, leaving ~470 B
  // packed and ~829 B unpacked headroom.
  //
  // EX pi-command bridge: index.ts gains the mirrored builtin command names,
  // the reserved-name set, the name/args split in submitPendingExCommand, and
  // dispatchSlashCommand plus its three injected seams; settings.ts gains the
  // exCommand reader and resolver; README gains the pi-command bridge section
  // and a rewritten comparison row. Measured after the README edits (they ship
  // in the package `files` list): packed 42576 -> 45627 (+3051 B), unpacked
  // 179906 -> 189116 (+9210 B), files unchanged at 17 (no new module — the
  // bridge lands in index.ts + settings.ts precisely to avoid a maxFiles bump).
  // Roughly a third of the packed delta is the 21-name builtin mirror, which a
  // future upstream re-export of BUILTIN_SLASH_COMMANDS would remove. Budgets
  // bumped to 46100 / 189900, leaving ~473 B packed and ~784 B unpacked
  // headroom. maxFiles stays at the cap: the next new module must bump it.
  maxFiles: 17,
  maxSize: 46100,
  maxUnpackedSize: 189900,
} as const;

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function runPackDryRun(): PackResult {
  let rawOutput: string;

  try {
    rawOutput = execSync("npm pack --dry-run --json", { encoding: "utf8" });
  } catch (error) {
    throw new Error(`npm pack --dry-run --json failed: ${formatError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (error) {
    throw new Error(
      `Failed to parse npm pack JSON output: ${formatError(error)}`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "npm pack --dry-run --json returned an unexpected JSON shape (expected non-empty array)",
    );
  }

  const firstResult = parsed[0];
  if (!isObject(firstResult)) {
    throw new Error("npm pack --dry-run --json first result is not an object");
  }

  const files = firstResult.files;
  const size = firstResult.size;
  const unpackedSize = firstResult.unpackedSize;

  if (!Array.isArray(files)) {
    throw new Error(
      "npm pack --dry-run --json is missing required field: files[]",
    );
  }

  if (typeof size !== "number" || !Number.isFinite(size)) {
    throw new Error(
      "npm pack --dry-run --json is missing required numeric field: size",
    );
  }

  if (typeof unpackedSize !== "number" || !Number.isFinite(unpackedSize)) {
    throw new Error(
      "npm pack --dry-run --json is missing required numeric field: unpackedSize",
    );
  }

  const packFiles = files.map((entry, index) => {
    if (
      !isObject(entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0
    ) {
      throw new Error(
        `npm pack --dry-run --json files[${index}] is missing string field: path`,
      );
    }

    return { path: entry.path } satisfies PackFile;
  });

  return {
    files: packFiles,
    size,
    unpackedSize,
  };
}

function normalizePath(pathValue: string): string {
  const posixSeparators = pathValue.replace(/\\/g, "/");
  const withoutPackagePrefix = posixSeparators.startsWith("package/")
    ? posixSeparators.slice("package/".length)
    : posixSeparators;
  const withoutLeadingDot = withoutPackagePrefix.startsWith("./")
    ? withoutPackagePrefix.slice(2)
    : withoutPackagePrefix;
  const normalized = posix.normalize(withoutLeadingDot);

  if (normalized.length === 0 || normalized === ".") {
    throw new Error(
      `Invalid empty pack path after normalization: ${pathValue}`,
    );
  }

  if (posix.isAbsolute(normalized)) {
    throw new Error(
      `Pack path must be relative, got absolute path: ${pathValue}`,
    );
  }

  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Pack path escapes package root: ${pathValue}`);
  }

  return normalized;
}

function normalizePaths(files: PackFile[]): string[] {
  return files.map((file) => normalizePath(file.path)).sort(compareStrings);
}

function checkRequired(paths: string[]): string[] {
  const pathSet = new Set(paths);

  return REQUIRED_FILES.filter(
    (requiredPath) => !pathSet.has(requiredPath),
  ).sort(compareStrings);
}

function matchForbidden(paths: string[]): ForbiddenMatch[] {
  const matches: ForbiddenMatch[] = [];

  for (const path of paths) {
    const globs = FORBIDDEN_GLOBS.filter((glob) =>
      FORBIDDEN_REGEX_BY_GLOB[glob].test(path),
    );

    if (globs.length > 0) {
      matches.push({ path, globs });
    }
  }

  return matches;
}

function checkThresholds(result: PackResult): string[] {
  const violations: string[] = [];

  if (result.files.length > THRESHOLDS.maxFiles) {
    violations.push(
      `files.length ${result.files.length} > ${THRESHOLDS.maxFiles}`,
    );
  }

  if (result.size > THRESHOLDS.maxSize) {
    violations.push(`size ${result.size} > ${THRESHOLDS.maxSize}`);
  }

  if (result.unpackedSize > THRESHOLDS.maxUnpackedSize) {
    violations.push(
      `unpackedSize ${result.unpackedSize} > ${THRESHOLDS.maxUnpackedSize}`,
    );
  }

  return violations;
}

function setsDifference(a: string[], b: string[]): string[] {
  const bSet = new Set(b);
  return a.filter((item) => !bSet.has(item));
}

function checkDeterminism(): DeterminismResult {
  const firstRun = runPackDryRun();
  const secondRun = runPackDryRun();

  const firstPaths = normalizePaths(firstRun.files);
  const secondPaths = normalizePaths(secondRun.files);

  const sameLength = firstPaths.length === secondPaths.length;
  const sameEntries =
    sameLength &&
    firstPaths.every((path, index) => path === secondPaths[index]);

  if (sameEntries) {
    return {
      passed: true,
      details: [
        `Stable file set across two consecutive dry-runs (${firstPaths.length} files)`,
      ],
    };
  }

  const onlyInFirstRun = setsDifference(firstPaths, secondPaths);
  const onlyInSecondRun = setsDifference(secondPaths, firstPaths);

  const details: string[] = ["Normalized file sets differ between dry-runs"];

  if (onlyInFirstRun.length > 0) {
    details.push(`Only in run #1: ${onlyInFirstRun.join(", ")}`);
  }

  if (onlyInSecondRun.length > 0) {
    details.push(`Only in run #2: ${onlyInSecondRun.join(", ")}`);
  }

  return {
    passed: false,
    details,
  };
}

function printSummary(
  result: PackResult,
  paths: string[],
  summaries: CheckSummary[],
): void {
  console.log("pack:check summary");
  console.log(`- files: ${paths.length}`);
  console.log(`- size: ${result.size} bytes`);
  console.log(`- unpackedSize: ${result.unpackedSize} bytes`);
  console.log("- file list:");
  for (const path of paths) {
    console.log(`  - ${path}`);
  }

  for (const summary of summaries) {
    const label = summary.passed ? "PASS" : "FAIL";
    console.log(`- [${label}] ${summary.name}`);
    for (const detail of summary.details) {
      console.log(`    - ${detail}`);
    }
  }
}

function main(): void {
  try {
    const summaries: CheckSummary[] = [];

    const determinism = checkDeterminism();
    summaries.push({
      name: "determinism",
      passed: determinism.passed,
      details: determinism.details,
    });

    const packResult = runPackDryRun();
    const normalizedPaths = normalizePaths(packResult.files);

    const missingRequired = checkRequired(normalizedPaths);
    summaries.push({
      name: "required files",
      passed: missingRequired.length === 0,
      details:
        missingRequired.length === 0
          ? [`All required files present (${REQUIRED_FILES.length})`]
          : missingRequired.map((path) => `Missing required file: ${path}`),
    });

    const forbiddenMatches = matchForbidden(normalizedPaths);
    summaries.push({
      name: "forbidden globs",
      passed: forbiddenMatches.length === 0,
      details:
        forbiddenMatches.length === 0
          ? ["No forbidden file paths matched"]
          : forbiddenMatches.map(
              (match) => `${match.path} matches ${match.globs.join(", ")}`,
            ),
    });

    const thresholdViolations = checkThresholds(packResult);
    summaries.push({
      name: "size thresholds",
      passed: thresholdViolations.length === 0,
      details:
        thresholdViolations.length === 0
          ? [
              `files.length ${packResult.files.length} <= ${THRESHOLDS.maxFiles}`,
              `size ${packResult.size} <= ${THRESHOLDS.maxSize}`,
              `unpackedSize ${packResult.unpackedSize} <= ${THRESHOLDS.maxUnpackedSize}`,
            ]
          : thresholdViolations,
    });

    printSummary(packResult, normalizedPaths, summaries);

    const failedChecks = summaries.filter((summary) => !summary.passed);

    if (failedChecks.length > 0) {
      console.error(
        `pack:check failed (${failedChecks.length} check${failedChecks.length === 1 ? "" : "s"})`,
      );
      process.exit(1);
    }

    console.log("pack:check passed");
    process.exit(0);
  } catch (error) {
    console.error("pack:check failed closed");
    console.error(formatError(error));
    process.exit(1);
  }
}

main();
