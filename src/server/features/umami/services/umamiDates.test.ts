import { describe, expect, it } from "vitest";
import { resolveUmamiDateRange } from "./umamiDates";

const timeZone = "Europe/Madrid";

function localParts(epochMs: number) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(epochMs));
}

describe("resolveUmamiDateRange", () => {
  it("defaults to the last 28 complete days with a matching previous window", () => {
    const result = resolveUmamiDateRange({
      timeZone,
      now: new Date("2026-03-15T10:00:00Z"),
    });
    expect(result.requested).toEqual({ startDate: null, endDate: null });
    expect(result.dayCount).toBe(28);
    expect(result.warnings).toEqual([]);
    expect(result.current).toMatchObject({
      startDate: "2026-02-15",
      endDate: "2026-03-14",
    });
    expect(result.previous).toMatchObject({
      startDate: "2026-01-18",
      endDate: "2026-02-14",
    });
  });

  it("computes DST-correct bounds across the 2026-10-25 Madrid change", () => {
    const { current } = resolveUmamiDateRange({
      timeZone,
      startDate: "2026-10-24",
      endDate: "2026-10-26",
      now: new Date("2026-11-10T10:00:00Z"),
    });
    // 24h + 25h + 24h
    expect(current.endAt - current.startAt + 1).toBe(73 * 3_600_000);
    expect(localParts(current.startAt)).toBe("24/10/2026, 00:00:00");
    expect(localParts(current.endAt + 1)).toBe("27/10/2026, 00:00:00");
    expect(localParts(current.endAt)).toBe("26/10/2026, 23:59:59");
  });

  it("clamps an end date of today to yesterday", () => {
    const result = resolveUmamiDateRange({
      timeZone,
      startDate: "2026-03-01",
      endDate: "2026-03-15",
      now: new Date("2026-03-15T10:00:00Z"),
    });
    expect(result.current.endDate).toBe("2026-03-14");
    expect(result.requested.endDate).toBe("2026-03-15");
    expect(result.warnings).toEqual(["end_date_clamped"]);
  });

  it.each([
    ["single date", { startDate: "2026-03-01" }],
    ["reversed dates", { startDate: "2026-03-05", endDate: "2026-03-01" }],
    ["impossible date", { startDate: "2026-02-30", endDate: "2026-03-01" }],
    [
      "clamp reverses range",
      { startDate: "2026-03-15", endDate: "2026-03-20" },
    ],
  ])("rejects %s", (_name, input) => {
    expect(() =>
      resolveUmamiDateRange({
        ...input,
        timeZone,
        now: new Date("2026-03-15T10:00:00Z"),
      }),
    ).toThrow(RangeError);
  });
});
