import { describe, expect, it } from "vitest";
import {
  renderCapabilities,
  renderCompare,
  renderDecompile,
  renderEvidence,
  renderFindings,
  renderJob,
  renderNativeSearch,
  renderReportJob,
  renderTargets,
  table
} from "../src/render.js";

describe("table", () => {
  it("pads columns and keeps the last column intact", () => {
    const rows = table(
      ["ID", "PATH"],
      [["a", "targets/x/reports/very-long-report-name.md"]],
      [4, 12]
    );
    expect(rows[0]).toMatch(/^ID\s{2}PATH$/);
    expect(rows[1]).toContain("targets/x/reports/very-long-report-name.md");
  });

  it("clips a middle column that has a width cap", () => {
    const rows = table(
      ["TYPE", "VALUE", "NOTE"],
      [["route", "x".repeat(50), "kept"]],
      [8, 10, 20]
    );
    expect(rows[1]).toContain("…");
    expect(rows[1]).not.toContain("x".repeat(50));
    expect(rows[1]).toContain("kept");
  });
});

describe("renderTargets", () => {
  it("explains how to create a target when there are none", () => {
    expect(renderTargets([])).toContain("apptrace analyze");
  });

  it("lists id, platform, version and name", () => {
    const text = renderTargets([
      {
        id: "cfeb0b51-0953-4360-b18a-1b89096d231b",
        name: "车工计算器",
        version: "6.0.0",
        targetRef: { platform: "ios" }
      }
    ]);
    expect(text).toContain("cfeb0b51-0953-4360-b18a-1b89096d231b");
    expect(text).toContain("ios");
    expect(text).toContain("车工计算器");
    expect(text).toContain("1 target(s)");
  });
});

describe("renderFindings", () => {
  it("reports the total, not just the page", () => {
    const text = renderFindings({
      items: [
        {
          type: "route",
          value: "../hong/ZuanKong",
          sourcePath: "Pandora/apps/x/app-service.js",
          start: { line: 1, column: 757251 },
          evidenceId: "ev_8b908660e90b125f3825ad058fb7d26109ada82584812c2fec0e4fea0ef94214"
        }
      ],
      total: 249,
      query: "hong"
    });
    expect(text).toContain("249 finding(s), 1 shown for \"hong\"");
    expect(text).toContain("app-service.js:1:757251");
    expect(text).toContain("ev_8b908660e90b125…");
  });

  it("says so when nothing matched", () => {
    expect(renderFindings({ items: [], total: 0, query: "nope" })).toContain(
      "No findings matched \"nope\""
    );
  });
});

describe("native renderers", () => {
  it("surfaces the failure code instead of an empty table", () => {
    const text = renderNativeSearch({
      status: "failed",
      errorCode: "ARTIFACT_ENCRYPTED",
      errorMessage: "all slices encrypted"
    });
    expect(text).toBe("native search failed — ARTIFACT_ENCRYPTED: all slices encrypted");
  });

  it("lists address and symbol", () => {
    const text = renderNativeSearch({
      status: "analyzed",
      result: {
        query: "main",
        kind: "procedures",
        mode: "literal",
        matchCount: 2,
        matches: [{ address: "0x1002d2424", value: "_CFRunLoopGetMain" }]
      }
    });
    expect(text).toContain("2 matches, 1 shown");
    expect(text).toContain("0x1002d2424");
    expect(text).toContain("_CFRunLoopGetMain");
  });

  it("reports a decompile refusal as a refusal", () => {
    const text = renderDecompile({
      status: "failed",
      errorCode: "ARTIFACT_ENCRYPTED",
      errorMessage: "请先使用本人拥有且获授权的解密样本"
    });
    expect(text).toContain("native decompile failed");
    expect(text).toContain("ARTIFACT_ENCRYPTED");
  });

  it("prints pseudocode when present", () => {
    const text = renderDecompile({
      status: "analyzed",
      result: { functionName: "foo", pseudocodePreview: "void foo(void) {\n}" }
    });
    expect(text).toContain("native:decompile foo");
    expect(text).toContain("void foo(void) {");
  });
});

describe("other renderers", () => {
  it("prints the report path", () => {
    expect(
      renderReportJob({ status: "analyzed", result: { reportPath: "targets/t/reports/r.md" } })
    ).toContain("Report: targets/t/reports/r.md");
  });

  it("splits capabilities into available and unavailable", () => {
    const text = renderCapabilities([
      { id: "inspect:ipa", label: "Inspect IPA", available: true },
      { id: "inspect:msix", reason: "Not implemented yet", available: false }
    ]);
    expect(text).toContain("Available (1)");
    expect(text).toContain("Unavailable (1)");
    expect(text).toContain("Not implemented yet");
  });

  it("counts evidence files", () => {
    const text = renderEvidence([{ kind: "native-search", format: "json", path: "a/b.json" }]);
    expect(text).toContain("1 evidence file(s)");
    expect(text).toContain("a/b.json");
  });

  it("shows added and removed values per category", () => {
    const text = renderCompare({
      routes: { added: ["/new"], removed: ["/old"], unchanged: [] }
    });
    expect(text).toContain("+ /new");
    expect(text).toContain("- /old");
  });

  it("renders job events with timestamps", () => {
    const text = renderJob({
      id: "j1",
      capabilityId: "generate:report",
      status: "analyzed",
      progress: 100,
      events: [{ level: "info", message: "done", createdAt: "2026-11-01T02:51:41.727Z" }]
    });
    expect(text).toContain("Status: analyzed (100%)");
    expect(text).toContain("2026-11-01 02:51:41 [info] done");
  });
});
