/**
 * Message tones, synthesized with WebAudio — short pitched blips in the spirit
 * of a desktop messenger. Original waveforms, not sampled from any app.
 */

const STORAGE_KEY = "twiliochat:sounds";

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  ctx ??= new AudioContext();
  return ctx;
}

export function soundsEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== "0";
}

export function setSoundsEnabled(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
}

function blip(
  from: number,
  to: number,
  duration: number,
  peak: number,
): void {
  const audio = audioContext();
  if (!audio) return;
  // Browsers suspend the context until a user gesture; resume is a no-op after.
  void audio.resume().catch(() => {});

  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const now = audio.currentTime;

  osc.type = "sine";
  osc.frequency.setValueAtTime(from, now);
  osc.frequency.exponentialRampToValueAtTime(to, now + duration);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain).connect(audio.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

/** Rising blip when a message goes out. */
export function playSent(): void {
  if (!soundsEnabled()) return;
  blip(660, 1180, 0.16, 0.09);
}

/** Falling two-tone when a message arrives. */
export function playReceived(): void {
  if (!soundsEnabled()) return;
  blip(920, 700, 0.2, 0.11);
}
