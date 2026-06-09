import { describe, it, expect, vi } from "vitest";
import { BacklogAdapter } from "../src/tracker/backlog-adapter.js";

describe("BacklogAdapter", () => {
  it("getStatusMap は name から既知キーへマップする", async () => {
    const rest = {
      getProjectStatuses: vi.fn().mockResolvedValue([
        { id: 1, name: "未対応" }, { id: 2, name: "処理中" }, { id: 3, name: "処理済み" }, { id: 4, name: "完了" },
      ]),
    } as any;
    const adapter = new BacklogAdapter(rest, "PROJ");
    const map = await adapter.getStatusMap();
    expect(map).toMatchObject({ open: 1, in_progress: 2, resolved: 3, closed: 4 });
  });

  it("setStatus は updateIssue に statusId を渡す", async () => {
    const rest = { updateIssue: vi.fn().mockResolvedValue(undefined) } as any;
    const adapter = new BacklogAdapter(rest, "PROJ");
    await adapter.setStatus("PROJ-1", 2, "進行中です");
    expect(rest.updateIssue).toHaveBeenCalledWith({ issueIdOrKey: "PROJ-1", statusId: 2, comment: "進行中です" });
  });
});
