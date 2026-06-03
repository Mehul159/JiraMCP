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
import { fetchIssueContextBundle } from "./jira/issue-context.js";
import {
  DEFAULT_ISSUE_FIELDS,
  type IssueResponse,
} from "./jira/issue-types.js";
import {
  PLAN_THEN_BUILD_PLAYBOOK_FAST,
  PLAN_THEN_BUILD_PLAYBOOK_STANDARD,
  registerJiraflowTools,
} from "./jiraflow/tools.js";
import { getRequestJiraConfig } from "./request-context.js";

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
      version: "2.0.0",
    },
    {
      instructions: `
You are JiraFlow, a Jira-to-Cursor bridge assistant. You help developers go from a Jira ticket to a merged PR with minimal friction.

## Tool routing — natural language → tool

| What the developer says | Tool to call |
|---|---|
| "start ticket X", "work on PROJ-123", "pick up ABC-99", "load my Jira task", "begin issue X" | jira_start_ticket |
| "get context for X", "prepare workspace for X", "what files are relevant to X", "focus areas for X" | prepare_cursor_context |
| "make a plan for X", "what's the implementation plan", "break down the ticket", "how should I approach X" | generate_implementation_plan |
| "looks good", "proceed", "approved", "go ahead", "yes implement it", "start coding" | approve_plan |
| "setup workspace", "checkout base branch", "pull latest", "get the repo ready" | workspace_setup |
| "create branch", "make a feature branch", "branch for X" | create_feature_branch |
| "commit", "save changes", "commit my work", "commit with message" | commit_with_context |
| "validate", "run checks", "lint", "run tests", "check my code" | validate_changes |
| "open PR", "create MR", "push and raise PR", "submit merge request" | create_merge_request |
| "mark as in progress", "move to <any status>", "submit merge request", "close ticket", "update Jira status", "transition ticket" | update_jira_status (accepts the target status name OR transition name; works with custom project workflows) |
| "write test cases for X", "automate ticket X", "make automation test cases", "generate cucumber/BDD tests for X", "create test scenarios from Jira" | prepare_test_authoring (give only the Jira number; mines existing feature files/steps/locators and returns a Gherkin skeleton to finalize) |
| "what's the status", "show workflow state", "where am I in the flow", "list workspaces" | jiraflow_workspace_status |

## Media context — opt-in ONLY (analyze_media flag)

Image/screenshot/log analysis is OFF by default because it consumes vision tokens. Pass `analyze_media: true` ONLY when the developer's wording explicitly asks to use the attached media. Otherwise omit it (or pass `false`) and use base Jira context.

| What the developer says | Flag |
|---|---|
| "analyse and build with media ABC-123", "start ABC-123 with screenshots", "make plan using attachments", "read the attached images", "look at the screenshots / pictures / photos / mockups" | call the matching tool with `analyze_media: true` |
| Any normal ticket prompt with NO media words ("start ABC-123", "plan ABC-123", "write tests for ABC-123") | `analyze_media` omitted / `false` |

Trigger words = media, attachment(s), screenshot(s), image(s), picture(s), photo(s), mockup(s), diagram(s) combined with an action like with/using/include/analyse/read/check/look at. When unsure, do NOT enable media — ask the developer if they want attachments analysed.

## MANDATORY workflow gate — NEVER skip this

After calling jira_start_ticket or prepare_cursor_context or generate_implementation_plan:

1. STOP. Do NOT touch any files.
2. Present the implementation_plan and context_pack to the developer.
3. Ask explicitly: "Does this plan look correct? Should I proceed with implementation?"
4. Only after explicit approval → call approve_plan → workspace_setup → create_feature_branch → begin coding.

This gate exists to save context tokens and prevent wrong implementations. Skipping it is a mistake.
workspace_setup is blocked until approve_plan has been called.

## State machine — always follow this order
ticket_loaded → context_prepared → parent_branch_ready → feature_branch_created → coding_in_progress → changes_validated → merge_request_ready → workflow_complete

For complex tickets with many linked issues, pass context_mode: "plan_only" to jira_start_ticket to save tokens; fetch full context only if file-level detail is needed.

All JiraFlow tools return {success,message,data} JSON. If a tool returns suggested_tool or next_action in its response, follow it. Hosted: device token or X-Jira-Email headers. Git/MR need workspace_id or repo_path.
`.trim(),
    },
  );

  registerJiraflowTools(server, getCfg);

  server.registerTool(
    "jira_get_issue",
    {
      description:
        "Load a single Jira issue by key (e.g. PROJ-123). Returns JSON fields including description, status, links, subtasks.",
      inputSchema: z.object({
        issue_key: z.string().describe("Jira issue key, e.g. PROJ-123"),
        fields: z.string().optional(),
        expand: z.string().optional(),
      }),
    },
    async ({ issue_key, fields, expand }) => {
      const cfg = getCfg();
      const q = new URLSearchParams();
      q.set("fields", fields?.trim() || DEFAULT_ISSUE_FIELDS);
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
        jql: z.string(),
        max_results: z.number().int().min(1).max(50).optional(),
        fields: z.string().optional(),
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
        "Loads issue with changelog, linked issues (brief), and recent comments.",
      inputSchema: z.object({
        issue_key: z.string(),
        max_linked: z.number().int().min(0).max(30).optional(),
        comment_limit: z.number().int().min(1).max(50).optional(),
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
        "Legacy: loads ticket context + playbook. Prefer jira_start_ticket for JiraFlow envelope.",
      inputSchema: z.object({
        issue_key: z.string(),
        delivery_mode: z.enum(["standard", "fast"]).optional(),
        max_linked: z.number().int().min(0).max(30).optional(),
        comment_limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ issue_key, delivery_mode, max_linked, comment_limit }) => {
      const cfg = getCfg();
      const bundle = await fetchIssueContextBundle(cfg, issue_key, {
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
            text: JSON.stringify(
              {
                success: true,
                message: "Legacy playbook wrapper — use jira_start_ticket for JiraFlow.",
                data: {
                  legacy_playbook: playbook,
                  bundle,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "jira_plan_then_build",
    {
      description: "Start from a Jira key: plan→implement playbook.",
      argsSchema: {
        issue_key: z.string(),
        delivery_mode: z.enum(["standard", "fast"]).optional(),
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
              `1) Call jira_start_ticket with ticket_number="${issue_key.trim()}"\n` +
              `2) Call prepare_cursor_context and generate_implementation_plan\n` +
              (delivery_mode === "fast"
                ? `3) Fast mode: brief plan then implement.\n`
                : `3) Ask approval before edits.\n`),
          },
        },
      ],
    }),
  );

  server.registerTool(
    "jira_get_transitions",
    {
      description: "List workflow transitions for an issue.",
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
      if (!key) return { contents: [] };
      const cfg = getCfg();
      const q = new URLSearchParams();
      q.set("fields", DEFAULT_ISSUE_FIELDS);
      q.set("expand", "changelog,renderedFields");
      const data = await jiraFetch<IssueResponse>(
        cfg,
        `/rest/api/3/issue/${encodeURIComponent(String(key).trim())}?${q}`,
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
