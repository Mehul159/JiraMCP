# Deploy Jira MCP (production)

This service exposes:

| Path | Purpose |
|------|---------|
| `GET /health` | Load balancer / platform health |
| `GET /setup` | One-time browser UI (device tokens) |
| `POST/GET/DELETE /mcp` | Cursor MCP (Streamable HTTP) |

**Persistence:** map a volume to **`MCP_DATA_DIR`** (default **`/app/data`**) so **`devices.json`** survives redeploys.

**Secrets:** never commit values below — use your platform’s secret store.

## Required environment variables

| Variable | Description |
|----------|-------------|
| `DEFAULT_JIRA_BASE_URL` or `JIRA_BASE_URL` | Shared Jira Cloud root (e.g. `https://company.atlassian.net`) |
| `MCP_PUBLIC_ORIGIN` | Public **HTTPS** URL, **no trailing slash** (`/setup` + logs). **Render:** optional — app uses **`RENDER_EXTERNAL_URL`** unless you set a custom domain here. |
| `MCP_SETUP_SECRET` | Protects `POST /setup/register` from anonymous abuse |

Optional:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` / `MCP_HTTP_PORT` | `3333` | Listen port inside container |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind address |
| `MCP_DATA_DIR` | `/app/data` | Device credential storage |
| `MCP_ALLOWED_HOSTS` | _(unset)_ | Comma-separated allowed `Host` headers |
| `RENDER_EXTERNAL_URL` | _(Render sets)_ | HTTPS URL of the service; used when `MCP_PUBLIC_ORIGIN` is unset |

When `NODE_ENV=production`, the server **exits on startup** if `DEFAULT_JIRA_BASE_URL` or `MCP_SETUP_SECRET` is missing, or if neither **`MCP_PUBLIC_ORIGIN`** nor **`RENDER_EXTERNAL_URL`** resolves to an `https://…` URL. Override with `SKIP_PRODUCTION_CONFIG_VALIDATION=true` only for emergencies.

---

## Fly.io (recommended first path)

Prerequisites: [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/), account, Docker optional (Fly builders work from repo).

1. **Create app** (once):

   ```bash
   cd /path/to/jira-mcp
   fly apps create jira-mcp
   ```

   Or adjust `app = "…"` in [`fly.toml`](fly.toml).

2. **Volume** (same region as `primary_region` in `fly.toml`, default `iad`):

   ```bash
   fly volumes create mcp_data --region iad --size 1
   ```

3. **Secrets:**

   ```bash
   fly secrets set DEFAULT_JIRA_BASE_URL=https://YOUR.atlassian.net \
     MCP_PUBLIC_ORIGIN=https://YOUR_APP.fly.dev \
     MCP_SETUP_SECRET="$(openssl rand -hex 32)"
   ```

   Replace `YOUR_APP.fly.dev` with your real hostname after first deploy (custom domain or `.fly.dev`).

4. **Deploy:**

   ```bash
   fly deploy
   ```

5. **Smoke test**

   - Open `https://YOUR_APP.fly.dev/health`
   - Open `https://YOUR_APP.fly.dev/setup`, register once, set **`JIRA_MCP_DEVICE_TOKEN`** on your PC (see success page).

**Revoke a device** (admin):

```bash
curl -X POST https://YOUR_APP.fly.dev/setup/revoke \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "device_token=jmcp_..." \
  -d "setup_secret=YOUR_MCP_SETUP_SECRET"
```

---

## Railway

1. New project → Deploy from GitHub (or CLI) using root [`Dockerfile`](Dockerfile).
2. **Add persistent volume** mounted at **`/app/data`** (Railway “Volume” / disk add-on — confirm current UI).
3. Set variables in Railway dashboard:

   - `NODE_ENV` = `production`
   - `DEFAULT_JIRA_BASE_URL`, `MCP_PUBLIC_ORIGIN` (your Railway HTTPS URL), `MCP_SETUP_SECRET`
   - Optionally `PORT` if Railway injects it — our server reads **`PORT`** first; align container listen port with Railway’s expectation.

4. Health check path: **`/health`** (configure in service settings if offered).

---

## Render

Render injects **`PORT`** (the process listens on it automatically) and **`RENDER_EXTERNAL_URL`** (`https://<service>.onrender.com`). This repo’s HTTP server uses **`RENDER_EXTERNAL_URL`** for `/setup` links when **`MCP_PUBLIC_ORIGIN`** is unset.

### Option A — Blueprint (recommended)

1. Push this repo to GitHub/GitLab (includes [`render.yaml`](render.yaml)).
2. In [Render Dashboard](https://dashboard.render.com): **New** → **Blueprint** → select the repo → apply.
3. When prompted, set **environment variables**:
   - **`DEFAULT_JIRA_BASE_URL`** — your shared Atlassian site root.
   - **`MCP_SETUP_SECRET`** — long random string (e.g. `openssl rand -hex 32`).
4. Confirm the **persistent disk** mounts at **`/app/data`** (declared in `render.yaml`). Disk requires a **paid instance type** (e.g. Starter); without a disk, device registrations are lost on redeploy.
5. After deploy: open **`RENDER_EXTERNAL_URL`/health**, then **`RENDER_EXTERNAL_URL`/setup**.

**Custom domain:** add the domain in Render, then set **`MCP_PUBLIC_ORIGIN`** to `https://your-domain.example` so `/setup` instructions match DNS.

### Option B — Manual Web Service

1. **New** → **Web Service** → connect repo.
2. **Runtime:** Docker; **Dockerfile path:** `./Dockerfile`; root directory: repo root.
3. **Instance type:** Starter (or higher) if you need a **persistent disk**.
4. **Disks** → Add disk → mount path **`/app/data`** (matches **`MCP_DATA_DIR`**).
5. **Environment:**
   - `NODE_ENV` = `production`
   - `MCP_HTTP_HOST` = `0.0.0.0`
   - `MCP_DATA_DIR` = `/app/data`
   - `DEFAULT_JIRA_BASE_URL`, `MCP_SETUP_SECRET` (required)
   - Optional: `MCP_PUBLIC_ORIGIN` if not using the default `onrender.com` URL for docs/links.
6. **Health check path:** `/health`.

### Cursor MCP URL on Render

Use **`https://<your-service>.onrender.com/mcp`** (or your custom domain) with header **`X-Jira-Mcp-Device-Token`** as in [`.cursor/mcp.hosted.example.json`](.cursor/mcp.hosted.example.json).

---

## Local parity (Docker Compose)

See [`docker-compose.yml`](docker-compose.yml):

```bash
cp .env.example .env
# edit .env — set DEFAULT_JIRA_BASE_URL, MCP_PUBLIC_ORIGIN, MCP_SETUP_SECRET
docker compose up --build
```

Use **`http://localhost:3333`** only for local demos; production must use **`https://`** for `MCP_PUBLIC_ORIGIN` unless you temporarily set `SKIP_PRODUCTION_CONFIG_VALIDATION=true`.

Compose defaults **`NODE_ENV=development`** so local HTTP URLs do not trip production startup validation. Managed hosts should set **`NODE_ENV=production`** (see [`fly.toml`](fly.toml)).

---

## Cursor (team)

Same MCP JSON for everyone; each developer sets **`JIRA_MCP_DEVICE_TOKEN`** on **their OS user** after visiting **`/setup`**.

Example: [`.cursor/mcp.hosted.example.json`](.cursor/mcp.hosted.example.json).
