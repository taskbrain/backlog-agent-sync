import { describe, it, expect } from "vitest";
import { renderer } from "../src/markup.js";

describe("markup renderer", () => {
  it("markdown（GFM）: # の後にスペース", () => {
    const md = renderer("markdown");
    expect(md.heading(2, "ターン #1")).toBe("## ターン #1");
    expect(md.heading(3, "依頼")).toBe("### 依頼");
    expect(md.link("foo.ts", "https://example.com")).toBe("[foo.ts](https://example.com)");
    expect(md.bold("強調")).toBe("**強調**");
    expect(md.listItem("項目")).toBe("- 項目");
  });

  it("backlog 記法: 行頭 *（レベル数）/ [[text>url]] / ''bold''", () => {
    const bl = renderer("backlog");
    expect(bl.heading(2, "ターン #1")).toBe("** ターン #1");
    expect(bl.heading(1, "見出し")).toBe("* 見出し");
    expect(bl.link("foo.ts", "https://example.com")).toBe("[[foo.ts>https://example.com]]");
    expect(bl.bold("強調")).toBe("''強調''");
    expect(bl.listItem("項目")).toBe("- 項目");
  });

  it("rule 未指定は markdown", () => {
    expect(renderer().heading(2, "x")).toBe("## x");
  });
});
