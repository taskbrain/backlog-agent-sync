import { join } from "node:path";
import type { BacklogConfig, JudgmentConfig, StaleSweepConfig } from "./types.js";

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

export function docsLedgerPath(cwd: string): string {
  return join(cwd, ".claude", "backlog-agent-sync", "docs-ledger.json");
}

/**
 * project.json の judgment ブロックを既定値で正規化する。
 * 既定: backend="auto"（model 未設定 = claude 既定モデル）。
 * 不正な backend 値は "auto" に丸める（後方互換・安全側）。
 */
export function resolveJudgmentConfig(judgment?: JudgmentConfig): Required<Pick<JudgmentConfig, "backend">> & { model?: string } {
  const backend = judgment?.backend;
  const normalized = backend === "deterministic" || backend === "claude-p" || backend === "auto" ? backend : "auto";
  return { backend: normalized, model: judgment?.model };
}

/**
 * project.json の staleSweep ブロックを既定値で正規化する。
 * 既定: enabled=true / thresholdHours=24。
 * 後方互換: 未設定（undefined）はすべて既定で埋める。
 * thresholdHours は有限の正数のみ採用し、それ以外（NaN/0/負/非数）は既定 24 に丸める（安全側）。
 */
export function resolveStaleSweepConfig(staleSweep?: StaleSweepConfig): Required<StaleSweepConfig> {
  const enabled = staleSweep?.enabled !== false; // 既定 true。明示 false のときだけ無効
  const raw = staleSweep?.thresholdHours;
  const thresholdHours = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 24;
  return { enabled, thresholdHours };
}
