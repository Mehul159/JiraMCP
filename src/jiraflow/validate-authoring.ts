// Objective validator for generated test automation.
//
// The 5-reviewer gate in the authoring pack is a checklist the agent grades
// itself on — and a self-graded gate can pass on an assumption or on invented
// locators (exactly the BR-16921 failure mode). This module turns the two
// failure-prone reviewers into PROGRAMMATIC checks that read the real edited
// files and cross-check them against the repo:
//
//   • Reviewer 2 (Anti-Fabrication) — every feature step must resolve to a real
//     step definition; newly-introduced selectors are surfaced for human
//     confirmation; step files must not embed locators.
//   • Reviewer 1 (Prerequisite / Data pre-state) — entities referenced by name
//     (company "X") should be created within the test or a tagged setup.
//
// Plus objective framework/runnability checks (try/catch, @shouldpass, a real
// Then assertion, leftover [TODO], login key exists in users.config.json).
//
// Design priorities: reliability first. Objective, deterministic failures BLOCK;
// provenance/heuristic concerns are ADVISORY (flagged, never silently passed).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildStepFamilies, findFamilyForStep, familyKey } from "./confusable-steps.js";

const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 256 * 1024;
const MAX_STEP_FILES = 600;

export type ReviewVerdict = "APPROVE" | "REQUEST CHANGES";

export type ReviewerResult = {
  id: number;
  name: string;
  verdict: ReviewVerdict;
  blocking: string[]; // objective failures → REQUEST CHANGES
  advisories: string[]; // heuristic / provenance notes → does not block
};

export type AutomationReview = {
  repoRoot: string;
  changed_files: string[];
  passed: boolean;
  score: string; // e.g. "3/5"
  reviewers: ReviewerResult[];
  markdown: string;
};

type FeatureStep = { keyword: string; text: string; line: number };
type FeatureScenario = {
  file: string;
  name: string;
  tags: string[];
  startLine: number;
  steps: FeatureStep[];
};
type StepDef = { file: string; pattern: string };

// ──────────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────────

export async function buildAutomationReview(opts: {
  repoRoot: string;
  files?: string[]; // explicit changed-file list; if omitted, derived from git
  ticket?: string;
}): Promise<AutomationReview> {
  const { repoRoot } = opts;

  const changed =
    opts.files && opts.files.length
      ? dedupe(opts.files.map((f) => f.replace(/\\/g, "/")))
      : await gitChangedFiles(repoRoot);

  const featureFiles = changed.filter((f) => /\.feature$/i.test(f));
  const stepFilesChanged = changed.filter(isStepFile);
  const codeFilesChanged = changed.filter((f) => /\.(t|j)sx?$/i.test(f));
  const poLocatorChanged = changed.filter(
    (f) => isLocatorFile(f) || isPageObjectFile(f),
  );

  // Universe of defined steps across the whole repo (not just changed files),
  // so reused steps still resolve.
  const allStepFiles = (await gitLsFiles(repoRoot)).filter(isStepFile).slice(0, MAX_STEP_FILES);
  const stepDefs = await mineStepDefs(repoRoot, allStepFiles);

  // Parse only the scenarios that belong to the changed feature files. If a
  // ticket key is given, narrow to scenarios tagged with it (the new work).
  const scenarios: FeatureScenario[] = [];
  for (const rel of featureFiles) {
    const content = await readFileCapped(join(repoRoot, rel));
    if (!content) continue;
    scenarios.push(...parseFeatureWithMeta(content, rel));
  }
  const targetScenarios = opts.ticket
    ? scenarios.filter((s) => s.tags.some((t) => eqTag(t, opts.ticket!)))
    : scenarios;
  const reviewScenarios = targetScenarios.length ? targetScenarios : scenarios;

  // Added lines in changed code files (for new-selector detection).
  const addedByFile = new Map<string, string[]>();
  for (const f of poLocatorChanged) {
    addedByFile.set(f, await gitAddedLines(repoRoot, f));
  }

  const usersConfig = await loadUserKeys(repoRoot);

  const reviewers: ReviewerResult[] = [
    reviewPrerequisites(reviewScenarios),
    await reviewAntiFabrication(repoRoot, reviewScenarios, stepDefs, stepFilesChanged, addedByFile),
    await reviewFrameworkConventions(repoRoot, reviewScenarios, stepFilesChanged, codeFilesChanged),
    reviewFunctionalCoverage(reviewScenarios),
    await reviewRunnability(repoRoot, reviewScenarios, changed, usersConfig),
  ];

  const approveCount = reviewers.filter((r) => r.verdict === "APPROVE").length;
  const passed = reviewers.every((r) => r.verdict === "APPROVE");
  const score = `${approveCount}/${reviewers.length}`;

  return {
    repoRoot,
    changed_files: changed,
    passed,
    score,
    reviewers,
    markdown: renderReview(reviewers, passed, score, changed, reviewScenarios.length),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Reviewer 1 — Prerequisite & data pre-state (heuristic → advisory)
// ──────────────────────────────────────────────────────────────────────────

function reviewPrerequisites(scenarios: FeatureScenario[]): ReviewerResult {
  const blocking: string[] = [];
  const advisories: string[] = [];

  for (const sc of scenarios) {
    const bodies = sc.steps.map((s) => s.text);
    const joined = bodies.join("\n").toLowerCase();

    // Objective: a scenario must start its setup with a login/Given step
    // (or it is relying on an unseen Background — advisory, not a hard fail).
    const hasLogin = bodies.some((b) => /\blog(s|ged)?\s*in|logs into|with user\b/i.test(b));
    if (!hasLogin) {
      advisories.push(`"${sc.name}" — no login/session step found; confirm a Background provides it.`);
    }

    // Data pre-state heuristic: entities referenced by name should be created in
    // the test (or a tagged setup) — not assumed to pre-exist.
    const companies = uniqueMatches(joined, /company\s+"([^"]+)"/gi);
    for (const company of companies) {
      const createsIt =
        joined.includes(`edit icon of company "${company}"`) ||
        /add company user|import compan|create compan/i.test(joined);
      if (!createsIt) {
        advisories.push(
          `"${sc.name}" references company "${company}" but no setup step creates/edits it in-test — confirm it is a real pre-existing fixture, not an assumption.`,
        );
      }
    }

    // If it verifies a user/selection count but never creates users → advisory.
    const verifiesCount = /verif\w*.*\b(\d+)\b.*user|user.*selected/i.test(joined);
    const createsUsers = /add company user|create .*user/i.test(joined);
    if (verifiesCount && !createsUsers) {
      advisories.push(
        `"${sc.name}" asserts a user/selection count but creates no users in-test — the expected count may be assuming pre-existing data.`,
      );
    }
  }

  // This reviewer never hard-blocks on heuristics (avoids false negatives), but
  // advisories MUST be read. Verdict is APPROVE only when there are no advisories.
  const verdict: ReviewVerdict = advisories.length === 0 ? "APPROVE" : "REQUEST CHANGES";
  return { id: 1, name: "Prerequisite & Sequence", verdict, blocking, advisories };
}

// ──────────────────────────────────────────────────────────────────────────
// Reviewer 2 — Anti-fabrication & reuse (objective)
// ──────────────────────────────────────────────────────────────────────────

async function reviewAntiFabrication(
  repoRoot: string,
  scenarios: FeatureScenario[],
  stepDefs: StepDef[],
  stepFilesChanged: string[],
  addedByFile: Map<string, string[]>,
): Promise<ReviewerResult> {
  const blocking: string[] = [];
  const advisories: string[] = [];

  // 1) Every feature step must resolve to a real step definition. An unmatched
  //    step is an undefined step → it WILL error at runtime. This is the
  //    objective signal that catches invented step text.
  const compiled = stepDefs.map((d) => ({ d, m: compileMatcher(d.pattern) }));
  for (const sc of scenarios) {
    for (const st of sc.steps) {
      if (!stepResolves(st.text, compiled)) {
        blocking.push(
          `Undefined step (no matching step definition): "${st.keyword} ${st.text}" — ${sc.file}:${st.line}. Reuse an existing step or ask the user; do not leave it undefined.`,
        );
      }
    }
  }

  // 2) Newly-introduced selectors cannot be auto-verified as real — surface them
  //    for human confirmation (this is exactly where fabricated locators hide).
  for (const [file, lines] of addedByFile) {
    for (const sel of extractNewSelectors(lines)) {
      advisories.push(
        `New selector introduced in ${file}: \`${sel.name}\` → \`${sel.selector}\`. Confirm this was PROVIDED/verified by a human — not invented.`,
      );
    }
  }

  // 3) Step files must not embed locators (that is a page-object's job).
  for (const f of stepFilesChanged) {
    const content = await readFileCapped(join(repoRoot, f));
    if (!content) continue;
    if (/\$\$?\(|\bbrowser\.\b|\bdriver\.\$|By\.(xpath|css)/.test(content)) {
      blocking.push(
        `Locator/browser call found inside step file ${f} — step definitions must only call page-object methods.`,
      );
    }
  }

  // 4) Duplicate step definitions (same pattern twice) → advisory.
  const seen = new Map<string, number>();
  for (const d of stepDefs) seen.set(d.pattern, (seen.get(d.pattern) ?? 0) + 1);
  for (const [pat, n] of seen) {
    if (n > 1) advisories.push(`Duplicate step definition defined ${n}× : "${pat}".`);
  }

  // 5) Confusable steps: a step that belongs to a family of look-alike REAL steps
  //    (e.g. "Save" vs "Save & Exit") is a wrong-but-valid pick that exact-match
  //    checks can never catch. Surface each distinct pick once for human
  //    confirmation. Deduped by (family, chosen variant) to stay low-noise.
  const families = buildStepFamilies(stepDefs.map((d) => d.pattern));
  const flaggedConfusables = new Set<string>();
  for (const sc of scenarios) {
    for (const st of sc.steps) {
      const fam = findFamilyForStep(st.text, families);
      if (!fam) continue;
      const chosen = familyKey(st.text)?.modifierKey ?? "";
      const dedupKey = `${fam.signature}|${chosen}`;
      if (flaggedConfusables.has(dedupKey)) continue;
      flaggedConfusables.add(dedupKey);
      const siblings = fam.variants
        .filter((v) => v.modifierKey !== chosen)
        .map((v) => `"${v.pattern}"`)
        .join(", ");
      if (!siblings) continue;
      advisories.push(
        `Confusable step "${st.text}" (${sc.file}:${st.line}) — look-alike real sibling(s): ${siblings}. ` +
          `All are valid steps with different behaviour; confirm this is the intended variant for this flow (pick by outcome, not by frequency).`,
      );
    }
  }

  const verdict: ReviewVerdict =
    blocking.length === 0 && advisories.length === 0 ? "APPROVE" : "REQUEST CHANGES";
  return { id: 2, name: "Anti-Fabrication & Reuse", verdict, blocking, advisories };
}

// ──────────────────────────────────────────────────────────────────────────
// Reviewer 3 — Framework & convention (objective)
// ──────────────────────────────────────────────────────────────────────────

async function reviewFrameworkConventions(
  repoRoot: string,
  scenarios: FeatureScenario[],
  stepFilesChanged: string[],
  codeFilesChanged: string[],
): Promise<ReviewerResult> {
  const blocking: string[] = [];
  const advisories: string[] = [];

  // @shouldpass tag mandatory on every (changed) scenario.
  for (const sc of scenarios) {
    if (!sc.tags.some((t) => /^@shouldpass$/i.test(t))) {
      blocking.push(`Scenario "${sc.name}" (${sc.file}:${sc.startLine}) is missing the @shouldpass tag.`);
    }
  }

  // Page-object methods must be wrapped in try/catch.
  for (const f of codeFilesChanged) {
    if (isStepFile(f)) continue; // steps handled in reviewer 2
    if (!isPageObjectFile(f)) continue;
    const content = await readFileCapped(join(repoRoot, f));
    if (!content) continue;
    for (const m of findAsyncMethodsWithoutTryCatch(content)) {
      blocking.push(`Page-object method \`${m}\` in ${f} is not wrapped in try/catch.`);
    }
  }

  void stepFilesChanged;
  const verdict: ReviewVerdict =
    blocking.length === 0 && advisories.length === 0 ? "APPROVE" : "REQUEST CHANGES";
  return { id: 3, name: "Framework & Convention", verdict, blocking, advisories };
}

// ──────────────────────────────────────────────────────────────────────────
// Reviewer 4 — Functional coverage (objective + advisory)
// ──────────────────────────────────────────────────────────────────────────

function reviewFunctionalCoverage(scenarios: FeatureScenario[]): ReviewerResult {
  const blocking: string[] = [];
  const advisories: string[] = [];

  for (const sc of scenarios) {
    const hasThen = sc.steps.some((s) => /^then$/i.test(s.keyword));
    const hasVerify = sc.steps.some((s) => /\bverif|assert|should|expect|displayed|present\b/i.test(s.text));
    if (!hasThen && !hasVerify) {
      blocking.push(`Scenario "${sc.name}" has no Then/verification step — a test with no assertion proves nothing.`);
    }
    // Hardcoded expected values cannot be checked against acceptance criteria here.
    const expected = uniqueMatches(sc.steps.map((s) => s.text).join("\n"), /verif\w*.*?"(\d+)"/gi);
    if (expected.length) {
      advisories.push(
        `"${sc.name}" asserts hardcoded value(s) ${expected.map((e) => `"${e}"`).join(", ")} — confirm these come from the ticket's acceptance criteria, not from reasoning.`,
      );
    }
  }

  const verdict: ReviewVerdict =
    blocking.length === 0 && advisories.length === 0 ? "APPROVE" : "REQUEST CHANGES";
  return { id: 4, name: "Functional Coverage", verdict, blocking, advisories };
}

// ──────────────────────────────────────────────────────────────────────────
// Reviewer 5 — Runnability & quality (objective)
// ──────────────────────────────────────────────────────────────────────────

async function reviewRunnability(
  repoRoot: string,
  scenarios: FeatureScenario[],
  changed: string[],
  userKeys: Set<string> | null,
): Promise<ReviewerResult> {
  const blocking: string[] = [];
  const advisories: string[] = [];

  // Leftover [TODO] markers in any changed file.
  for (const f of changed) {
    const content = await readFileCapped(join(repoRoot, f));
    if (!content) continue;
    if (/\[TODO/i.test(content)) blocking.push(`Unresolved [TODO] left in ${f}.`);
  }

  // Login keys referenced should exist in users.config.json — but this is an
  // ADVISORY, not a hard block: a key may legitimately be added in a separate
  // merge request / config branch, so a "missing" key here is not proof of a
  // runtime failure. Surface it loudly, but never block the gate on it.
  if (userKeys) {
    for (const sc of scenarios) {
      for (const key of uniqueMatches(sc.steps.map((s) => s.text).join("\n"), /with user "([^"]+)"/gi)) {
        if (!userKeys.has(key)) {
          advisories.push(
            `Login user key "${key}" in "${sc.name}" was not found in users.config.json. ` +
              `If it is added in another MR/config branch this is fine — otherwise add it before running.`,
          );
        }
      }
    }
  } else {
    advisories.push("Could not read users.config.json — login user keys were not verified.");
  }

  // Blind fixed waits are flaky — report the count.
  let waits = 0;
  for (const sc of scenarios) {
    waits += sc.steps.filter((s) => /waits? for "\d+" seconds/i.test(s.text)).length;
  }
  if (waits > 0) {
    advisories.push(`${waits} fixed wait step(s) found — prefer explicit waits; fixed sleeps cause flakiness.`);
  }

  const verdict: ReviewVerdict =
    blocking.length === 0 && advisories.length === 0 ? "APPROVE" : "REQUEST CHANGES";
  return { id: 5, name: "Runnability & Quality", verdict, blocking, advisories };
}

// ──────────────────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────────────────

function renderReview(
  reviewers: ReviewerResult[],
  passed: boolean,
  score: string,
  changed: string[],
  scenarioCount: number,
): string {
  const md: string[] = [];
  md.push("# Automation Review Gate (objective)");
  md.push("");
  md.push(passed ? `✅ **PASSED (${score})** — safe to present.` : `⛔ **BLOCKED (${score})** — fix the items below, then re-run.`);
  md.push("");
  md.push(`Reviewed ${scenarioCount} scenario(s) across ${changed.length} changed file(s).`);
  md.push("");
  md.push("```");
  md.push("REVIEW GATE");
  for (const r of reviewers) {
    const mark = r.verdict === "APPROVE" ? "APPROVE" : "REQUEST CHANGES";
    md.push(` ${r.id}. ${r.name.padEnd(26, ".")} ${mark}`);
  }
  md.push(` → ${passed ? `PASSED (${score}). Safe to present.` : `BLOCKED (${score}). Do not present code.`}`);
  md.push("```");
  md.push("");

  for (const r of reviewers) {
    if (r.blocking.length === 0 && r.advisories.length === 0) continue;
    md.push(`## ${r.id}. ${r.name} — ${r.verdict}`);
    if (r.blocking.length) {
      md.push("**Blocking (must fix):**");
      for (const b of r.blocking) md.push(`- ⛔ ${b}`);
    }
    if (r.advisories.length) {
      md.push("**Advisory (confirm):**");
      for (const a of r.advisories) md.push(`- ⚠️ ${a}`);
    }
    md.push("");
  }

  if (!passed) {
    md.push("> Per the master automation prompt: do NOT present code until this gate is APPROVE on all five.");
    md.push("> For any missing step/locator, add it to Required Inputs and ask the user — never fabricate.");
  }
  return md.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Parsing + matching helpers
// ──────────────────────────────────────────────────────────────────────────

function parseFeatureWithMeta(content: string, file: string): FeatureScenario[] {
  const lines = content.split(/\r?\n/);
  const scenarios: FeatureScenario[] = [];
  let pendingTags: string[] = [];
  let current: FeatureScenario | null = null;

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    const lineNo = idx + 1;
    if (line.startsWith("@")) {
      pendingTags.push(...line.split(/\s+/).filter((t) => t.startsWith("@")));
      return;
    }
    const sc = line.match(/^Scenario(?:\s+Outline)?:\s*(.+)$/i);
    if (sc) {
      current = { file, name: sc[1].trim(), tags: pendingTags, startLine: lineNo, steps: [] };
      scenarios.push(current);
      pendingTags = [];
      return;
    }
    const st = line.match(/^(Given|When|Then|And|But)\s+(.+)$/i);
    if (st && current) {
      current.steps.push({ keyword: capitalize(st[1]), text: st[2].trim(), line: lineNo });
      return;
    }
    // Blank line between tag block and a non-scenario keyword resets stray tags.
    if (line === "" && !current) pendingTags = pendingTags.length ? pendingTags : [];
  });
  return scenarios;
}

async function mineStepDefs(repoRoot: string, files: string[]): Promise<StepDef[]> {
  const out: StepDef[] = [];
  const seen = new Set<string>();
  for (const rel of files) {
    const content = await readFileCapped(join(repoRoot, rel));
    if (!content) continue;
    for (const pat of extractStepPatterns(content)) {
      const key = pat;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: rel, pattern: pat });
    }
  }
  return out;
}

function extractStepPatterns(content: string): string[] {
  const pats: string[] = [];
  const jsRe = /\b(Given|When|Then|And|But)\s*\(\s*([`'"/])([\s\S]*?)\2/g;
  const javaRe = /@(Given|When|Then|And|But)\s*\(\s*"([\s\S]*?)"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = jsRe.exec(content)) !== null) {
    const p = m[3].replace(/\s+/g, " ").trim();
    if (p.length > 2 && p.length < 300) pats.push(p);
  }
  while ((m = javaRe.exec(content)) !== null) {
    const p = m[2].replace(/\s+/g, " ").trim();
    if (p.length > 2 && p.length < 300) pats.push(p);
  }
  return pats;
}

type Matcher = { re: RegExp | null; literal: string };

function compileMatcher(pattern: string): Matcher {
  let re: RegExp | null = null;
  try {
    // Anchor if not already anchored so partial text doesn't over-match.
    const body = pattern.replace(/^\^/, "").replace(/\$$/, "");
    re = new RegExp(`^${body}$`);
  } catch {
    re = null;
  }
  return { re, literal: literalize(pattern) };
}

function stepResolves(stepText: string, defs: { d: StepDef; m: Matcher }[]): boolean {
  const lit = literalize(stepText);
  for (const { m } of defs) {
    if (m.re && m.re.test(stepText)) return true;
    if (m.literal && m.literal === lit) return true;
  }
  return false;
}

// Normalize a step / pattern to a comparable literal: blank out quoted params,
// strip regex tokens and cucumber expression params, collapse whitespace.
function literalize(s: string): string {
  return s
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/"\(\[\^"\]\*\)\??"/g, '""') // "([^"]*)?" → ""
    .replace(/\([^)]*\)\??/g, "") // remaining capture groups
    .replace(/\{(string|int|float|word)\}/g, "") // cucumber expressions
    .replace(/"[^"]*"/g, '""') // any quoted literal → ""
    .replace(/\\/g, "")
    .replace(/[?]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractNewSelectors(addedLines: string[]): { name: string; selector: string }[] {
  const out: { name: string; selector: string }[] = [];
  const re = /get\s+(\w+)\s*\(\s*\)\s*\{\s*return\s+\$\$?\(\s*([`'"])([\s\S]*?)\2/;
  for (const line of addedLines) {
    const m = line.match(re);
    if (m) out.push({ name: m[1], selector: truncate(m[3], 120) });
  }
  return out;
}

// Find async methods whose body has no try/catch. Brace-balanced scan.
function findAsyncMethodsWithoutTryCatch(content: string): string[] {
  const out: string[] = [];
  const re = /\basync\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const bodyStart = m.index + m[0].length - 1; // position of '{'
    const body = sliceBalanced(content, bodyStart);
    if (body == null) continue;
    if (!/\btry\b/.test(body) || !/\bcatch\b/.test(body)) out.push(name);
  }
  return out;
}

function sliceBalanced(content: string, openBraceIdx: number): string | null {
  let depth = 0;
  for (let i = openBraceIdx; i < content.length; i++) {
    const ch = content[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return content.slice(openBraceIdx + 1, i);
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Git + fs helpers
// ──────────────────────────────────────────────────────────────────────────

async function gitChangedFiles(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "-uall"], {
      cwd: repoRoot,
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const files: string[] = [];
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.replace(/\r$/, "");
      if (!line.trim()) continue;
      let path = line.slice(3).trim();
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) path = path.slice(arrow + 4).trim(); // renamed → new name
      path = path.replace(/^"(.*)"$/, "$1");
      files.push(path.replace(/\\/g, "/"));
    }
    return dedupe(files);
  } catch {
    return [];
  }
}

async function gitAddedLines(repoRoot: string, file: string): Promise<string[]> {
  const added: string[] = [];
  const collect = (stdout: string) => {
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
    }
  };
  for (const args of [
    ["diff", "--unified=0", "--", file],
    ["diff", "--cached", "--unified=0", "--", file],
  ]) {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
      collect(stdout);
    } catch {
      /* ignore */
    }
  }
  // Untracked file: whole content is "added".
  if (added.length === 0) {
    const content = await readFileCapped(join(repoRoot, file));
    if (content) added.push(...content.split(/\r?\n/));
  }
  return added;
}

async function gitLsFiles(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: repoRoot,
      timeout: 8000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function loadUserKeys(repoRoot: string): Promise<Set<string> | null> {
  for (const rel of ["users.config.json", "config/users.config.json", "test/users.config.json"]) {
    const content = await readFileCapped(join(repoRoot, rel));
    if (!content) continue;
    try {
      const json = JSON.parse(content) as { users?: Record<string, unknown> };
      if (json.users && typeof json.users === "object") return new Set(Object.keys(json.users));
    } catch {
      /* try next */
    }
  }
  return null;
}

async function readFileCapped(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path);
    return buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Misc
// ──────────────────────────────────────────────────────────────────────────

function isStepFile(f: string): boolean {
  return (
    /(step[-_ ]?def|step[-_ ]?definition|steps?)/i.test(f) &&
    /\.(t|j)sx?$|\.java$|\.kt$|\.py$|\.rb$|\.cs$/i.test(f)
  );
}

function isLocatorFile(f: string): boolean {
  return /(locator|selector|element)/i.test(f) && /\.(t|j)sx?$/i.test(f);
}

function isPageObjectFile(f: string): boolean {
  return /(page[-_.]?object|pageobjects?|\bpo\b|PO)\b|PO\.(t|j)sx?$/i.test(f) && /\.(t|j)sx?$/i.test(f);
}

function uniqueMatches(text: string, re: RegExp): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = g.exec(text)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

function eqTag(tag: string, ticket: string): boolean {
  return tag.replace(/^@/, "").toUpperCase() === ticket.replace(/^@/, "").toUpperCase();
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
