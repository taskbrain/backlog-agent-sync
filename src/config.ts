import { join } from "node:path";
import type { BacklogConfig } from "./types.js";

export function resolveConfig(env: NodeJS.ProcessEnv): BacklogConfig {
  const domain = env.BACKLOG_DOMAIN;
  const apiKey = env.BACKLOG_API_KEY ?? env.CLAUDE_PLUGIN_OPTION_BACKLOG_API_KEY;
  const projectKey = env.BACKLOG_PROJECT;
  const missing: string[] = [];
  if (!domain) missing.push("BACKLOG_DOMAIN");
  if (!apiKey) missing.push("BACKLOG_API_KEY");
  if (!projectKey) missing.push("BACKLOG_PROJECT");
  if (missing.length) throw new Error(`必須環境変数が未設定: ${missing.join(", ")}`);
  return { domain: domain!, apiKey: apiKey!, projectKey: projectKey! };
}

export function stateDirFor(cwd: string): string {
  return join(cwd, ".claude", "state");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".claude", "backlog-agent-sync", "project.json");
}

export function seedLedgerPath(cwd: string): string {
  return join(cwd, ".claude", "backlog-agent-sync", "seed-ledger.json");
}
