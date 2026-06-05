// ──────────────────────────────────────────────────────────────────────────
// Confusable step families
//
// Some Gherkin steps share the SAME action + object but differ only by a small
// modifier that changes behaviour — e.g.:
//   "User clicks on Save button on Settings"      (stays on page)
//   "User clicks on Save & Exit button in settings" (saves AND leaves)
//
// Both are REAL step definitions, so exact-match / anti-fabrication checks can
// never tell them apart. An agent tends to pick the most FREQUENT variant, which
// silently breaks scenarios that needed the other one.
//
// This module groups step patterns into "confusable families" (same core
// signature, ≥2 distinct modifier variants) so the pack can warn the author and
// the validator can flag the choice for human confirmation.
//
// Design priority: LOW NOISE. We keep the stopword list small and only group
// steps that genuinely share a core action+object, requiring ≥2 modifier
// variants before a family is reported.
// ──────────────────────────────────────────────────────────────────────────

// Tokens that change WHAT a step does (the differentiator inside a family).
const MODIFIER_TOKENS = new Set([
  "exit",
  "continue",
  "confirm",
  "close",
  "next",
  "draft",
  "final",
  "later",
  "anyway",
  "without",
  "again",
]);

// Generic UI / grammar noise removed before computing the core signature.
// Deliberately small — dropping domain nouns (company, user, settings, record…)
// would over-merge unrelated steps and create false warnings.
const STOPWORDS = new Set([
  "user",
  "the",
  "a",
  "an",
  "on",
  "in",
  "to",
  "of",
  "for",
  "from",
  "at",
  "is",
  "are",
  "be",
  "button",
  "btn",
  "icon",
  "link",
  "tab",
  "field",
  "page",
  "popup",
  "pop",
  "up",
  "menu",
  "header",
  "footer",
  "dropdown",
  "drop",
  "down",
  "checkbox",
  "toggle",
  "option",
  "options",
  "screen",
  "section",
  "modal",
  "dialog",
  "window",
  "label",
]);

export type StepVariant = { pattern: string; modifierKey: string };
export type StepFamily = { signature: string; variants: StepVariant[] };

/** Blank params/regex tokens, strip punctuation, lowercase — comparable text. */
function normalize(pattern: string): string {
  return pattern
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/"\(\[\^"\]\*\)\??"/g, " ") // "([^"]*)?" → space
    .replace(/\([^)]*\)\??/g, " ") // remaining capture groups
    .replace(/\{(string|int|float|word)\}/g, " ") // cucumber expressions
    .replace(/"[^"]*"/g, " ") // any quoted literal
    .replace(/[\\]/g, " ")
    .replace(/[^a-zA-Z0-9 ]/g, " ") // punctuation incl. & becomes a separator
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Compute the (signature, modifierKey) for a step pattern or step text.
 * - signature: sorted core content tokens (action + object + context)
 * - modifierKey: sorted modifier tokens, or "plain" when none
 * Returns null when there is too little content to compare safely.
 */
export function familyKey(
  pattern: string,
): { signature: string; modifierKey: string } | null {
  const norm = normalize(pattern);
  if (!norm) return null;
  const tokens = norm
    .split(" ")
    .filter(Boolean)
    .filter((t) => t !== "&" && t !== "and"); // joiners, not content
  const modifiers: string[] = [];
  const core: string[] = [];
  for (const t of tokens) {
    if (MODIFIER_TOKENS.has(t)) modifiers.push(t);
    else if (!STOPWORDS.has(t)) core.push(t);
  }
  if (core.length < 2) return null; // too trivial to compare without noise
  const signature = [...core].sort().join(" ");
  const modifierKey = modifiers.length
    ? [...new Set(modifiers)].sort().join("+")
    : "plain";
  return { signature, modifierKey };
}

/**
 * Group step patterns into confusable families. A family is only returned when
 * it has ≥2 DISTINCT modifier variants for the same core signature — that is the
 * exact condition under which an agent can silently pick the wrong real step.
 */
export function buildStepFamilies(patterns: string[]): StepFamily[] {
  const bySig = new Map<string, Map<string, StepVariant>>();
  for (const p of patterns) {
    const k = familyKey(p);
    if (!k) continue;
    let m = bySig.get(k.signature);
    if (!m) {
      m = new Map();
      bySig.set(k.signature, m);
    }
    // First pattern seen for a given modifier wins as the representative.
    if (!m.has(k.modifierKey)) m.set(k.modifierKey, { pattern: p, modifierKey: k.modifierKey });
  }
  const families: StepFamily[] = [];
  for (const [signature, m] of bySig) {
    if (m.size < 2) continue; // need ≥2 modifier variants to be confusable
    families.push({ signature, variants: [...m.values()] });
  }
  return families;
}

/**
 * Find the confusable family a given step belongs to (if any). Used by the
 * validator to flag a confusable step for human confirmation.
 */
export function findFamilyForStep(
  stepText: string,
  families: StepFamily[],
): StepFamily | null {
  const k = familyKey(stepText);
  if (!k) return null;
  for (const fam of families) {
    if (
      fam.signature === k.signature &&
      fam.variants.some((v) => v.modifierKey === k.modifierKey)
    ) {
      return fam;
    }
  }
  return null;
}
