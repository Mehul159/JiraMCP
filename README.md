# Jira MCP for Cursor

This folder is a **Model Context Protocol (MCP)** server that talks to **Jira Cloud** over the REST API. Cursor can call its tools when you work on a ticket (for example `PROJ-123`), so the agent sees the same description, status, links, subtasks, changelog, and comments as in Jira.

**Production deploy:** see **[DEPLOY.md](DEPLOY.md)** (Fly.io, Render [`render.yaml`](render.yaml), Railway, Docker Compose).

This repo supports two ways to run the same tools:

| Mode | Who configures Jira | Typical use |
|------|---------------------|-------------|
| **stdio** (`npm start`) | Server process env (`.env`) | Solo dev, repo-local MCP |
| **HTTP** (`npm run start:http`) | **Device token** from `/setup` (recommended) or email+token headers | **Teams**, shared Cursor seats |

## Hosted HTTP server (team)

Deploy `npm run start:http` (or Docker) behind **HTTPS**.

### Recommended: `/setup` + device token (shared Cursor login, per-machine Jira)

1. Ops sets **`DEFAULT_JIRA_BASE_URL`**, **`MCP_PUBLIC_ORIGIN`** (e.g. `https://jira-mcp.company.com`), and **`MCP_SETUP_SECRET`** (protects registration).
2. Each teammate opens **your public origin + `/setup`** (e.g. `https://jira-mcp.company.com/setup`), enters **their** Atlassian email + API token once.
3. The success page gives a **device token**. Configure Cursor using **either** path:
   - **Easiest when OS env vars are locked:** paste the generated MCP JSON into Cursor **Settings → MCP** (User scope). The token lives only in Cursor config — no Windows Environment Variables dialog.
   - **Teams / shared JSON:** set OS **user** env **`JIRA_MCP_DEVICE_TOKEN`** (PowerShell snippet on the success page), restart Cursor, and use the snippet with **`${env:JIRA_MCP_DEVICE_TOKEN}`**.
4. **Everyone can share identical MCP JSON** only if you use the env-var path — otherwise each developer keeps their own pasted-token config:

```json
{
  "mcpServers": {
    "jira": {
      "url": "https://jira-mcp.yourcompany.com/mcp",
      "headers": {
        "X-Jira-Mcp-Device-Token": "${env:JIRA_MCP_DEVICE_TOKEN}"
      }
    }
  }
}
```

**Isolation:** With **`${env:...}`**, Cursor reads each PC’s OS user environment. With **pasted token**, keep MCP config in **User** settings so it is not committed to git ([`.cursor/mcp.hosted.pasted-token.example.json`](.cursor/mcp.hosted.pasted-token.example.json)).

Device mappings live on the server in **`MCP_DATA_DIR`** (default `./data/devices.json`). Env-based example: [`.cursor/mcp.hosted.example.json`](.cursor/mcp.hosted.example.json).

### Alternative: email + token headers (no `/setup`)

Send **`X-Jira-Email`** and **`X-Jira-Api-Token`** per user ([tokens](https://id.atlassian.com/manage-profile/security/api-tokens)). Optional **`X-Jira-Base-Url`** if the server has no default site.

### Host environment (ops)

| Env | Purpose |
|-----|---------|
| `DEFAULT_JIRA_BASE_URL` / `JIRA_BASE_URL` | Shared Jira site (needed for device tokens) |
| `MCP_PUBLIC_ORIGIN` | Public URL used in `/setup` docs (default `http://127.0.0.1:PORT`) |
| `MCP_SETUP_SECRET` | Required on `/setup` registration when set |
| `MCP_DATA_DIR` | Storage dir for `devices.json` |
| `PORT` / `MCP_HTTP_PORT` | Port (default **3333**) |
| `MCP_HTTP_HOST` | Bind (default **0.0.0.0**) |
| `MCP_ALLOWED_HOSTS` | Allowed `Host` headers when public |

**`GET /health`** · **`GET /setup`** · **`POST /setup/register`** · **`POST /setup/revoke`** (revoke + setup secret)

```bash
docker build -t jira-mcp .
docker run \
  -e NODE_ENV=production \
  -e DEFAULT_JIRA_BASE_URL=https://your-site.atlassian.net \
  -e MCP_PUBLIC_ORIGIN=https://jira-mcp.example.com \
  -e MCP_SETUP_SECRET=your-secret \
  -v jira-mcp-data:/app/data \
  -p 3333:3333 \
  jira-mcp
```

**Security:** HTTPS, firewall, **`MCP_SETUP_SECRET`**, and locking down **`data/devices.json`**. Device tokens are bearer-equivalent for Jira via this gateway.

## How stdio “always running” works

With **stdio**, Cursor **starts** `node dist/index.js` when it connects and keeps it for that session.

With **HTTP**, Cursor opens a **remote** MCP session to your URL; no local Node required per developer.

## One-time setup (local stdio)

1. **Jira API token** (Cloud): [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) — create a token for your Atlassian account.

2. **Credentials in `.env`** at the project root (this file is gitignored). Copy `.env.example` to `.env` and set:

   - `JIRA_BASE_URL` — site root, e.g. `https://your-company.atlassian.net` (no trailing slash)
   - `JIRA_EMAIL` — the Atlassian account email used for the token
   - `JIRA_API_TOKEN` — the token string

   `.cursor/mcp.json` uses **`envFile`** so Cursor injects these into the server process. If you prefer system-wide variables instead, you can change `mcp.json` to use `"env": { "JIRA_BASE_URL": "${env:JIRA_BASE_URL}", ... }` and remove `envFile`.

   On Windows you can also use `setx` for user env vars and point `mcp.json` at `${env:...}` as above.

3. **Build the server** (from this directory):

   ```bash
   npm install
   npm run build
   ```

4. **Enable the MCP server in Cursor** — this repo already includes `.cursor/mcp.json`. Open **Cursor Settings → MCP** and confirm **jira** is enabled (green if healthy).

## Plan → approve → build → PR (ticket-led workflow)

**Cursor limitation:** MCP cannot toggle **Plan** vs **Agent** mode or click **Create PR** in the browser — you run git / `gh` (or your host’s flow).

### One-liner behaviors

| You type | What happens |
|----------|----------------|
| **`KAN-3`** only | Loads ticket via **`jira_ticket_plan_then_build`** (standard mode): **plan → you approve → implement → PR checklist** (branch, commits, push, `gh pr create` template). |
| **`KAN-3 fast`** / **`KAN-3 ship`** / **`KAN-3 implement`** | Same tool with **`delivery_mode`: `"fast"`**: short bullet plan, then **implement in one turn**, then PR-ready steps. Skip only if the ticket is ambiguous (agent asks one question). |
| Search first | Use **`jira_search`** with JQL; then open a key with **`jira_ticket_plan_then_build`** or **`jira_get_issue_context`**. |

Copy **`.cursor/rules/jira-plan-then-build.mdc`** into **application repos** where you implement work (and enable the **jira** MCP there too).

**MCP prompt:** **`jira_plan_then_build`** — optional; pass `issue_key` and optionally **`delivery_mode`** (`standard` \| `fast`).

## JiraFlow (v2)

Deterministic **ticket → context → git → MR** orchestration. All JiraFlow tools return JSON: `{ "success", "message", "data" }`.

**Workflow:** `jira_start_ticket` → `prepare_cursor_context` → `workspace_setup` → `create_feature_branch` → (code) → `validate_changes` → `commit_with_context` → `create_merge_request`

| Tool | Use |
|------|-----|
| `jira_start_ticket` | Load ticket intelligence, init `.jiraflow/state.json` |
| `prepare_cursor_context` | High-signal markdown + `files_to_read` from repo grep |
| `generate_implementation_plan` | Structured plan markdown |
| `workspace_setup` | Checkout parent/base branch |
| `create_feature_branch` | Branch from `.jiraflow.yaml` pattern |
| `commit_with_context` | Ticket-aware commit message |
| `validate_changes` | Run `workflow.validate_scripts` |
| `create_merge_request` | GitHub PR / GitLab MR |
| `jiraflow_workspace_status` | List hosted workspaces + state |

Copy [`.jiraflow.yaml.example`](.jiraflow.yaml.example) to app repos as `.jiraflow.yaml`. Hosted: set `JIRAFLOW_WORKSPACE_ROOT`, clone repos, copy [`workspaces.yaml.example`](workspaces.yaml.example) to `workspaces.yaml`. Optional GitHub/GitLab tokens via `/setup` or env.

Design: [`docs/superpowers/specs/2026-05-27-jiraflow-design.md`](docs/superpowers/specs/2026-05-27-jiraflow-design.md)

## Tools you get (Jira read)

| Tool | Use |
|------|-----|
| `jira_ticket_plan_then_build` | Legacy playbook + JSON (prefer `jira_start_ticket`) |
| `jira_get_issue_context` | Full issue + related keys + comments (no playbook text) |
| `jira_get_issue` | Single issue JSON; optional `fields` and `expand` |
| `jira_search` | JQL search (up to 50 hits) |
| `jira_get_comments` | All comments (paginated) |
| `jira_get_transitions` | Workflow transitions for the issue |

## Resource

- `jira://issue/PROJ-123` — same payload shape as a rich issue fetch (for clients that read MCP resources).

## Using it in chat

- **`KAN-3`** — agent calls **`jira_start_ticket`** (or legacy **`jira_ticket_plan_then_build`**), plans without edits, asks approval, then implements with PR-ready finish.
- **`KAN-3 fast`** or **`KAN-3 ship`** — same tool with **`delivery_mode`: `"fast"`** for fewer round-trips (use **Agent** mode for edits).
- **Ad hoc:** *“Summarize **ABC-42**.”* — **`jira_get_issue_context`** is fine.

Optional MCP prompt **`jira_plan_then_build`** (with argument `issue_key` and optional `delivery_mode`) injects the phased instructions explicitly.

## Jira Server / Data Center

This build targets **Jira Cloud** (Basic auth with email + API token). On-prem setups differ (PAT, cookies, base path); those would need small auth and URL changes.
