import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TicketIntelligence } from "./intelligence.js";
import {
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
  const keywords = [
    ...keywordsFromText(
      intelligence.summary,
      intelligence.plain_description,
      ...(opts.focus_areas ?? []),
    ),
    ...(opts.focus_areas ?? []).map((f) => f.toLowerCase()),
  ];
  const uniqueKw = [...new Set(keywords)].slice(0, 15);
  const ticketTokens = new Set(
    keywordsFromText(intelligence.summary, ...stepsToReproduce, ...acceptance),
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
    prerequisites = backgrounds.slice(0, 12);

    // Step-definition mining.
    const stepCandidates = dedupe([
      ...(await grepInPathspecMany(repoRoot, uniqueKw, STEP_PATHSPECS)),
      ...rankByOverlap(stepFiles, ticketTokens),
    ]).slice(0, MAX_STEP_FILES_READ);
    reusable_steps = (await mineStepDefinitions(repoRoot, stepCandidates))
      .filter((s) => overlapScore(new Set(keywordsFromText(s.pattern)), ticketTokens) > 0)
      .slice(0, 40);
    if (reusable_steps.length === 0) {
      // Fall back to a sample of available steps so the agent sees conventions.
      reusable_steps = (await mineStepDefinitions(repoRoot, stepCandidates)).slice(0, 25);
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
    "Author the test cases by FINALIZING feature_skeleton into a .feature file that follows the repo's existing structure. " +
    "REUSE the step phrasings in reusable_steps verbatim where they fit (do not invent duplicates). " +
    "Only write NEW step definitions and locators for steps/elements that do not already exist. " +
    "Include the prerequisites as Background or setup steps. Place files alongside similar_scenarios.";

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
  const { summary, steps, acceptance, prerequisites, key } = opts;
  const lines: string[] = [];
  lines.push(`@${key}`);
  lines.push(`Feature: ${summary || key}`);
  lines.push("");

  if (prerequisites.length) {
    lines.push("  Background:");
    for (const p of prerequisites.slice(0, 6)) lines.push(`    ${p}`);
    lines.push("");
  }

  lines.push(`  Scenario: ${summary || `Verify ${key}`}`);
  if (!prerequisites.length) {
    lines.push("    Given the application is open and the user is logged in");
  }

  const reproSteps = steps.length ? steps : ["perform the action described in the ticket"];
  reproSteps.forEach((s, i) => {
    const kw = i === 0 ? "When" : "And";
    lines.push(`    ${kw} ${stripLeadingKeyword(s)}`);
  });

  if (acceptance.length) {
    acceptance.slice(0, 6).forEach((a, i) => {
      const kw = i === 0 ? "Then" : "And";
      lines.push(`    ${kw} ${stripLeadingKeyword(a)}`);
    });
  } else {
    lines.push("    Then the expected result is verified");
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

  md.push("## Similar existing scenarios (reuse these)");
  if (opts.similar_scenarios.length) {
    for (const sc of opts.similar_scenarios) {
      md.push(`### \`${sc.file}\` — ${sc.name} (match ${sc.score})`);
      md.push("```gherkin");
      md.push(...sc.steps);
      md.push("```");
    }
  } else {
    md.push(opts.hasRepo ? "_No closely matching scenarios found_" : "_Provide repo_path/workspace_id to mine existing tests_");
  }
  md.push("");

  md.push("## Reusable step definitions");
  if (opts.reusable_steps.length) {
    for (const s of opts.reusable_steps) {
      md.push(`- \`${s.keyword}\` ${s.pattern}  _(\`${s.file}\`)_`);
    }
  } else {
    md.push("_None found — new step definitions will be needed_");
  }
  md.push("");

  md.push("## Prerequisite / background steps");
  md.push(
    opts.prerequisites.length
      ? opts.prerequisites.map((p) => `- ${p}`).join("\n")
      : "_None detected_",
  );
  md.push("");

  md.push("## Locator / page-object files");
  md.push(
    opts.locator_files.length
      ? opts.locator_files.map((f) => `- \`${f}\``).join("\n")
      : "_None found_",
  );
  md.push("");

  md.push("## Proposed feature skeleton");
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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function cleanPattern(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripLeadingKeyword(s: string): string {
  return s.replace(/^(Given|When|Then|And|But)\s+/i, "").trim();
}
