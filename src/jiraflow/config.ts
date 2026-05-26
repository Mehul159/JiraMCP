import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type ApprovalMode = "smart" | "strict" | "lenient";

export type JiraflowRepoConfig = {
  jira: {
    project_key?: string;
    branch_field?: string;
    parent_branch_field?: string;
  };
  git: {
    provider: "github" | "gitlab";
    default_base_branch: string;
    branching: { feature_pattern: string };
  };
  workflow: {
    approval_mode: ApprovalMode;
    auto_generate_plan: boolean;
    auto_generate_context: boolean;
    validate_scripts: string[];
  };
};

export type ServerWorkspace = {
  id: string;
  path: string;
  provider: "github" | "gitlab";
  remote: string;
  default_base_branch: string;
};

export type ServerWorkspacesConfig = {
  workspaces: ServerWorkspace[];
};

const DEFAULT_REPO_CONFIG: JiraflowRepoConfig = {
  jira: {},
  git: {
    provider: "github",
    default_base_branch: "main",
    branching: { feature_pattern: "{type}/{ticket}-{slug}" },
  },
  workflow: {
    approval_mode: "smart",
    auto_generate_plan: true,
    auto_generate_context: true,
    validate_scripts: [],
  },
};

export function workspaceRootFromEnv(): string | undefined {
  const raw =
    process.env.JIRAFLOW_WORKSPACE_ROOT?.trim() ||
    process.env.JIRAFLOW_SERVER_CONFIG?.trim();
  return raw || undefined;
}

export function loadServerWorkspaces(): ServerWorkspacesConfig {
  const root = workspaceRootFromEnv();
  if (!root) return { workspaces: [] };
  const path = join(root, "workspaces.yaml");
  if (!existsSync(path)) return { workspaces: [] };
  try {
    const doc = parseYaml(readFileSync(path, "utf8")) as ServerWorkspacesConfig;
    return { workspaces: doc.workspaces ?? [] };
  } catch {
    return { workspaces: [] };
  }
}

export function loadRepoConfig(repoRoot: string): JiraflowRepoConfig {
  const path = join(repoRoot, ".jiraflow.yaml");
  if (!existsSync(path)) return { ...DEFAULT_REPO_CONFIG };
  try {
    const doc = parseYaml(readFileSync(path, "utf8")) as Partial<JiraflowRepoConfig>;
    return {
      jira: { ...DEFAULT_REPO_CONFIG.jira, ...doc.jira },
      git: {
        ...DEFAULT_REPO_CONFIG.git,
        ...doc.git,
        branching: {
          ...DEFAULT_REPO_CONFIG.git.branching,
          ...doc.git?.branching,
        },
      },
      workflow: {
        ...DEFAULT_REPO_CONFIG.workflow,
        ...doc.workflow,
        validate_scripts:
          doc.workflow?.validate_scripts ??
          DEFAULT_REPO_CONFIG.workflow.validate_scripts,
      },
    };
  } catch {
    return { ...DEFAULT_REPO_CONFIG };
  }
}

export function resolveWorkspaceById(
  workspace_id: string,
): ServerWorkspace | null {
  const { workspaces } = loadServerWorkspaces();
  return workspaces.find((w) => w.id === workspace_id) ?? null;
}

export function resolveRepoRoot(opts: {
  workspace_id?: string;
  repo_path?: string;
}): { repoRoot: string; workspace?: ServerWorkspace } | { error: string } {
  if (opts.repo_path?.trim()) {
    const repoRoot = resolve(opts.repo_path.trim());
    const root = workspaceRootFromEnv();
    if (root) {
      const allowed = resolve(root);
      if (!repoRoot.startsWith(allowed)) {
        return {
          error: `repo_path must be under JIRAFLOW_WORKSPACE_ROOT (${allowed}).`,
        };
      }
    }
    return { repoRoot };
  }
  if (opts.workspace_id?.trim()) {
    const ws = resolveWorkspaceById(opts.workspace_id.trim());
    if (!ws) {
      return {
        error: `Unknown workspace_id "${opts.workspace_id}". Register it in workspaces.yaml under JIRAFLOW_WORKSPACE_ROOT.`,
      };
    }
    const root = workspaceRootFromEnv();
    if (!root) {
      return {
        error: "JIRAFLOW_WORKSPACE_ROOT is not set on the server.",
      };
    }
    return { repoRoot: resolve(join(root, ws.path)), workspace: ws };
  }
  const cwd = process.cwd();
  if (existsSync(join(cwd, ".git"))) {
    return { repoRoot: cwd };
  }
  return {
    error:
      "Provide workspace_id (hosted) or repo_path (local) pointing at a git repository.",
  };
}

export function slugFromSummary(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "change";
}

export function branchNameFromPattern(
  pattern: string,
  ticket: string,
  summary: string,
  issueType?: string,
): string {
  const typeMap: Record<string, string> = {
    bug: "fix",
    story: "feat",
    task: "feat",
    epic: "feat",
  };
  const rawType = (issueType ?? "task").toLowerCase();
  const type = typeMap[rawType] ?? "feat";
  return pattern
    .replace("{type}", type)
    .replace("{ticket}", ticket)
    .replace("{slug}", slugFromSummary(summary));
}
