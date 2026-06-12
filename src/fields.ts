import type { FieldRules } from "./types.js";

export interface FieldCacheEntry { id: number; name: string; }
export interface FieldVersionEntry extends FieldCacheEntry {
  startDate?: string;
  releaseDueDate?: string;
  archived?: boolean;
}

/** project.json から読み込むキャッシュ（欠落しても落ちない）。 */
export interface FieldCache {
  myselfId?: number;
  priorities?: FieldCacheEntry[];
  categories?: FieldCacheEntry[];
  versions?: FieldVersionEntry[];
  fieldRules?: FieldRules;
}

export interface ResolvedCreateFields {
  assigneeId?: number;
  priorityId?: number;
  categoryId?: number[];
  milestoneId?: number[];
}

export const DEFAULT_HIGH_KEYWORDS = ["緊急", "至急", "障害", "本番障害", "critical", "クリティカル"];
export const DEFAULT_LOW_KEYWORDS = ["軽微", "typo", "タイポ", "些細"];

const HIGH_NAMES = ["高", "high"];
const LOW_NAMES = ["低", "low"];

function includesAny(lowerText: string, keywords: string[]): boolean {
  return keywords.some((k) => !!k && lowerText.includes(k.toLowerCase()));
}

function findByName(list: FieldCacheEntry[] | undefined, names: string[]): FieldCacheEntry | undefined {
  return list?.find((e) => names.includes(e.name.trim().toLowerCase()));
}

/**
 * 課題作成時のフィールドを決定論ルール（設計 §3.2）で解決する純関数。
 * - 担当者: assignSelf（既定 true）→ myselfId
 * - 優先度: キーワード判定で「高/低」（High/Low）。該当なしは未設定（呼出側の既定「中」に委ねる）
 * - カテゴリ: categoryRules のキーワード一致 → カテゴリ名 → id
 * - マイルストーン: "current" = 未アーカイブかつ releaseDueDate が今日以降（startDate があれば今日以前）の先頭 /
 *   名前指定 = 名前一致 / "off"・未設定 = 設定しない
 * 高度な判断（真の優先度・適切な担当者）は ceiling（MCP update_issue）で上書きする。
 * キャッシュが欠落している項目は黙ってスキップし、全欠落なら {} を返す。
 */
export function resolveCreateFields(prompt: string, cache: FieldCache, now: Date = new Date()): ResolvedCreateFields {
  const out: ResolvedCreateFields = {};
  const rules = cache.fieldRules ?? {};
  const text = (prompt ?? "").toLowerCase();

  // 担当者
  if ((rules.assignSelf ?? true) && cache.myselfId != null) {
    out.assigneeId = cache.myselfId;
  }

  // 優先度（high 判定を優先）
  const highKeywords = rules.priorityKeywords?.high ?? DEFAULT_HIGH_KEYWORDS;
  const lowKeywords = rules.priorityKeywords?.low ?? DEFAULT_LOW_KEYWORDS;
  if (includesAny(text, highKeywords)) {
    const p = findByName(cache.priorities, HIGH_NAMES);
    if (p) out.priorityId = p.id;
  } else if (includesAny(text, lowKeywords)) {
    const p = findByName(cache.priorities, LOW_NAMES);
    if (p) out.priorityId = p.id;
  }

  // カテゴリ
  const categoryIds: number[] = [];
  for (const [categoryName, keywords] of Object.entries(rules.categoryRules ?? {})) {
    if (!Array.isArray(keywords) || !includesAny(text, keywords)) continue;
    const c = cache.categories?.find((e) => e.name.trim() === categoryName.trim());
    if (c && !categoryIds.includes(c.id)) categoryIds.push(c.id);
  }
  if (categoryIds.length) out.categoryId = categoryIds;

  // マイルストーン
  const milestone = rules.milestone;
  if (milestone && milestone !== "off") {
    if (milestone === "current") {
      // 日付は yyyy-MM-dd の辞書順比較（UTC 基準。境界の1日ズレは許容）
      const today = now.toISOString().slice(0, 10);
      const hit = cache.versions?.find((v) =>
        !v.archived &&
        !!v.releaseDueDate && today <= v.releaseDueDate.slice(0, 10) &&
        (!v.startDate || v.startDate.slice(0, 10) <= today),
      );
      if (hit) out.milestoneId = [hit.id];
    } else {
      const hit = cache.versions?.find((v) => v.name.trim() === milestone.trim());
      if (hit) out.milestoneId = [hit.id];
    }
  }

  return out;
}
