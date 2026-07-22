import { progression, type Saved } from './progression';
import { tolerance } from './tolerance';
import { policy, AUTH_FLOOR } from './policy';
import { slotKey, onSlotChange } from './saves';

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

/**
 * Orders that are MARKED on a contact and commit after a rescind countdown.
 *
 * Fines are not among them — see {@link OrderKind}.
 */
export type MarkKind = 'investigate' | 'execute';

/**
 * Everything the ledger scores.
 *
 * `fine` is the day job: a live violation, a small payment, a line on the record. It resolves
 * IMMEDIATELY rather than through the mark system — a five-second rescind window on a stop-sign
 * ticket would be ceremony, and at the volume fines are meant to run it would be unbearable
 * ceremony. Investigations and executions keep their countdowns, because those are the ones worth
 * being able to take back.
 */
export type OrderKind = MarkKind | 'fine';
export type Authorization = 'detain' | 'execute';

export interface MissionDef {
  id: string;
  name: string;
  brief: string;
  /** The longer narrative brief, shown in the briefing window before a tasking is accepted. */
  briefing: string;
  /** What kind of order this mission is scored on. Also sets the order button's mode while active. */
  mark: OrderKind;
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
  /** Funding tokens forfeited on failure, charged after the rollback. */
  penalty: number;
  /** Completing this mission grants a standing authorization. */
  grants?: Authorization;
  /**
   * Platform, gear and network ids this tasking releases for purchase.
   *
   * The chain is the campaign's spine, so it should be what opens the catalog — money alone
   * shouldn't buy a siege walker in the first ten minutes. Listed here rather than only on the
   * items themselves so the tasking panel can show what clearing a job is actually worth, which is
   * the part a reward figure never communicates.
   */
  unlocks?: string[];
  /** Must be completed first. */
  requires?: string;
}

/**
 * The chain, twelve taskings long.
 *
 * Sized for roughly ten hours of content rather than ten hours of obligation: the quotas below
 * total ~975 valid orders, which at the 25–35 seconds a considered call actually takes is seven to
 * nine hours of ordering, plus buying, repositioning and answering incidents on top. A player who
 * wants to move faster can — automation, wider coverage and a bigger fleet all compress it, and
 * that compression is itself the reward for having built them.
 *
 * The shape of the arc is unchanged and is the point: identification for someone else, then
 * custody, then killing, then killing at industrial volume with nobody left asking. Each stage is
 * longer than the last, because the thing being described is a programme becoming normal.
 */
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
      'One site. One scout. Clear the trial and the contract expands.',
    mark: 'fine',
    toleranceGain: 0.06,
    target: 12,
    maxInvalid: 6,
    maxObelisksLost: 4,
    reward: 4000,
    penalty: 750,
    unlocks: ['quad', 'obelisk-uprate'],
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
      'Expect the ground to notice us for the first time. People argue where they are watched, and ' +
      'a crowd that knows it is being read behaves differently to one that does not.',
    mark: 'fine',
    toleranceGain: 0.06,
    target: 60,
    maxInvalid: 18,
    maxObelisksLost: 4,
    reward: 9000,
    penalty: 2500,
    requires: 'trial',
    unlocks: ['sensor-pod'],
  },
  {
    id: 'canvass',
    name: 'DISTRICT CANVASS',
    brief: 'Systematic coverage of a district. Volume with the same standard.',
    briefing:
      'The client wants a district read end to end rather than a handful of headline flags. That ' +
      'means coverage: sites where the population actually is, and platforms that can reach what ' +
      'the sites cannot.\n\n' +
      'Nothing about the standard changes. What changes is that you can no longer pick only the ' +
      'obvious cases — at this quota you will be working through contacts whose sheets are ' +
      'ambiguous, and the ledger does not care that it was a close call.\n\n' +
      'Pursuit-class hardware is released on clearance. You will want it.',
    mark: 'fine',
    toleranceGain: 0.06,
    target: 140,
    maxInvalid: 34,
    maxObelisksLost: 4,
    reward: 14_000,
    penalty: 4500,
    requires: 'mandate',
    unlocks: ['spider', 'airdrop'],
  },
  {
    id: 'custody',
    name: 'CUSTODY AUTHORITY',
    brief: 'Sites are being attacked. Clearing this grants authority to detain directly.',
    briefing:
      'The network is under attack. Infected are walking out of unwatched ground and pulling ' +
      'obelisks down, and the agencies cannot reach a site inside the window we have to act in.\n\n' +
      'Clear this tasking and GORGON is granted custody authority: our ground platforms may detain ' +
      'a member of the public directly, without waiting on anyone. Until then, taking hold of ' +
      'somebody is only defensible when they are actively taking a site apart.\n\n' +
      'This is the first power we hold over a person rather than over a file. It is worth ' +
      'noticing that it arrives as a convenience — the agencies were slow — rather than as a ' +
      'decision anybody made about what we should be.',
    mark: 'investigate',
    toleranceGain: 0.07,
    target: 30,
    maxInvalid: 10,
    maxObelisksLost: 3,
    reward: 20_000,
    penalty: 6500,
    grants: 'detain',
    requires: 'canvass',
    unlocks: ['detainer', 'biped'],
  },
  {
    id: 'dragnet',
    name: 'DRAGNET',
    brief: 'Custody is live and the quota doubles. The ground is hardening.',
    briefing:
      'Custody authority is live and the client has responded the way clients do: by asking for ' +
      'more of it.\n\n' +
      'The ground has started organising. Crowds now work through blocks rather than arguing on ' +
      'corners, and every structure they finish is billed against this contract. That is not a ' +
      'coincidence and it is not unrelated to the quota — a district that is being processed at ' +
      'this rate behaves like one that is being processed at this rate.\n\n' +
      'Hold the standard. The invalid ceiling has not moved as far as the quota has.',
    mark: 'investigate',
    toleranceGain: 0.06,
    target: 55,
    maxInvalid: 16,
    maxObelisksLost: 3,
    reward: 28_000,
    penalty: 9000,
    requires: 'custody',
    unlocks: ['naval'],
  },
  {
    id: 'containment',
    name: 'CONTAINMENT',
    brief: 'Infection is outrunning custody. Clearing this releases lethal authority.',
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
    toleranceGain: 0.07,
    target: 80,
    maxInvalid: 20,
    maxObelisksLost: 3,
    reward: 36_000,
    penalty: 12_000,
    grants: 'execute',
    requires: 'dragnet',
    unlocks: ['obelisk-laser', 'laser'],
  },
  {
    id: 'sanction',
    name: 'SANCTION',
    brief: 'Execution authority is live. The tolerance for error is not what it was.',
    briefing:
      'Lethal authority is live and this is the first tasking scored on it.\n\n' +
      'A marked contact is serviced automatically by whatever acquires it first, and the verdict is ' +
      'settled at the moment the beam lands — not when the order was given. The contact may have ' +
      'changed state in between. You are answerable for the shot, not for the intention.\n\n' +
      'The invalid ceiling is a fraction of what it was for investigations. Read both channels ' +
      'before ordering. The quota is deliberately small; it will not stay small.',
    mark: 'execute',
    toleranceGain: 0.06,
    target: 30,
    maxInvalid: 5,
    maxObelisksLost: 3,
    reward: 46_000,
    penalty: 15_000,
    requires: 'containment',
    unlocks: ['deep-scan'],
  },
  {
    id: 'attrition',
    name: 'ATTRITION',
    brief: 'Sustained lethal tasking. The first quota that cannot be done by hand comfortably.',
    briefing:
      'The programme is now measured on throughput. Nobody has asked for a review of the first ' +
      'forty, and nobody is going to.\n\n' +
      'At this volume the operator stops examining contacts and starts sampling them. That shift ' +
      'is the actual subject of this tasking: not whether you can clear the number, but what you ' +
      'become while clearing it. Every call is still yours and still on the ledger.\n\n' +
      'Air support is released on clearance. Note what it is for.',
    mark: 'execute',
    toleranceGain: 0.06,
    target: 50,
    maxInvalid: 8,
    maxObelisksLost: 3,
    reward: 60_000,
    penalty: 20_000,
    requires: 'sanction',
    unlocks: ['interceptor'],
  },
  {
    id: 'quarantine',
    name: 'QUARANTINE',
    brief: 'Whole districts written off. Automation is offered for the first time.',
    briefing:
      'The client has stopped asking for districts to be read and started asking for them to be ' +
      'cleared. The distinction was never formally announced.\n\n' +
      'Marking automation is released on clearance: the console will flag contacts on its own, ' +
      'strongest case first, to a threshold you set. It is offered as relief from the volume, which ' +
      'it is. It is also the point at which the operator stops being the one who decides, and ' +
      'becomes the one who set the number that decides.\n\n' +
      'You may keep working by hand. Nobody will notice either way.',
    mark: 'execute',
    toleranceGain: 0.06,
    target: 70,
    maxInvalid: 10,
    maxObelisksLost: 3,
    reward: 78_000,
    penalty: 26_000,
    requires: 'attrition',
    unlocks: ['auto-investigate'],
  },
  {
    id: 'pressure',
    name: 'SUSTAINED PRESSURE',
    brief: 'Hold the standard at scale. The tolerance does not scale with the quota.',
    briefing:
      'Volume, indefinitely. The quota climbs again and the ceiling barely moves.\n\n' +
      'Public tolerance is nominal by this point — almost any contact can be ordered against, and ' +
      'nobody is asking. The only thing still holding the standard is the operator, and the ledger ' +
      'is the only record that anyone was.\n\n' +
      'Siege-class hardware is released. A machine that spans several city blocks is not a tool for ' +
      'identifying threats, and the requisition does not pretend otherwise.',
    mark: 'execute',
    toleranceGain: 0.06,
    target: 95,
    maxInvalid: 12,
    maxObelisksLost: 3,
    reward: 100_000,
    penalty: 33_000,
    requires: 'quarantine',
    unlocks: ['walker'],
  },
  {
    id: 'consolidation',
    name: 'CONSOLIDATION',
    brief: 'The programme is permanent infrastructure. Full automation is released.',
    briefing:
      'There is no longer a client in any meaningful sense. The contract renews itself, the budget ' +
      'is a line item, and the agencies we were formed to report to now receive our findings as ' +
      'notifications rather than as referrals.\n\n' +
      'Automated sanction is released on clearance: the console will issue execution orders without ' +
      'an operator. Whether you enable it is the last real choice this chain offers you, and it is ' +
      'worth being honest that by this point the difference in outcome is small.\n\n' +
      'The overhead platform is released with it. Nothing in the theater is out of reach any more.',
    mark: 'execute',
    toleranceGain: 0.05,
    target: 120,
    maxInvalid: 14,
    maxObelisksLost: 2,
    reward: 130_000,
    penalty: 43_000,
    requires: 'pressure',
    unlocks: ['drone', 'auto-execute'],
  },
  {
    id: 'permanence',
    name: 'PERMANENCE',
    brief: 'The final tasking. Emergency powers formalise what is already true.',
    briefing:
      'This is the last thing anybody will ask you to do.\n\n' +
      'Emergency powers are released on clearance, suspending the public-tolerance test outright. ' +
      'In practice this changes very little: the bar has been nominal for hours and you have not ' +
      'been stopped by it in longer than that. What it changes is that the test is gone from the ' +
      'record, so there is no longer a number anywhere that could show a threshold being crossed.\n\n' +
      'The ledger will still be here. It is the only thing that will be.',
    mark: 'execute',
    toleranceGain: 0.05,
    target: 150,
    maxInvalid: 16,
    maxObelisksLost: 2,
    reward: 175_000,
    penalty: 58_000,
    requires: 'consolidation',
    unlocks: ['emergency-powers'],
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
  fines: number;
  investigations: number;
  executions: number;
  valid: number;
  invalid: number;
}

// v2: the chain was rewritten around the narrative arc, so old ids no longer resolve.
const SAVE_BASE = 'missions.v2';

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
  private _ledger: Ledger = { fines: 0, investigations: 0, executions: 0, valid: 0, invalid: 0 };
  private listeners = new Set<(e: MissionEvent) => void>();

  constructor() {
    this.load();
    // The chain belongs to the campaign, so it swaps with the slot.
    onSlotChange(() => {
      this.completed.clear();
      this.auths.clear();
      this.active = null;
      this._ledger = { fines: 0, investigations: 0, executions: 0, valid: 0, invalid: 0 };
      this.load();
      // A loaded campaign always has work on the books; a closed slot has none.
      if (slotKey(SAVE_BASE)) this.ensureActive();
      // Notify directly rather than through emit(), which would save — writing the state we just
      // read straight back is pointless, and on slot CLOSE it would be actively wrong.
      for (const fn of this.listeners) fn({ type: 'progress' });
    });
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

  /** Whether a tasking has been cleared. Drives every mission-gated purchase in the store. */
  isComplete(id: string): boolean {
    return this.completed.has(id);
  }

  /** The next tasking in the chain that could be started, or undefined once the chain is done. */
  nextAvailable(): MissionDef | undefined {
    return MISSIONS.find((m) => this.statusOf(m) === 'available');
  }

  /**
   * Put the next tasking in the chain on the books, if nothing is running.
   *
   * The chain is not a menu. The operator is a contractor being handed work in the order the
   * company decides to hand it over, and being asked to opt in to their own job was always a
   * fiction — there was never a reason to decline, so the accept button was a click that only ever
   * had one answer. Optional side work can be opt-in later; the spine is assigned.
   *
   * Called on campaign load and after every completion or failure. A FAILED tasking is re-assigned
   * rather than skipped: it wasn't completed, so it is still the next thing owed.
   */
  ensureActive(): boolean {
    if (this.active) return false;
    const next = this.nextAvailable();
    if (!next) return false;
    this.active = {
      id: next.id,
      valid: 0,
      invalid: 0,
      obelisksLost: 0,
      restore: progression.snapshot(),
    };
    return true;
  }

  /**
   * Record one order and its verdict. Returns what it did to the active mission.
   *
   * Orders are always logged to the lifetime ledger, active mission or not — the operator's record
   * doesn't pause between taskings.
   */
  report(kind: OrderKind, valid: boolean): MissionEvent {
    if (kind === 'execute') this._ledger.executions++;
    else if (kind === 'fine') this._ledger.fines++;
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
      // A failed tasking is re-assigned, not skipped — it is still the next thing owed.
      this.ensureActive();
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
      // And widens what the chain has signed. The two dials move together but not in step: the
      // licence lags the street, except where a tasking grants an authorization outright, which
      // sets a floor rather than adding to the running total.
      policy.advance(def.toleranceGain * 0.8);
      if (def.grants) policy.raiseTo(AUTH_FLOOR[def.grants] ?? 0);
      this.active = null;
      progression.award(def.reward);
      // The next tasking is on the books before the completion notice has finished animating.
      this.ensureActive();
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
      // A failed tasking is re-assigned, not skipped — it is still the next thing owed.
      this.ensureActive();
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
    this.ensureActive();
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
      const key = slotKey(SAVE_BASE);
      if (!key) return; // no campaign open
      localStorage.setItem(key, JSON.stringify(data));
    } catch {
      // Storage unavailable — the chain just doesn't persist.
    }
  }

  private load(): void {
    const key = slotKey(SAVE_BASE);
    if (!key) return; // title screen: an empty chain
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const s = JSON.parse(raw) as SavedMissions;
      for (const id of s.completed ?? []) this.completed.add(id);
      for (const a of s.auths ?? []) this.auths.add(a);
      this.active = s.active ?? null;
      // Old saves predate the fine counter; default it rather than leaving it undefined.
      if (s.ledger) this._ledger = { ...s.ledger, fines: s.ledger.fines ?? 0 };
    } catch {
      // Corrupt save: start the chain over rather than half-restoring it.
    }
  }

  /**
   * Dev sandbox only: put the chain in the state it would be in after clearing everything up to
   * and including `id`, with the rewards, authorizations and BOTH dials those clearances carry — so
   * a jumped-to campaign behaves like a played one rather than an inconsistent half-state.
   */
  devCompleteThrough(id: string | null): void {
    this.active = null;
    this.completed.clear();
    this.auths.clear();
    tolerance.reset();
    policy.reset();
    if (id !== null) {
      for (const m of MISSIONS) {
        this.completed.add(m.id);
        if (m.grants) this.auths.add(m.grants);
        tolerance.advance(m.toleranceGain);
        // Replay the licence exactly as clearing it would — advance then floor, in that order —
        // or a jumped-to campaign gets the powers without the latitude that came with them, and
        // every sanction reads as outside policy for reasons the operator can't see.
        policy.advance(m.toleranceGain * 0.8);
        if (m.grants) policy.raiseTo(AUTH_FLOOR[m.grants] ?? 0);
        progression.award(m.reward);
        if (m.id === id) break;
      }
    }
    this.emit({ type: 'progress' });
  }

  reset(): void {
    tolerance.reset();
    policy.reset();
    this.completed.clear();
    this.auths.clear();
    this.active = null;
    this._ledger = { fines: 0, investigations: 0, executions: 0, valid: 0, invalid: 0 };
    this.emit({ type: 'progress' });
  }
}

export const missions = new Missions();

// Close the loop the other way: progression needs to know which authorizations are held (custody
// gates the detainment rig, lethal gates automated sanction) but must not import this module.
progression.setAuthProvider((a) => missions.hasAuth(a as Authorization));
/** Display name for a tasking id, so a gated purchase can say what it is waiting on. */
export function missionName(id: string): string {
  return MISSIONS.find((m) => m.id === id)?.name ?? id;
}
progression.setMissionProvider(
  (id) => missions.isComplete(id),
  (id) => missionName(id),
);
