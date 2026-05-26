import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { JiraflowRepoConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export type ValidateResult = {
  passed: boolean;
  results: { script: string; ok: boolean; output: string }[];
};

export async function validateChanges(
  repoRoot: string,
  config: JiraflowRepoConfig,
  long_running?: boolean,
): Promise<ValidateResult> {
  const scripts = config.workflow.validate_scripts;
  if (scripts.length === 0) {
    return {
      passed: true,
      results: [
        {
          script: "(none configured)",
          ok: true,
          output: "Add workflow.validate_scripts in .jiraflow.yaml to run lint/test.",
        },
      ],
    };
  }

  const timeout = long_running ? 60_000 : 8_000;
  const results: ValidateResult["results"] = [];
  let passed = true;

  for (const script of scripts) {
    try {
      const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
      const shellArg = process.platform === "win32" ? "/c" : "-c";
      const { stdout, stderr } = await execFileAsync(
        shell,
        [shellArg, script],
        { cwd: repoRoot, timeout, maxBuffer: 2 * 1024 * 1024 },
      );
      results.push({ script, ok: true, output: (stdout + stderr).slice(0, 2000) });
    } catch (e) {
      passed = false;
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ script, ok: false, output: msg.slice(0, 2000) });
    }
  }

  return { passed, results };
}
