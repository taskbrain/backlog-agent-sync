import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/init.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fakeAdapter() {
  return {
    getStatusMap: vi.fn().mockResolvedValue({ open: 1, in_progress: 2, resolved: 3, closed: 4 }),
    createIssue: vi.fn(), setStatus: vi.fn(), addComment: vi.fn(), findByMarker: vi.fn(),
  } as any;
}

function fakeRest(overrides: Record<string, unknown> = {}) {
  return {
    getMyself: vi.fn().mockResolvedValue({ id: 5, name: "me" }),
    getProject: vi.fn().mockResolvedValue({ id: 99, projectKey: "PROJ", name: "P" }),
    getIssueTypes: vi.fn().mockResolvedValue([{ id: 4236190, name: "タスク" }, { id: 4236189, name: "バグ" }]),
    getPriorities: vi.fn().mockResolvedValue([{ id: 2, name: "高" }, { id: 3, name: "中" }, { id: 4, name: "低" }]),
    getProjectInfo: vi.fn().mockResolvedValue({ id: 99, textFormattingRule: "markdown" }),
    getCategories: vi.fn().mockResolvedValue([{ id: 101, name: "フロントエンド" }]),
    getVersions: vi.fn().mockResolvedValue([{ id: 201, name: "v1.0", startDate: "2026-06-01", releaseDueDate: "2026-06-30", archived: false }]),
    getResolutions: vi.fn().mockResolvedValue([{ id: 0, name: "対応済み" }, { id: 1, name: "対応しない" }]),
    getGitRepositories: vi.fn().mockResolvedValue([{ id: 9, name: "app", httpUrl: "https://ex.backlog.com/git/PROJ/app.git" }]),
    ...overrides,
  } as any;
}

/** git の無い環境を既定にする（execFile 失敗 → generic）。 */
function baseDeps(restOverrides: Record<string, unknown> = {}, depsOverrides: Record<string, unknown> = {}) {
  return {
    adapter: fakeAdapter(),
    rest: fakeRest(restOverrides),
    execFile: vi.fn().mockRejectedValue(new Error("not a git repository")),
    parseRemoteUrl: vi.fn().mockReturnValue({ kind: "generic" }),
    ...depsOverrides,
  } as any;
}

function readWritten() {
  return JSON.parse(readFileSync(join(dir, ".claude", "backlog-agent-sync", "project.json"), "utf8"));
}

describe("runInit", () => {
  it("auth 検証 → statusMap 解決 → project.json を書く", async () => {
    const deps = baseDeps();
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, deps);
    expect(deps.rest.getMyself).toHaveBeenCalled();
    const written = readWritten();
    expect(written.statusMap.in_progress).toBe(2);
    expect(written.projectKey).toBe("PROJ");
    expect(out.ok).toBe(true);
  });

  it("projectId 未指定なら getProject で解決する", async () => {
    const deps = baseDeps();
    const out = await runInit({ cwd: dir, projectKey: "PROJ" }, deps);
    expect(deps.rest.getProject).toHaveBeenCalledWith("PROJ");
    expect(readWritten().projectId).toBe(99);
    expect(out.ok).toBe(true);
  });

  it("issueTypes/priorities をキャッシュし「タスク」「中」を既定に選ぶ", async () => {
    const deps = baseDeps({
      getIssueTypes: vi.fn().mockResolvedValue([
        { id: 4236189, name: "バグ" }, { id: 4236190, name: "タスク" }, { id: 4236191, name: "要望" },
      ]),
      getPriorities: vi.fn().mockResolvedValue([{ id: 2, name: "高" }, { id: 3, name: "中" }, { id: 4, name: "低" }]),
    });
    const out = await runInit({ cwd: dir, projectKey: "TC", projectId: 791973 }, deps);
    expect(deps.rest.getIssueTypes).toHaveBeenCalledWith("TC");
    const written = readWritten();
    expect(written.issueTypes).toEqual([
      { id: 4236189, name: "バグ" }, { id: 4236190, name: "タスク" }, { id: 4236191, name: "要望" },
    ]);
    expect(written.priorities.length).toBe(3);
    expect(written.defaultIssueTypeId).toBe(4236190); // 「タスク」優先
    expect(written.defaultPriorityId).toBe(3); // 「中」優先
    expect(out.defaultIssueTypeId).toBe(4236190);
    expect(out.defaultPriorityId).toBe(3);
  });

  it("「タスク」「中」が無ければ先頭/中央へフォールバックする", async () => {
    const deps = baseDeps({
      getIssueTypes: vi.fn().mockResolvedValue([{ id: 7, name: "Feature" }, { id: 8, name: "Chore" }]),
      getPriorities: vi.fn().mockResolvedValue([{ id: 11, name: "P1" }, { id: 12, name: "P2" }, { id: 13, name: "P3" }]),
    });
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, deps);
    expect(out.defaultIssueTypeId).toBe(7); // 先頭
    expect(out.defaultPriorityId).toBe(12); // 中央
  });
});

describe("runInit（G19: vcs / textFormattingRule / フィールドキャッシュ）", () => {
  it("github remote を検出して vcs を保存する", async () => {
    const deps = baseDeps({}, {
      execFile: vi.fn().mockResolvedValue({ stdout: "git@github.com:taskbrain/app.git\n" }),
      parseRemoteUrl: vi.fn().mockReturnValue({ kind: "github", owner: "taskbrain", repo: "app" }),
    });
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, deps);
    expect(deps.execFile).toHaveBeenCalledWith("git", ["remote", "get-url", "origin"], expect.objectContaining({ cwd: dir }));
    expect(deps.parseRemoteUrl).toHaveBeenCalledWith("git@github.com:taskbrain/app.git");
    expect(out.vcs).toEqual({ kind: "github", owner: "taskbrain", repo: "app" });
    expect(readWritten().vcs.kind).toBe("github");
    expect(out.warnings).toEqual([]);
  });

  it("backlog remote はリポジトリ実在確認のうえ保持する", async () => {
    const vcs = { kind: "backlog", webBase: "https://ex.backlog.com", projectKey: "PROJ", repoName: "app" };
    const deps = baseDeps({}, {
      execFile: vi.fn().mockResolvedValue({ stdout: "ex@ex.git.backlog.com:/PROJ/app.git\n" }),
      parseRemoteUrl: vi.fn().mockReturnValue(vcs),
    });
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, deps);
    expect(deps.rest.getGitRepositories).toHaveBeenCalledWith("PROJ");
    expect(out.vcs).toEqual(vcs);
    expect(readWritten().vcs).toEqual(vcs);
  });

  it("backlog remote のリポジトリが見つからなければ警告して generic", async () => {
    const deps = baseDeps({
      getGitRepositories: vi.fn().mockResolvedValue([{ id: 9, name: "other" }]),
    }, {
      execFile: vi.fn().mockResolvedValue({ stdout: "ex@ex.git.backlog.com:/PROJ/app.git\n" }),
      parseRemoteUrl: vi.fn().mockReturnValue({ kind: "backlog", webBase: "https://ex.backlog.com", projectKey: "PROJ", repoName: "app" }),
    });
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, deps);
    expect(out.vcs.kind).toBe("generic");
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toContain("app");
  });

  it("remote 取得に失敗したら generic", async () => {
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, baseDeps());
    expect(out.vcs).toEqual({ kind: "generic" });
    expect(readWritten().vcs.kind).toBe("generic");
  });

  it("--vcs generic の上書きでは git 実行ごとスキップする", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "git@github.com:taskbrain/app.git\n" });
    const deps = baseDeps({}, { execFile });
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10, vcsOverride: "generic" }, deps);
    expect(execFile).not.toHaveBeenCalled();
    expect(out.vcs.kind).toBe("generic");
  });

  it("--vcs github の上書きは検出結果の kind を差し替える", async () => {
    const deps = baseDeps({}, {
      execFile: vi.fn().mockResolvedValue({ stdout: "https://example.com/foo/bar.git\n" }),
      parseRemoteUrl: vi.fn().mockReturnValue({ kind: "generic" }),
    });
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10, vcsOverride: "github" }, deps);
    expect(out.vcs.kind).toBe("github");
  });

  it("textFormattingRule / categories / versions / resolutions / myselfId を保存する", async () => {
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, baseDeps());
    const written = readWritten();
    expect(written.textFormattingRule).toBe("markdown");
    expect(out.textFormattingRule).toBe("markdown");
    expect(written.categories).toEqual([{ id: 101, name: "フロントエンド" }]);
    expect(written.versions[0]).toEqual({ id: 201, name: "v1.0", startDate: "2026-06-01", releaseDueDate: "2026-06-30", archived: false });
    expect(written.resolutions).toEqual([{ id: 0, name: "対応済み" }, { id: 1, name: "対応しない" }]);
    expect(written.myselfId).toBe(5);
  });

  it("resolutionFixedId は id:0（対応済み）でも欠落せず保存される", async () => {
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, baseDeps());
    const written = readWritten();
    expect(written.resolutionFixedId).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(written, "resolutionFixedId")).toBe(true);
    expect(out.resolutionFixedId).toBe(0);
  });

  it("fieldRules 雛形が無ければ既定値を書き込む（summarize は既定 claude）", async () => {
    await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, baseDeps());
    expect(readWritten().fieldRules).toEqual({ assignSelf: true, resolutionOnResolve: true, milestone: "off", summarize: "claude" });
  });

  it("既存の fieldRules（ユーザー設定）は保持する", async () => {
    const cfgDir = join(dir, ".claude", "backlog-agent-sync");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "project.json"), JSON.stringify({
      fieldRules: { assignSelf: false, milestone: "current", categoryRules: { "フロントエンド": ["liff"] } },
      customKey: "keep-me",
    }), "utf8");
    await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, baseDeps());
    const written = readWritten();
    expect(written.fieldRules).toEqual({ assignSelf: false, milestone: "current", categoryRules: { "フロントエンド": ["liff"] } });
    expect(written.customKey).toBe("keep-me"); // 未知キーも保持
  });
});
