import { createHash } from "node:crypto";
import type { ApprovalMode } from "./config.js";

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

export function checkApproval(opts: {
  mode: ApprovalMode;
  action: ApprovalAction;
  approval_token?: string;
  ticket_number: string;
  workspace_id?: string;
}): { approved: true } | { approved: false; prompt: string; approval_token: string } {
  const risk = ACTION_RISK[opts.action];
  if (!needsAsk(opts.mode, risk)) return { approved: true };

  const expected = mintApprovalToken(opts.action, opts.ticket_number, opts.workspace_id);
  if (opts.approval_token?.trim() === expected) return { approved: true };

  return {
    approved: false,
    prompt: `Approval required for ${opts.action} (${risk} risk, mode=${opts.mode}). Confirm with the user, then re-call with approval_token.`,
    approval_token: expected,
  };
}

export function mintApprovalToken(
  action: ApprovalAction,
  ticket: string,
  workspace_id?: string,
): string {
  const payload = `${action}:${ticket}:${workspace_id ?? ""}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
