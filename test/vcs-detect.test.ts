import { describe, it, expect } from "vitest";
import { parseRemoteUrl } from "../src/vcs/detect.js";

describe("parseRemoteUrl", () => {
  it("github: https / scp風 / ssh:// の3形式（.git 任意）", () => {
    expect(parseRemoteUrl("https://github.com/taskbrain/backlog-agent-sync.git"))
      .toEqual({ kind: "github", owner: "taskbrain", repo: "backlog-agent-sync" });
    expect(parseRemoteUrl("git@github.com:taskbrain/backlog-agent-sync.git"))
      .toEqual({ kind: "github", owner: "taskbrain", repo: "backlog-agent-sync" });
    expect(parseRemoteUrl("ssh://git@github.com/taskbrain/backlog-agent-sync"))
      .toEqual({ kind: "github", owner: "taskbrain", repo: "backlog-agent-sync" });
  });

  it("backlog: ssh:// は git. サブドメインを除去して webBase を組む", () => {
    expect(parseRemoteUrl("ssh://xx@xx.git.backlog.jp/PROJ/repo.git"))
      .toEqual({ kind: "backlog", webBase: "https://xx.backlog.jp", projectKey: "PROJ", repoName: "repo" });
  });

  it("backlog: scp風（backlog.com / backlogtool.com）", () => {
    expect(parseRemoteUrl("xx@xx.git.backlog.com:/PROJ/repo.git"))
      .toEqual({ kind: "backlog", webBase: "https://xx.backlog.com", projectKey: "PROJ", repoName: "repo" });
    expect(parseRemoteUrl("xx@xx.git.backlogtool.com:/PROJ/repo.git"))
      .toEqual({ kind: "backlog", webBase: "https://xx.backlogtool.com", projectKey: "PROJ", repoName: "repo" });
  });

  it("backlog: https クローン URL（/git/<PROJ>/<repo>）", () => {
    expect(parseRemoteUrl("https://xx.backlog.jp/git/PROJ/repo.git"))
      .toEqual({ kind: "backlog", webBase: "https://xx.backlog.jp", projectKey: "PROJ", repoName: "repo" });
  });

  it("generic: GHE / 不正文字列 / パス情報不足", () => {
    expect(parseRemoteUrl("https://ghe.example.com/o/r.git").kind).toBe("generic"); // GitHub Enterprise は generic
    expect(parseRemoteUrl("").kind).toBe("generic");
    expect(parseRemoteUrl("not a url").kind).toBe("generic");
    expect(parseRemoteUrl("https://github.com/only-owner").kind).toBe("generic");
  });
});
