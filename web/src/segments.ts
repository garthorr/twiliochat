/**
 * SMS segment accounting. Carriers bill per segment, so the composer shows
 * the count once a message is close to splitting.
 *
 * GSM-7 fits 160 characters in one segment, 153 per segment when split.
 * Anything outside that alphabet (emoji, curly quotes, most accents) forces
 * UCS-2: 70 characters, or 67 per segment when split.
 */

const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
// These take two GSM-7 characters (escape + char).
const GSM7_EXTENDED = "^{}\\[~]|€";

export interface SegmentInfo {
  characters: number;
  segments: number;
  encoding: "GSM-7" | "UCS-2";
  /** Characters left before another segment is added. */
  remaining: number;
}

export function segmentInfo(text: string): SegmentInfo {
  const chars = [...text];
  const isGsm7 = chars.every(
    (c) => GSM7.includes(c) || GSM7_EXTENDED.includes(c),
  );

  if (isGsm7) {
    const units = chars.reduce(
      (sum, c) => sum + (GSM7_EXTENDED.includes(c) ? 2 : 1),
      0,
    );
    const segments = units <= 160 ? Math.max(1, Math.ceil(units / 160)) : Math.ceil(units / 153);
    const capacity = units <= 160 ? 160 : segments * 153;
    return {
      characters: units,
      segments,
      encoding: "GSM-7",
      remaining: capacity - units,
    };
  }

  // UCS-2 counts UTF-16 code units, so astral emoji cost two.
  const units = text.length;
  const segments = units <= 70 ? Math.max(1, Math.ceil(units / 70)) : Math.ceil(units / 67);
  const capacity = units <= 70 ? 70 : segments * 67;
  return {
    characters: units,
    segments,
    encoding: "UCS-2",
    remaining: capacity - units,
  };
}

/** Only worth showing once a message is near or past a segment boundary. */
export function shouldShowCounter(info: SegmentInfo): boolean {
  return info.segments > 1 || info.remaining <= 20;
}
