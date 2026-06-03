import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TicketIntelligence } from "./intelligence.js";
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
  kb_path?: string;
  next_action: string;
};

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

  const kb: TestAuthoringKB = {
    key,
    summary: intelligence.summary,
    issue_type: intelligence.issue_type,
    status: intelligence.status,
    description: intelligence.plain_description,
    acceptance,
    steps_to_reproduce: stepsToReproduce,
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
    prerequisites = dedupe([...backgrounds, ...inlinePrereqs]).slice(0, 12);

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
  }

  const feature_skeleton = buildFeatureSkeleton({
    summary: intelligence.summary,
    issueType: intelligence.issue_type,
    steps: stepsToReproduce,
    acceptance,
    prerequisites,
    reusableSteps: reusable_steps,
    key,
  });

  const markdown = renderMarkdown({
    kb,
    similar_scenarios,
    reusable_steps,
    locator_files,
    prerequisites,
    feature_skeleton,
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
    "MANDATORY WORKFLOW — follow every rule below in order before writing any code:\n\n" +

    "STEP 1 — JIRA DEEP READ:\n" +
    "Read the full Jira ticket (description, acceptance criteria, QA comments, linked issues). " +
    "Do NOT work from the ticket title alone. Extract: (a) the ONE core action/validation, " +
    "(b) the expected result, (c) the module/page it operates on.\n\n" +

    "STEP 2 — PREREQUISITE ANALYSIS (do this before writing a single Gherkin line):\n" +
    "Reason backwards from the core task. For each scenario, ask: " +
    "'What must already be true before this step can succeed at runtime?' " +
    "Check all five categories:\n" +
    "  • LOGIN/SESSION — which user role/key is required?\n" +
    "  • NAVIGATION — which page must the user be on first? Any menus/tabs to traverse?\n" +
    "  • DATA/CONFIG PRE-STATE — any record, toggle, template, or setting that must exist first?\n" +
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
    "  5. ⛔ BLOCKED — no match found → DO NOT generate code → add to 'Required Inputs' table → ask user\n\n" +

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

    "Finalize feature_skeleton into a .feature file following the repo's existing structure. " +
    "Place files alongside similar_scenarios. " +
    "Include all prerequisite steps before the main Jira step in every scenario.";

  return {
    markdown,
    knowledge_base: kb,
    similar_scenarios,
    reusable_steps,
    locator_files,
    prerequisites,
    feature_skeleton,
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
  reusableSteps: StepDefinition[];
  key: string;
}): string {
  const { summary, steps, acceptance, prerequisites, reusableSteps, key } = opts;
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
  feature_skeleton: string;
  hasRepo: boolean;
}): string {
  const { kb } = opts;
  const md: string[] = [];
  md.push(`# Test authoring pack — ${kb.key}`);
  md.push("");
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

  // ── Prerequisite / background steps ──────────────────────────────────────
  md.push("## Prerequisite / setup steps (mined from repo)");
  if (opts.prerequisites.length) {
    md.push("> Found in existing Background blocks and recurring inline Given setup steps.");
    md.push("> Include them (as Given) before the main Jira step. Reuse verbatim — do not paraphrase.");
    md.push(opts.prerequisites.map((p) => `- ${p}`).join("\n"));
  } else {
    md.push("> ⚠️ **No prerequisite steps were mined from the repo.**");
    md.push(">");
    md.push("> Before writing any Gherkin, manually reason through these categories:");
    md.push("> 1. **LOGIN/SESSION** — which user role/key is needed?");
    md.push("> 2. **NAVIGATION** — which page must be active before the main step?");
    md.push("> 3. **DATA/CONFIG PRE-STATE** — any record, toggle, or template needed first?");
    md.push("> 4. **SEQUENTIAL DEPENDENCY** — is this step N of a workflow requiring steps 1..N-1?");
    md.push("> 5. **FILE/DATA INPUTS** — any upload, dropdown, or form fill needed before the main action?");
    md.push(">");
    md.push("> Search `Reusable step definitions` below for each prerequisite.");
    md.push("> If not found, add it to **Required Inputs** and ask the user before generating code.");
  }
  md.push("");

  // ── Similar existing scenarios ────────────────────────────────────────────
  md.push("## Similar existing scenarios (reuse these verbatim where possible)");
  if (opts.similar_scenarios.length) {
    md.push("> Use these scenarios as structural and wording templates.");
    md.push("> Match their step wording exactly — do not paraphrase.");
    for (const sc of opts.similar_scenarios) {
      md.push(`### \`${sc.file}\` — ${sc.name} (match score: ${sc.score})`);
      md.push("```gherkin");
      md.push(...sc.steps);
      md.push("```");
    }
  } else {
    md.push(opts.hasRepo
      ? "> ⚠️ No closely matching scenarios found in repo. All steps will need reuse analysis against step definitions below."
      : "> ⚠️ Provide `repo_path` or `workspace_id` to mine existing tests for reuse.");
  }
  md.push("");

  // ── Reusable step definitions ─────────────────────────────────────────────
  md.push("## Reusable step definitions");
  md.push("> **REUSE PRIORITY ORDER — follow top-to-bottom, stop at first match:**");
  md.push("> 1. Exact match → use verbatim");
  md.push("> 2. Parameterized match → extract value as parameter");
  md.push("> 3. Compose from two existing steps");
  md.push("> 4. Extend existing step minimally");
  md.push("> 5. ⛔ No match → add to Required Inputs below → ask user → wait for confirmation");
  md.push("");
  if (opts.reusable_steps.length) {
    for (const s of opts.reusable_steps) {
      md.push(`- \`${s.keyword}\` \`${s.pattern}\`  _→ \`${s.file}\`_`);
    }
  } else {
    md.push("> ⚠️ No reusable steps found. Provide `repo_path`/`workspace_id` to mine the framework.");
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
      : "> ⚠️ No locator files found. Provide `repo_path`/`workspace_id` or ask user for locators.",
  );
  md.push("");

  // ── Required Inputs — blocked gaps ───────────────────────────────────────
  md.push("## ⛔ Required Inputs — BLOCKED (user confirmation needed before code generation)");
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
 * Derive prerequisite candidates from the inline setup steps that recur across
 * similar scenarios. Frequency-ranked so the most common setup (login, then
 * navigation) surfaces first. Matches frameworks that use inline Given steps
 * instead of a Background block.
 */
function derivePrerequisitesFromScenarios(scenarios: AutomationScenario[]): string[] {
  const tally = new Map<string, { display: string; count: number }>();
  for (const sc of scenarios) {
    for (const step of sc.steps) {
      const body = stripLeadingKeyword(step);
      if (!body || !isPrerequisiteStep(body)) continue;
      const norm = body.toLowerCase();
      const entry = tally.get(norm);
      if (entry) entry.count += 1;
      else tally.set(norm, { display: step, count: 1 });
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.count - a.count)
    .map((e) => e.display)
    .slice(0, 8);
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
