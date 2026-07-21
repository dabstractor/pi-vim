function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// `npm pack --json` changed its top-level shape across major versions.
// Legacy npm (< 12) prints an array of pack-result objects; npm >= 12 prints
// an object keyed by package name whose values are those same result objects.
// Accept both and normalize to the first result so the gate stays portable
// across whichever npm the caller happens to run.
export function extractPackResult(parsed: unknown): Record<string, unknown> {
  let candidates: unknown[];

  if (Array.isArray(parsed)) {
    candidates = parsed;
  } else if (isObject(parsed)) {
    candidates = Object.values(parsed);
  } else {
    throw new Error(
      "npm pack --dry-run --json returned an unrecognized JSON shape (expected an array or an object keyed by package name)",
    );
  }

  if (candidates.length === 0) {
    throw new Error("npm pack --dry-run --json returned no pack results");
  }

  const firstResult = candidates[0];
  if (!isObject(firstResult)) {
    throw new Error("npm pack --dry-run --json first result is not an object");
  }

  return firstResult;
}
