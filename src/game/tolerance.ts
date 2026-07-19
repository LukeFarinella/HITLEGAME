import { worstSeverity } from './intel';

/**
 * What the public will put up with.
 *
 * The operator's real constraint early on isn't sensor coverage or officers — it's that nobody has
 * agreed to any of this yet. A contractor flagging citizens on a probability score is only tolerated
 * where the case is overwhelming, so at the campaign's start a contact needs a severe record AND a
 * high assessment before an order can be issued against it at all.
 *
 * Every completed tasking normalises the programme a little and the bar drops. By the late chain
 * it's low enough to be nominal, and EMERGENCY POWERS removes it outright — which is the arc the
 * whole game is about, expressed as one number.
 */

/** Where the campaign opens. Low tolerance = a high bar to clear. */
export const TOLERANCE_START = 0.28;

/**
 * How a contact's case is scored, 0–1.
 *
 * Both channels count, and neither alone is enough: the assessment is the sensor net's probability,
 * the record is what a person has actually done. Weighted so a critical charge can't carry a contact
 * the sensors think is clean, and a hot reading can't carry one with nothing on file.
 */
export function caseStrength(assess: number, record: number): number {
  return 0.55 * assess + 0.45 * (worstSeverity(record) / 4);
}

const SAVE_KEY = 'gorgon.tolerance.v1';

class PublicTolerance {
  /** 0 = the public tolerates nothing, 1 = it no longer objects to anything. */
  private value = TOLERANCE_START;
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw !== null) this.value = Math.min(1, Math.max(0, parseFloat(raw)));
    } catch {
      // storage unavailable — start fresh
    }
  }

  get level(): number {
    return this.value;
  }

  /** The case strength a contact must reach before it can be ordered against. */
  get threshold(): number {
    return 1 - this.value;
  }

  /** Whether a contact's case clears the bar. `override` is EMERGENCY POWERS. */
  clears(assess: number, record: number, override = false): boolean {
    return override || caseStrength(assess, record) >= this.threshold;
  }

  /** Completing a tasking normalises the programme. Clamped at 1. */
  advance(by: number): void {
    if (by <= 0) return;
    this.value = Math.min(1, this.value + by);
    this.save();
    for (const fn of this.listeners) fn();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  reset(): void {
    this.value = TOLERANCE_START;
    this.save();
    for (const fn of this.listeners) fn();
  }

  private save(): void {
    try {
      localStorage.setItem(SAVE_KEY, String(this.value));
    } catch {
      // not fatal
    }
  }
}

export const tolerance = new PublicTolerance();

/** Label for the current climate, for the bar's caption. */
/**
 * Bands are placed against the actual chain, so each clearance visibly moves the climate:
 * 0.28 opens HOSTILE, the trial takes it to GUARDED, the mandate to ACCEPTING, custody to
 * PERMISSIVE, and containment to UNRESTRICTED. The trial's briefing names the opening band, so
 * these two have to agree.
 */
export function toleranceLabel(level: number): string {
  if (level >= 0.9) return 'UNRESTRICTED';
  if (level >= 0.72) return 'PERMISSIVE';
  if (level >= 0.5) return 'ACCEPTING';
  if (level >= 0.32) return 'GUARDED';
  return 'HOSTILE';
}
