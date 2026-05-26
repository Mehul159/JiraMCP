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
    files_to_read = await grepFiles(opts.repoRoot, uniqueKw.slice(0, 8));
  }

  const relatedLines = Object.entries(intelligence.related_issues).map(
    ([k, v]) =>
      `- **${k}**: ${String(v.fields?.summary ?? "")} (${(v.fields?.status as { name?: string })?.name ?? ""})`,
  );

  const markdown = [
    `# Cursor context — ${intelligence.issue.key ?? "ticket"}`,
    "",
    "## Ticket",
    `- **Summary:** ${intelligence.summary}`,
    `- **Type:** ${intelligence.issue_type}`,
    `- **Status:** ${intelligence.status}`,
    "",
    "## Description",
    intelligence.plain_description.slice(0, 4000) || "_No description_",
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
    "- Verify linked issues before merging",
    "- Confirm acceptance criteria with ticket reporter if ambiguous",
    "",
    "## Open questions",
    "- Are there migrations or feature flags required?",
  ].join("\n");

  return { markdown, files_to_read, keywords: uniqueKw };
}

async function grepFiles(repoRoot: string, keywords: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const kw of keywords) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["grep", "-l", "-i", "--fixed-strings", kw, "--"],
        { cwd: repoRoot, timeout: 6000, maxBuffer: 512 * 1024 },
      );
      for (const line of stdout.split(/\r?\n/)) {
        const f = line.trim();
        if (f) found.add(f);
      }
    } catch {
      /* no matches */
    }
    if (found.size >= 25) break;
  }
  return [...found].slice(0, 25);
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
