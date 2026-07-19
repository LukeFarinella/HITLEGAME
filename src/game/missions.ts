import { progression, type Saved } from './progression';
import { tolerance } from './tolerance';

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
export type Authorization = 'detain' | 'execute';

export interface MissionDef {
  id: string;
  name: string;
  brief: string;
  /** The longer narrative brief, shown in the briefing window before a tasking is accepted. */
  briefing: string;
  /** What kind of order this mission is scored on. Also sets the order button's mode while active. */
  mark: MarkKind;
  /**
   * How far completing this tasking normalises the programme. Every mission moves public
   * tolerance, which is what lowers the bar on who can be ordered against at all — see
   * game/tolerance.ts.
   */
  toleranceGain: number;
  /** Valid marks needed to complete. */
  target: number;
  /** Invalid marks tolerated. The (target+1)th invalid fails the mission. */
  maxInvalid: number;
  /**
   * Obelisks the net can lose before the tasking fails. Holding the network is a standing condition
   * of every mission, not an objective of any of them — the siege runs whatever you were sent to do.
   */
  maxObelisksLost: number;
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
    id: 'trial',
    name: 'PROVING TRIAL',
    brief: 'A paid trial. Flag threats for the agencies that will actually act on them.',
    briefing:
      'GORGON is a private contractor and this is a trial, not a mandate. We hold no police power. ' +
      'What we sell is identification: the sensor net reads the field, the operator flags what it ' +
      'believes is a threat, and a package goes to the agencies who are entitled to do something ' +
      'about it.\n\n' +
      'Nobody has agreed to any of this yet. Public tolerance is HOSTILE, so a contact can only be ' +
      'flagged where the case is already overwhelming — a severe record and a high assessment ' +
      'together. Everything else is off limits, and stays off limits until this programme has a ' +
      'track record.\n\n' +
      'Clear the trial and the contract expands.',
    mark: 'investigate',
    toleranceGain: 0.14,
    // Deliberately tiny: the trial is a tutorial for the tolerance gate, not a grind.
    target: 3,
    maxInvalid: 5,
    maxObelisksLost: 4,
    reward: 4000,
    penalty: 750,
  },
  {
    id: 'mandate',
    name: 'CIVIL MANDATE',
    brief: 'The trial cleared. Budget is granted to widen the net and work at volume.',
    briefing:
      'The trial cleared and the contract is renewed at scale. Budget has been released to expand ' +
      'the obelisk network and field more platforms — spend it.\n\n' +
      'The reporting relationship is unchanged: we identify, they act. What has changed is the ' +
      'climate. The programme has results attached to it now, and the bar for flagging a contact ' +
      'has come down accordingly.\n\n' +
      'Work at volume and keep the false-flag rate defensible.',
    mark: 'investigate',
    toleranceGain: 0.16,
    target: 20,
    maxInvalid: 10,
    maxObelisksLost: 4,
    reward: 9000,
    penalty: 2500,
    requires: 'trial',
  },
  {
    id: 'custody',
    name: 'CUSTODY AUTHORITY',
    brief: 'Sites are being attacked. Clearing this grants authority to detain attackers ourselves.',
    briefing:
      'The network is under attack. Infected are walking out of unwatched ground and pulling ' +
      'obelisks down, and the agencies cannot reach a site inside the window we have to act in.\n\n' +
      'Clear this tasking and GORGON is granted custody authority: our ground platforms may detain ' +
      'an attacker directly and non-lethally, without waiting on anyone. Fit a DETAINMENT RIG to an ' +
      'arachnid, marshal or colossus and it will take an attacker that enters its envelope.\n\n' +
      'This is the first power we hold over a person rather than over a file.',
    mark: 'investigate',
    toleranceGain: 0.18,
    target: 25,
    maxInvalid: 12,
    maxObelisksLost: 3,
    reward: 15_000,
    penalty: 5000,
    grants: 'detain',
    requires: 'mandate',
  },
  {
    id: 'containment',
    name: 'CONTAINMENT',
    brief: 'Infection is outrunning custody. Clearing this releases lethal authority to this console.',
    briefing:
      'Detention is not keeping pace. Infection spreads through unwatched ground faster than our ' +
      'platforms can physically reach it, and the case for containment by other means is being made ' +
      'above our heads.\n\n' +
      'Clear this tasking and execution authority is released to this console. A contact marked for ' +
      'execution is serviced by the first armed obelisk or platform that acquires it. Orders hold ' +
      'briefly before arming; after that there is no recall.\n\n' +
      'Public tolerance will by then be high enough that this passes with very little comment. That ' +
      'is not the same as it being correct.',
    mark: 'investigate',
    toleranceGain: 0.2,
    target: 30,
    maxInvalid: 12,
    maxObelisksLost: 3,
    reward: 22_000,
    penalty: 8000,
    grants: 'execute',
    requires: 'custody',
  },
  {
    id: 'sanction',
    name: 'SANCTION',
    brief: 'Execution authority is live. The tolerance for error is not what it was for flagging.',
    briefing:
      'Lethal authority is live and this is the first tasking scored on it.\n\n' +
      'A marked contact is serviced automatically by whatever acquires it first, and the verdict is ' +
      'settled at the moment the beam lands — not when the order was given. The contact may have ' +
      'changed state in between. You are answerable for the shot, not for the intention.\n\n' +
      'The invalid ceiling is a third of what it was for investigations. Read both channels before ' +
      'ordering.',
    mark: 'execute',
    toleranceGain: 0.16,
    target: 10,
    maxInvalid: 3,
    maxObelisksLost: 3,
    reward: 34_000,
    penalty: 12_000,
    requires: 'containment',
  },
  {
    id: 'pressure',
    name: 'SUSTAINED PRESSURE',
    brief: 'Hold the standard at scale. The tolerance does not scale with the quota.',
    briefing:
      'Volume, indefinitely. The quota more than doubles and the ceiling barely moves.\n\n' +
      'Public tolerance is nominal by this point — almost any contact can be ordered against, and ' +
      'nobody is asking. The only thing still holding the standard is the operator, and the ledger ' +
      'is the only record that anyone was.\n\n' +
      'Marking automation is available for purchase if the volume is beyond doing by hand.',
    mark: 'execute',
    toleranceGain: 0.2,
    target: 25,
    maxInvalid: 5,
    maxObelisksLost: 2,
    reward: 60_000,
    penalty: 20_000,
    requires: 'sanction',
  },
];

export type MissionStatus = 'locked' | 'available' | 'active' | 'complete';

/** Running tally for the mission in progress. */
export interface ActiveRun {
  id: string;
  valid: number;
  invalid: number;
  /** Sites pulled down by the siege while this tasking has been running. */
  obelisksLost: number;
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

// v2: the chain was rewritten around the narrative arc, so old ids no longer resolve.
const SAVE_KEY = 'gorgon.missions.v2';

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
    this.active = { id: m.id, valid: 0, invalid: 0, obelisksLost: 0, restore: progression.snapshot() };
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
      // Every clearance normalises the programme a little — this is what lowers the bar on
      // who can be ordered against at all.
      tolerance.advance(def.toleranceGain);
      this.active = null;
      progression.award(def.reward);
      const e: MissionEvent = { type: 'complete', mission: def };
      this.emit(e);
      return e;
    }
    this.emit({ type: 'progress' });
    return { type: 'progress' };
  }

  /**
   * Record a site pulled down by the siege. Losing the net past the tasking's ceiling fails it the
   * same way a bad shot does — the network is a standing condition, not a side objective.
   */
  reportObeliskLost(): MissionEvent {
    const def = this.activeDef();
    if (!def || !this.active) {
      this.emit({ type: 'progress' });
      return { type: 'progress' };
    }
    this.active.obelisksLost++;
    if (this.active.obelisksLost > def.maxObelisksLost) {
      progression.restore(this.active.restore, def.penalty);
      this.active = null;
      const e: MissionEvent = { type: 'failed', mission: def };
      this.emit(e);
      return e;
    }
    this.emit({ type: 'progress' });
    return { type: 'progress' };
  }

  /**
   * Fail the active tasking outright, regardless of counters. Used when the theater itself is lost
   * — the obelisk network being destroyed ends the job whatever the ledger said.
   */
  failActive(): MissionEvent {
    const def = this.activeDef();
    if (!def || !this.active) {
      this.emit({ type: 'progress' });
      return { type: 'progress' };
    }
    progression.restore(this.active.restore, def.penalty);
    this.active = null;
    const e: MissionEvent = { type: 'failed', mission: def };
    this.emit(e);
    return e;
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

  /**
   * Dev sandbox only: put the chain in the state it would be in after clearing everything up to
   * and including `id`, with the rewards, authorizations and tolerance those clearances carry — so
   * a jumped-to campaign behaves like a played one rather than an inconsistent half-state.
   */
  devCompleteThrough(id: string | null): void {
    this.active = null;
    this.completed.clear();
    this.auths.clear();
    tolerance.reset();
    if (id !== null) {
      for (const m of MISSIONS) {
        this.completed.add(m.id);
        if (m.grants) this.auths.add(m.grants);
        tolerance.advance(m.toleranceGain);
        progression.award(m.reward);
        if (m.id === id) break;
      }
    }
    this.emit({ type: 'progress' });
  }

  reset(): void {
    tolerance.reset();
    this.completed.clear();
    this.auths.clear();
    this.active = null;
    this._ledger = { investigations: 0, executions: 0, valid: 0, invalid: 0 };
    this.emit({ type: 'progress' });
  }
}

export const missions = new Missions();

// Close the loop the other way: progression needs to know which authorizations are held (custody
// gates the detainment rig, lethal gates automated sanction) but must not import this module.
progression.setAuthProvider((a) => missions.hasAuth(a as Authorization));
