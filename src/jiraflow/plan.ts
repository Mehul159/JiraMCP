import type { ContextPack } from "./context-engine.js";
import type { TicketIntelligence } from "./intelligence.js";
import { commentsToPlain } from "./context-engine.js";
import { extractAcceptanceLines } from "./adf.js";

export function generateImplementationPlan(opts: {
  intelligence: TicketIntelligence;
  context?: ContextPack;
}): string {
  const { intelligence, context } = opts;
  const key = intelligence.issue.key ?? "TICKET";
  const acceptance = extractAcceptanceLines(intelligence.plain_description);
  const steps = deriveImplementationSteps(intelligence, context);
  const complexity = estimateComplexity(intelligence, context);
  const linked = Object.keys(intelligence.related_issues);

  return [
    `# Implementation plan — ${key}`,
    "",
    `**Complexity estimate:** ${complexity}`,
    "",
    "## Scope",
    intelligence.summary,
    "",
    "## Acceptance criteria",
    acceptance.length
      ? acceptance.map((l) => `- ${l}`).join("\n")
      : "- Derive from description and linked issues",
    "",
    "## Likely files / modules",
    context?.files_to_read?.length
      ? context.files_to_read.map((f) => `- \`${f}\``).join("\n")
      : "- To be identified after workspace_setup",
    "",
    "## Implementation steps",
    steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    "",
    "## Test strategy",
    `- Type: ${intelligence.issue_type}`,
    "- Unit tests for new logic",
    "- Manual verification against acceptance criteria",
    "",
    "## Risks",
    linked.length
      ? `- Regression in linked areas: ${linked.join(", ")}`
      : "- None listed",
    "",
    "## Open questions",
    "- Confirm API contracts if touching shared modules",
    "",
    "## Recent comments",
    commentsToPlain(intelligence.comments) || "_No recent comments_",
  ].join("\n");
}

function deriveImplementationSteps(
  intelligence: TicketIntelligence,
  context?: ContextPack,
): string[] {
  const desc = intelligence.plain_description.toLowerCase();
  const type = intelligence.issue_type.toLowerCase();
  const steps: string[] = [];

  if (context?.files_to_read?.length) {
    steps.push(
      `Read these files first: ${context.files_to_read
        .slice(0, 5)
        .map((f) => `\`${f}\``)
        .join(", ")}`,
    );
  } else {
    steps.push(
      "Identify relevant files via grep or codebase search before writing any code",
    );
  }

  if (type === "bug") {
    steps.push("Reproduce the bug locally and write a failing test that captures it");
    steps.push("Find root cause — do not fix symptoms");
    steps.push("Implement the fix with minimal blast radius");
    steps.push("Verify the failing test now passes");
  } else if (type === "story" || type === "feature") {
    steps.push("Implement the feature in the smallest vertical slice possible");
    steps.push(
      "Wire up to existing patterns — do not introduce new abstractions unless necessary",
    );
  } else if (type === "task") {
    steps.push("Complete the task as scoped — flag scope creep immediately");
  }

  if (desc.includes("migrat")) {
    steps.push("Write and test the migration script before touching application code");
  }
  if (desc.includes("api") || desc.includes("endpoint")) {
    steps.push("Update OpenAPI/Swagger spec if endpoint signature changes");
  }
  if (desc.includes("test") || desc.includes("spec")) {
    steps.push("Ensure test coverage meets or exceeds existing baseline");
  }
  if (desc.includes("ui") || desc.includes("frontend") || desc.includes("component")) {
    steps.push(
      "Match existing design system patterns — do not introduce new CSS variables or component patterns",
    );
  }

  steps.push("Run `validate_changes` (lint + type-check + tests) before committing");

  return steps;
}

function estimateComplexity(
  intelligence: TicketIntelligence,
  context?: ContextPack,
): "XS" | "S" | "M" | "L" | "XL" {
  const fileCount = context?.files_to_read?.length ?? 0;
  const linkedCount = Object.keys(intelligence.related_issues).length;
  const descLen = intelligence.plain_description.length;
  const score =
    fileCount * 2 +
    linkedCount +
    (descLen > 1000 ? 2 : 0) +
    (descLen > 3000 ? 2 : 0);
  if (score <= 2) return "XS";
  if (score <= 5) return "S";
  if (score <= 10) return "M";
  if (score <= 18) return "L";
  return "XL";
}
