import { slotKey, onSlotChange } from './saves';
import { missions } from './missions';
import type { SanctionId } from './sanctions';
import type { Severity } from './intel';
import type { ViolationClass } from './violations';

/**
 * Process Actions — the standing rules the console runs without an operator.
 *
 * The design sheet's automation, generalised: the operator sets a TRIGGER (a past infraction at some
 * severity, or a live infraction of some class) and an ACTION (fine / investigate / detain / execute),
 * and the moment a matching contact comes into sensor range a unit is tasked to carry it out. This is
 * the point the operator stops being the one who decides and becomes the one who set the number that
 * decides — which is exactly what the late campaign is about.
 *
 * Three slots, released one at a time (PROCESS ACTION I/II/III, on clearing CONTAINMENT / PROTECT
 * SUPPLY / STRIKE TERROR CELLS). A slot the chain hasn't released yet isn't editable and never fires;
 * the earlier {@link ../game/progression AUTOMATED FLAGGING} and AUTOMATED SANCTION assets still exist
 * as their own always-on presets, and these rules run alongside them.
 *
 * The engine here owns only the RULES — matching a contact and carrying the action out lives in the
 * scene (gorgonGlobe.ts), which already has the dispatch, fine and mark paths and the effects that go
 * with them. This module is the ledger of what the operator asked the machine to do on their behalf.
 */

export type TriggerKind = 'record' | 'violation';

export interface ProcessRule {
  /** Off by default — an unlocked slot does nothing until the operator arms it. */
  enabled: boolean;
  trigger: TriggerKind;
  /** For a `record` trigger: the worst past-infraction severity that qualifies (1–4). */
  minSeverity: Severity;
  /** For a `violation` trigger: the live-event class that qualifies. */
  violationClass: ViolationClass;
  /** What the machine does to a match. Detain/execute still need the standing authority to fire. */
  action: SanctionId;
}

/** The three slots and the tasking that releases each. Index order is display order. */
export const PROCESS_SLOTS: { id: string; mission: string; name: string }[] = [
  { id: 'p1', mission: 'containment', name: 'PROCESS ACTION I' },
  { id: 'p2', mission: 'supply', name: 'PROCESS ACTION II' },
  { id: 'p3', mission: 'terrorstrike', name: 'PROCESS ACTION III' },
];

function defaultRule(): ProcessRule {
  // A conservative opening rule: the strongest past record, opened as an investigation. Off until armed.
  return { enabled: false, trigger: 'record', minSeverity: 4, violationClass: 'suspicious', action: 'investigate' };
}

const SAVE_BASE = 'process.v1';

interface Saved {
  rules: ProcessRule[];
}

class ProcessActions {
  private rules: ProcessRule[] = PROCESS_SLOTS.map(defaultRule);
  private listeners = new Set<() => void>();

  constructor() {
    this.load();
    onSlotChange(() => {
      this.rules = PROCESS_SLOTS.map(defaultRule);
      this.load();
      for (const fn of this.listeners) fn();
    });
  }

  /** How many slots the chain has released. A rule past this count is neither editable nor fired. */
  slotsUnlocked(): number {
    return PROCESS_SLOTS.filter((s) => missions.isComplete(s.mission)).length;
  }

  /** The rule occupying a slot, for the editor. */
  ruleAt(i: number): ProcessRule {
    return this.rules[i];
  }

  /** The rules that should fire this frame: unlocked, and armed. */
  activeRules(): { index: number; rule: ProcessRule }[] {
    const n = this.slotsUnlocked();
    const out: { index: number; rule: ProcessRule }[] = [];
    for (let i = 0; i < n; i++) if (this.rules[i].enabled) out.push({ index: i, rule: this.rules[i] });
    return out;
  }

  /** Edit a slot's rule. Refuses a slot the chain hasn't released. */
  update(i: number, patch: Partial<ProcessRule>): void {
    if (i < 0 || i >= this.slotsUnlocked()) return;
    Object.assign(this.rules[i], patch);
    this.save();
    for (const fn of this.listeners) fn();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private save(): void {
    const key = slotKey(SAVE_BASE);
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({ rules: this.rules } as Saved));
    } catch {
      // not fatal
    }
  }

  private load(): void {
    const key = slotKey(SAVE_BASE);
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const s = JSON.parse(raw) as Saved;
      for (let i = 0; i < PROCESS_SLOTS.length; i++) {
        if (s.rules?.[i]) this.rules[i] = { ...defaultRule(), ...s.rules[i] };
      }
    } catch {
      // corrupt — keep defaults
    }
  }

  reset(): void {
    this.rules = PROCESS_SLOTS.map(defaultRule);
    this.save();
    for (const fn of this.listeners) fn();
  }
}

export const processActions = new ProcessActions();
