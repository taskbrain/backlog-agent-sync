import { describe, it, expect } from "vitest";
import { resolveCreateFields } from "../src/fields.js";

const priorities = [{ id: 2, name: "高" }, { id: 3, name: "中" }, { id: 4, name: "低" }];
const categories = [{ id: 101, name: "フロントエンド" }, { id: 102, name: "インフラ" }];
const versions = [
  { id: 203, name: "archived", startDate: "2026-06-01", releaseDueDate: "2026-06-30", archived: true },
  { id: 201, name: "v1.0", startDate: "2026-05-01", releaseDueDate: "2026-05-31", archived: false },
  { id: 202, name: "v1.1", startDate: "2026-06-01", releaseDueDate: "2026-06-30", archived: false },
];
const now = new Date("2026-06-12T10:00:00Z");

describe("resolveCreateFields", () => {
  it("優先度: 既定キーワードで高/低を解決し、該当なしは未設定", () => {
    const cache = { priorities };
    expect(resolveCreateFields("本番障害が起きています", cache, now).priorityId).toBe(2);
    expect(resolveCreateFields("Critical bug in prod", cache, now).priorityId).toBe(2); // 大文字小文字を無視
    expect(resolveCreateFields("typoを修正して", cache, now).priorityId).toBe(4);
    expect(resolveCreateFields("通常の機能追加", cache, now).priorityId).toBeUndefined();
  });

  it("優先度: high と low の両方に該当したら high を優先する", () => {
    expect(resolveCreateFields("緊急: typo修正", { priorities }, now).priorityId).toBe(2);
  });

  it("優先度: priorityKeywords のカスタムは既定を置き換える", () => {
    const cache = { priorities, fieldRules: { priorityKeywords: { high: ["p0"] } } };
    expect(resolveCreateFields("p0 対応をお願いします", cache, now).priorityId).toBe(2);
    expect(resolveCreateFields("緊急対応", cache, now).priorityId).toBeUndefined(); // high 既定は無効化
    expect(resolveCreateFields("typo修正", cache, now).priorityId).toBe(4); // low は既定のまま
  });

  it("優先度: 英語名 High/Normal/Low でも解決する", () => {
    const en = [{ id: 11, name: "High" }, { id: 12, name: "Normal" }, { id: 13, name: "Low" }];
    expect(resolveCreateFields("緊急の障害です", { priorities: en }, now).priorityId).toBe(11);
    expect(resolveCreateFields("軽微な修正", { priorities: en }, now).priorityId).toBe(13);
  });

  it("担当者: assignSelf（既定 true）で myselfId を設定し、false なら設定しない", () => {
    expect(resolveCreateFields("x", { myselfId: 5 }, now).assigneeId).toBe(5); // fieldRules 無し = 既定 true
    expect(resolveCreateFields("x", { myselfId: 5, fieldRules: { assignSelf: true } }, now).assigneeId).toBe(5);
    expect(resolveCreateFields("x", { myselfId: 5, fieldRules: { assignSelf: false } }, now).assigneeId).toBeUndefined();
    expect(resolveCreateFields("x", { fieldRules: { assignSelf: true } }, now).assigneeId).toBeUndefined(); // myselfId 欠落
  });

  it("カテゴリ: categoryRules のキーワード一致でカテゴリ id 配列を返す（大文字小文字無視・重複なし）", () => {
    const cache = {
      categories,
      fieldRules: { categoryRules: { "フロントエンド": ["liff", "ui"], "インフラ": ["deploy", "cloudflare"] } },
    };
    expect(resolveCreateFields("LIFFの画面を修正", cache, now).categoryId).toEqual([101]);
    expect(resolveCreateFields("UIを直してdeployする", cache, now).categoryId).toEqual([101, 102]);
    expect(resolveCreateFields("関係ない作業", cache, now).categoryId).toBeUndefined();
    // ルールにあるがキャッシュに無いカテゴリ名はスキップ
    const noCat = { fieldRules: { categoryRules: { "存在しない": ["liff"] } } };
    expect(resolveCreateFields("liff", noCat, now).categoryId).toBeUndefined();
  });

  it("マイルストーン: current は期間内・未アーカイブの先頭を選ぶ", () => {
    const cache = { versions, fieldRules: { milestone: "current" } };
    expect(resolveCreateFields("x", cache, now).milestoneId).toEqual([202]); // 203 は archived、201 は期間外
  });

  it("マイルストーン: 日付の無いバージョンは current に該当しない", () => {
    const cache = { versions: [{ id: 210, name: "someday" }], fieldRules: { milestone: "current" } };
    expect(resolveCreateFields("x", cache, now).milestoneId).toBeUndefined();
  });

  it("マイルストーン: 名前指定は名前一致、off/未設定は設定しない", () => {
    expect(resolveCreateFields("x", { versions, fieldRules: { milestone: "v1.0" } }, now).milestoneId).toEqual([201]);
    expect(resolveCreateFields("x", { versions, fieldRules: { milestone: "off" } }, now).milestoneId).toBeUndefined();
    expect(resolveCreateFields("x", { versions }, now).milestoneId).toBeUndefined();
  });

  it("キャッシュ全欠落なら {} を返す", () => {
    expect(resolveCreateFields("緊急の障害。liffのdeploy", {}, now)).toEqual({});
  });
});
