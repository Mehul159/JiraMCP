import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadRepoConfig, resolveRepoRoot, type ServerWorkspace } from "./config.js";
import { loadState } from "./state.js";

export type ResolvedWorkspace = {
  repoRoot: string;
  config: ReturnType<typeof loadRepoConfig>;
  workspace?: ServerWorkspace;
  state: ReturnType<typeof loadState>;
};

export function resolveWorkspace(opts: {
  workspace_id?: string;
  repo_path?: string;
}): { ok: ResolvedWorkspace } | { error: string } {
  const resolved = resolveRepoRoot(opts);
  if ("error" in resolved) return { error: resolved.error };
  const { repoRoot, workspace } = resolved;
  if (!existsSync(join(repoRoot, ".git"))) {
    return { error: `Not a git repository: ${repoRoot}` };
  }
  return {
    ok: {
      repoRoot,
      config: loadRepoConfig(repoRoot),
      workspace,
      state: loadState(repoRoot),
    },
  };
}
