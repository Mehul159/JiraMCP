import simpleGit, { type SimpleGit } from "simple-git";
import { auditLog } from "./audit.js";
import { branchNameFromPattern, type JiraflowRepoConfig } from "./config.js";
import type { TicketIntelligence } from "./intelligence.js";
import { fieldFromIssue } from "./intelligence.js";

export function gitClient(repoRoot: string): SimpleGit {
  return simpleGit(repoRoot);
}

export async function workspaceSetup(opts: {
  repoRoot: string;
  config: JiraflowRepoConfig;
  intelligence: TicketIntelligence;
}): Promise<{ parent_branch: string }> {
  const git = gitClient(opts.repoRoot);
  await git.fetch();
  const parentFromJira = fieldFromIssue(
    opts.intelligence.issue,
    opts.config.jira.parent_branch_field,
  );
  const parent =
    parentFromJira?.trim() ||
    opts.config.git.default_base_branch ||
    "main";
  await git.checkout(parent);
  try {
    await git.pull("origin", parent);
  } catch {
    /* pull optional */
  }
  auditLog("workspace_setup", {
    repo: opts.repoRoot,
    parent_branch: parent,
  });
  return { parent_branch: parent };
}

export async function createFeatureBranch(opts: {
  repoRoot: string;
  config: JiraflowRepoConfig;
  intelligence: TicketIntelligence;
}): Promise<{ branch: string }> {
  const key = opts.intelligence.issue.key ?? "TICKET";
  const branch = branchNameFromPattern(
    opts.config.git.branching.feature_pattern,
    key,
    opts.intelligence.summary,
    opts.intelligence.issue_type,
  );
  const git = gitClient(opts.repoRoot);
  await git.checkoutLocalBranch(branch);
  auditLog("create_feature_branch", { repo: opts.repoRoot, branch });
  return { branch };
}

function buildCommitMessage(
  key: string,
  summary: string,
  issueType: string,
  message_override?: string,
): string {
  if (message_override?.trim()) return message_override.trim();

  const typeMap: Record<string, string> = {
    bug: "fix",
    story: "feat",
    task: "chore",
    epic: "feat",
    improvement: "refactor",
    subtask: "chore",
  };
  const prefix = typeMap[issueType.toLowerCase()] ?? "chore";
  const slug = summary.slice(0, 72 - key.length - prefix.length - 5).trim();
  return `${prefix}: ${slug}\n\nJira: ${key}`;
}

export async function commitWithContext(opts: {
  repoRoot: string;
  intelligence: TicketIntelligence;
  message_override?: string;
}): Promise<{ commit_message: string; committed: boolean }> {
  const git = gitClient(opts.repoRoot);
  const status = await git.status();
  const key = opts.intelligence.issue.key ?? "TICKET";
  const commit_message = buildCommitMessage(
    key,
    opts.intelligence.summary,
    opts.intelligence.issue_type,
    opts.message_override,
  );

  if (status.files.length === 0) {
    return { commit_message, committed: false };
  }

  await git.add(status.files.map((f) => f.path).filter(Boolean) as string[]);
  await git.commit(commit_message);
  auditLog("commit_with_context", { repo: opts.repoRoot, key });
  return { commit_message, committed: true };
}

export async function pushBranch(repoRoot: string, branch: string): Promise<void> {
  const git = gitClient(repoRoot);
  await git.push("origin", branch, ["--set-upstream"]);
  auditLog("push", { repo: repoRoot, branch });
}

export async function currentBranch(repoRoot: string): Promise<string> {
  const git = gitClient(repoRoot);
  const s = await git.status();
  return s.current ?? "HEAD";
}

export async function parseRemote(repoRoot: string): Promise<{
  provider: "github" | "gitlab";
  owner: string;
  repo: string;
} | null> {
  const git = gitClient(repoRoot);
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");
  const url = origin?.refs?.fetch ?? origin?.refs?.push ?? "";
  const gh = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
  if (gh) return { provider: "github", owner: gh[1], repo: gh[2].replace(/\.git$/, "") };
  const gl = url.match(/gitlab\.com[:/](.+)\/([^/.]+)/i);
  if (gl) return { provider: "gitlab", owner: gl[1], repo: gl[2].replace(/\.git$/, "") };
  return null;
}
