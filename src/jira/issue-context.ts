import { jiraFetch, type JiraConfig } from "../jira-client.js";
import {
  DEFAULT_ISSUE_FIELDS,
  type IssueContextBundle,
  type IssueLink,
  type IssueResponse,
} from "./issue-types.js";

function collectLinkedKeys(issue: IssueResponse): string[] {
  const links = issue.fields?.issuelinks as IssueLink[] | undefined;
  if (!Array.isArray(links)) return [];
  const keys: string[] = [];
  for (const l of links) {
    if (l.inwardIssue?.key) keys.push(l.inwardIssue.key);
    if (l.outwardIssue?.key) keys.push(l.outwardIssue.key);
  }
  return [...new Set(keys)];
}

function collectSubtaskKeys(issue: IssueResponse): string[] {
  const subs = issue.fields?.subtasks as { key?: string }[] | undefined;
  if (!Array.isArray(subs)) return [];
  return [...new Set(subs.map((s) => s.key).filter(Boolean) as string[])];
}

async function fetchIssueBrief(cfg: JiraConfig, key: string) {
  const q = new URLSearchParams({
    fields: "summary,status,issuetype,priority,assignee",
  });
  return jiraFetch<IssueResponse>(
    cfg,
    `/rest/api/3/issue/${encodeURIComponent(key)}?${q}`,
  );
}

export async function fetchIssueContextBundle(
  cfg: JiraConfig,
  issue_key: string,
  options: { max_linked?: number; comment_limit?: number },
): Promise<IssueContextBundle> {
  const key = issue_key.trim();
  const q = new URLSearchParams();
  q.set("fields", DEFAULT_ISSUE_FIELDS);
  q.set("expand", "changelog,renderedFields");
  const main = await jiraFetch<IssueResponse>(
    cfg,
    `/rest/api/3/issue/${encodeURIComponent(key)}?${q}`,
  );

  const cap = options.max_linked ?? 15;
  const linkedKeys = collectLinkedKeys(main).slice(0, cap);
  const subKeys = collectSubtaskKeys(main).slice(0, 50);
  const toFetch = [...new Set([...subKeys, ...linkedKeys])];

  const related: Record<string, IssueResponse> = {};
  await Promise.all(
    toFetch.map(async (k) => {
      try {
        related[k] = await fetchIssueBrief(cfg, k);
      } catch (e) {
        related[k] = {
          key: k,
          fields: {
            summary: `(fetch failed: ${e instanceof Error ? e.message : String(e)})`,
          },
        };
      }
    }),
  );

  let comments: unknown = null;
  try {
    const cq = new URLSearchParams({
      maxResults: String(options.comment_limit ?? 15),
      orderBy: "-created",
    });
    comments = await jiraFetch<unknown>(
      cfg,
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment?${cq}`,
    );
  } catch {
    comments = { error: "Could not load comments" };
  }

  return { issue: main, related_issues: related, comments };
}

export function normalizeIssueKey(raw: string): string {
  const t = raw.trim().replace(/^#/, "");
  // Tolerate "PROJ 123" (space instead of dash).
  const spaceNorm = t.replace(/^([A-Za-z][A-Za-z0-9]*)\s+(\d+)$/, "$1-$2");
  const m = spaceNorm.match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/);
  if (!m) {
    throw new Error(
      `"${raw}" is not a valid Jira issue key. Expected format: PROJ-123.`,
    );
  }
  return `${m[1].toUpperCase()}-${m[2]}`;
}
