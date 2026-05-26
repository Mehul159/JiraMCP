import type { IncomingHttpHeaders } from "node:http";

export type JiraConfig = {
  baseUrl: string;
  email: string;
  apiToken: string;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function authHeader(cfg: JiraConfig): string {
  const token = Buffer.from(`${cfg.email}:${cfg.apiToken}`, "utf8").toString(
    "base64",
  );
  return `Basic ${token}`;
}

export async function jiraFetch<T>(
  cfg: JiraConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${normalizeBaseUrl(cfg.baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authHeader(cfg),
      ...init?.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text) as { errorMessages?: string[]; message?: string };
      detail = j.errorMessages?.join("; ") ?? j.message ?? text;
    } catch {
      /* keep text */
    }
    throw new Error(`Jira ${res.status}: ${detail}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export function loadJiraConfigFromEnv(): JiraConfig {
  const baseUrl =
    process.env.JIRA_BASE_URL?.trim() ||
    process.env.JIRA_HOST?.trim() ||
    "";
  const email = process.env.JIRA_EMAIL?.trim() || "";
  const apiToken =
    process.env.JIRA_API_TOKEN?.trim() ||
    process.env.JIRA_TOKEN?.trim() ||
    "";
  if (!baseUrl || !email || !apiToken) {
    throw new Error(
      "Missing Jira env: set JIRA_BASE_URL (or JIRA_HOST), JIRA_EMAIL, JIRA_API_TOKEN",
    );
  }
  return { baseUrl, email, apiToken };
}

function headerValue(
  headers: IncomingHttpHeaders,
  lowerName: string,
): string | undefined {
  const v = headers[lowerName];
  if (Array.isArray(v)) return v[0]?.trim();
  return typeof v === "string" ? v.trim() : undefined;
}

/**
 * Hosted MCP: read credentials from HTTP headers on each request.
 * Headers: X-Jira-Email, X-Jira-Api-Token, optional X-Jira-Base-Url.
 * If base URL is omitted, uses defaultSiteUrl (from env on the server).
 */
export function jiraConfigFromHttpHeaders(
  headers: IncomingHttpHeaders,
  defaultSiteUrl?: string,
): JiraConfig | null {
  const email = headerValue(headers, "x-jira-email");
  const apiToken = headerValue(headers, "x-jira-api-token");
  const headerBase = headerValue(headers, "x-jira-base-url");
  const baseUrlRaw =
    headerBase ||
    defaultSiteUrl?.trim() ||
    process.env.DEFAULT_JIRA_BASE_URL?.trim() ||
    process.env.JIRA_BASE_URL?.trim() ||
    "";
  if (!email || !apiToken || !baseUrlRaw) {
    return null;
  }
  return {
    baseUrl: normalizeBaseUrl(baseUrlRaw),
    email,
    apiToken,
  };
}

/**
 * Prefer device token from one-time /setup (shared Cursor config + per-PC env).
 * Fallback: X-Jira-Email + X-Jira-Api-Token headers.
 */
export function resolveHostedJiraConfig(
  headers: IncomingHttpHeaders,
  defaultSiteUrl: string | undefined,
  lookupDevice: (
    token: string,
  ) => { email: string; apiToken: string } | null,
): JiraConfig | null {
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
    return {
      baseUrl: normalizeBaseUrl(baseUrlRaw),
      email: row.email,
      apiToken: row.apiToken,
    };
  }
  return jiraConfigFromHttpHeaders(headers, defaultSiteUrl);
}

function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const auth = headerValue(headers, "authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) return undefined;
  return auth.slice(7).trim();
}

/** Site URL your team shares when everyone uses the same Jira Cloud instance. */
export function hostedDefaultJiraSiteUrl(): string {
  return (
    process.env.DEFAULT_JIRA_BASE_URL?.trim() ||
    process.env.JIRA_BASE_URL?.trim() ||
    ""
  );
}
