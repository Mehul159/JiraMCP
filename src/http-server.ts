import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  hostedDefaultJiraSiteUrl,
  resolveHostedJiraConfig,
} from "./jira-client.js";
import { deviceStoreDir, getDeviceCredential } from "./device-store.js";
import { InMemoryEventStore } from "./in-memory-event-store.js";
import { withJiraRequestContext } from "./request-context.js";
import { createJiraMcpServer } from "./server-core.js";
import { mountSetupRoutes } from "./setup-ui.js";

function trimOrigin(url: string | undefined): string | undefined {
  const t = url?.trim().replace(/\/+$/, "");
  return t || undefined;
}

/** User override, then Render’s public URL, then local dev default. */
function resolvedPublicOrigin(listenPort: number): string {
  return (
    trimOrigin(process.env.MCP_PUBLIC_ORIGIN) ||
    trimOrigin(process.env.RENDER_EXTERNAL_URL) ||
    `http://127.0.0.1:${listenPort}`
  );
}

const port = parseInt(
  process.env.PORT ?? process.env.MCP_HTTP_PORT ?? "3333",
  10,
);
const bindHost = process.env.MCP_HTTP_HOST ?? "0.0.0.0";
const defaultSiteUrl = hostedDefaultJiraSiteUrl();
const deviceDir = deviceStoreDir();

const publicOrigin = resolvedPublicOrigin(port);

function validateProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.SKIP_PRODUCTION_CONFIG_VALIDATION === "true") return;
  const errs: string[] = [];
  if (!hostedDefaultJiraSiteUrl()) {
    errs.push(
      "DEFAULT_JIRA_BASE_URL or JIRA_BASE_URL must be set in production.",
    );
  }
  if (!process.env.MCP_SETUP_SECRET?.trim()) {
    errs.push("MCP_SETUP_SECRET must be set in production.");
  }
  const pub =
    trimOrigin(process.env.MCP_PUBLIC_ORIGIN) ||
    trimOrigin(process.env.RENDER_EXTERNAL_URL);
  if (!pub) {
    errs.push(
      "Set MCP_PUBLIC_ORIGIN to your public https URL, or deploy on Render so RENDER_EXTERNAL_URL is set.",
    );
  } else if (!pub.startsWith("https://")) {
    errs.push(
      "Public URL must use https:// in production (MCP_PUBLIC_ORIGIN or RENDER_EXTERNAL_URL), unless SKIP_PRODUCTION_CONFIG_VALIDATION=true.",
    );
  }
  if (errs.length) {
    for (const e of errs) console.error("[jira-mcp]", e);
    process.exit(1);
  }
}

validateProductionConfig();

const allowedHostsList =
  process.env.MCP_ALLOWED_HOSTS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];

const expressOpts =
  bindHost === "127.0.0.1" || bindHost === "localhost"
    ? { host: bindHost as "127.0.0.1" | "localhost" }
    : {
        host: bindHost,
        ...(allowedHostsList.length > 0
          ? { allowedHosts: allowedHostsList }
          : {}),
      };

const app = createMcpExpressApp(expressOpts);

mountSetupRoutes(app, publicOrigin);

type TransportRecord = {
  transport: StreamableHTTPServerTransport;
};

const transports: Record<string, TransportRecord> = {};

function jiraFromRequest(req: Request) {
  return resolveHostedJiraConfig(
    req.headers,
    defaultSiteUrl || undefined,
    (tok) => getDeviceCredential(deviceDir, tok),
  );
}

function authError(res: Response) {
  res.status(401).json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message:
        "Missing or invalid auth. Option A: complete /setup once and send header X-Jira-Mcp-Device-Token (Bearer also works) with env JIRA_MCP_DEVICE_TOKEN on this PC. Option B: send X-Jira-Email + X-Jira-Api-Token. Server must set DEFAULT_JIRA_BASE_URL for device tokens.",
    },
    id: null,
  });
}

function sessionHeader(req: Request): string | undefined {
  const h = req.headers["mcp-session-id"];
  if (typeof h === "string") return h;
  if (Array.isArray(h)) return h[0];
  return undefined;
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "jira-mcp" });
});

const mcpPostHandler = async (req: Request, res: Response) => {
  const cfg = jiraFromRequest(req);
  if (!cfg) {
    authError(res);
    return;
  }

  const sessionId = sessionHeader(req);

  try {
    await withJiraRequestContext(cfg, async () => {
      if (sessionId && transports[sessionId]) {
        const { transport } = transports[sessionId];
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const eventStore = new InMemoryEventStore();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          eventStore,
          onsessioninitialized: (sid) => {
            transports[sid] = { transport };
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
        };

        const server = createJiraMcpServer();
        await server.connect(transport);

        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "Bad Request: missing mcp-session-id or invalid session (initialize again)",
        },
        id: null,
      });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
};

const mcpGetHandler = async (req: Request, res: Response) => {
  const cfg = jiraFromRequest(req);
  if (!cfg) {
    authError(res);
    return;
  }

  const sessionId = sessionHeader(req);
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  await withJiraRequestContext(cfg, async () => {
    await transports[sessionId].transport.handleRequest(req, res);
  });
};

const mcpDeleteHandler = async (req: Request, res: Response) => {
  const cfg = jiraFromRequest(req);
  if (!cfg) {
    authError(res);
    return;
  }

  const sessionId = sessionHeader(req);
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  await withJiraRequestContext(cfg, async () => {
    await transports[sessionId].transport.handleRequest(req, res);
  });
};

app.post("/mcp", mcpPostHandler);
app.get("/mcp", mcpGetHandler);
app.delete("/mcp", mcpDeleteHandler);

app.listen(port, bindHost, () => {
  console.info(`jira-mcp MCP endpoint ${publicOrigin}/mcp`);
  console.info(`One-time device linking UI ${publicOrigin}/setup`);
  if (!defaultSiteUrl) {
    console.warn(
      "DEFAULT_JIRA_BASE_URL (or JIRA_BASE_URL) not set — device tokens + header auth need a default site URL.",
    );
  }
});
