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

**Workflow:** `jira_start_ticket` → review plan → `approve_plan` → `workspace_setup` → `create_feature_branch` → (code) → `validate_changes` → `commit_with_context` → `create_merge_request` → `update_jira_status`

| Tool | Use |
|------|-----|
| `jira_start_ticket` | Load ticket intelligence, plan + context; init `.jiraflow/state.json`. Returns a plan you MUST review. Supports `context_mode` (`full`/`plan_only`/`context_only`/`minimal`) |
| `prepare_cursor_context` | Focused markdown + ranked `files_to_read` from parallel repo grep |
| `generate_implementation_plan` | Adaptive plan (per issue type + content) with `complexity_estimate` |
| `approve_plan` | Human gate — unlocks `workspace_setup` after the developer approves |
| `workspace_setup` | Checkout parent/base branch (blocked until plan approved) |
| `create_feature_branch` | Branch from `.jiraflow.yaml` pattern |
| `commit_with_context` | Conventional-commit message (`fix:`/`feat:` + `Jira: KEY`) |
| `validate_changes` | Run `workflow.validate_scripts` (warns if none configured) |
| `create_merge_request` | GitHub PR / GitLab MR with acceptance criteria + linked issues |
| `update_jira_status` | Transition the ticket — matches your project's live transitions by target status or transition name; terminal statuses (Closed/Rejected/Done) require approval |
| `prepare_test_authoring` | Turn a Jira number into a BDD/automation test pack — builds a ticket knowledge base, mines existing feature files / step definitions / locators, finds similar scenarios to reuse, derives prerequisite steps, and returns a ready-to-finalize Gherkin skeleton |
| `jiraflow_workspace_status` | List hosted workspaces + state |

Copy [`.jiraflow.yaml.example`](.jiraflow.yaml.example) to app repos as `.jiraflow.yaml`. Hosted: set `JIRAFLOW_WORKSPACE_ROOT`, clone repos, copy [`workspaces.yaml.example`](workspaces.yaml.example) to `workspaces.yaml`. Optional GitHub/GitLab tokens via `/setup` or env.

Design: [`docs/superpowers/specs/2026-05-27-jiraflow-design.md`](docs/superpowers/specs/2026-05-27-jiraflow-design.md)

### Using JiraFlow in Cursor

1. Open Cursor in your repo.
2. In the AI chat, say: **"start ticket PROJ-123"**.
3. JiraFlow loads the ticket, generates a plan, and shows you:
   - Summary, acceptance criteria, risks
   - Relevant files in your codebase
   - Step-by-step implementation plan + complexity estimate
4. **Review the plan.** Say **"looks good, proceed"** to approve it (`approve_plan`).
5. JiraFlow checks out the right base branch and creates your feature branch.
6. Code your changes. Say **"validate"** to run lint/tests.
7. Say **"commit"** → **"open PR"** → **"move to done"** to finish.

You never need to leave Cursor.

### The Context Engine

JiraFlow's context engine does three things Cursor can't do alone:

1. **Ticket intelligence** — fetches the full Jira ticket including linked issues, subtasks, and comments, converting Jira's ADF format (bullet lists, panels, code blocks, tables, headings) to clean readable text.
2. **Impact grep** — scans your codebase for files containing keywords from the ticket, running all keywords in parallel and ranking files by keyword-match frequency, so Cursor knows exactly which files are relevant before you open any.
3. **Media intelligence** — downloads attachments (screenshots, logs, text files) and analyzes them so visible UI labels, error messages, and on-screen state become part of the plan and context — *before* any code is written.
4. **Adaptive plan** — generates an implementation plan tailored to the issue type (bug vs story vs task), ticket content (migrations, API changes, UI work), and linked issues — not generic boilerplate.

This means Cursor gets a focused, high-signal context pack instead of exploring the codebase blindly.

#### Media intelligence (attachments)

`jira_start_ticket`, `prepare_cursor_context`, `generate_implementation_plan`, and `prepare_test_authoring` can read the ticket's attachments and fold them into the context:

- **Images** (PNG/JPG/GIF/WebP) → analyzed with a vision model into concise, engineer-focused notes (UI elements, verbatim error messages, screen/state).
- **Text/logs** (`.txt/.log/.csv/.json/.xml/...`) → extracted inline.
- Other types (PDF, video, office, archives) are listed with a skip reason.

**Opt-in by design.** Media analysis is **OFF by default** because each analyzed image costs vision tokens (~10k–40k extra per ticket). It runs only when:

1. A developer asks for it in natural language — e.g. *"analyse and build with media ABC-123"*, *"start ABC-123 with screenshots"*, *"make the plan using the attachments"*. Cursor maps this wording to `analyze_media: true` on the tool call. Normal prompts (no media words) stay on base Jira context with **zero** extra token cost.
2. A team turns it on globally via `.jiraflow.yaml` (`media_analysis.enabled: true`) or `MEDIA_ANALYSIS_ENABLED=true`.

> Having a `VISION_API_KEY` set does **not** auto-enable analysis — it only makes analysis *possible* when requested.

Configure the vision backend with env vars:

| Var | Default | Purpose |
|-----|---------|---------|
| `VISION_API_KEY` / `OPENAI_API_KEY` | — | API key for the vision model (required for image analysis) |
| `VISION_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `VISION_MODEL` | `gpt-4o-mini` | Vision-capable model |
| `MEDIA_ANALYSIS_ENABLED` | `false` | Force on/off globally (`true`/`false`) |
| `MEDIA_MAX_FILES` | `6` | Max attachments analyzed per ticket |
| `MEDIA_MAX_FILE_BYTES` | `8388608` | Per-file download cap |
| `MEDIA_MAX_TOTAL_BYTES` | `25165824` | Total download budget per ticket |

Per-repo override in `.jiraflow.yaml` (recommended: keep `enabled: false` and let developers opt in per ticket):

```yaml
workflow:
  media_analysis:
    enabled: false      # OFF by default; per-call "with media" still works
    mode: images_only   # full | images_only | off
    max_files: 2
```

Per-call control: pass `analyze_media: true` to force analysis on, or `false` to force it off, on any of those tools. Media analysis is best-effort — failures never block the workflow.

### Generating automated test cases from a Jira ticket

`prepare_test_authoring` extends the context engine to BDD/automation work. Point it at your **test automation repo** (`repo_path` or `workspace_id`) and give it just a Jira number:

```
write test cases for BR-1234
```

It then:

1. **Builds a knowledge base** from the ticket — summary, description, acceptance criteria, **steps to reproduce**, comments, and linked issues (saved to `.jiraflow/kb/<KEY>.md`).
2. **Mines existing automation assets** — discovers `.feature` files, step-definition files (Cucumber JS/TS, Java/Kotlin annotations, Python behave/pytest-bdd), and locator/page-object files.
3. **Finds similar scenarios** — scores existing scenarios by keyword overlap with the ticket so you reuse, not duplicate.
4. **Extracts reusable steps** — surfaces matching `Given/When/Then` patterns to reuse verbatim.
5. **Derives prerequisites** — collects `Background:` steps from related features.
6. **Returns a Gherkin skeleton** — a ready-to-finalize feature built from the steps-to-reproduce and acceptance criteria.

The agent then finalizes the skeleton into a feature file, reusing the listed steps/locators and writing only the genuinely new ones — instead of authoring tests from scratch.

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
