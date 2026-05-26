import type { IncomingHttpHeaders } from "node:http";
import type { StoredDeviceCredential } from "../device-store.js";
import {
  jiraConfigFromHttpHeaders,
  normalizeBaseUrl,
  type JiraConfig,
} from "../jira-client.js";
import type { RequestContext } from "../request-context.js";
import type { GitCredentials } from "../jiraflow/mr.js";

function headerValue(
  headers: IncomingHttpHeaders,
  lowerName: string,
): string | undefined {
  const v = headers[lowerName];
  if (Array.isArray(v)) return v[0]?.trim();
  return typeof v === "string" ? v.trim() : undefined;
}

function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const auth = headerValue(headers, "authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) return undefined;
  return auth.slice(7).trim();
}

export function resolveHostedRequestContext(
  headers: IncomingHttpHeaders,
  defaultSiteUrl: string | undefined,
  lookupDevice: (token: string) => StoredDeviceCredential | null,
): RequestContext | null {
  const deviceTok =
    headerValue(headers, "x-jira-mcp-device-token") || bearerToken(headers);
  if (deviceTok) {
    const row = lookupDevice(deviceTok);
    if (!row) return null;
    const baseUrlRaw =
      defaultSiteUrl?.trim() ||
      process.env.DEFAULT_JIRA_BASE_URL?.trim() ||
      process.env.JIRA_BASE_URL?.trim() ||
      "";
    if (!baseUrlRaw) return null;
    const jira: JiraConfig = {
      baseUrl: normalizeBaseUrl(baseUrlRaw),
      email: row.email,
      apiToken: row.apiToken,
    };
    const git: GitCredentials = {
      github_token: row.github_token,
      gitlab_token: row.gitlab_token,
    };
    return { jira, git, deviceId: deviceTok.slice(0, 8) + "…" };
  }

  const jira = jiraConfigFromHttpHeaders(headers, defaultSiteUrl);
  if (!jira) return null;
  return { jira };
}
