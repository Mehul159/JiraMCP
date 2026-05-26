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

  return [
    `# Implementation plan — ${key}`,
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
    "1. Read suggested files and related ticket context",
    "2. Implement minimal change aligned with issue type",
    "3. Add or update tests covering acceptance criteria",
    "4. Run validate_changes before commit",
    "",
    "## Test strategy",
    `- Type: ${intelligence.issue_type}`,
    "- Unit tests for new logic",
    "- Manual verification against acceptance criteria",
    "",
    "## Risks",
    "- Regression in linked areas: " +
      Object.keys(intelligence.related_issues).join(", ") || "none listed",
    "",
    "## Open questions",
    "- Confirm API contracts if touching shared modules",
    "",
    "## Recent comments",
    commentsToPlain(intelligence.comments) || "_No recent comments_",
  ].join("\n");
}
