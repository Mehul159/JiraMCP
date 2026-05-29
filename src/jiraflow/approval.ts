import { randomUUID } from "node:crypto";
import type { ApprovalMode } from "./config.js";
import { initState, loadState, saveState } from "./state.js";

export type ApprovalAction =
  | "branch_create"
  | "commit"
  | "push"
  | "force_push"
  | "mr_create"
  | "jira_done";

type Risk = "LOW" | "MEDIUM" | "HIGH";

const ACTION_RISK: Record<ApprovalAction, Risk> = {
  branch_create: "LOW",
  commit: "LOW",
  push: "MEDIUM",
  force_push: "HIGH",
  mr_create: "MEDIUM",
  jira_done: "HIGH",
};

function needsAsk(mode: ApprovalMode, risk: Risk): boolean {
  if (mode === "lenient") return risk === "HIGH";
  if (mode === "strict") return risk !== "LOW";
  // smart
  if (risk === "HIGH") return true;
  if (risk === "MEDIUM") return true;
  return false;
}

const APPROVAL_TTL_MS = 10 * 60 * 1000;

export function checkApproval(opts: {
  mode: ApprovalMode;
  action: ApprovalAction;
  approval_token?: string;
  ticket_number: string;
  workspace_id?: string;
  repoRoot?: string;
}): { approved: true } | { approved: false; prompt: string; approval_token: string } {
  const risk = ACTION_RISK[opts.action];
  if (!needsAsk(opts.mode, risk)) return { approved: true };

  const provided = opts.approval_token?.trim();
  if (provided && validateApprovalToken(provided, opts.action, opts.repoRoot)) {
    return { approved: true };
  }

  // Issue a fresh, time-bound token the human must explicitly relay back.
  const token = issueApprovalToken(opts.action, opts.ticket_number, opts.repoRoot);
  return {
    approved: false,
    prompt: `Approval required for ${opts.action} (${risk} risk, mode=${opts.mode}). Confirm with the developer, then re-call with approval_token. Token expires in 10 minutes.`,
    approval_token: token,
  };
}

export function issueApprovalToken(
  action: ApprovalAction,
  ticket: string,
  repoRoot?: string,
): string {
  const token = randomUUID();
  if (repoRoot) {
    const state = loadState(repoRoot);
    const now = Date.now();
    saveState(repoRoot, {
      ...(state ?? initState(ticket)),
      ticket_number: state?.ticket_number ?? ticket,
      pending_approval: {
        token,
        action,
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
      },
    });
  }
  return token;
}

export function validateApprovalToken(
  token: string,
  action: ApprovalAction,
  repoRoot?: string,
): boolean {
  if (!repoRoot) return false;
  const state = loadState(repoRoot);
  const pending = state?.pending_approval;
  if (!pending) return false;
  if (pending.token !== token) return false;
  if (pending.action !== action) return false;
  if (new Date(pending.expires_at).getTime() < Date.now()) return false;
  return true;
}
