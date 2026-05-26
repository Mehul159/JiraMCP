import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  jiraFetch,
  loadJiraConfigFromEnv,
  type JiraConfig,
} from "./jira-client.js";
import { getRequestJiraConfig } from "./request-context.js";

const DEFAULT_FIELDS = [
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

type IssueLink = {
  id?: string;
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: { key?: string; fields?: Record<string, unknown> };
  outwardIssue?: { key?: string; fields?: Record<string, unknown> };
};

type IssueResponse = {
  id?: string;
  key?: string;
  self?: string;
  fields?: Record<string, unknown>;
  changelog?: unknown;
};

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

type IssueContextBundle = {
  issue: IssueResponse;
  related_issues: Record<string, IssueResponse>;
  comments: unknown;
};

async function fetchIssueContextBundle(
  cfg: JiraConfig,
  issue_key: string,
  options: { max_linked?: number; comment_limit?: number },
): Promise<IssueContextBundle> {
  const q = new URLSearchParams();
  q.set("fields", DEFAULT_FIELDS);
  q.set("expand", "changelog,renderedFields");
  const main = await jiraFetch<IssueResponse>(
    cfg,
    `/rest/api/3/issue/${encodeURIComponent(issue_key.trim())}?${q}`,
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
    })
  );

  let comments: unknown = null;
  try {
    const cq = new URLSearchParams({
      maxResults: String(options.comment_limit ?? 15),
      orderBy: "-created",
    });
    comments = await jiraFetch<unknown>(
      cfg,
      `/rest/api/3/issue/${encodeURIComponent(issue_key.trim())}/comment?${cq}`,
    );
  } catch {
    comments = { error: "Could not load comments" };
  }

  return { issue: main, related_issues: related, comments };
}

const PLAN_THEN_BUILD_PLAYBOOK_STANDARD = `## Jira workflow (plan → gate → implement → PR)

**Limitation:** MCP cannot switch Cursor between Plan mode and Agent mode. Open **Plan** or **Agent** yourself; this playbook tells the assistant how to behave.

### Phase 1 — Planning only (no implementation)
- Parse the Jira JSON below: summary, description, acceptance criteria (if any), type (bug/story/task), links, subtasks, comments, changelog highlights.
- Produce a concise plan: scope, files/areas likely touched, risks, open questions, suggested test strategy.
- **Do not** edit project files, run installs, or apply patches in this phase.

### Phase 2 — Gate (required)
- Stop and ask the user explicitly for approval to implement (e.g. “Approve this plan and proceed with implementation?”).
- If they want autonomous edits, tell them to switch to **Agent** after they approve.

### Phase 3 — Implementation (after explicit approval only)
- Implement according to the approved plan. Prefer small, reviewable commits.

### Phase 4 — PR-ready (same session, after code works)
- **Branch:** \`feat/<KEY>-short-slug\` or \`fix/<KEY>-short-slug\` (derive slug from summary).
- **Commits:** First line references the key, e.g. \`KAN-1: add todo list scaffold\`.
- **Verify:** run the project’s usual lint/tests before pushing.
- **Open PR:** push then e.g. \`gh pr create --title "KAN-1: …" --body "## Summary\\n…\\n\\n## Jira\\n- https://<site>/browse/KAN-1 (adjust host)\\n"\` — or the repo’s equivalent; include testing notes.
`;

const PLAN_THEN_BUILD_PLAYBOOK_FAST = `## Jira fast delivery (ticket key + ship intent)

The user asked for **minimal friction**: implement soon after loading the ticket.

**Limitation:** MCP cannot switch Cursor Plan/Agent for you — use **Agent** mode for edits.

### Phase 1 — Ultra-short plan (still no edits during this subsection)
- Read the Jira JSON below; write **≤8 bullets**: scope, main files/modules, tests to add/update, risks.
- If the ticket is **ambiguous or security-sensitive**, stop and ask one clarifying question instead of guessing.

### Phase 2 — Gate (compressed)
- Unless blocked by ambiguity, treat **the request to use fast delivery** as approval to implement **in this same turn** after the bullets above.

### Phase 3 — Implement immediately
- Implement per bullets; keep commits review-sized.

### Phase 4 — PR-ready
- Same as standard workflow: sensible branch name, commits with \`<KEY>:\` prefix, tests, then push + \`gh pr create\` (or team workflow) with Jira link in body.
`;

function playbookForDeliveryMode(mode: "standard" | "fast"): string {
  return mode === "fast"
    ? PLAN_THEN_BUILD_PLAYBOOK_FAST
    : PLAN_THEN_BUILD_PLAYBOOK_STANDARD;
}

function getCfg(): JiraConfig {
  const fromReq = getRequestJiraConfig();
  if (fromReq) return fromReq;
  return loadJiraConfigFromEnv();
}

/** Shared MCP surface for stdio (local) and Streamable HTTP (hosted). */
export function createJiraMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "jira-mcp",
      version: "1.0.0",
    },
    {
      instructions:
        "Jira Cloud. Hosted: credentials from HTTP headers X-Jira-Email, X-Jira-Api-Token, optional X-Jira-Base-Url (or server default). Local stdio: process env. Ticket-key-only messages: call jira_ticket_plan_then_build (optional delivery_mode fast when user said ship/fast/implement now). Use jira_search for JQL discovery; jira_get_issue_context for ad-hoc reads.",
    },
  );

  server.registerTool(
    "jira_get_issue",
    {
      description:
        "Load a single Jira issue by key (e.g. PROJ-123). Returns JSON fields including description, status, links, subtasks.",
      inputSchema: z.object({
        issue_key: z
          .string()
          .describe("Jira issue key, e.g. PROJ-123"),
        fields: z
          .string()
          .optional()
          .describe(
            "Comma-separated Jira field ids (default: common agile fields). Use *navigable for many navigable fields.",
          ),
        expand: z
          .string()
          .optional()
          .describe(
            "Optional expand: e.g. renderedFields,changelog (comma-separated)",
          ),
      }),
    },
    async ({ issue_key, fields, expand }) => {
      const cfg = getCfg();
      const q = new URLSearchParams();
      q.set("fields", fields?.trim() || DEFAULT_FIELDS);
      if (expand?.trim()) q.set("expand", expand.trim());
      const data = await jiraFetch<IssueResponse>(
        cfg,
        `/rest/api/3/issue/${encodeURIComponent(issue_key.trim())}?${q}`,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "jira_search",
    {
      description: "Run a JQL search (Jira Query Language). Max 50 results.",
      inputSchema: z.object({
        jql: z.string().describe("JQL string"),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Default 25"),
        fields: z
          .string()
          .optional()
          .describe(
            "Comma-separated fields per issue (default: summary,status,issuetype,key)",
          ),
      }),
    },
    async ({ jql, max_results, fields }) => {
      const cfg = getCfg();
      const fieldList = (fields?.trim() || "summary,status,issuetype,key")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const body = {
        jql,
        maxResults: max_results ?? 25,
        fields: fieldList,
      };
      // Legacy POST /rest/api/3/search returns 410 on Jira Cloud — use enhanced JQL search.
      const data = await jiraFetch<{ issues?: IssueResponse[]; total?: number }>(
        cfg,
        "/rest/api/3/search/jql",
        { method: "POST", body: JSON.stringify(body) },
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "jira_get_comments",
    {
      description: "List comments on an issue (newest last; includes body ADF).",
      inputSchema: z.object({
        issue_key: z.string(),
        max_results: z.number().int().min(1).max(100).optional(),
      }),
    },
    async ({ issue_key, max_results }) => {
      const cfg = getCfg();
      const q = new URLSearchParams({
        maxResults: String(max_results ?? 50),
        orderBy: "-created",
      });
      const data = await jiraFetch<unknown>(
        cfg,
        `/rest/api/3/issue/${encodeURIComponent(issue_key.trim())}/comment?${q}`,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "jira_get_issue_context",
    {
      description:
        "Best for agents: loads the issue with changelog, subtasks + linked issues (brief), and recent comments so you can judge scope, bugs, and related work.",
      inputSchema: z.object({
        issue_key: z.string().describe("e.g. PROJ-123"),
        max_linked: z
          .number()
          .int()
          .min(0)
          .max(30)
          .optional()
          .describe("Max linked issues to expand (default 15)"),
        comment_limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Recent comments to fetch (default 15)"),
      }),
    },
    async ({ issue_key, max_linked, comment_limit }) => {
      const cfg = getCfg();
      const bundle = await fetchIssueContextBundle(cfg, issue_key, {
        max_linked,
        comment_limit,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(bundle, null, 2) }],
      };
    },
  );

  server.registerTool(
    "jira_ticket_plan_then_build",
    {
      description:
        "Use when the user message is primarily a Jira issue key: loads full ticket context AND returns the plan→approval→implement playbook (with PR-ready steps). Use delivery_mode fast when the user asked to ship/implement quickly (e.g. KEY fast, KEY ship). MCP cannot switch Cursor Plan/Agent modes.",
      inputSchema: z.object({
        issue_key: z
          .string()
          .describe("e.g. KAN-42 — uppercase project key + number"),
        delivery_mode: z
          .enum(["standard", "fast"])
          .optional()
          .describe(
            "standard = plan then explicit approval (default). fast = short plan then implement in same turn when user signaled ship/implement now.",
          ),
        max_linked: z.number().int().min(0).max(30).optional(),
        comment_limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ issue_key, delivery_mode, max_linked, comment_limit }) => {
      const cfg = getCfg();
      const bundle = await fetchIssueContextBundle(cfg, issue_key.trim(), {
        max_linked,
        comment_limit,
      });
      const mode = delivery_mode ?? "standard";
      const playbook = playbookForDeliveryMode(mode);
      return {
        content: [
          {
            type: "text" as const,
            text: `${playbook}\n---\n## Ticket\n\`${bundle.issue.key ?? issue_key.trim()}\`\n---\n## Jira payload (JSON)\n`,
          },
          {
            type: "text" as const,
            text: JSON.stringify(bundle, null, 2),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "jira_plan_then_build",
    {
      description:
        "Start from a Jira key: plan→implement playbook; optional delivery_mode fast for ship-in-one-turn (Cursor Plan/Agent chosen in UI).",
      argsSchema: {
        issue_key: z.string().describe("Jira issue key, e.g. PROJ-123"),
        delivery_mode: z
          .enum(["standard", "fast"])
          .optional()
          .describe("fast when user wants minimal approval friction"),
      },
    },
    async ({ issue_key, delivery_mode }) => ({
      description: `Plan → approve → build workflow for ${issue_key}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Ticket: ${issue_key.trim()}\n` +
              (delivery_mode === "fast"
                ? `Delivery: FAST (short plan then implement in same turn).\n\n`
                : "") +
              `Follow this strictly:\n` +
              `1) Call tool jira_ticket_plan_then_build with issue_key="${issue_key.trim()}"` +
              (delivery_mode === "fast"
                ? ` and delivery_mode="fast".`
                : `.`) +
              `\n` +
              (delivery_mode === "fast"
                ? `2) Brief plan (≤8 bullets) then implement; PR-ready checklist at end.\n`
                : `2) Phase 1 — Planning only: summarize scope from the JSON; do not edit files.\n` +
                  `3) Phase 2 — Ask me explicitly to approve before any implementation.\n` +
                  `4) Phase 3 — Only after I approve, implement (I may switch to Agent mode in Cursor).\n`) +
              `Note: You cannot switch Cursor Plan/Agent mode for me.`,
          },
        },
      ],
    }),
  );

  server.registerTool(
    "jira_get_transitions",
    {
      description:
        "List available workflow transitions for an issue (for status changes).",
      inputSchema: z.object({ issue_key: z.string() }),
    },
    async ({ issue_key }) => {
      const cfg = getCfg();
      const data = await jiraFetch<unknown>(
        cfg,
        `/rest/api/3/issue/${encodeURIComponent(issue_key.trim())}/transitions`,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  const issueTemplate = new ResourceTemplate("jira://issue/{key}", {
    list: undefined,
  });

  server.registerResource(
    "jira-issue",
    issueTemplate,
    {
      description: "Read a Jira issue as JSON via jira://issue/PROJ-123",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = variables.key;
      const key = Array.isArray(raw) ? raw[0] : raw;
      if (!key) {
        return { contents: [] };
      }
      const cfg = getCfg();
      const q = new URLSearchParams();
      q.set("fields", DEFAULT_FIELDS);
      q.set("expand", "changelog,renderedFields");
      const data = await jiraFetch<IssueResponse>(
        cfg,
        `/rest/api/3/issue/${encodeURIComponent(key.trim())}?${q}`,
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
