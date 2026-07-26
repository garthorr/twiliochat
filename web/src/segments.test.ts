import { describe, expect, it } from "vitest";
import { segmentInfo, shouldShowCounter } from "./segments";

describe("SMS segment accounting", () => {
  it("counts a plain message as one GSM-7 segment", () => {
    const info = segmentInfo("hello there");
    expect(info.encoding).toBe("GSM-7");
    expect(info.segments).toBe(1);
    expect(info.characters).toBe(11);
    expect(info.remaining).toBe(149);
  });

  it("splits GSM-7 at 160, then bills 153 per segment", () => {
    expect(segmentInfo("a".repeat(160)).segments).toBe(1);
    expect(segmentInfo("a".repeat(161)).segments).toBe(2);
    expect(segmentInfo("a".repeat(306)).segments).toBe(2);
    expect(segmentInfo("a".repeat(307)).segments).toBe(3);
  });

  it("charges two units for GSM-7 extended characters", () => {
    // A single '€' costs an escape plus the character.
    expect(segmentInfo("€").characters).toBe(2);
    expect(segmentInfo("€".repeat(80)).segments).toBe(1);
    expect(segmentInfo("€".repeat(81)).segments).toBe(2);
  });

  it("drops to UCS-2 when a character is outside GSM-7", () => {
    const info = segmentInfo("hello 👋");
    expect(info.encoding).toBe("UCS-2");
    expect(info.segments).toBe(1);

    expect(segmentInfo("é".repeat(70)).encoding).toBe("GSM-7");
    expect(segmentInfo("😀".repeat(35)).segments).toBe(1);
    // Astral emoji cost two UTF-16 units each, so 36 tips into a second.
    expect(segmentInfo("😀".repeat(36)).segments).toBe(2);
  });

  it("only shows the counter near or past a boundary", () => {
    expect(shouldShowCounter(segmentInfo("short"))).toBe(false);
    expect(shouldShowCounter(segmentInfo("a".repeat(145)))).toBe(true);
    expect(shouldShowCounter(segmentInfo("a".repeat(200)))).toBe(true);
  });
});
