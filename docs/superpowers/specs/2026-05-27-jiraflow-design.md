# JiraFlow MCP v2 — Design Specification

**Date:** 2026-05-27  
**Status:** Approved for implementation  
**Scope:** Option B — Extend TypeScript; full PRD with hosted git/MR via hybrid workspace model.

## 1. Purpose

JiraFlow turns Jira tickets into high-signal Cursor context and deterministic workflow orchestration (state, approvals, branches, commits, MRs) without external LLM calls.

## 2. Architecture

- **Stack:** TypeScript, existing MCP SDK, `yaml`, `simple-git`, `minimatch`.
- **Entry:** [`src/server-core.ts`](../../src/server-core.ts) registers legacy Jira tools + [`src/jiraflow/tools.ts`](../../src/jiraflow/tools.ts).
- **Hosted git:** Repos under `JIRAFLOW_WORKSPACE_ROOT`; tools take `workspace_id`. Paths validated with `minimatch` + realpath check.
- **Credentials:** Jira via existing device/header auth; GitHub/GitLab via per-device tokens in `devices.json` or server env fallback.

## 3. Tool contract

Every JiraFlow tool returns MCP text content: `JSON.stringify({ success: boolean, message: string, data: object })`.

On failure: `success: false`, human `message`, `data.recovery_steps: string[]`, state unchanged unless noted.

## 4. Tools

| Tool | Inputs | State transition |
|------|--------|------------------|
| `jira_start_ticket` | `ticket_number`, `workspace_id?`, `repo_path?`, `dry_run?` | → `ticket_loaded` |
| `prepare_cursor_context` | `ticket_number`, `workspace_id?`, `repo_path?`, `focus_areas?` | → `context_prepared` |
| `generate_implementation_plan` | same | (no change if already past) |
| `workspace_setup` | `ticket_number`, `workspace_id?`, `repo_path?` | → `parent_branch_ready` |
| `create_feature_branch` | `ticket_number`, `workspace_id?`, `repo_path?`, `approval_token?` | → `feature_branch_created` |
| `commit_with_context` | `workspace_id?`, `repo_path?`, `message_override?`, `approval_token?` | → `coding_in_progress` |
| `validate_changes` | `workspace_id?`, `repo_path?`, `long_running?` | → `changes_validated` |
| `create_merge_request` | `ticket_number`, `workspace_id?`, `repo_path?`, `approval_token?` | → `merge_request_ready` |
| `jiraflow_workspace_status` | `workspace_id?` | none |

Legacy `jira_ticket_plan_then_build` wraps `jira_start_ticket` + `data.legacy_playbook`.

## 5. State machine

File: `{workspace}/.jiraflow/state.json`

States: `ticket_loaded` → `context_prepared` → `parent_branch_ready` → `feature_branch_created` → `coding_in_progress` → `changes_validated` → `merge_request_ready` → `workflow_complete`.

Illegal transitions return `success: false` with `data.suggested_tool`.

## 6. Config

**`.jiraflow.yaml`** (per repo): `jira.project_key`, `jira.branch_field`, `jira.parent_branch_field`, `git.provider`, `git.default_base_branch`, `git.branching.feature_pattern`, `workflow.approval_mode`, `workflow.validate_scripts[]`.

**`workspaces.yaml`** under `JIRAFLOW_WORKSPACE_ROOT`: list of `{ id, path, provider, remote, default_base_branch }`.

## 7. Approval

Modes: `smart` | `strict` | `lenient`. Actions: `branch_create`, `commit`, `push`, `force_push`, `mr_create`, `jira_done`.

`approval_token` is a deterministic hash returned in prior `data.approval_required`; re-submit to proceed.

## 8. Security

- Reject paths outside workspace root (hosted).
- No tokens in tool output.
- Audit log: `MCP_DATA_DIR/audit.log` or stderr.
- Block force-push without HIGH approval.

## 9. Testing

`node:test` for config, state, response, slugify, path allowlist, plan sections.

## 10. Version

Server metadata `jira-mcp` version `2.0.0`.
