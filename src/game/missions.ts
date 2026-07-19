import { progression, type Saved } from './progression';

/**
 * The mission chain — the campaign's spine, and the only thing that scores the operator.
 *
 * A mission asks for a number of VALID marks and tolerates a number of invalid ones. Validity is
 * settled against the unit's true infection state at the instant the order lands, which the
 * operator cannot see: they see the assessment and the charge sheet (see intel.ts) and have to
 * decide. Cross the invalid ceiling and the mission fails, the campaign rolls back to the snapshot
 * taken when it was accepted, and a penalty comes off the top.
 *
 * Missions unlock in order, and one runs at a time — the active mission is also what decides
 * whether the order button reads INVESTIGATE or EXECUTE.
 */

export type MarkKind = 'investigate' | 'execute';
export type Authorization = 'execute';

export interface MissionDef {
  id: string;
  name: string;
  brief: string;
  /** What kind of order this mission is scored on. Also sets the order button's mode while active. */
  mark: MarkKind;
  /** Valid marks needed to complete. */
  target: number;
  /** Invalid marks tolerated. The (target+1)th invalid fails the mission. */
  maxInvalid: number;
  reward: number;
  /** Officers forfeited on failure, charged after the rollback. */
  penalty: number;
  /** Completing this mission grants a standing authorization. */
  grants?: Authorization;
  /** Must be completed first. */
  requires?: string;
}

export const MISSIONS: MissionDef[] = [
  {
    id: 'baseline',
    name: 'BASELINE SURVEY',
    brief:
      'Establish a working read on the field. Flag contacts for investigation and keep the false-flag rate down.',
    mark: 'investigate',
    // Tolerances are set against measured hit rates, not by feel. Working inside city coverage —
    // all a fresh campaign has — a player marking every contact that reads hot lands around 67%
    // valid, because the obelisk net suppresses infection in exactly the ground it lets you act on.
    // 12/8 needs 60%, so the opening tasking is passable there and comfortable once the disc
    // observer opens up the dark, where the same play measures ~90%.
    target: 12,
    maxInvalid: 8,
    reward: 2500,
    penalty: 750,
  },
  {
    id: 'pattern',
    name: 'PATTERN OF LIFE',
    brief:
      'Sustained surveillance at volume. Clearing this releases lethal authority to the operator.',
    mark: 'investigate',
    target: 30,
    maxInvalid: 14,
    reward: 6000,
    penalty: 2000,
    grants: 'execute',
    requires: 'baseline',
  },
  {
    id: 'sanction',
    name: 'SANCTION',
    brief:
      'Execution authority is live. Orders hold for 8 seconds before arming — rescind inside that window or not at all. Armed contacts are serviced by the first obelisk or disc that acquires them.',
    mark: 'execute',
    target: 10,
    maxInvalid: 3,
    reward: 14_000,
    penalty: 6000,
    requires: 'pattern',
  },
  {
    id: 'pressure',
    name: 'SUSTAINED PRESSURE',
    brief: 'Hold the standard at scale. The tolerance does not scale with the quota.',
    mark: 'execute',
    target: 25,
    maxInvalid: 5,
    reward: 30_000,
    penalty: 12_000,
    requires: 'sanction',
  },
];

export type MissionStatus = 'locked' | 'available' | 'active' | 'complete';

/** Running tally for the mission in progress. */
export interface ActiveRun {
  id: string;
  valid: number;
  invalid: number;
  /** Where the campaign gets rolled back to if this mission fails. */
  restore: Saved;
}

/** The lifetime ledger, shown on the missions panel whether or not anything is active. */
export interface Ledger {
  investigations: number;
  executions: number;
  valid: number;
  invalid: number;
}

const SAVE_KEY = 'gorgon.missions.v1';

interface SavedMissions {
  completed: string[];
  auths: Authorization[];
  active: ActiveRun | null;
  ledger: Ledger;
}

export type MissionEvent =
  | { type: 'progress' }
  | { type: 'complete'; mission: MissionDef }
  | { type: 'failed'; mission: MissionDef };

export class Missions {
  private completed = new Set<string>();
  private auths = new Set<Authorization>();
  private active: ActiveRun | null = null;
  private _ledger: Ledger = { investigations: 0, executions: 0, valid: 0, invalid: 0 };
  private listeners = new Set<(e: MissionEvent) => void>();

  constructor() {
    this.load();
  }

  get ledger(): Ledger {
    return this._ledger;
  }

  activeRun(): ActiveRun | null {
    return this.active;
  }

  activeDef(): MissionDef | undefined {
    return this.active ? MISSIONS.find((m) => m.id === this.active!.id) : undefined;
  }

  hasAuth(a: Authorization): boolean {
    return this.auths.has(a);
  }

  /**
   * Which order the mark button issues right now. Execution needs both the standing authorization
   * and an active mission that calls for it — lethal authority isn't left switched on by default.
   */
  markKind(): MarkKind {
    const def = this.activeDef();
    if (def?.mark === 'execute' && this.hasAuth('execute')) return 'execute';
    return 'investigate';
  }

  statusOf(m: MissionDef): MissionStatus {
    if (this.completed.has(m.id)) return 'complete';
    if (this.active?.id === m.id) return 'active';
    if (m.requires && !this.completed.has(m.requires)) return 'locked';
    return 'available';
  }

  onChange(fn: (e: MissionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: MissionEvent): void {
    this.save();
    for (const fn of this.listeners) fn(e);
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  accept(m: MissionDef): boolean {
    if (this.statusOf(m) !== 'available') return false;
    // The restore point is taken here, before the operator has made a single call.
    this.active = { id: m.id, valid: 0, invalid: 0, restore: progression.snapshot() };
    this.emit({ type: 'progress' });
    return true;
  }

  /** Stand down voluntarily. Costs nothing — only failure rolls the campaign back. */
  abandon(): boolean {
    if (!this.active) return false;
    this.active = null;
    this.emit({ type: 'progress' });
    return true;
  }

  /**
   * Record one order and its verdict. Returns what it did to the active mission.
   *
   * Orders are always logged to the lifetime ledger, active mission or not — the operator's record
   * doesn't pause between taskings.
   */
  report(kind: MarkKind, valid: boolean): MissionEvent {
    if (kind === 'execute') this._ledger.executions++;
    else this._ledger.investigations++;
    if (valid) this._ledger.valid++;
    else this._ledger.invalid++;

    const def = this.activeDef();
    if (!def || !this.active || def.mark !== kind) {
      this.emit({ type: 'progress' });
      return { type: 'progress' };
    }

    if (valid) this.active.valid++;
    else this.active.invalid++;

    if (this.active.invalid > def.maxInvalid) {
      progression.restore(this.active.restore, def.penalty);
      this.active = null;
      const e: MissionEvent = { type: 'failed', mission: def };
      this.emit(e);
      return e;
    }
    if (this.active.valid >= def.target) {
      this.completed.add(def.id);
      if (def.grants) this.auths.add(def.grants);
      this.active = null;
      progression.award(def.reward);
      const e: MissionEvent = { type: 'complete', mission: def };
      this.emit(e);
      return e;
    }
    this.emit({ type: 'progress' });
    return { type: 'progress' };
  }

  // ---- persistence -----------------------------------------------------------------------------

  private save(): void {
    try {
      const data: SavedMissions = {
        completed: [...this.completed],
        auths: [...this.auths],
        active: this.active,
        ledger: this._ledger,
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch {
      // Storage unavailable — the chain just doesn't persist.
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as SavedMissions;
      for (const id of s.completed ?? []) this.completed.add(id);
      for (const a of s.auths ?? []) this.auths.add(a);
      this.active = s.active ?? null;
      if (s.ledger) this._ledger = s.ledger;
    } catch {
      // Corrupt save: start the chain over rather than half-restoring it.
    }
  }

  reset(): void {
    this.completed.clear();
    this.auths.clear();
    this.active = null;
    this._ledger = { investigations: 0, executions: 0, valid: 0, invalid: 0 };
    this.emit({ type: 'progress' });
  }
}

export const missions = new Missions();
