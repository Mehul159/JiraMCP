import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const WORKFLOW_STATES = [
  "ticket_loaded",
  "context_prepared",
  "parent_branch_ready",
  "feature_branch_created",
  "coding_in_progress",
  "changes_validated",
  "merge_request_ready",
  "workflow_complete",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export type WorkflowStateFile = {
  ticket_number: string;
  state: WorkflowState;
  workspace_id?: string;
  feature_branch?: string;
  parent_branch?: string;
  updated_at: string;
};

const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  ticket_loaded: ["context_prepared", "parent_branch_ready"],
  context_prepared: ["parent_branch_ready"],
  parent_branch_ready: ["feature_branch_created"],
  feature_branch_created: ["coding_in_progress"],
  coding_in_progress: ["changes_validated", "feature_branch_created"],
  changes_validated: ["merge_request_ready", "coding_in_progress"],
  merge_request_ready: ["workflow_complete"],
  workflow_complete: [],
};

export function stateFilePath(repoRoot: string): string {
  return join(repoRoot, ".jiraflow", "state.json");
}

export function loadState(repoRoot: string): WorkflowStateFile | null {
  try {
    const raw = readFileSync(stateFilePath(repoRoot), "utf8");
    const parsed = JSON.parse(raw) as WorkflowStateFile;
    if (!parsed.ticket_number || !parsed.state) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveState(repoRoot: string, state: WorkflowStateFile): void {
  const path = stateFilePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2), "utf8");
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(
  current: WorkflowState | null,
  next: WorkflowState,
): { ok: true } | { ok: false; message: string; suggested_tool?: string } {
  if (!current) {
    if (next === "ticket_loaded") return { ok: true };
    return {
      ok: false,
      message: `No workflow started. Call jira_start_ticket first.`,
      suggested_tool: "jira_start_ticket",
    };
  }
  if (current === next) return { ok: true };
  if (canTransition(current, next)) return { ok: true };
  return {
    ok: false,
    message: `Cannot transition from ${current} to ${next}.`,
    suggested_tool: suggestToolForState(current),
  };
}

function suggestToolForState(state: WorkflowState): string {
  const map: Record<WorkflowState, string> = {
    ticket_loaded: "prepare_cursor_context",
    context_prepared: "workspace_setup",
    parent_branch_ready: "create_feature_branch",
    feature_branch_created: "commit_with_context",
    coding_in_progress: "validate_changes",
    changes_validated: "create_merge_request",
    merge_request_ready: "create_merge_request",
    workflow_complete: "jira_start_ticket",
  };
  return map[state] ?? "jira_start_ticket";
}

export function initState(ticket_number: string, workspace_id?: string): WorkflowStateFile {
  return {
    ticket_number,
    state: "ticket_loaded",
    workspace_id,
    updated_at: new Date().toISOString(),
  };
}
