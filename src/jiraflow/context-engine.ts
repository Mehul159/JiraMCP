import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TicketIntelligence } from "./intelligence.js";
import { adfToPlainText, extractAcceptanceLines, keywordsFromText } from "./adf.js";

const execFileAsync = promisify(execFile);

export type ContextPack = {
  markdown: string;
  files_to_read: string[];
  keywords: string[];
};

export async function generateCursorContext(opts: {
  intelligence: TicketIntelligence;
  repoRoot?: string;
  focus_areas?: string[];
}): Promise<ContextPack> {
  const { intelligence } = opts;
  const acceptance = extractAcceptanceLines(intelligence.plain_description);
  const keywords = [
    ...keywordsFromText(
      intelligence.summary,
      intelligence.plain_description,
      ...(opts.focus_areas ?? []),
    ),
    ...(opts.focus_areas ?? []).map((f) => f.toLowerCase()),
  ];
  const uniqueKw = [...new Set(keywords)].slice(0, 15);

  let files_to_read: string[] = [];
  if (opts.repoRoot && uniqueKw.length > 0) {
    files_to_read = await grepFiles(opts.repoRoot, uniqueKw);
  }

  const relatedLines = Object.entries(intelligence.related_issues).map(
    ([k, v]) =>
      `- **${k}**: ${String(v.fields?.summary ?? "")} (${(v.fields?.status as { name?: string })?.name ?? ""})`,
  );

  const risks = deriveRisks(intelligence);

  const markdown = [
    `# Cursor context — ${intelligence.issue.key ?? "ticket"}`,
    "",
    "## Ticket",
    `- **Summary:** ${intelligence.summary}`,
    `- **Type:** ${intelligence.issue_type}`,
    `- **Status:** ${intelligence.status}`,
    "",
    "## Description",
    smartTruncate(intelligence.plain_description, 4000) || "_No description_",
    "",
    "## Acceptance",
    acceptance.length ? acceptance.map((l) => `- ${l}`).join("\n") : "_None detected_",
    "",
    "## Related issues",
    relatedLines.length ? relatedLines.join("\n") : "_None_",
    "",
    "## Suggested files",
    files_to_read.length
      ? files_to_read.map((f) => `- \`${f}\``).join("\n")
      : "_Run with repo_path/workspace_id for impact grep_",
    "",
    "## Focus keywords",
    uniqueKw.join(", "),
    "",
    "## Risks",
    risks.map((r) => `- ${r}`).join("\n"),
  ].join("\n");

  return { markdown, files_to_read, keywords: uniqueKw };
}

function smartTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(".", maxLen);
  return (
    (cut > maxLen * 0.7 ? text.slice(0, cut + 1) : text.slice(0, maxLen)) +
    "\n…(truncated)"
  );
}

function deriveRisks(intelligence: TicketIntelligence): string[] {
  const risks: string[] = [];
  const desc = intelligence.plain_description.toLowerCase();
  const linked = Object.keys(intelligence.related_issues);
  if (linked.length > 0) {
    risks.push(`Regression risk in linked issues: ${linked.join(", ")}`);
  }
  if (desc.includes("migrat")) {
    risks.push("Database/data migration may be required — verify rollback plan");
  }
  if (desc.includes("flag") || desc.includes("feature flag")) {
    risks.push("Feature flag required — confirm flag name and rollout plan");
  }
  if (desc.includes("api") || desc.includes("endpoint")) {
    risks.push("API contract change — check backward compatibility");
  }
  if (desc.includes("auth") || desc.includes("permission")) {
    risks.push("Auth/permission change — test with multiple user roles");
  }
  if (desc.includes("payment") || desc.includes("billing")) {
    risks.push("Payment-related change — requires QA sign-off");
  }
  if (risks.length === 0) {
    risks.push("No specific risks detected — standard review applies");
  }
  return risks;
}

async function grepFiles(repoRoot: string, keywords: string[]): Promise<string[]> {
  const scores = new Map<string, number>();
  await Promise.all(
    keywords.map(async (kw) => {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["grep", "-l", "-i", "--fixed-strings", kw, "--"],
          { cwd: repoRoot, timeout: 6000, maxBuffer: 512 * 1024 },
        );
        for (const line of stdout.split(/\r?\n/)) {
          const f = line.trim();
          if (f) scores.set(f, (scores.get(f) ?? 0) + 1);
        }
      } catch {
        /* no matches */
      }
    }),
  );
  // Rank by how many distinct keywords each file matched.
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f)
    .slice(0, 20);
}

export function commentsToPlain(comments: unknown): string {
  if (!comments || typeof comments !== "object") return "";
  const c = comments as { comments?: { body?: unknown; author?: { displayName?: string } }[] };
  if (!Array.isArray(c.comments)) return "";
  return c.comments
    .slice(0, 5)
    .map((x) => {
      const body =
        typeof x.body === "string" ? x.body : adfToPlainText(x.body);
      return `- ${x.author?.displayName ?? "user"}: ${body.slice(0, 300)}`;
    })
    .join("\n");
}
