import type { Express, Request, Response } from "express";
import express from "express";
import {
  deviceStoreDir,
  registerDevice,
  revokeDevice,
} from "./device-store.js";
import { hostedDefaultJiraSiteUrl } from "./jira-client.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setupSecretFromRequest(req: Request): string {
  const bodyVal =
    typeof req.body?.setup_secret === "string" ? req.body.setup_secret : "";
  const h = req.headers["x-setup-secret"];
  const headerVal =
    typeof h === "string" ? h : Array.isArray(h) ? (h[0] ?? "") : "";
  return (bodyVal || headerVal).trim();
}

function requireSetupSecret(req: Request, res: Response): boolean {
  const expected = process.env.MCP_SETUP_SECRET?.trim();
  if (!expected) return true;
  if (setupSecretFromRequest(req) !== expected) {
    res.status(403).send("Invalid setup secret.");
    return false;
  }
  return true;
}

/** Avoid breaking out of <textarea> if token ever contained < */
function safeTextareaBody(s: string): string {
  return s.replace(/</g, "&lt;");
}

export function mountSetupRoutes(app: Express, serverPublicOrigin: string) {
  const siteUrl = hostedDefaultJiraSiteUrl();
  const storeDir = deviceStoreDir();
  const formRouter = express.Router();
  formRouter.use(express.urlencoded({ extended: false }));

  const publicOrigin = serverPublicOrigin.replace(/\/+$/, "");

  formRouter.get("/setup", (_req: Request, res: Response) => {
    const needSecret = Boolean(process.env.MCP_SETUP_SECRET?.trim());
    res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width"/>
<title>Jira MCP — link this machine</title>
<style>
body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.45}
input{width:100%;padding:.5rem;margin:.35rem 0 1rem;box-sizing:border-box}
button{padding:.55rem 1rem;margin-top:.5rem}
.small{font-size:.9rem;color:#444}.warn{border-left:4px solid #c90;padding:.75rem;background:#fff8e8;margin:1rem 0}
code{background:#f3f3f3;padding:.15rem .35rem}
</style></head><body>
<h1>Link your machine to Jira MCP</h1>
<p class="small">One-time step per <strong>profile on this computer</strong>. The next page lists ways to finish in Cursor — including <strong>no Windows Environment Variables</strong> if your org locks those.</p>
${siteUrl ? `<p>Jira site (admin): <code>${escapeHtml(siteUrl)}</code></p>` : `<p class="warn">Admin must set <code>DEFAULT_JIRA_BASE_URL</code> on the server.</p>`}
${needSecret ? `<p class="small">You need the team <strong>setup secret</strong> once.</p>` : `<p class="warn">Anyone can register — set <code>MCP_SETUP_SECRET</code> in production.</p>`}
<form method="post" action="/setup/register">
<label>Atlassian email<input type="email" name="email" required autocomplete="username"/></label>
<label>API token <span class="small">(<a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener">create</a>)</span><input type="password" name="api_token" required autocomplete="current-password"/></label>
${needSecret ? `<label>Setup secret<input type="password" name="setup_secret" required autocomplete="off"/></label>` : ""}
<button type="submit">Create device token</button>
</form>
<p class="small"><strong>Isolation:</strong> Keep the token on <em>your</em> machine only (OS env per login, or Cursor <strong>User</strong> MCP settings — see success page). Different OS logins → different tokens.</p>
</body></html>`);
  });

  formRouter.post("/setup/register", async (req: Request, res: Response) => {
    if (!requireSetupSecret(req, res)) return;
    if (!siteUrl) {
      res
        .status(503)
        .send("Server missing DEFAULT_JIRA_BASE_URL / JIRA_BASE_URL.");
      return;
    }
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const apiToken =
      typeof req.body?.api_token === "string" ? req.body.api_token.trim() : "";
    if (!email || !apiToken || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).send("Invalid email or token.");
      return;
    }
    let token: string;
    try {
      token = await registerDevice(storeDir, email, apiToken);
    } catch (e) {
      console.error(e);
      res.status(500).send("Could not save device binding.");
      return;
    }

    const cursorSnippet = JSON.stringify(
      {
        mcpServers: {
          jira: {
            url: `${publicOrigin}/mcp`,
            headers: {
              "X-Jira-Mcp-Device-Token": "${env:JIRA_MCP_DEVICE_TOKEN}",
            },
          },
        },
      },
      null,
      2,
    );

    const cursorSnippetDirect = JSON.stringify(
      {
        mcpServers: {
          jira: {
            url: `${publicOrigin}/mcp`,
            headers: {
              "X-Jira-Mcp-Device-Token": token,
            },
          },
        },
      },
      null,
      2,
    );

    res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Device linked</title>
<style>
body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}
textarea{width:100%;min-height:12rem;font-family:monospace;font-size:.85rem}
code{background:#eee;padding:.12rem .35rem}.ok{border-left:4px solid #080;padding:.75rem;background:#f0fff4;margin:1rem 0}
.tip{border-left:4px solid #08c;padding:.75rem;background:#f0f8ff;margin:1rem 0;font-size:.95rem;line-height:1.45}
button{padding:.45rem .85rem;margin:.35rem .35rem 0 0}
.small{font-size:.9rem;color:#444}
</style></head><body>
<h1>Copy these on this PC only</h1>
<p class="ok"><strong>Device token</strong></p>
<p><textarea readonly id="tok">${safeTextareaBody(token)}</textarea></p>
<p><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('tok').value)">Copy token</button></p>

<h2>1. Easiest: Cursor only (no OS environment variables)</h2>
<p>If company policy blocks editing user/system environment variables, skip PowerShell <code>setx</code> / System Properties entirely.</p>
<ol>
<li>In Cursor: <strong>Settings</strong> → search <strong>MCP</strong> → open the MCP configuration editor.</li>
<li>Paste the JSON below (or set URL <code>${escapeHtml(publicOrigin)}/mcp</code> and header <code>X-Jira-Mcp-Device-Token</code> to your token).</li>
<li>Prefer <strong>User</strong> scope / global MCP settings so the token is not committed inside this repo’s <code>.cursor/mcp.json</code>.</li>
<li>Restart Cursor if it does not pick up changes.</li>
</ol>
<p><textarea readonly>${safeTextareaBody(cursorSnippetDirect)}</textarea></p>
<p class="tip"><strong>Safety:</strong> Anyone who can read your MCP config can use this token for Jira via this server. Turn off Settings Sync for MCP if you worry about cloud copies, or revoke the token after laptop loss (<code>/setup/revoke</code> with the setup secret).</p>

<h2>2. Teams: OS env var + identical JSON on every PC</h2>
<p><strong>Windows</strong> PowerShell (User scope):</p>
<pre><code>[Environment]::SetEnvironmentVariable("JIRA_MCP_DEVICE_TOKEN", "${safeTextareaBody(token)}", "User")</code></pre>
<p>Fully quit and reopen Cursor.</p>
<p><strong>macOS / Linux:</strong> add <code>export JIRA_MCP_DEVICE_TOKEN="…"</code> to your shell profile, then reopen Cursor.</p>
<p>Then use this MCP snippet (same file for everyone — only the OS env value differs per login):</p>
<p><textarea readonly>${safeTextareaBody(cursorSnippet)}</textarea></p>
<p class="small">Cursor expands <code>\${env:JIRA_MCP_DEVICE_TOKEN}</code> from <strong>this machine’s</strong> environment.</p>

<p><a href="/setup">Link another device</a></p>
</body></html>`);
  });

  formRouter.post("/setup/revoke", async (req: Request, res: Response) => {
    if (!requireSetupSecret(req, res)) return;
    const tok =
      typeof req.body?.device_token === "string"
        ? req.body.device_token.trim()
        : "";
    if (!tok) {
      res.status(400).send("Missing device_token.");
      return;
    }
    const ok = await revokeDevice(storeDir, tok);
    res.status(ok ? 200 : 404).send(ok ? "Revoked." : "Unknown token.");
  });

  app.use(formRouter);
}
