export type IssueLink = {
  id?: string;
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: { key?: string; fields?: Record<string, unknown> };
  outwardIssue?: { key?: string; fields?: Record<string, unknown> };
};

export type IssueResponse = {
  id?: string;
  key?: string;
  self?: string;
  fields?: Record<string, unknown>;
  changelog?: unknown;
};

export type IssueContextBundle = {
  issue: IssueResponse;
  related_issues: Record<string, IssueResponse>;
  comments: unknown;
};

export const DEFAULT_ISSUE_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "issuetype",
  "assignee",
  "reporter",
  "labels",
  "components",
  "parent",
  "subtasks",
  "issuelinks",
  "attachment",
  "created",
  "updated",
  "creator",
  "project",
  "fixVersions",
  "versions",
  "duedate",
  "resolution",
].join(",");
