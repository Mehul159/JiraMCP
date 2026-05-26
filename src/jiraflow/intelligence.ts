import type { JiraConfig } from "../jira-client.js";
import { fetchIssueContextBundle } from "../jira/issue-context.js";
import type { IssueContextBundle, IssueResponse } from "../jira/issue-types.js";
import { adfToPlainText } from "./adf.js";

export type TicketIntelligence = IssueContextBundle & {
  plain_description: string;
  summary: string;
  issue_type: string;
  status: string;
};

export async function buildTicketIntelligence(
  cfg: JiraConfig,
  ticket_number: string,
  options?: { max_linked?: number; comment_limit?: number },
): Promise<TicketIntelligence> {
  const bundle = await fetchIssueContextBundle(cfg, ticket_number, options ?? {});
  const fields = bundle.issue.fields ?? {};
  const summary = String(fields.summary ?? "");
  const desc = fields.description;
  const plain_description =
    typeof desc === "string" ? desc : adfToPlainText(desc);
  const issue_type =
    (fields.issuetype as { name?: string } | undefined)?.name ?? "Task";
  const status =
    (fields.status as { name?: string } | undefined)?.name ?? "Unknown";
  return {
    ...bundle,
    plain_description,
    summary,
    issue_type,
    status,
  };
}

export function fieldFromIssue(
  issue: IssueResponse,
  fieldId: string | undefined,
): string | undefined {
  if (!fieldId) return undefined;
  const v = issue.fields?.[fieldId];
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "name" in v) {
    return String((v as { name?: string }).name);
  }
  return undefined;
}
