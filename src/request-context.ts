import { AsyncLocalStorage } from "node:async_hooks";
import type { JiraConfig } from "./jira-client.js";
import type { GitCredentials } from "./jiraflow/mr.js";

export type RequestContext = {
  jira: JiraConfig;
  git?: GitCredentials;
  deviceId?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export async function withRequestContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

/** @deprecated use withRequestContext */
export async function withJiraRequestContext<T>(
  cfg: JiraConfig,
  fn: () => Promise<T>,
): Promise<T> {
  return withRequestContext({ jira: cfg }, fn);
}

export function getRequestJiraConfig(): JiraConfig | undefined {
  return storage.getStore()?.jira;
}

export function getRequestGitCredentials(): GitCredentials {
  const store = storage.getStore();
  const fromCtx = store?.git ?? {};
  return {
    github_token:
      fromCtx.github_token?.trim() ||
      process.env.GITHUB_TOKEN?.trim() ||
      undefined,
    gitlab_token:
      fromCtx.gitlab_token?.trim() ||
      process.env.GITLAB_TOKEN?.trim() ||
      undefined,
  };
}

export function getRequestDeviceId(): string | undefined {
  return storage.getStore()?.deviceId;
}
