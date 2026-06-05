import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TicketIntelligence } from "./intelligence.js";
import { buildStepFamilies, familyKey } from "./confusable-steps.js";
import {
  adfToPlainText,
  extractAcceptanceLines,
  extractStepsToReproduce,
  keywordsFromText,
} from "./adf.js";

const execFileAsync = promisify(execFile);

const MAX_FEATURE_FILES_READ = 15;
const MAX_STEP_FILES_READ = 20;
const MAX_FILE_BYTES = 96 * 1024;

// Master automation prompt — the single source of truth for priorities and the
// framework conventions. Authored as a real .md file (prompts/automation-master-
// prompt.md) so it is editable without touching code, then loaded here and
// embedded into every authoring pack. An embedded fallback guarantees the
// system never breaks if the file is missing (reliability over cleverness).
const MASTER_PROMPT_RELATIVE = "prompts/automation-master-prompt.md";

let masterPromptCache: { text: string; path?: string } | null = null;

async function loadMasterPrompt(): Promise<{ text: string; path?: string }> {
  if (masterPromptCache) return masterPromptCache;
  // Resolve against the compiled module (dist/jiraflow → repo root) and the dev
  // module (src/jiraflow → repo root), plus the process cwd as a final attempt.
  const candidates = [
    join(__dirname, "..", "..", MASTER_PROMPT_RELATIVE),
    join(__dirname, "..", "..", "..", MASTER_PROMPT_RELATIVE),
    join(process.cwd(), MASTER_PROMPT_RELATIVE),
  ];
  for (const p of candidates) {
    const text = await readFileCapped(p);
    if (text && text.trim().length > 0) {
      masterPromptCache = { text, path: p };
      return masterPromptCache;
    }
  }
  masterPromptCache = { text: EMBEDDED_MASTER_PROMPT };
  return masterPromptCache;
}

// Condensed, faithful fallback used only when the .md file cannot be read.
const EMBEDDED_MASTER_PROMPT = [
  "# MASTER AUTOMATION PROMPT — Jira → Cucumber/WebdriverIO (BrainPayroll)",
  "",
  "## THE ONE RULE: Never fabricate. Reuse what exists. If it does not exist, STOP and ASK the user.",
  "Do not invent step text, page-object methods, or locators (XPath/CSS/ID).",
  "",
  "## PRIORITY ORDER (highest → lowest):",
  "1. PREREQUISITES FIRST — login/session → tax year/context → navigation → data/config pre-state → prior workflow steps → file/dropdown inputs.",
  "2. READ THE TICKET FULLY — description + acceptance criteria + QA comments + linked issues.",
  "3. REUSE EXISTING STEPS verbatim (match similar scenarios exactly).",
  "4. REUSE EXISTING PAGE-OBJECT METHODS & CONFIRMED LOCATORS.",
  "5. ASK THE USER for anything missing (add to Required Inputs and wait).",
  "6. GENERATE NEW CODE LAST — only for confirmed reuse or user-supplied wording + locator.",
  "",
  "## PREREQUISITE CHECKLIST (answer all before writing Gherkin):",
  "- LOGIN: `Given User logs into brain payroll with user \"<key>\"` (admin) or `... client portal ...` (client). Key must exist in users.config.json.",
  "- CONTEXT: tax year via `And User select tax year \"YYYY-YYYY\"` + `And User accepts the confirmation popup`.",
  "- NAVIGATION: `And User is on <X> page` (sideNavigationPO.navigateToPageFromSideNav(\"Parent-->Child\")).",
  "- DATA PRE-STATE: company/employee/template/toggle that must already exist (often a prior scenario). See DOMAIN FLOW PREREQUISITES below.",
  "- SEQUENCE: replicate full ordered sequence from similar scenarios.",
  "- FILE/INPUT: uploads + sheet selection + form fills before the main action.",
  "Authoritative sequence: [login] → [context] → [navigation] → [data pre-state] → [inputs] → [MAIN ACTION] → [assertion].",
  "",
  "## DOMAIN FLOW PREREQUISITES (Mandatory Sequences):",
  "- EPS: Company exists → Company has employees → FPS sent → EPS sent.",
  "- BACS: Company exists → Company has employees → Employee has bank details → BACS payment made.",
  "- PAYE BACS: Company exists → Company has employees → FPS sent → EPS sent → PAYE BACS generated.",
  "- YEAR END PROCESS: Company exists → Company has employees → FPS sent for last period → Payroll migration → Company migration → Employee migration.",
  "",
  "## ARCHITECTURE (do not short-circuit):",
  "feature → step_definations/slpgl/<area>_steps.ts → pageobjects/SLPGL/<area>/<name>PO.ts → locaters/SLPGL/<area>/<name>_locator.ts",
  "- Step def: one Page-Object call only; no $()/XPath/browser.* ; assertions via chai assert.",
  "- Page-object method: this.driver.<util>(this.<locator>.<getter>, ...) wrapped in try/catch throwing 'Exception occured while <X> -->' + err.",
  "- Locator: getter returning $(\"xpath|css\").",
  "",
  "## CONVENTIONS:",
  "- Tags: `@<JIRA-KEY> @shouldpass @<ReleaseTag>` (@shouldpass mandatory).",
  "- Params: double-quoted in Gherkin, captured with \"([^\\\"]*)?\" in regex.",
  "- Waits: `And User waits for \"<ms>\" seconds` — number is milliseconds.",
  "- Naming: <Name>Locator, <Name>PO classes; camelCase methods (clickX/selectX/enterX/verifyX).",
  "- Folders: features/, step_definations/slpgl/, pageobjects/SLPGL/<area>/, locaters/SLPGL/<area>/.",
  "",
  "## REUSE LADDER (stop at first match): exact → parameterized → compose → extend minimally → BLOCKED (ask user).",
  "",
  "## WHEN BLOCKED, ask the user for: (1) exact step wording, (2) locator XPath/CSS/ID, (3) page-object file, (4) page/URL context.",
  "Asking is success. Fabricating a locator is failure.",
  "",
  "## 5-REVIEWER GATE — run BEFORE presenting any result; finish only at 5/5 APPROVE:",
  "1. Prerequisite & Sequence — all prereqs present and correctly ordered; no assumed app state.",
  "2. Anti-Fabrication & Reuse — nothing invented; existing steps/methods/locators/user-keys reused, not rewritten.",
  "3. Framework & Convention — layering exact; no $()/browser.* in steps; PO try/catch; locators are getters; chai asserts; @shouldpass; correct param/wait/naming/folders.",
  "4. Functional Coverage — acceptance criteria + steps-to-reproduce + expected result covered with a real Then assertion; QA edge cases handled.",
  "5. Runnability & Quality — no [TODO]; login key exists in users.config.json; selectors resolvable; sensible waits; deterministic; no dead/duplicate steps.",
  "Any reviewer = REQUEST CHANGES → fix it, or if info is missing add to Required Inputs and ASK the user. Output the verdict block; never present code that is not 5/5.",
].join("\n");

export type AutomationScenario = {
  file: string;
  name: string;
  steps: string[];
  score: number;
};

export type StepDefinition = {
  file: string;
  keyword: string;
  pattern: string;
};

export type TestAuthoringKB = {
  key: string;
  summary: string;
  issue_type: string;
  status: string;
  description: string;
  acceptance: string[];
  steps_to_reproduce: string[];
  // Data/entity pre-state the ticket TEXT depends on (e.g. "companies must have
  // multiple users set up"). Mined from the ticket itself, not the repo — this
  // is the prerequisite class most often missed because it is implied, never
  // written as a step.
  data_prerequisites: string[];
  related: { key: string; summary: string; status: string }[];
  comments: { author: string; text: string }[];
  keywords: string[];
};

export type TestAuthoringPack = {
  markdown: string;
  knowledge_base: TestAuthoringKB;
  similar_scenarios: AutomationScenario[];
  reusable_steps: StepDefinition[];
  locator_files: string[];
  prerequisites: string[];
  feature_skeleton: string;
  data_prerequisites: string[];
  // Families of REAL steps that share an action+object but differ by a modifier
  // (e.g. "Save" vs "Save & Exit"). The agent must pick deliberately — these
  // cannot be told apart by exact-match checks.
  confusable_steps: ConfusableStepGroup[];
  // Copy-template: closest scenario split into keep-verbatim envelope + editable
  // main block. Null when there is no usable similar scenario.
  scenario_template: ScenarioTemplate | null;
  master_prompt: string;
  master_prompt_path?: string;
  reviewer_gate: string[];
  kb_path?: string;
  next_action: string;
};

export type ConfusableStepGroup = {
  signature: string;
  variants: { pattern: string; used_in_similar: number }[];
};

// A copy-template derived from the closest matching scenario, split into a
// stable "envelope" (navigation/setup + save/verify/exit that is shared across
// similar scenarios) and the "main" action block. The author keeps prelude and
// postlude VERBATIM and only rewrites the main steps — so the proven start/end
// of a working scenario is never accidentally altered.
export type ScenarioTemplate = {
  source: string; // "<scenario name> (<file>)"
  prelude: string[]; // navigation/setup — keep verbatim
  main: string[]; // the only block you customise
  postlude: string[]; // save/verify/exit — keep verbatim
  derived_from_siblings: boolean; // true = envelope learned from ≥2 scenarios
};

// The five independent reviewers the result must pass before it is presented.
// Surfaced programmatically so callers can render/enforce the same gate.
const REVIEWER_GATE: string[] = [
  "Prerequisite & Sequence — all prerequisites present and correctly ordered; no assumed app state.",
  "Anti-Fabrication & Reuse — nothing invented; existing steps/methods/locators/user-keys reused, not rewritten.",
  "Framework & Convention — layering exact; no $()/browser.* in steps; PO try/catch; locators are getters; chai asserts; @shouldpass; correct param/wait/naming/folders.",
  "Functional Coverage — acceptance criteria + steps-to-reproduce + expected result covered with a real Then assertion; QA edge cases handled.",
  "Runnability & Quality — no [TODO]; login key exists in users.config.json; selectors resolvable; sensible waits; deterministic; no dead/duplicate steps.",
];

export async function buildTestAuthoringPack(opts: {
  intelligence: TicketIntelligence;
  repoRoot?: string;
  focus_areas?: string[];
  persist_kb?: boolean;
}): Promise<TestAuthoringPack> {
  const { intelligence, repoRoot } = opts;
  const key = intelligence.issue.key ?? "TICKET";

  const acceptance = extractAcceptanceLines(intelligence.plain_description);
  const stepsToReproduce = extractStepsToReproduce(intelligence.plain_description);
  const mediaSummary = intelligence.media_context?.combined_summary ?? "";
  // QA / reviewer comments frequently hold prerequisites and clarifications that
  // are NOT written in the description. Read them as part of "read the ticket fully".
  const commentEntries = extractCommentTexts(intelligence.comments);
  const commentText = commentEntries.map((c) => c.text).join("\n");
  const keywords = [
    ...keywordsFromText(
      intelligence.summary,
      intelligence.plain_description,
      mediaSummary,
      commentText,
      ...(opts.focus_areas ?? []),
    ),
    ...(opts.focus_areas ?? []).map((f) => f.toLowerCase()),
  ];
  const uniqueKw = [...new Set(keywords)].slice(0, 15);
  const ticketTokens = new Set(
    keywordsFromText(
      intelligence.summary,
      ...stepsToReproduce,
      ...acceptance,
      mediaSummary,
      commentText,
    ),
  );

  const related = Object.entries(intelligence.related_issues).map(([k, v]) => ({
    key: k,
    summary: String(v.fields?.summary ?? ""),
    status: (v.fields?.status as { name?: string })?.name ?? "",
  }));

  // Mine the ticket TEXT for data/entity pre-state requirements (the class of
  // prerequisite that is implied, never written as a step — e.g. "companies must
  // have multiple users set up"). This is read straight from Jira so it is caught
  // even when no similar repo scenario shows the setup.
  const fullTextForDomain = [
    intelligence.summary,
    intelligence.plain_description,
    ...stepsToReproduce,
    ...acceptance,
    commentText,
  ].join(" ");
  
  const data_prerequisites = [
    ...extractDomainFlowPrerequisites(fullTextForDomain),
    ...extractTicketPrerequisites({
      summary: intelligence.summary,
      description: intelligence.plain_description,
      acceptance,
      steps: stepsToReproduce,
      comments: commentText,
    }),
  ];

  const kb: TestAuthoringKB = {
    key,
    summary: intelligence.summary,
    issue_type: intelligence.issue_type,
    status: intelligence.status,
    description: intelligence.plain_description,
    acceptance,
    steps_to_reproduce: stepsToReproduce,
    data_prerequisites,
    related,
    comments: commentEntries
      .slice(0, 10)
      .map((c) => ({ author: c.author, text: c.text.slice(0, 600) })),
    keywords: uniqueKw,
  };

  let similar_scenarios: AutomationScenario[] = [];
  let reusable_steps: StepDefinition[] = [];
  let locator_files: string[] = [];
  let prerequisites: string[] = [];
  let confusable_steps: ConfusableStepGroup[] = [];
  let scenario_template: ScenarioTemplate | null = null;

  if (repoRoot && uniqueKw.length > 0) {
    const allFiles = await gitLsFiles(repoRoot);
    const featureFiles = allFiles.filter((f) => /\.feature$/i.test(f));
    const stepFiles = allFiles.filter(isStepFile);
    locator_files = rankByOverlap(
      allFiles.filter(isLocatorFile),
      ticketTokens,
    ).slice(0, 12);

    // Scenario mining: read top candidate feature files and score scenarios.
    const grepHits = await grepInPathspec(repoRoot, uniqueKw, "*.feature");
    const featureCandidates = dedupe([
      ...grepHits,
      ...rankByOverlap(featureFiles, ticketTokens),
    ]).slice(0, MAX_FEATURE_FILES_READ);

    const { scenarios, backgrounds } = await mineFeatureFiles(
      repoRoot,
      featureCandidates,
      ticketTokens,
    );
    similar_scenarios = scenarios.slice(0, 8);
    // Prerequisites come from two sources: explicit Background blocks AND the
    // leading Given/setup steps that appear inline across similar scenarios
    // (login, navigation, data pre-state). Many frameworks use inline Givens
    // instead of Background, so mining backgrounds alone misses prerequisites.
    const inlinePrereqs = derivePrerequisitesFromScenarios(scenarios);
    prerequisites = sanitizeStepSequence(dedupe([...backgrounds, ...inlinePrereqs])).slice(0, 12);

    // Step-definition mining — mine once, then assemble in priority order.
    const stepCandidates = dedupe([
      ...(await grepInPathspecMany(repoRoot, uniqueKw, STEP_PATHSPECS)),
      ...rankByOverlap(stepFiles, ticketTokens),
    ]).slice(0, MAX_STEP_FILES_READ);
    const allMinedSteps = await mineStepDefinitions(repoRoot, stepCandidates);
    const keywordMatched = allMinedSteps.filter(
      (s) => overlapScore(new Set(keywordsFromText(s.pattern)), ticketTokens) > 0,
    );
    // Common prerequisite steps (login, navigation, selection) rarely share
    // keywords with the ticket, so they would be dropped by the overlap filter.
    // Always surface them so prerequisite steps can be reused, never fabricated.
    const prereqSteps = allMinedSteps.filter((s) => isPrerequisiteStep(s.pattern));
    reusable_steps = dedupeSteps([...keywordMatched, ...prereqSteps]).slice(0, 40);
    if (reusable_steps.length === 0) {
      // Fall back to a sample of available steps so the agent sees conventions.
      reusable_steps = allMinedSteps.slice(0, 25);
    }

    // Confusable-step families: detected across the BROAD step universe (so a
    // rarer-but-correct variant is surfaced even if the keyword filter dropped
    // it), then narrowed to families relevant to this ticket. Per variant we
    // count how often it is used in the closest similar scenarios — that local
    // usage is the anchor the agent should follow (Layer 2).
    confusable_steps = buildRelevantConfusables(
      allMinedSteps.map((s) => s.pattern),
      similar_scenarios,
      reusable_steps,
      ticketTokens,
    );

    // Copy-template: take the closest scenario and split it into the stable
    // envelope (shared navigation/setup + save/verify/exit) and the editable
    // main block, so the author preserves the proven start/end verbatim and only
    // rewrites the middle.
    scenario_template = buildScenarioTemplate(similar_scenarios);
  }

  const feature_skeleton = buildFeatureSkeleton({
    summary: intelligence.summary,
    issueType: intelligence.issue_type,
    steps: stepsToReproduce,
    acceptance,
    prerequisites,
    dataPrerequisites: data_prerequisites,
    reusableSteps: reusable_steps,
    key,
  });

  const master = await loadMasterPrompt();

  const markdown = renderMarkdown({
    kb,
    similar_scenarios,
    reusable_steps,
    locator_files,
    prerequisites,
    dataPrerequisites: data_prerequisites,
    confusables: confusable_steps,
    scenarioTemplate: scenario_template,
    feature_skeleton,
    masterPrompt: master.text,
    hasRepo: Boolean(repoRoot),
  });

  let kb_path: string | undefined;
  if (repoRoot && opts.persist_kb !== false) {
    try {
      const dir = join(repoRoot, ".jiraflow", "kb");
      await mkdir(dir, { recursive: true });
      kb_path = join(dir, `${key}.md`);
      await writeFile(kb_path, markdown, "utf8");
    } catch {
      kb_path = undefined;
    }
  }

  const next_action =
    " GOVERNED BY THE MASTER AUTOMATION PROMPT — it is embedded at the very top of `markdown` " +
    "(and also returned as `master_prompt`). Read it FIRST; it defines the priority order, the " +
    "BrainPayroll framework conventions, the reuse ladder, and the ask-don't-fabricate rule. " +
    "Everything below is an application of those rules.\n\n" +

    " TOP PRIORITY — PREREQUISITES BEFORE ANYTHING ELSE.\n" +
    "The #1 cause of broken automation is skipping prerequisite steps " +
    "(login, navigation, data/template setup, prior workflow steps). " +
    "FIRST QUESTION, ALWAYS: 'Are there any prerequisites? What must already be true before the main action runs?' " +
    "The 'prerequisites' array in this pack AND the leading steps of every scenario in 'similar_scenarios' " +
    "already show the required setup — READ THEM. Place every prerequisite (as Given/And) BEFORE the main Jira " +
    "step in every scenario. Never skip them. Never assume the app is already in the correct state.\n\n" +

    "MANDATORY WORKFLOW — follow every rule below in order before writing any code:\n\n" +

    "STEP 1 — JIRA DEEP READ:\n" +
    "Read the full Jira ticket (description, acceptance criteria, QA comments, linked issues). " +
    "Do NOT work from the ticket title alone. Extract: (a) the ONE core action/validation, " +
    "(b) the expected result, (c) the module/page it operates on.\n\n" +

    "STEP 2 — PREREQUISITE ANALYSIS (TOPMOST — do this before writing a single Gherkin line):\n" +
    "Read the LEADING steps of every scenario in similar_scenarios — those leading steps ARE the prerequisites; " +
    "replicate them. Then reason backwards from the core task and ask: " +
    "'What must already be true before this step can succeed at runtime?' " +
    "Check all five categories:\n" +
    "  • LOGIN/SESSION — which user role/key is required?\n" +
    "  • NAVIGATION — which page must the user be on first? Any menus/tabs to traverse? " +
    "FIREWALL: login already lands on the Company List page — do NOT add 'User is on Company List page' " +
    "immediately after login; it is redundant and breaks the run. Never emit a login step twice.\n" +
    "  • DATA/CONFIG PRE-STATE — any record, toggle, template, ENTITY, or setting that must exist first? " +
    "READ the 'data_prerequisites' array in this pack (mined from the ticket text): it lists entities the " +
    "ticket DEPENDS ON (e.g. 'companies must have multiple users set up'). These are COMPULSORY. If the repo " +
    "has no step that creates them, you MUST add creation steps first (reuse existing setup steps) or STOP and ask — " +
    "never assume the data already exists.\n" +
    "  • SEQUENTIAL DEPENDENCY — is this step N of a multi-step workflow requiring steps 1..N-1 first?\n" +
    "  • FILE/DATA INPUTS — any file upload, dropdown selection, or form fill needed before the main action?\n" +
    "Build the FULL ordered step sequence: [prereq 1] → [prereq 2] → [prereq N] → [main Jira step] → [assertion]. " +
    "This sequence is authoritative. All Gherkin is generated from it.\n\n" +

    "STEP 3 — REUSE ANALYSIS (mandatory for EVERY step including prerequisites):\n" +
    "Search reusable_steps for each step in your sequence. Follow this priority order — stop at first match:\n" +
    "  1. EXACT REUSE — step found verbatim in reusable_steps → use it as-is, do not rewrite\n" +
    "  2. PARAMETERIZED REUSE — step exists with hardcoded value → extract as parameter, reuse\n" +
    "  3. COMPOSE FROM EXISTING — combine two existing steps in sequence\n" +
    "  4. EXTEND MINIMALLY — existing step is 90% correct, add smallest possible change\n" +
    "  5.  BLOCKED — no match found → DO NOT generate code → add to 'Required Inputs' table → ask user\n\n" +

    "STEP 3.5 — COPY THE ENVELOPE, CHANGE ONLY THE MIDDLE:\n" +
    "If 'scenario_template' is present, author the new scenario by COPYING it: keep the 'prelude' " +
    "(navigation/setup) and 'postlude' (save/verify/exit) steps VERBATIM — they are the proven envelope shared " +
    "by similar scenarios — and rewrite ONLY the 'main' block to match this ticket. Do NOT swap an envelope step " +
    "for a look-alike (e.g. 'Save' → 'Save & Exit'); that is the #1 silent-breakage cause. " +
    "If this ticket truly needs a different navigation or save/exit than the envelope, make that change DELIBERATELY, " +
    "cross-check it against 'confusable_steps', and call it out explicitly — never change start/end steps silently.\n\n" +

    "STEP 4 — LOCATOR VALIDATION:\n" +
    "Only use locators confirmed present in locator_files. " +
    "If a locator is not confirmed: DO NOT generate one. " +
    "Add it to the 'Required Locator Inputs' table and ask the user for: " +
    "element name, element type, XPath/CSS/ID, and which page object file to place it in. " +
    "There is NO 'naming convention is consistent' exception — if not confirmed, ask.\n\n" +

    "STEP 5 — GENERATE ONLY CONFIRMED CODE:\n" +
    "Only generate step definitions, page object methods, and locators when: " +
    "(a) a confirmed existing match was found (reuse it), OR " +
    "(b) the user has explicitly provided the missing step wording and locator. " +
    "NEVER generate speculative code. NEVER fabricate XPath, IDs, or step text. " +
    "If in doubt — stop and ask the user. Asking is always correct.\n\n" +

    "STEP 6 — THE 5-REVIEWER GATE (run BEFORE presenting any result; finish only at 5/5 APPROVE):\n" +
    "Treat your output as a PR facing five independent reviewers. Simulate each, write the verdict, " +
    "and present code ONLY when all five APPROVE:\n" +
    "  1. PREREQUISITE & SEQUENCE — all prereqs present and correctly ordered; no assumed app state.\n" +
    "  2. ANTI-FABRICATION & REUSE — nothing invented; existing steps/methods/locators/user-keys reused, not rewritten.\n" +
    "  3. FRAMEWORK & CONVENTION — layering exact; no $()/browser.* in steps; PO try/catch; locators are getters; chai asserts; @shouldpass; correct param/wait/naming/folders.\n" +
    "  4. FUNCTIONAL COVERAGE — acceptance criteria + steps-to-reproduce + expected result covered with a real Then assertion; QA edge cases handled.\n" +
    "  5. RUNNABILITY & QUALITY — no [TODO]; login key exists in users.config.json; selectors resolvable; sensible waits; deterministic; no dead/duplicate steps.\n" +
    "Any reviewer = REQUEST CHANGES → fix it, or if information is missing add it to 'Required Inputs' and ASK the user, then re-run the gate. " +
    "Output the verdict block (1..5 with APPROVE/REQUEST CHANGES and a PASSED x/5 line). Never present code that is not 5/5.\n\n" +

    "Finalize feature_skeleton into a .feature file following the repo's existing structure. " +
    "Place files alongside similar_scenarios. " +
    "Include all prerequisite steps before the main Jira step in every scenario. " +
    "Do not present the final result until the 5-reviewer gate passes 5/5.";

  return {
    markdown,
    knowledge_base: kb,
    similar_scenarios,
    reusable_steps,
    locator_files,
    prerequisites,
    feature_skeleton,
    data_prerequisites,
    confusable_steps,
    scenario_template,
    master_prompt: master.text,
    master_prompt_path: master.path,
    reviewer_gate: REVIEWER_GATE,
    kb_path,
    next_action,
  };
}

// ---------- file discovery ----------

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

const STEP_PATHSPECS = ["*steps*", "*Steps*", "*step_def*", "*step-def*"];

function isStepFile(f: string): boolean {
  return (
    /(step[-_ ]?def|step[-_ ]?definition|steps?)/i.test(f) &&
    /\.(t|j)sx?$|\.java$|\.kt$|\.py$|\.rb$|\.cs$/i.test(f)
  );
}

function isLocatorFile(f: string): boolean {
  return (
    /(locator|page[-_.]?object|\bpage\b|\bpo\b|selector|element)/i.test(f) &&
    /\.(t|j)sx?$|\.java$|\.kt$|\.py$|\.rb$|\.cs$|\.json$|\.ya?ml$/i.test(f)
  );
}

async function grepInPathspec(
  repoRoot: string,
  keywords: string[],
  pathspec: string,
): Promise<string[]> {
  return grepInPathspecMany(repoRoot, keywords, [pathspec]);
}

async function grepInPathspecMany(
  repoRoot: string,
  keywords: string[],
  pathspecs: string[],
): Promise<string[]> {
  const scores = new Map<string, number>();
  await Promise.all(
    keywords.map(async (kw) => {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["grep", "-l", "-i", "--fixed-strings", kw, "--", ...pathspecs],
          { cwd: repoRoot, timeout: 6000, maxBuffer: 1024 * 1024 },
        );
        for (const line of stdout.split(/\r?\n/)) {
          const f = line.trim();
          if (f) scores.set(f, (scores.get(f) ?? 0) + 1);
        }
      } catch {
        /* no match */
      }
    }),
  );
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

// ---------- scenario + step mining ----------

async function mineFeatureFiles(
  repoRoot: string,
  files: string[],
  ticketTokens: Set<string>,
): Promise<{ scenarios: AutomationScenario[]; backgrounds: string[] }> {
  const scenarios: AutomationScenario[] = [];
  const backgrounds: string[] = [];
  for (const rel of files) {
    const content = await readFileCapped(join(repoRoot, rel));
    if (!content) continue;
    const parsed = parseFeature(content);
    for (const bg of parsed.background) {
      if (!backgrounds.includes(bg)) backgrounds.push(bg);
    }
    for (const sc of parsed.scenarios) {
      const tokens = new Set(keywordsFromText(sc.name, ...sc.steps));
      const score = overlapScore(tokens, ticketTokens);
      if (score > 0) {
        scenarios.push({ file: rel, name: sc.name, steps: sc.steps, score });
      }
    }
  }
  scenarios.sort((a, b) => b.score - a.score);
  return { scenarios, backgrounds };
}

function parseFeature(content: string): {
  scenarios: { name: string; steps: string[] }[];
  background: string[];
} {
  const lines = content.split(/\r?\n/);
  const scenarios: { name: string; steps: string[] }[] = [];
  const background: string[] = [];
  let current: { name: string; steps: string[] } | null = null;
  let inBackground = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (/^Background:/i.test(line)) {
      inBackground = true;
      current = null;
      continue;
    }
    const scMatch = line.match(/^Scenario(?:\s+Outline)?:\s*(.+)$/i);
    if (scMatch) {
      inBackground = false;
      current = { name: scMatch[1].trim(), steps: [] };
      scenarios.push(current);
      continue;
    }
    const stepMatch = line.match(/^(Given|When|Then|And|But)\s+(.+)$/i);
    if (stepMatch) {
      const step = `${stepMatch[1]} ${stepMatch[2].trim()}`;
      if (inBackground) background.push(step);
      else if (current) current.steps.push(step);
    }
  }
  return { scenarios, background };
}

async function mineStepDefinitions(
  repoRoot: string,
  files: string[],
): Promise<StepDefinition[]> {
  const out: StepDefinition[] = [];
  const seen = new Set<string>();
  for (const rel of files) {
    const content = await readFileCapped(join(repoRoot, rel));
    if (!content) continue;
    for (const def of extractStepDefs(content, rel)) {
      const dedupeKey = `${def.keyword}|${def.pattern}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(def);
    }
  }
  return out;
}

function extractStepDefs(content: string, file: string): StepDefinition[] {
  const defs: StepDefinition[] = [];
  // JS/TS Cucumber: Given('...', ...) / When("...") / Then(/regex/)
  const jsRe = /\b(Given|When|Then|And|But)\s*\(\s*([`'"/])([\s\S]*?)\2/g;
  // Java/Kotlin annotations: @Given("...") / @When("...")
  const javaRe = /@(Given|When|Then|And|But)\s*\(\s*"([\s\S]*?)"\s*\)/g;
  // Python behave / pytest-bdd: @given('...') @when("...") @then(u'...')
  const pyRe = /@(given|when|then)\s*\(\s*u?(['"])([\s\S]*?)\2/gi;

  let m: RegExpExecArray | null;
  while ((m = jsRe.exec(content)) !== null) {
    defs.push({ file, keyword: capitalize(m[1]), pattern: cleanPattern(m[3]) });
  }
  while ((m = javaRe.exec(content)) !== null) {
    defs.push({ file, keyword: capitalize(m[1]), pattern: cleanPattern(m[2]) });
  }
  while ((m = pyRe.exec(content)) !== null) {
    defs.push({ file, keyword: capitalize(m[1]), pattern: cleanPattern(m[3]) });
  }
  return defs.filter((d) => d.pattern.length > 2 && d.pattern.length < 200);
}

// ---------- skeleton + rendering ----------

function buildFeatureSkeleton(opts: {
  summary: string;
  issueType: string;
  steps: string[];
  acceptance: string[];
  prerequisites: string[];
  dataPrerequisites: string[];
  reusableSteps: StepDefinition[];
  key: string;
}): string {
  const { summary, steps, acceptance, prerequisites, dataPrerequisites, reusableSteps, key } = opts;
  const lines: string[] = [];

  lines.push(`# ============================================================`);
  lines.push(`# SKELETON FOR: ${key}`);
  lines.push(`# INSTRUCTIONS: Read next_action fully before editing this file.`);
  lines.push(`# Do NOT use placeholder steps — replace every [TODO] with real`);
  lines.push(`# step text found in reusable_steps, or ask user for missing ones.`);
  lines.push(`# Prerequisites are inline Given steps (match the repo convention).`);
  lines.push(`# ============================================================`);
  lines.push("");
  lines.push(`@${key} @shouldpass`);
  lines.push(`Feature: ${summary || key}`);
  lines.push("");

  // --- data/entity pre-state stated in the ticket (COMPULSORY) ---
  if (dataPrerequisites.length) {
    lines.push(`  # !!! COMPULSORY DATA PREREQUISITES (mined from the ticket text) !!!`);
    lines.push(`  # The scenario below is meaningless unless this data exists FIRST.`);
    dataPrerequisites.slice(0, 6).forEach((d) => {
      lines.push(`  #   - ${d}`);
    });
    lines.push(`  # Add creation/setup steps for the above BEFORE the main action,`);
    lines.push(`  # reusing existing setup steps — or STOP and ask the user. Do NOT assume it exists.`);
    lines.push("");
  }

  lines.push(`  @${key} @shouldpass`);
  lines.push(`  Scenario: ${summary || `Verify ${key}`}`);

  // --- prerequisite steps (inline Given), emitted BEFORE the main action ---
  if (prerequisites.length) {
    lines.push("    # --- prerequisite steps (mined from similar scenarios) ---");
    lines.push("    # Verify each exists in reusable_steps; do not paraphrase.");
    prerequisites.slice(0, 6).forEach((p, i) => {
      const kw = i === 0 ? "Given" : "And";
      lines.push(`    ${kw} ${stripLeadingKeyword(p)}`);
    });
  } else {
    lines.push("    # --- NO PREREQUISITE STEPS MINED FROM REPO ---");
    lines.push("    # Identify prerequisites before the main action. Answer:");
    lines.push("    #   1. LOGIN: Which user/role is needed? (find login Given in reusable_steps)");
    lines.push("    #   2. NAVIGATION: Which page must be active first? (find navigation step)");
    lines.push("    #   3. DATA STATE: Any record/toggle/template needed beforehand?");
    lines.push("    #   4. SEQUENCE: Is this part of a multi-step workflow?");
    lines.push("    #   5. FILE/INPUT: Any upload or form fill needed before main action?");
    lines.push("    # [TODO: Given] <login + navigation prerequisites — reuse or ask user>");
  }

  // Steps to reproduce from Jira — real content only
  if (steps.length > 0) {
    lines.push("    # --- main steps derived from Jira description ---");
    lines.push("    # Cross-check each step against reusable_steps before finalizing.");
    steps.forEach((s, i) => {
      const kw = i === 0 ? "When" : "And";
      lines.push(`    ${kw} ${stripLeadingKeyword(s)}`);
    });
  } else {
    lines.push("    # --- NO STEPS TO REPRODUCE FOUND IN JIRA TICKET ---");
    lines.push("    # [TODO: When] <main action from Jira — search reusable_steps first>");
    lines.push("    # If this step is not in reusable_steps, add it to Required Inputs.");
  }

  // Acceptance criteria from Jira — real content only
  if (acceptance.length > 0) {
    lines.push("    # --- assertions derived from Jira acceptance criteria ---");
    acceptance.slice(0, 6).forEach((a, i) => {
      const kw = i === 0 ? "Then" : "And";
      lines.push(`    ${kw} ${stripLeadingKeyword(a)}`);
    });
  } else {
    lines.push("    # --- NO ACCEPTANCE CRITERIA FOUND IN JIRA TICKET ---");
    lines.push("    # [TODO: Then] <expected result from Jira — do not invent assertions>");
  }

  lines.push("");

  // Reuse reference block — the key section for the agent
  if (reusableSteps.length > 0) {
    lines.push("  # ============================================================");
    lines.push("  # REUSABLE STEPS FOUND IN REPO (use these verbatim above):");
    lines.push("  # ============================================================");
    for (const s of reusableSteps.slice(0, 20)) {
      lines.push(`  #   ${s.keyword}: ${s.pattern}  [${s.file}]`);
    }
    lines.push("  # ============================================================");
    lines.push("  # If the step you need is NOT listed above:");
    lines.push("  #   1. DO NOT generate a new step definition");
    lines.push("  #   2. DO NOT guess a locator");
    lines.push("  #   3. Add it to Required Locator/XPath Inputs and ask the user");
    lines.push("  # ============================================================");
  } else {
    lines.push("  # ============================================================");
    lines.push("  # NO REUSABLE STEPS FOUND — repo_path/workspace_id may not be set.");
    lines.push("  # Provide repo_path so existing steps can be mined.");
    lines.push("  # Until confirmed, ALL new steps require user input before code is generated.");
    lines.push("  # ============================================================");
  }

  return lines.join("\n");
}

function renderMarkdown(opts: {
  kb: TestAuthoringKB;
  similar_scenarios: AutomationScenario[];
  reusable_steps: StepDefinition[];
  locator_files: string[];
  prerequisites: string[];
  dataPrerequisites: string[];
  confusables: ConfusableStepGroup[];
  scenarioTemplate: ScenarioTemplate | null;
  feature_skeleton: string;
  masterPrompt: string;
  hasRepo: boolean;
}): string {
  const { kb } = opts;
  const md: string[] = [];
  md.push(`# Test authoring pack — ${kb.key}`);
  md.push("");

  // ── MASTER PROMPT: the authoritative rules, embedded so they are always seen ─
  md.push("> **Read the master automation rules below before doing anything.**");
  md.push("> They define the priority order, framework conventions, reuse ladder,");
  md.push("> and the ask-don't-fabricate rule. The rest of this pack applies them to this ticket.");
  md.push("");
  md.push("<details open>");
  md.push("<summary> MASTER AUTOMATION RULES (authoritative — click to collapse)</summary>");
  md.push("");
  md.push(opts.masterPrompt.trim());
  md.push("");
  md.push("</details>");
  md.push("");
  md.push("---");
  md.push("");

  // ── TOP PRIORITY: prerequisites first, before anything else ───────────────
  md.push("##  STEP 0 — PREREQUISITES FIRST (highest priority, do not skip)");
  md.push("> The #1 cause of broken automation is skipping setup steps.");
  md.push("> Before automating the main task, ANSWER THIS QUESTION:");
  md.push("> **\"Are there any prerequisites? What must already be true before the main action runs?\"**");
  md.push("> (login / session, navigation to the right page, data or template pre-state, prior workflow steps)");
  md.push("");

  // ── Data/entity pre-state mined from the TICKET TEXT — the most-missed class ──
  if (opts.dataPrerequisites.length) {
    md.push("### 🚨 COMPULSORY DATA / ENTITY PREREQUISITES (read from the ticket)");
    md.push("> These are **read directly from the Jira ticket** — entities the ticket DEPENDS ON.");
    md.push("> The test proves nothing unless this data exists FIRST.");
    md.push("> Example: a 'select all users vs select one user' bug is untestable unless the company has multiple users.");
    md.push("");
    opts.dataPrerequisites.forEach((d, i) => md.push(`${i + 1}. ${d}`));
    md.push("");
    md.push("> **For each item above:** find a repo setup step that creates it and run it BEFORE the main action.");
    md.push("> If no such step exists, CREATE the setup steps first (reusing existing ones) or **STOP and ask the user**.");
    md.push("> Do NOT write the main scenario assuming this data is already present.");
    md.push("");
  } else {
    md.push("### Data / entity prerequisites (read from the ticket)");
    md.push("> No explicit data pre-state was auto-detected in the ticket text — **do not assume there is none.**");
    md.push("> Re-read the description: does the bug/feature reference entities (users, companies, records, templates)");
    md.push("> that must already exist for the test to be meaningful? If so, set them up first or ask the user.");
    md.push("");
  }

  if (opts.prerequisites.length) {
    md.push("**Prerequisite sequence — run these IN ORDER as `Given`/`And` BEFORE the main step:**");
    md.push("");
    opts.prerequisites.forEach((p, i) => md.push(`${i + 1}. ${stripLeadingKeyword(p)}`));
    md.push("");
    const topSc = opts.similar_scenarios[0];
    if (topSc) {
      const lead = leadingPrerequisiteSteps(topSc.steps);
      if (lead.length) {
        md.push(
          `> These are the leading steps of the closest matching scenario ` +
            `\`${topSc.name}\` (\`${topSc.file}\`) — replicate this exact setup.`,
        );
      }
    }
    md.push("> Reuse each verbatim from **Reusable step definitions** below.");
    md.push("> If a prerequisite step is missing, ASK the user — never skip it, never assume the app is already set up.");
  } else {
    md.push(">  **No prerequisites auto-detected. You MUST still check manually — do not assume there are none.**");
    md.push("> Reason through every category and confirm against the related scenarios below:");
    md.push("> 1. **LOGIN/SESSION** — which user role/key must be logged in first?");
    md.push("> 2. **NAVIGATION** — which page/menu must be open before the main step?");
    md.push("> 3. **DATA/CONFIG PRE-STATE** — any record, toggle, or template needed first?");
    md.push("> 4. **SEQUENTIAL DEPENDENCY** — is this step N of a workflow requiring steps 1..N-1?");
    md.push("> 5. **FILE/DATA INPUTS** — any upload, dropdown, or form fill needed before the main action?");
    md.push("> Read the leading steps of every scenario under **Similar existing scenarios** — those leading steps ARE the prerequisites.");
    md.push("> If a prerequisite is missing from Reusable step definitions, add it to **Required Inputs** and ask the user.");
  }
  md.push("");

  // ── CONFUSABLE STEPS — wrong-but-valid pick is invisible to exact matching ──
  if (opts.confusables.length) {
    md.push("## ⚠️ CONFUSABLE STEPS — choose deliberately (do NOT default to the most common)");
    md.push("> These are groups of **real** steps that look alike but behave differently —");
    md.push("> e.g. `Save` stays on the page while `Save & Exit` saves AND leaves.");
    md.push("> Exact-match/anti-fabrication checks CANNOT catch a wrong pick here, because");
    md.push("> every variant is a legitimate step. Choosing the wrong one silently breaks the test.");
    md.push("");
    opts.confusables.forEach((g, i) => {
      md.push(`**Group ${i + 1}** — core action \`${g.signature}\`:`);
      for (const v of g.variants) {
        const tag =
          v.used_in_similar > 0
            ? ` — used **${v.used_in_similar}×** in similar scenarios (likely the convention for this flow)`
            : " — not used in any similar scenario";
        md.push(`- \`${v.pattern}\`${tag}`);
      }
      md.push("");
    });
    md.push("> **Rule:** pick the variant that matches the ticket's intended OUTCOME *and* the");
    md.push("> usage in the closest similar scenario — NOT the globally most frequent variant.");
    md.push("> If you cannot tell which variant the flow needs, STOP and ask the user.");
    md.push("");
  }

  // ── SCENARIO COPY-TEMPLATE — keep the envelope, change only the middle ──────
  const tpl = opts.scenarioTemplate;
  if (tpl && (tpl.prelude.length || tpl.postlude.length)) {
    md.push("## 🧱 SCENARIO TEMPLATE — copy this, change ONLY the middle block");
    md.push(
      `> Closest matching scenario: \`${tpl.source}\`. ` +
        (tpl.derived_from_siblings
          ? "The PRELUDE and POSTLUDE below are the steps that **multiple** similar scenarios share — i.e. the proven navigation/setup and save/verify/exit envelope."
          : "Only one similar scenario was found, so the envelope below is a best-effort split — verify it before relying on it."),
    );
    md.push(
      "> **Rule: copy the whole scenario, then edit ONLY the `MAIN ACTION` lines.** " +
        "Do NOT touch the PRELUDE (how you get to the screen) or the POSTLUDE (how you save/verify/leave) — " +
        "those are why the reference scenario works. Changing them is the #1 source of silent breakage " +
        "(e.g. swapping `Save` for `Save & Exit`).",
    );
    md.push("");
    md.push("```gherkin");
    md.push("  # ── PRELUDE — navigation/setup — KEEP VERBATIM ──");
    if (tpl.prelude.length) tpl.prelude.forEach((s) => md.push(`  ${s}`));
    else md.push("  # (none detected — confirm no setup is required)");
    md.push("");
    md.push("  # ── MAIN ACTION — the ONLY block you customise for this ticket ──");
    if (tpl.main.length) tpl.main.forEach((s) => md.push(`  ${s}`));
    else md.push("  # (insert this ticket's specific action steps here)");
    md.push("");
    md.push("  # ── POSTLUDE — save/verify/exit — KEEP VERBATIM ──");
    if (tpl.postlude.length) tpl.postlude.forEach((s) => md.push(`  ${s}`));
    else md.push("  # (none detected — confirm no save/verify/exit is required)");
    md.push("```");
    md.push(
      "> If this ticket genuinely needs a DIFFERENT save/exit or navigation than the envelope shows, " +
        "that is a deliberate change — call it out explicitly and justify it (cross-check **Confusable steps** above). " +
        "Never change it silently.",
    );
    md.push("");
  }

  md.push("## Knowledge base");
  md.push(`- **Summary:** ${kb.summary}`);
  md.push(`- **Type:** ${kb.issue_type}`);
  md.push(`- **Status:** ${kb.status}`);
  md.push("");
  md.push("### Steps to reproduce");
  md.push(
    kb.steps_to_reproduce.length
      ? kb.steps_to_reproduce.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "_None detected in description_",
  );
  md.push("");
  md.push("### Acceptance criteria");
  md.push(
    kb.acceptance.length
      ? kb.acceptance.map((a) => `- ${a}`).join("\n")
      : "_None detected_",
  );
  md.push("");
  md.push("### Related issues");
  md.push(
    kb.related.length
      ? kb.related.map((r) => `- **${r.key}**: ${r.summary} (${r.status})`).join("\n")
      : "_None_",
  );
  md.push("");
  md.push("### QA / reviewer comments");
  md.push("> Read these for prerequisites and clarifications not in the description.");
  md.push(
    kb.comments.length
      ? kb.comments.map((c) => `- **${c.author}:** ${c.text}`).join("\n")
      : "_None_",
  );
  md.push("");

  // ── Similar existing scenarios ────────────────────────────────────────────
  md.push("## Similar existing scenarios (read leading steps for prerequisites)");
  if (opts.similar_scenarios.length) {
    md.push("> Use these scenarios as structural and wording templates.");
    md.push("> Match their step wording exactly — do not paraphrase.");
    md.push("> **The LEADING steps of each scenario are the prerequisites — replicate them first.**");
    for (const sc of opts.similar_scenarios) {
      const lead = leadingPrerequisiteSteps(sc.steps);
      md.push(`### \`${sc.file}\` — ${sc.name} (match score: ${sc.score})`);
      if (lead.length) {
        md.push(`_Prerequisite (leading) steps: ${lead.map((s) => stripLeadingKeyword(s)).join(" → ")}_`);
      }
      md.push("```gherkin");
      md.push(...sc.steps);
      md.push("```");
    }
  } else {
    md.push(opts.hasRepo
      ? ">  No closely matching scenarios found in repo. All steps will need reuse analysis against step definitions below."
      : ">  Provide `repo_path` or `workspace_id` to mine existing tests for reuse.");
  }
  md.push("");

  // ── Reusable step definitions ─────────────────────────────────────────────
  md.push("## Reusable step definitions");
  md.push("> **REUSE PRIORITY ORDER — follow top-to-bottom, stop at first match:**");
  md.push("> 1. Exact match → use verbatim");
  md.push("> 2. Parameterized match → extract value as parameter");
  md.push("> 3. Compose from two existing steps");
  md.push("> 4. Extend existing step minimally");
  md.push("> 5.  No match → add to Required Inputs below → ask user → wait for confirmation");
  md.push("");
  if (opts.reusable_steps.length) {
    for (const s of opts.reusable_steps) {
      md.push(`- \`${s.keyword}\` \`${s.pattern}\`  _→ \`${s.file}\`_`);
    }
  } else {
    md.push(">  No reusable steps found. Provide `repo_path`/`workspace_id` to mine the framework.");
    md.push("> Until steps are confirmed, all new steps require user input before any code is generated.");
  }
  md.push("");

  // ── Locator / page-object files ───────────────────────────────────────────
  md.push("## Locator / page-object files");
  md.push("> Only use locators **confirmed present** in these files.");
  md.push("> If a locator is not confirmed: DO NOT generate one. Add to Required Inputs.");
  md.push(
    opts.locator_files.length
      ? opts.locator_files.map((f) => `- \`${f}\``).join("\n")
      : ">  No locator files found. Provide `repo_path`/`workspace_id` or ask user for locators.",
  );
  md.push("");

  // ── Required Inputs — blocked gaps ───────────────────────────────────────
  md.push("##  Required Inputs — BLOCKED (user confirmation needed before code generation)");
  md.push("> Add every step or locator not found in the repo to this table.");
  md.push("> Do NOT generate step definitions, page methods, or locators for these rows.");
  md.push("> Ask the user to provide the information below, then generate code only after confirmation.");
  md.push("");
  md.push("| Step / Element | Type | Element Name | Element Type | Page/Context | Info Needed From User |");
  md.push("|----------------|------|--------------|--------------|--------------|----------------------|");
  md.push("| _(add rows here for every gap found)_ | Prereq / Main / Assert | | button/input/dropdown | | XPath, CSS, ID, page object file |");
  md.push("");
  md.push("> **When asking the user, request:**");
  md.push("> 1. Exact step definition wording (the text in the `.ts` file)");
  md.push("> 2. Element locator: XPath `//...` or CSS selector or element ID");
  md.push("> 3. Page object file where the method should be added");
  md.push("> 4. Page or URL context where the element appears");
  md.push("");

  // ── Proposed feature skeleton ─────────────────────────────────────────────
  md.push("## Proposed feature skeleton");
  md.push("> **Read all sections above before editing this skeleton.**");
  md.push("> Replace every `[TODO]` with confirmed step text from reusable steps.");
  md.push("> Do NOT remove the comment headers — they are navigation guides.");
  md.push("```gherkin");
  md.push(opts.feature_skeleton);
  md.push("```");

  // ── 5-Reviewer gate — final quality gate before presenting any result ──────
  md.push("");
  md.push("## 👥 FINAL GATE — pass all 5 reviewers before presenting (do not skip)");
  md.push("> Treat the result as a PR facing five independent reviewers. Simulate each, write the");
  md.push("> verdict, and present code **only at 5/5 APPROVE**. Any REQUEST CHANGES → fix it, or if");
  md.push("> info is missing add it to **Required Inputs** and ask the user, then re-run the gate.");
  md.push("");
  md.push("| # | Reviewer | REQUEST CHANGES if… |");
  md.push("|---|----------|----------------------|");
  md.push("| 1 | Prerequisite & Sequence | any prereq missing/misordered, or app state assumed |");
  md.push("| 2 | Anti-Fabrication & Reuse | any invented/unconfirmed step, method, locator, or user key; existing steps rewritten |");
  md.push("| 3 | Framework & Convention | `$()`/`browser.*` in steps; PO not try/catch; locator not a getter; no chai assert; missing `@shouldpass`; wrong param/wait/naming/folder |");
  md.push("| 4 | Functional Coverage | acceptance criteria / steps-to-reproduce / expected result not covered; no real `Then` assertion |");
  md.push("| 5 | Runnability & Quality | any `[TODO]`; login key not in `users.config.json`; unresolved selector; bad waits; non-deterministic; dead/duplicate steps |");
  md.push("");
  md.push("Output the verdict block, e.g.:");
  md.push("```");
  md.push("REVIEW GATE");
  md.push(" 1. Prerequisite & Sequence ........ APPROVE");
  md.push(" 2. Anti-Fabrication & Reuse ....... APPROVE");
  md.push(" 3. Framework & Convention ......... APPROVE");
  md.push(" 4. Functional Coverage ............ APPROVE");
  md.push(" 5. Runnability & Quality .......... APPROVE");
  md.push(" → PASSED (5/5). Safe to present.");
  md.push("```");

  return md.join("\n");
}

// ---------- small helpers ----------

async function readFileCapped(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path);
    return buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
  } catch {
    return null;
  }
}

function rankByOverlap(files: string[], ticketTokens: Set<string>): string[] {
  return files
    .map((f) => ({ f, s: overlapScore(new Set(keywordsFromText(f.replace(/[/\\._-]/g, " "))), ticketTokens) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.f);
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

function dedupeSteps(steps: StepDefinition[]): StepDefinition[] {
  const seen = new Set<string>();
  const out: StepDefinition[] = [];
  for (const s of steps) {
    const key = `${s.keyword}|${s.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Pull plain text out of the Jira comment payload (ADF or string bodies).
 * Comments are fetched but were previously unused; they often hold the
 * prerequisites and clarifications missing from the description.
 */
function extractCommentTexts(comments: unknown): { author: string; text: string }[] {
  if (!comments || typeof comments !== "object") return [];
  const arr = (comments as { comments?: unknown }).comments;
  if (!Array.isArray(arr)) return [];
  const out: { author: string; text: string }[] = [];
  for (const c of arr) {
    if (!c || typeof c !== "object") continue;
    const obj = c as { author?: { displayName?: string }; body?: unknown };
    const author = obj.author?.displayName ?? "user";
    const text = (typeof obj.body === "string" ? obj.body : adfToPlainText(obj.body)).trim();
    if (text) out.push({ author, text });
  }
  return out;
}

/**
 * A step is a "prerequisite-class" step when it sets up state required before
 * the main action — login/session, navigation, or pre-state selection. These
 * rarely share keywords with the ticket, so they are surfaced unconditionally.
 */
function isPrerequisiteStep(text: string): boolean {
  return /\b(logs?\s+in|logs?\s+into|log[\s-]?in|signs?\s+in|sign[\s-]?in|logged\s+in|with user|navigat|is on .+ page|goes?\s+to|open(s|ed|ing)?\b|launch|home\s*page|dashboard|lands?\s+on|select(s)?\b.*\b(user|template|company|client))\b/i.test(
    text,
  );
}

/**
 * Extract the leading "setup" steps from a single scenario — the prerequisite
 * sequence that runs BEFORE the main action. These are the maximal prefix of
 * steps that are either Given steps or match prerequisite patterns
 * (login/navigation/selection). Stops at the first real action (When that is
 * not navigation) or the first assertion (Then). This catches domain-specific
 * setup steps even when they do not match the keyword patterns, because they
 * still appear as leading Given steps.
 */
function leadingPrerequisiteSteps(steps: string[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    const kw = (step.match(/^(Given|When|Then|And|But)\b/i)?.[1] ?? "").toLowerCase();
    const body = stripLeadingKeyword(step);
    if (kw === "then" || kw === "but") break; // reached assertions / negative path
    if (kw === "given" || isPrerequisiteStep(body)) {
      out.push(step);
      continue;
    }
    break; // first non-setup action ends the prerequisite block
  }
  return out;
}

/**
 * Derive the prerequisite sequence by reading the LEADING steps of every
 * similar scenario. Ranked by position first (so login → navigation → selection
 * keeps its natural order) then by how many scenarios share the step (a real
 * prerequisite recurs; a one-off main action does not). This is the primary
 * signal — it surfaces prerequisites the keyword patterns alone would miss.
 */
function derivePrerequisitesFromScenarios(scenarios: AutomationScenario[]): string[] {
  const tally = new Map<string, { display: string; count: number; firstIdx: number }>();
  for (const sc of scenarios) {
    const leading = leadingPrerequisiteSteps(sc.steps);
    leading.forEach((step, idx) => {
      const norm = stripLeadingKeyword(step).toLowerCase();
      if (!norm) return;
      const entry = tally.get(norm);
      if (entry) {
        entry.count += 1;
        entry.firstIdx = Math.min(entry.firstIdx, idx);
      } else {
        tally.set(norm, { display: step, count: 1, firstIdx: idx });
      }
    });
  }
  return [...tally.values()]
    .sort((a, b) => a.firstIdx - b.firstIdx || b.count - a.count)
    .map((e) => e.display)
    .slice(0, 8);
}

/**
 * Domain entities that, when a ticket references them as pre-existing, usually
 * indicate a COMPULSORY data prerequisite (they must be created/exist before the
 * scenario is meaningful). Kept broad but bounded to avoid noise.
 */
const PREREQ_ENTITIES =
  "users?|company users?|companies|company|clients?|employees?|records?|accounts?|roles?|groups?|templates?|report packs?|payslips?|reports?";

/**
 * Explicit precondition phrases. When a sentence contains one of these AND a
 * domain entity, it is almost certainly stating a setup requirement.
 */
const PREREQ_PHRASES =
  /\b(pre[\s-]?requisite|pre[\s-]?condition|precondition|prerequisite|must (?:already )?(?:exist|be set up|be configured|have)|should (?:already )?(?:exist|be set up)|needs? to (?:exist|be set up|be created)|set ?up under|configured with|assuming|given that|provided that|requires?|ensure (?:that )?)\b/i;

/**
 * Quantity/existence signal next to an entity — e.g. "all users set up under the
 * selected companies", "multiple company users", "every user under the company".
 * This is the class of prerequisite that is IMPLIED, never written as a step,
 * and is the one most commonly missed.
 */
const PREREQ_EXISTENCE = new RegExp(
  `\\b(all|every|each|multiple|several|various|both|two|more than one|number of)\\s+(?:\\w+\\s+){0,2}(${PREREQ_ENTITIES})\\b`,
  "i",
);
const PREREQ_ENTITY_STATE = new RegExp(
  `\\b(${PREREQ_ENTITIES})\\s+(?:are|is|were|have been|that are|that have been)?\\s*(set ?up|configured|created|that exist|existing|already (?:set ?up|created|configured))\\b`,
  "i",
);

/**
 * Read the ticket TEXT (summary + description + acceptance + steps + comments)
 * and surface data/entity pre-state the scenario depends on. This is the
 * prerequisite class the repo-scenario miner cannot see, because it is implied
 * by the prose, not present as a Gherkin step in similar scenarios.
 *
 * Returns short, actionable instructions (with the quoted evidence) so the agent
 * cannot wave it away — e.g. it forces the "create company users first" step.
 */
function extractTicketPrerequisites(opts: {
  summary: string;
  description: string;
  acceptance: string[];
  steps: string[];
  comments: string;
}): string[] {
  const blob = [
    opts.summary,
    opts.description,
    opts.acceptance.join(". "),
    opts.steps.join(". "),
    opts.comments,
  ]
    .filter(Boolean)
    .join(". ");
  if (!blob.trim()) return [];

  const sentences = splitSentences(blob);
  const out: { norm: string; line: string }[] = [];
  const seen = new Set<string>();

  for (const raw of sentences) {
    const s = raw.replace(/\s+/g, " ").trim();
    if (s.length < 8 || s.length > 400) continue;

    const explicit = PREREQ_PHRASES.test(s);
    const existMatch = PREREQ_EXISTENCE.exec(s);
    const stateMatch = PREREQ_ENTITY_STATE.exec(s);
    const existence = existMatch || stateMatch;
    if (!explicit && !existence) continue;

    // Identify the entity the requirement is about (for the instruction). Prefer
    // the entity the quantity/state signal attaches to (e.g. "all USERS"), so the
    // instruction names the right thing and duplicates collapse cleanly.
    const entityRaw =
      existMatch?.[2] ??
      stateMatch?.[1] ??
      new RegExp(`\\b(${PREREQ_ENTITIES})\\b`, "i").exec(s)?.[1];
    if (!entityRaw) continue; // a precondition with no entity is too vague to action
    const entity = entityRaw.toLowerCase().replace(/s$/, "");

    const evidence = truncateSentence(s, 180);
    const line = explicit
      ? `Stated precondition — ensure it holds before the scenario: "${evidence}"`
      : `Data pre-state — the scenario depends on **${entity}${entity.endsWith("y") ? "/ies" : "s"}** that must already exist. ` +
        `Create/set them up first (reuse existing setup steps) or STOP and ask. Evidence: "${evidence}"`;

    const norm = `${entity}|${explicit ? "x" : "e"}`;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({ norm, line });
    if (out.length >= 6) break;
  }

  return out.map((o) => o.line);
}

/**
 * Extract hardcoded domain-specific prerequisite flows based on keyword detection.
 * Ensures that common business processes (EPS, BACS, Year End) always inject
 * their mandatory data/setup sequences into the authoring pack.
 */
function extractDomainFlowPrerequisites(blob: string): string[] {
  const text = blob.toLowerCase();
  const out: string[] = [];

  const isYearEnd = /\byear\s*end\b/.test(text);
  const isPayeBacs = /\bpaye\s*bacs\b/.test(text);
  const isBacs = !isPayeBacs && /\bbacs\b/.test(text);
  const isEps = !isPayeBacs && /\beps\b/.test(text); // Paye bacs already covers EPS

  if (isYearEnd) {
    out.push("DOMAIN FLOW (Year End): Company should exist");
    out.push("DOMAIN FLOW (Year End): Company should have employees");
    out.push("DOMAIN FLOW (Year End): FPS need to be sent for the last period");
    out.push("DOMAIN FLOW (Year End): Payroll migration");
    out.push("DOMAIN FLOW (Year End): Company migration");
    out.push("DOMAIN FLOW (Year End): Employee migration");
  } 
  
  if (isPayeBacs) {
    out.push("DOMAIN FLOW (PAYE BACS): Company should exist");
    out.push("DOMAIN FLOW (PAYE BACS): Company should have employees");
    out.push("DOMAIN FLOW (PAYE BACS): For employees FPS need to be sent");
    out.push("DOMAIN FLOW (PAYE BACS): After FPS then EPS need to be sent");
    out.push("DOMAIN FLOW (PAYE BACS): After EPS then payment BACS can be generated");
  } else {
    // Only output these if PAYE BACS didn't already cover them
    if (isBacs) {
      out.push("DOMAIN FLOW (BACS): Company should exist");
      out.push("DOMAIN FLOW (BACS): Company should have employees");
      out.push("DOMAIN FLOW (BACS): Employee should have bank details");
      out.push("DOMAIN FLOW (BACS): Payment should be made using BACS");
    }
    if (isEps) {
      out.push("DOMAIN FLOW (EPS): Company should exist");
      out.push("DOMAIN FLOW (EPS): Company should have employees");
      out.push("DOMAIN FLOW (EPS): For employees FPS need to be sent");
      out.push("DOMAIN FLOW (EPS): After FPS then EPS need to be sent");
    }
  }

  return out;
}

/**
 * Build the ticket-relevant confusable step families with per-variant usage
 * counts from the closest similar scenarios (the Layer 2 anchor). Families are
 * detected across the BROAD step universe so a rarer-but-correct variant is
 * surfaced even when the keyword filter dropped it, then narrowed to families
 * that actually touch this ticket to keep noise low.
 */
function buildRelevantConfusables(
  allPatterns: string[],
  similar: AutomationScenario[],
  reusable: StepDefinition[],
  ticketTokens: Set<string>,
): ConfusableStepGroup[] {
  const families = buildStepFamilies(allPatterns);
  if (families.length === 0) return [];

  // Count how often each variant is actually used in similar scenarios.
  const usage = new Map<string, number>(); // `${signature}|${modifierKey}` -> count
  for (const sc of similar) {
    for (const step of sc.steps) {
      const k = familyKey(stripLeadingKeyword(step));
      if (!k) continue;
      const key = `${k.signature}|${k.modifierKey}`;
      usage.set(key, (usage.get(key) ?? 0) + 1);
    }
  }

  const reusablePatterns = new Set(reusable.map((s) => s.pattern));
  const out: ConfusableStepGroup[] = [];

  for (const fam of families) {
    const variants = fam.variants.map((v) => ({
      pattern: v.pattern,
      used_in_similar: usage.get(`${fam.signature}|${v.modifierKey}`) ?? 0,
    }));

    // Relevance gate: keep only families that touch THIS ticket — a variant is
    // used in similar scenarios, offered as a reusable step, or overlaps the
    // ticket keywords. Prevents dumping unrelated repo-wide families.
    const relevant = variants.some(
      (v) =>
        v.used_in_similar > 0 ||
        reusablePatterns.has(v.pattern) ||
        overlapScore(new Set(keywordsFromText(v.pattern)), ticketTokens) > 0,
    );
    if (!relevant) continue;

    // Most-used-locally variant first — that is the convention to follow.
    variants.sort((a, b) => b.used_in_similar - a.used_in_similar);
    out.push({ signature: fam.signature, variants: variants.slice(0, 5) });
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Build a copy-template from the closest similar scenario: split its steps into
 * a stable envelope (prelude = shared navigation/setup, postlude = shared
 * save/verify/exit) and the editable main block.
 *
 * Primary strategy is DATA-DRIVEN: the envelope is the longest step prefix and
 * suffix that the closest sibling scenarios share with the base (params blanked
 * so values like a company name don't break the match). Steps shared across
 * sibling scenarios of the same flow ARE the stable envelope; the part that
 * varies between them is the action. Falls back to a conservative keyword
 * heuristic when only one similar scenario exists.
 */
function buildScenarioTemplate(
  similar: AutomationScenario[],
): ScenarioTemplate | null {
  if (!similar.length) return null;
  const base = similar[0];
  const baseSteps = sanitizeStepSequence(base.steps);
  if (baseSteps.length < 3) return null; // too short to have a real envelope

  const siblings = similar
    .slice(1, 4)
    .map((s) => sanitizeStepSequence(s.steps))
    .filter((steps) => steps.length >= 2);
  let prefixLen = 0;
  let suffixLen = 0;
  const derived_from_siblings = siblings.length > 0;

  if (derived_from_siblings) {
    prefixLen = Math.min(...siblings.map((steps) => commonPrefixLen(baseSteps, steps)));
    suffixLen = Math.min(...siblings.map((steps) => commonSuffixLen(baseSteps, steps)));
  } else {
    prefixLen = countLeadingEnvelope(baseSteps);
    suffixLen = countTrailingEnvelope(baseSteps);
  }

  // Never let the envelope swallow the whole scenario — always leave a main slot
  // and prevent prefix/suffix from overlapping.
  if (prefixLen + suffixLen > baseSteps.length - 1) {
    suffixLen = Math.max(0, baseSteps.length - 1 - prefixLen);
  }

  const prelude = baseSteps.slice(0, prefixLen);
  const postlude =
    suffixLen > 0 ? baseSteps.slice(baseSteps.length - suffixLen) : [];
  const main = baseSteps.slice(prefixLen, baseSteps.length - suffixLen);

  // No usable envelope detected — not worth presenting a template.
  if (prelude.length === 0 && postlude.length === 0) return null;

  return {
    source: `${base.name} (${base.file})`,
    prelude,
    main,
    postlude,
    derived_from_siblings,
  };
}

// ── Step-sequence firewall ──────────────────────────────────────────────────
// Project rule: after the login step the user ALREADY lands on the Company List
// page, so an explicit "User is on Company List page" right after login is
// redundant and breaks the run. Also collapses consecutive duplicate steps
// (e.g. a doubled login line). Applied to everything the pack emits as steps.
function sanitizeStepSequence(steps: string[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    // Drop an exact consecutive duplicate (values blanked) — e.g. doubled login.
    if (prev && normStepForCompare(prev) === normStepForCompare(step)) continue;
    // Drop the redundant Company-List landing immediately after login.
    if (prev && isLoginStep(prev) && isCompanyListLanding(step)) continue;
    out.push(step);
  }
  return out;
}

function isLoginStep(step: string): boolean {
  return /\blog(s|ged)?\s+in(to)?\b/i.test(stripLeadingKeyword(step));
}

function isCompanyListLanding(step: string): boolean {
  const s = stripLeadingKeyword(step).toLowerCase();
  return /\bis on\b.*\bcompany list\b.*\bpage\b/.test(s);
}

/** Normalize a step for envelope comparison: drop keyword, blank quoted values. */
function normStepForCompare(step: string): string {
  return stripLeadingKeyword(step)
    .replace(/"[^"]*"/g, '""')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function commonPrefixLen(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && normStepForCompare(a[i]) === normStepForCompare(b[i])) i++;
  return i;
}

function commonSuffixLen(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (
    i < n &&
    normStepForCompare(a[a.length - 1 - i]) === normStepForCompare(b[b.length - 1 - i])
  )
    i++;
  return i;
}

// Single-scenario fallback — conservative keyword classification of the steps
// that form the navigation/setup prelude and the save/verify/exit postlude.
function countLeadingEnvelope(steps: string[]): number {
  let i = 0;
  while (i < steps.length - 1 && isLeadEnvelopeStep(steps[i])) i++;
  return i;
}

function countTrailingEnvelope(steps: string[]): number {
  let i = 0;
  while (i < steps.length - 1 && isTrailEnvelopeStep(steps[steps.length - 1 - i])) i++;
  return i;
}

function isLeadEnvelopeStep(step: string): boolean {
  const s = stripLeadingKeyword(step).toLowerCase();
  return /\b(logs? into|log(s|ged)? in|navigat|is on .*page|go(es)? to|opens|selects .*(dropdown|drop down)|clicks on .*(tab|menu|icon)|enters? .*(field)|turns? on toogle|toggle)\b/.test(
    s,
  );
}

function isTrailEnvelopeStep(step: string): boolean {
  if (/^\s*Then\b/i.test(step)) return true; // assertions belong to the postlude
  const s = stripLeadingKeyword(step).toLowerCase();
  return /\b(save|submit|verif|assert|should|exit|close|log ?out|success|updated|message|waits?)\b/.test(
    s,
  );
}

/** Lightweight sentence splitter for prose mined from Jira/ADF. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?:])\s+|\n+|•|·|\u2022/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Trim a sentence to a max length on a word boundary. */
function truncateSentence(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + "…";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function cleanPattern(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripLeadingKeyword(s: string): string {
  return s.replace(/^(Given|When|Then|And|But)\s+/i, "").trim();
}
