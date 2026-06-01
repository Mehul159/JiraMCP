import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { jiraFetch, type JiraConfig } from "../jira-client.js";
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
import { buildTestAuthoringPack } from "./test-authoring.js";
import {
  assertTransition,
  initState,
  loadState,
  saveState,
  suggestToolForState,
  type WorkflowState,
} from "./state.js";
import { validateChanges } from "./validate.js";
import { resolveWorkspace } from "./workspace.js";
import { loadServerWorkspaces } from "./config.js";

const workspaceInputs = {
  workspace_id: z.string().optional().describe("Hosted workspace id from workspaces.yaml"),
  repo_path: z.string().optional().describe("Local absolute path to git repo (stdio)"),
};

/** Normalize an issue key, returning an MCP error result instead of throwing. */
function safeNormalizeKey(
  raw: string,
): { ok: true; key: string } | { ok: false; result: ReturnType<typeof toMcpContent> } {
  try {
    return { ok: true, key: normalizeIssueKey(raw) };
  } catch (e) {
    return {
      ok: false,
      result: toMcpContent(
        fail(e instanceof Error ? e.message : String(e), {
          recovery_steps: ["Pass a valid Jira issue key like PROJ-123."],
        }),
      ),
    };
  }
}

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
        "START HERE for any Jira ticket. Say 'start ticket PROJ-123', 'work on ABC-99', 'pick up my Jira task', 'begin issue X'. Loads ticket data, generates implementation plan, and builds Cursor context. Always call this first — it returns a plan you MUST review before coding.",
      inputSchema: z.object({
        ticket_number: z.string(),
        dry_run: z.boolean().optional(),
        context_mode: z
          .enum(["full", "plan_only", "context_only", "minimal"])
          .optional()
          .describe(
            "'full' (default) = plan + context. 'plan_only' = skip context pack. 'context_only' = skip plan. 'minimal' = ticket data only, fastest.",
          ),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, dry_run, context_mode, workspace_id, repo_path }) => {
      const norm = safeNormalizeKey(ticket_number);
      if (!norm.ok) return norm.result;
      const ticket = norm.key;
      const cfg = getCfg();
      const mode = context_mode ?? "full";
      try {
        const intelligence = await buildTicketIntelligence(cfg, ticket);
        const ws = resolveWorkspace({ workspace_id, repo_path });
        let context_pack: string | undefined;
        let context_files: string[] = [];
        let context_keywords: string[] = [];
        let implementation_plan: string | undefined;
        let recommended_parent_branch: string | undefined;

        if (!("error" in ws)) {
          const cfgRepo = ws.ok.config;

          // Deduplication guard — don't silently overwrite an active workflow.
          const existing = loadState(ws.ok.repoRoot);
          if (
            existing &&
            existing.ticket_number === ticket &&
            existing.state !== "workflow_complete" &&
            !dry_run
          ) {
            return toMcpContent(
              ok(
                `Ticket ${ticket} already has an active workflow (state: ${existing.state}).`,
                {
                  ticket_number: ticket,
                  existing_state: existing,
                  warning:
                    "This ticket already has an active workflow. Pass dry_run: true to preview without overwriting, or call jiraflow_workspace_status to see current state.",
                  suggested_tool: suggestToolForState(existing.state),
                },
              ),
            );
          }

          if (!dry_run) {
            saveState(ws.ok.repoRoot, {
              ...initState(ticket, workspace_id),
              updated_at: new Date().toISOString(),
            });
          }
          if (
            (mode === "full" || mode === "context_only") &&
            cfgRepo.workflow.auto_generate_context
          ) {
            const ctx = await generateCursorContext({
              intelligence,
              repoRoot: ws.ok.repoRoot,
            });
            context_pack = ctx.markdown;
            context_files = ctx.files_to_read;
            context_keywords = ctx.keywords;
            if (!dry_run) {
              const advance = advanceState(ws.ok.repoRoot, ticket, "context_prepared");
              if (!advance.ok) {
                console.error("[jiraflow] state advance warning:", advance.message);
              }
            }
          }
          if (
            (mode === "full" || mode === "plan_only") &&
            cfgRepo.workflow.auto_generate_plan
          ) {
            implementation_plan = generateImplementationPlan({
              intelligence,
              context: context_pack
                ? {
                    markdown: context_pack,
                    files_to_read: context_files,
                    keywords: context_keywords,
                  }
                : undefined,
            });
          }
          recommended_parent_branch = cfgRepo.git.default_base_branch ?? "main";
        }

        return toMcpContent(
          ok(`Ticket ${ticket} loaded. STOP — review plan before coding.`, {
            ticket_number: ticket,
            state: dry_run ? "dry_run" : "ticket_loaded",
            context_mode: mode,
            intelligence,
            context_pack,
            implementation_plan,
            recommended_parent_branch,
            dry_run: Boolean(dry_run),
            next_action: {
              required: true,
              instruction:
                "Present the implementation_plan to the developer and ask for explicit approval before calling workspace_setup or create_feature_branch. Do NOT edit any files until approved. When the developer approves, call approve_plan.",
              approved_tool: "approve_plan",
              blocked_until_approved: [
                "workspace_setup",
                "create_feature_branch",
                "commit_with_context",
              ],
            },
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
      description:
        "Build focused Cursor context for a ticket. Use when developer says 'get context for X', 'what files are relevant to X', 'prepare workspace context', 'focus areas for this ticket'. Returns files to read + keywords + markdown context pack.",
      inputSchema: z.object({
        ticket_number: z.string(),
        focus_areas: z.array(z.string()).optional(),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, focus_areas, workspace_id, repo_path }) => {
      const norm = safeNormalizeKey(ticket_number);
      if (!norm.ok) return norm.result;
      const ticket = norm.key;
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
      description:
        "Create a structured implementation plan before any coding. Use when developer says 'make a plan', 'break down the ticket', 'how should I approach X', 'what are the steps'. Returns step-by-step plan with acceptance criteria, test strategy, and risks. ALWAYS present this to the developer and get approval before implementation.",
      inputSchema: z.object({
        ticket_number: z.string(),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, workspace_id, repo_path }) => {
      const norm = safeNormalizeKey(ticket_number);
      if (!norm.ok) return norm.result;
      const ticket = norm.key;
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
          ok("Plan generated. STOP — get developer approval before implementation.", {
            implementation_plan: plan,
            next_action: {
              required: true,
              instruction:
                "Show this plan to the developer. Ask: 'Does this look correct? Should I proceed?' Do not call workspace_setup until they approve via approve_plan.",
              approved_tool: "approve_plan",
            },
          }),
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
    "approve_plan",
    {
      description:
        "Developer explicitly approves the implementation plan. Call this when developer says 'looks good', 'proceed', 'approved', 'go ahead', 'yes implement it', 'start coding'. This unlocks workspace_setup and branch creation.",
      inputSchema: z.object({
        ticket_number: z.string(),
        notes: z
          .string()
          .optional()
          .describe("Optional developer notes or adjustments to the plan"),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, notes, workspace_id, repo_path }) => {
      const norm = safeNormalizeKey(ticket_number);
      if (!norm.ok) return norm.result;
      const ticket = norm.key;
      const ws = resolveWorkspace({ workspace_id, repo_path });
      if ("error" in ws) {
        return toMcpContent(fail(ws.error, { recovery_steps: [] }));
      }
      const current = loadState(ws.ok.repoRoot);
      const now = new Date().toISOString();
      saveState(ws.ok.repoRoot, {
        ...(current ?? initState(ticket, workspace_id)),
        ticket_number: ticket,
        state: "context_prepared",
        plan_approved: true,
        plan_approved_at: now,
        updated_at: now,
      });
      return toMcpContent(
        ok("Plan approved. You may now call workspace_setup to begin implementation.", {
          ticket_number: ticket,
          state: "context_prepared",
          plan_approved: true,
          notes: notes ?? null,
          next_tool: "workspace_setup",
        }),
      );
    },
  );

  server.registerTool(
    "workspace_setup",
    {
      description:
        "Fetch remote and checkout the correct base/parent branch. Use when developer says 'setup workspace', 'get the repo ready', 'checkout base branch', 'pull latest'. Call AFTER plan is approved, BEFORE creating a feature branch.",
      inputSchema: z.object({
        ticket_number: z.string(),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, workspace_id, repo_path }) => {
      const norm = safeNormalizeKey(ticket_number);
      if (!norm.ok) return norm.result;
      const ticket = norm.key;
      const ws = resolveWorkspace({ workspace_id, repo_path });
      if ("error" in ws) {
        return toMcpContent(
          fail(ws.error, { recovery_steps: ["Set JIRAFLOW_WORKSPACE_ROOT and workspaces.yaml."] }),
        );
      }
      const state = ws.ok.state;
      if (state && !state.plan_approved) {
        return toMcpContent(
          fail("Plan must be approved before workspace setup.", {
            recovery_steps: [
              "Call generate_implementation_plan or jira_start_ticket first.",
              "Present the plan to the developer.",
              "Call approve_plan once they confirm.",
            ],
            suggested_tool: "generate_implementation_plan",
          }),
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
      description:
        "Create a correctly-named feature branch from the base branch. Use when developer says 'create branch', 'make a feature branch', 'start a branch for X'. Requires workspace_setup to have run first.",
      inputSchema: z.object({
        ticket_number: z.string(),
        approval_token: z.string().optional(),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, workspace_id, repo_path, approval_token }) => {
      const norm = safeNormalizeKey(ticket_number);
      if (!norm.ok) return norm.result;
      const ticket = norm.key;
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
        repoRoot: ws.ok.repoRoot,
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
      description:
        "Stage all changes and commit with a smart ticket-aware message. Use when developer says 'commit', 'save my changes', 'commit my work', 'commit with context'. Generates a conventional commit message from ticket summary. Run validate_changes first if not done.",
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
      const rawTicket = ticket_number ?? ws.ok.state?.ticket_number ?? "";
      if (!rawTicket.trim()) {
        return toMcpContent(
          fail("ticket_number required.", { recovery_steps: ["Pass ticket_number."] }),
        );
      }
      const norm = safeNormalizeKey(rawTicket);
      if (!norm.ok) return norm.result;
      const ticket = norm.key;
      const approval = checkApproval({
        mode: ws.ok.config.workflow.approval_mode,
        action: "commit",
        approval_token,
        ticket_number: ticket,
        workspace_id,
        repoRoot: ws.ok.repoRoot,
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
      description:
        "Run lint, type-check, and test scripts configured in .jiraflow.yaml. Use when developer says 'validate', 'run checks', 'lint my code', 'run tests', 'check before commit'. Returns pass/fail per script with output.",
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
      description:
        "Push branch and open a GitHub PR or GitLab MR with full ticket context in the description. Use when developer says 'open PR', 'create MR', 'submit merge request', 'push and raise PR', 'I am done coding'.",
      inputSchema: z.object({
        ticket_number: z.string(),
        approval_token: z.string().optional(),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, workspace_id, repo_path, approval_token }) => {
      const norm = safeNormalizeKey(ticket_number);
      if (!norm.ok) return norm.result;
      const ticket = norm.key;
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
        repoRoot: ws.ok.repoRoot,
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
      description:
        "Show registered workspaces and current workflow state. Use when developer says 'show status', 'where am I in the flow', 'what workspaces are configured', 'list workspaces', 'show current state'.",
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

  server.registerTool(
    "update_jira_status",
    {
      description:
        "Update a Jira ticket's status by performing a workflow transition. Use when developer says 'move ticket to <status>', 'mark as in progress', 'submit merge request', 'close the ticket', 'update Jira status'. Accepts either the TARGET status name (e.g. 'In Progress', 'Merge Requested', 'QA Testing In Progress') or the transition name (e.g. 'Dev started', 'Merge request submitted'); matching is done against the project's live transitions. Transitions into a terminal status (Closed, Rejected, Done, Cancelled) require approval.",
      inputSchema: z.object({
        ticket_number: z.string(),
        status: z
          .string()
          .describe(
            "Target status name or transition name. Matched against the ticket's available transitions returned by Jira.",
          ),
        approval_token: z.string().optional(),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, status, approval_token, workspace_id, repo_path }) => {
      const norm = safeNormalizeKey(ticket_number);
      if (!norm.ok) return norm.result;
      const ticket = norm.key;
      const cfg = getCfg();

      try {
        const transitions = await jiraFetch<{
          transitions: {
            id: string;
            name: string;
            to?: { id: string; name: string };
          }[];
        }>(cfg, `/rest/api/3/issue/${encodeURIComponent(ticket)}/transitions`);

        const want = status.trim().toLowerCase();
        // Prefer matching on the TARGET status name (workflow-agnostic), since
        // transition names often differ from the status they lead to
        // (e.g. "Dev started" -> "In Progress").
        const match =
          transitions.transitions.find(
            (t) => t.to?.name.toLowerCase() === want,
          ) ??
          transitions.transitions.find((t) => t.name.toLowerCase() === want) ??
          transitions.transitions.find((t) =>
            t.to?.name.toLowerCase().includes(want),
          ) ??
          transitions.transitions.find((t) =>
            t.name.toLowerCase().includes(want),
          );

        if (!match) {
          return toMcpContent(
            fail(`No transition matching "${status}" is available from the ticket's current status.`, {
              available_transitions: transitions.transitions.map((t) => ({
                transition: t.name,
                to: t.to?.name ?? null,
              })),
              recovery_steps: [
                "Pick a value from available_transitions (either the transition name or its 'to' status).",
                "Jira only offers transitions valid from the current status — the ticket may need an intermediate step first.",
              ],
            }),
          );
        }

        const targetName = match.to?.name ?? status;
        const TERMINAL = new Set(["closed", "rejected", "done", "cancelled", "canceled", "won't do", "wont do"]);
        const isHighRisk = TERMINAL.has(targetName.toLowerCase());
        if (isHighRisk) {
          const ws = resolveWorkspace({ workspace_id, repo_path });
          const repoRoot = "error" in ws ? undefined : ws.ok.repoRoot;
          const mode = "error" in ws ? "smart" : ws.ok.config.workflow.approval_mode;
          const approval = checkApproval({
            mode,
            action: "jira_done",
            approval_token,
            ticket_number: ticket,
            workspace_id,
            repoRoot,
          });
          if (!approval.approved) {
            return toMcpContent(
              fail(`Approval required to move ${ticket} to terminal status "${targetName}".`, {
                approval_required: true,
                prompt: `About to move ${ticket} to "${targetName}" (terminal). Confirm with the developer, then re-call with approval_token.`,
                approval_token: approval.approval_token,
              }),
            );
          }
        }

        await jiraFetch(
          cfg,
          `/rest/api/3/issue/${encodeURIComponent(ticket)}/transitions`,
          {
            method: "POST",
            body: JSON.stringify({ transition: { id: match.id } }),
          },
        );
        auditLog("update_jira_status", {
          ticket,
          status: targetName,
          transition: match.name,
          device: getRequestDeviceId(),
        });
        return toMcpContent(
          ok(`Ticket ${ticket} moved to "${targetName}" via "${match.name}".`, {
            ticket,
            status: targetName,
            transition_name: match.name,
            transition_id: match.id,
          }),
        );
      } catch (e) {
        return toMcpContent(
          fail(e instanceof Error ? e.message : String(e), {
            recovery_steps: [
              "Verify Jira credentials and that you have transition permission.",
            ],
          }),
        );
      }
    },
  );

  server.registerTool(
    "prepare_test_authoring",
    {
      description:
        "Turn a Jira ticket into an automated-test authoring pack. Say 'write test cases for PROJ-123', 'automate ticket ABC-9', 'make automation test cases for X', 'generate cucumber/BDD tests for this ticket'. Give ONLY the Jira number — it reads the description, acceptance criteria, steps to reproduce, comments and linked issues into a knowledge base, then mines the repo's existing feature files, step definitions and locators/page-objects, finds the most similar existing scenarios to reuse, derives prerequisite/background steps, and returns a ready-to-finalize Gherkin feature skeleton. Pass repo_path or workspace_id pointing at the TEST AUTOMATION repo so it can mine existing assets.",
      inputSchema: z.object({
        ticket_number: z.string(),
        focus_areas: z
          .array(z.string())
          .optional()
          .describe("Optional extra keywords (feature/module names) to bias the repo search."),
        persist_kb: z
          .boolean()
          .optional()
          .describe("Write the knowledge-base markdown to .jiraflow/kb/<KEY>.md (default true)."),
        ...workspaceInputs,
      }),
    },
    async ({ ticket_number, focus_areas, persist_kb, workspace_id, repo_path }) => {
      const norm = safeNormalizeKey(ticket_number);
      if (!norm.ok) return norm.result;
      const ticket = norm.key;
      const cfg = getCfg();

      const ws = resolveWorkspace({ workspace_id, repo_path });
      const repoRoot = "error" in ws ? undefined : ws.ok.repoRoot;

      try {
        const intelligence = await buildTicketIntelligence(cfg, ticket);
        const pack = await buildTestAuthoringPack({
          intelligence,
          repoRoot,
          focus_areas,
          persist_kb,
        });
        auditLog("prepare_test_authoring", {
          ticket,
          repoRoot: repoRoot ?? undefined,
          similar: String(pack.similar_scenarios.length),
          reusable_steps: String(pack.reusable_steps.length),
          device: getRequestDeviceId(),
        });
        return toMcpContent(
          ok(
            repoRoot
              ? `Built test authoring pack for ${ticket} (${pack.similar_scenarios.length} similar scenarios, ${pack.reusable_steps.length} reusable steps).`
              : `Built test authoring pack for ${ticket} from Jira only — pass repo_path/workspace_id to mine existing tests.`,
            {
              ticket,
              knowledge_base: pack.knowledge_base,
              similar_scenarios: pack.similar_scenarios,
              reusable_steps: pack.reusable_steps,
              locator_files: pack.locator_files,
              prerequisites: pack.prerequisites,
              feature_skeleton: pack.feature_skeleton,
              context_pack: pack.markdown,
              kb_path: pack.kb_path ?? null,
              next_action: pack.next_action,
            },
          ),
        );
      } catch (e) {
        return toMcpContent(
          fail(e instanceof Error ? e.message : String(e), {
            recovery_steps: [
              "Verify the Jira key exists and credentials are valid.",
              "Pass repo_path (stdio) or workspace_id (hosted) to enable repo mining.",
            ],
          }),
        );
      }
    },
  );
}

export { PLAN_THEN_BUILD_PLAYBOOK_STANDARD, PLAN_THEN_BUILD_PLAYBOOK_FAST };
