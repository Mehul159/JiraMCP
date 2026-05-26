import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { JiraConfig } from "../jira-client.js";
import { normalizeIssueKey } from "../jira/issue-context.js";
import { getRequestDeviceId, getRequestGitCredentials } from "../request-context.js";
import { checkApproval } from "./approval.js";
import { auditLog } from "./audit.js";
import { generateCursorContext } from "./context-engine.js";
import {
  commitWithContext,
  createFeatureBranch,
  workspaceSetup,
} from "./git.js";
import { buildTicketIntelligence } from "./intelligence.js";
import { createMergeRequest } from "./mr.js";
import { generateImplementationPlan } from "./plan.js";
import { fail, ok, toMcpContent } from "./response.js";
import {
  assertTransition,
  initState,
  loadState,
  saveState,
  type WorkflowState,
} from "./state.js";
import { validateChanges } from "./validate.js";
import { resolveWorkspace } from "./workspace.js";
import { loadServerWorkspaces } from "./config.js";

const workspaceInputs = {
  workspace_id: z.string().optional().describe("Hosted workspace id from workspaces.yaml"),
  repo_path: z.string().optional().describe("Local absolute path to git repo (stdio)"),
};

const PLAN_THEN_BUILD_PLAYBOOK_STANDARD = `## Jira workflow (plan → gate → implement → PR)

Use JiraFlow tools: jira_start_ticket → prepare_cursor_context → workspace_setup → create_feature_branch → validate_changes → commit_with_context → create_merge_request.

### Phase 1 — Planning only
- Parse context pack and plan; do not edit files until user approves (unless fast mode).

### Phase 2 — Gate
- Ask explicit approval before implementation.

### Phase 3 — Implementation
- Implement per plan; use validate_changes before commit.

### Phase 4 — PR-ready
- create_merge_request or gh pr create with Jira link.
`;

const PLAN_THEN_BUILD_PLAYBOOK_FAST = `## Jira fast delivery

≤8 bullet plan then implement in same turn unless ambiguous. Use JiraFlow git/MR tools when workspace is configured.
`;

function getJiraBaseUrl(cfg: JiraConfig): string {
  return cfg.baseUrl;
}

function advanceState(
  repoRoot: string,
  ticket: string,
  next: WorkflowState,
  extra?: Partial<ReturnType<typeof loadState>>,
) {
  const current = loadState(repoRoot);
  const check = assertTransition(current?.state ?? null, next);
  if (!check.ok && current?.state !== next) {
    return check;
  }
  const merged = {
    ...(current ?? initState(ticket)),
    ...extra,
    ticket_number: ticket,
    state: next,
    updated_at: new Date().toISOString(),
  };
  saveState(repoRoot, merged);
  return { ok: true as const, state: merged };
}

export function registerJiraflowTools(
  server: McpServer,
  getCfg: () => JiraConfig,
): void {
  server.registerTool(
    "jira_start_ticket",
    {
      description:
        "JiraFlow entry: load ticket intelligence, init workflow state, optional auto plan/context.",
      inputSchema: z.object({
        ticket_number: z.string(),
        dry_run: z.boolean().optional(),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, dry_run, workspace_id, repo_path }) => {
      const ticket = normalizeIssueKey(ticket_number);
      const cfg = getCfg();
      try {
        const intelligence = await buildTicketIntelligence(cfg, ticket);
        const ws = resolveWorkspace({ workspace_id, repo_path });
        let context_pack: string | undefined;
        let implementation_plan: string | undefined;
        let recommended_parent_branch: string | undefined;

        if (!("error" in ws)) {
          const cfgRepo = ws.ok.config;
          if (!dry_run) {
            saveState(ws.ok.repoRoot, {
              ...initState(ticket, workspace_id),
              updated_at: new Date().toISOString(),
            });
          }
          if (cfgRepo.workflow.auto_generate_context) {
            const ctx = await generateCursorContext({
              intelligence,
              repoRoot: ws.ok.repoRoot,
            });
            context_pack = ctx.markdown;
            if (!dry_run) advanceState(ws.ok.repoRoot, ticket, "context_prepared");
          }
          if (cfgRepo.workflow.auto_generate_plan) {
            implementation_plan = generateImplementationPlan({
              intelligence,
              context: context_pack
                ? { markdown: context_pack, files_to_read: [], keywords: [] }
                : undefined,
            });
          }
          recommended_parent_branch =
            cfgRepo.git.default_base_branch ?? "main";
        }

        return toMcpContent(
          ok(`Ticket ${ticket} loaded.`, {
            ticket_number: ticket,
            state: dry_run ? "dry_run" : "ticket_loaded",
            intelligence,
            context_pack,
            implementation_plan,
            recommended_parent_branch,
            dry_run: Boolean(dry_run),
          }),
        );
      } catch (e) {
        return toMcpContent(
          fail(e instanceof Error ? e.message : String(e), {
            recovery_steps: ["Verify Jira credentials and issue key."],
          }),
        );
      }
    },
  );

  server.registerTool(
    "prepare_cursor_context",
    {
      description: "Build high-signal Cursor context pack from ticket + repo impact.",
      inputSchema: z.object({
        ticket_number: z.string(),
        focus_areas: z.array(z.string()).optional(),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, focus_areas, workspace_id, repo_path }) => {
      const ticket = normalizeIssueKey(ticket_number);
      const cfg = getCfg();
      try {
        const intelligence = await buildTicketIntelligence(cfg, ticket);
        const ws = resolveWorkspace({ workspace_id, repo_path });
        const repoRoot = "error" in ws ? undefined : ws.ok.repoRoot;
        const pack = await generateCursorContext({
          intelligence,
          repoRoot,
          focus_areas,
        });
        if (repoRoot) advanceState(repoRoot, ticket, "context_prepared");
        return toMcpContent(
          ok("Context pack ready.", {
            context_pack: pack.markdown,
            files_to_read: pack.files_to_read,
            keywords: pack.keywords,
          }),
        );
      } catch (e) {
        return toMcpContent(
          fail(e instanceof Error ? e.message : String(e), {
            recovery_steps: ["Call jira_start_ticket first."],
          }),
        );
      }
    },
  );

  server.registerTool(
    "generate_implementation_plan",
    {
      description: "Structured implementation plan markdown for the ticket.",
      inputSchema: z.object({
        ticket_number: z.string(),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, workspace_id, repo_path }) => {
      const ticket = normalizeIssueKey(ticket_number);
      try {
        const intelligence = await buildTicketIntelligence(getCfg(), ticket);
        const ws = resolveWorkspace({ workspace_id, repo_path });
        let context;
        if (!("error" in ws)) {
          context = await generateCursorContext({
            intelligence,
            repoRoot: ws.ok.repoRoot,
          });
        }
        const plan = generateImplementationPlan({ intelligence, context });
        return toMcpContent(
          ok("Plan generated.", { implementation_plan: plan }),
        );
      } catch (e) {
        return toMcpContent(
          fail(e instanceof Error ? e.message : String(e), {
            recovery_steps: [],
          }),
        );
      }
    },
  );

  server.registerTool(
    "workspace_setup",
    {
      description: "Fetch and checkout parent/base branch for the ticket.",
      inputSchema: z.object({
        ticket_number: z.string(),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, workspace_id, repo_path }) => {
      const ticket = normalizeIssueKey(ticket_number);
      const ws = resolveWorkspace({ workspace_id, repo_path });
      if ("error" in ws) {
        return toMcpContent(
          fail(ws.error, { recovery_steps: ["Set JIRAFLOW_WORKSPACE_ROOT and workspaces.yaml."] }),
        );
      }
      try {
        const intelligence = await buildTicketIntelligence(getCfg(), ticket);
        const { parent_branch } = await workspaceSetup({
          repoRoot: ws.ok.repoRoot,
          config: ws.ok.config,
          intelligence,
        });
        advanceState(ws.ok.repoRoot, ticket, "parent_branch_ready", {
          parent_branch,
          workspace_id,
        });
        auditLog("workspace_setup", {
          workspace_id,
          device: getRequestDeviceId(),
          ticket,
        });
        return toMcpContent(
          ok(`Checked out ${parent_branch}.`, { parent_branch, state: "parent_branch_ready" }),
        );
      } catch (e) {
        return toMcpContent(
          fail(e instanceof Error ? e.message : String(e), {
            recovery_steps: ["Ensure git remote is configured."],
            state: ws.ok.state?.state,
          }),
        );
      }
    },
  );

  server.registerTool(
    "create_feature_branch",
    {
      description: "Create feature branch from config pattern.",
      inputSchema: z.object({
        ticket_number: z.string(),
        approval_token: z.string().optional(),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, workspace_id, repo_path, approval_token }) => {
      const ticket = normalizeIssueKey(ticket_number);
      const ws = resolveWorkspace({ workspace_id, repo_path });
      if ("error" in ws) {
        return toMcpContent(fail(ws.error, { recovery_steps: [] }));
      }
      const approval = checkApproval({
        mode: ws.ok.config.workflow.approval_mode,
        action: "branch_create",
        approval_token,
        ticket_number: ticket,
        workspace_id,
      });
      if (!approval.approved) {
        return toMcpContent(
          fail("Approval required.", {
            approval_required: true,
            prompt: approval.prompt,
            approval_token: approval.approval_token,
          }),
        );
      }
      try {
        const intelligence = await buildTicketIntelligence(getCfg(), ticket);
        const { branch } = await createFeatureBranch({
          repoRoot: ws.ok.repoRoot,
          config: ws.ok.config,
          intelligence,
        });
        advanceState(ws.ok.repoRoot, ticket, "feature_branch_created", {
          feature_branch: branch,
        });
        return toMcpContent(
          ok(`Branch ${branch} created.`, { branch, state: "feature_branch_created" }),
        );
      } catch (e) {
        return toMcpContent(
          fail(e instanceof Error ? e.message : String(e), { recovery_steps: [] }),
        );
      }
    },
  );

  server.registerTool(
    "commit_with_context",
    {
      description: "Stage all changes and commit with ticket-aware message.",
      inputSchema: z.object({
        ticket_number: z.string().optional(),
        message_override: z.string().optional(),
        approval_token: z.string().optional(),
        ...workspaceInputs,
      }),
    },
    async ({
      ticket_number,
      message_override,
      workspace_id,
      repo_path,
      approval_token,
    }) => {
      const ws = resolveWorkspace({ workspace_id, repo_path });
      if ("error" in ws) {
        return toMcpContent(fail(ws.error, { recovery_steps: [] }));
      }
      const ticket =
        normalizeIssueKey(ticket_number ?? ws.ok.state?.ticket_number ?? "");
      if (!ticket || ticket === "") {
        return toMcpContent(
          fail("ticket_number required.", { recovery_steps: ["Pass ticket_number."] }),
        );
      }
      const approval = checkApproval({
        mode: ws.ok.config.workflow.approval_mode,
        action: "commit",
        approval_token,
        ticket_number: ticket,
        workspace_id,
      });
      if (!approval.approved) {
        return toMcpContent(
          fail("Approval required.", {
            approval_required: true,
            prompt: approval.prompt,
            approval_token: approval.approval_token,
          }),
        );
      }
      try {
        const intelligence = await buildTicketIntelligence(getCfg(), ticket);
        const result = await commitWithContext({
          repoRoot: ws.ok.repoRoot,
          intelligence,
          message_override,
        });
        advanceState(ws.ok.repoRoot, ticket, "coding_in_progress");
        return toMcpContent(
          ok(result.committed ? "Committed." : "Nothing to commit.", result),
        );
      } catch (e) {
        return toMcpContent(
          fail(e instanceof Error ? e.message : String(e), { recovery_steps: [] }),
        );
      }
    },
  );

  server.registerTool(
    "validate_changes",
    {
      description: "Run validate_scripts from .jiraflow.yaml.",
      inputSchema: z.object({
        long_running: z.boolean().optional(),
        ...workspaceInputs,
      }),
    },
    async ({ workspace_id, repo_path, long_running }) => {
      const ws = resolveWorkspace({ workspace_id, repo_path });
      if ("error" in ws) {
        return toMcpContent(fail(ws.error, { recovery_steps: [] }));
      }
      try {
        const result = await validateChanges(
          ws.ok.repoRoot,
          ws.ok.config,
          long_running,
        );
        const ticket = ws.ok.state?.ticket_number;
        if (ticket && result.passed) {
          advanceState(ws.ok.repoRoot, ticket, "changes_validated");
        }
        return toMcpContent(
          result.passed
            ? ok("Validation passed.", { ...result, state: "changes_validated" })
            : fail("Validation failed.", { ...result, recovery_steps: ["Fix errors and re-run."] }),
        );
      } catch (e) {
        return toMcpContent(
          fail(e instanceof Error ? e.message : String(e), { recovery_steps: [] }),
        );
      }
    },
  );

  server.registerTool(
    "create_merge_request",
    {
      description: "Push branch and open GitHub PR or GitLab MR.",
      inputSchema: z.object({
        ticket_number: z.string(),
        approval_token: z.string().optional(),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, workspace_id, repo_path, approval_token }) => {
      const ticket = normalizeIssueKey(ticket_number);
      const ws = resolveWorkspace({ workspace_id, repo_path });
      if ("error" in ws) {
        return toMcpContent(fail(ws.error, { recovery_steps: [] }));
      }
      const approval = checkApproval({
        mode: ws.ok.config.workflow.approval_mode,
        action: "mr_create",
        approval_token,
        ticket_number: ticket,
        workspace_id,
      });
      if (!approval.approved) {
        return toMcpContent(
          fail("Approval required.", {
            approval_required: true,
            prompt: approval.prompt,
            approval_token: approval.approval_token,
          }),
        );
      }
      try {
        const intelligence = await buildTicketIntelligence(getCfg(), ticket);
        const parent =
          ws.ok.state?.parent_branch ??
          ws.ok.config.git.default_base_branch ??
          "main";
        const creds = getRequestGitCredentials();
        const { url, provider } = await createMergeRequest({
          repoRoot: ws.ok.repoRoot,
          intelligence,
          parent_branch: parent,
          creds,
          jira_base_url: getJiraBaseUrl(getCfg()),
        });
        advanceState(ws.ok.repoRoot, ticket, "merge_request_ready");
        advanceState(ws.ok.repoRoot, ticket, "workflow_complete");
        return toMcpContent(
          ok(`Merge request created (${provider}).`, { url, provider, state: "workflow_complete" }),
        );
      } catch (e) {
        return toMcpContent(
          fail(e instanceof Error ? e.message : String(e), {
            recovery_steps: [
              "Add GITHUB_TOKEN or GITLAB_TOKEN via /setup or server env.",
              "Ensure origin remote points to GitHub/GitLab.",
            ],
          }),
        );
      }
    },
  );

  server.registerTool(
    "jiraflow_workspace_status",
    {
      description: "List registered workspaces and local workflow state.",
      inputSchema: z.object({
        workspace_id: z.string().optional(),
        repo_path: z.string().optional(),
      }),
    },
    async ({ workspace_id, repo_path }) => {
      const serverWs = loadServerWorkspaces();
      const ws = resolveWorkspace({ workspace_id, repo_path });
      if ("error" in ws && workspace_id) {
        return toMcpContent(
          fail(ws.error, { registered_workspaces: serverWs.workspaces }),
        );
      }
      const data: Record<string, unknown> = {
        registered_workspaces: serverWs.workspaces,
        workspace_root: process.env.JIRAFLOW_WORKSPACE_ROOT ?? null,
      };
      if (!("error" in ws)) {
        data.repoRoot = ws.ok.repoRoot;
        data.state = ws.ok.state;
        data.config = ws.ok.config;
      }
      return toMcpContent(ok("Workspace status.", data));
    },
  );
}

export { PLAN_THEN_BUILD_PLAYBOOK_STANDARD, PLAN_THEN_BUILD_PLAYBOOK_FAST };
