import { AsyncLocalStorage } from "node:async_hooks";
import type { JiraConfig } from "./jira-client.js";

type Store = { jira: JiraConfig };

const storage = new AsyncLocalStorage<Store>();

/** Run an async handler so tools resolve credentials from this HTTP request. */
export async function withJiraRequestContext<T>(
  cfg: JiraConfig,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ jira: cfg }, fn);
}

export function getRequestJiraConfig(): JiraConfig | undefined {
  return storage.getStore()?.jira;
}
