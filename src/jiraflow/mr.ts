import { currentBranch, parseRemote, pushBranch } from "./git.js";
import type { TicketIntelligence } from "./intelligence.js";

export type GitCredentials = {
  github_token?: string;
  gitlab_token?: string;
};

export async function createMergeRequest(opts: {
  repoRoot: string;
  intelligence: TicketIntelligence;
  parent_branch: string;
  creds: GitCredentials;
  jira_base_url?: string;
}): Promise<{ url: string; provider: string }> {
  const remote = await parseRemote(opts.repoRoot);
  if (!remote) {
    throw new Error("Could not parse origin remote for GitHub/GitLab.");
  }

  const branch = await currentBranch(opts.repoRoot);
  await pushBranch(opts.repoRoot, branch);

  const key = opts.intelligence.issue.key ?? "TICKET";
  const title = `${key}: ${opts.intelligence.summary}`;
  const jiraLink = opts.jira_base_url
    ? `${opts.jira_base_url.replace(/\/+$/, "")}/browse/${key}`
    : key;
  const body = [
    "## Summary",
    opts.intelligence.summary,
    "",
    "## Jira",
    jiraLink,
    "",
    "## Test plan",
    "- [ ] Verify acceptance criteria",
    "- [ ] CI green",
  ].join("\n");

  if (remote.provider === "github") {
    const token = opts.creds.github_token;
    if (!token) throw new Error("GitHub token required (device setup or GITHUB_TOKEN env).");
    const res = await fetch(
      `https://api.github.com/repos/${remote.owner}/${remote.repo}/pulls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          head: branch,
          base: opts.parent_branch,
          body,
        }),
      },
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub PR failed ${res.status}: ${text}`);
    const data = JSON.parse(text) as { html_url: string };
    return { url: data.html_url, provider: "github" };
  }

  const token = opts.creds.gitlab_token;
  if (!token) throw new Error("GitLab token required (device setup or GITLAB_TOKEN env).");
  const projectPath = encodeURIComponent(`${remote.owner}/${remote.repo}`);
  const res = await fetch(
    `https://gitlab.com/api/v4/projects/${projectPath}/merge_requests`,
    {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        source_branch: branch,
        target_branch: opts.parent_branch,
        description: body,
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`GitLab MR failed ${res.status}: ${text}`);
  const data = JSON.parse(text) as { web_url: string };
  return { url: data.web_url, provider: "gitlab" };
}
