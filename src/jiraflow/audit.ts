import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { deviceStoreDir } from "../device-store.js";

export function auditLog(
  action: string,
  details: Record<string, string | undefined>,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    action,
    ...details,
  });
  const dir = process.env.MCP_DATA_DIR?.trim() || deviceStoreDir();
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "audit.log"), line + "\n", "utf8");
  } catch {
    console.error("[jiraflow-audit]", line);
  }
}
