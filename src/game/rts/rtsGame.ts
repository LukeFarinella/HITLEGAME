/**
 * The RTS match — a self-contained skirmish that reuses the theater scene but runs StarCraft-shaped
 * rules instead of the surveillance campaign.
 *
 * This module owns only the MATCH STATE: the money economy and (as the mode grows) structures, tech
 * and the enemy. It deliberately knows nothing about Cesium or the scene — the scene reads it each
 * frame and renders from it, exactly the way it reads {@link ../progression Progression}. Keeping it
 * a plain state object is what lets the RTS mode be purely additive: the campaign singletons are
 * untouched, and an RTS match is just a different object the scene happens to be driving.
 *
 * Design note — the Nexus. The starting obelisk is the Nexus (the main base, in StarCraft terms).
 * Losing it loses the match; razing the enemy's Nexus wins it. Every other obelisk is an economy
 * expansion the player builds at a predetermined site and rebuilds if it falls.
 */

import { STRUCTURES, type Structure, type StructureType } from './structures';
import { RTS_UNITS, type RtsUnitId } from './units';
import { RESEARCH, type ResearchId } from './research';

/** Economy tuning. One place, so the whole balance of the opening is a handful of readable numbers. */
export const RTS_ECON = {
  /** What a fresh match opens with — enough to think about a first building, not to skip the opening. */
  START_MONEY: 500,
  /**
   * Money a single obelisk trickles in per second, just for standing. The passive floor of the
   * economy; traffic-incident bonuses (later phases) ride on top of it.
   */
  INCOME_PER_OBELISK_S: 8,
  /**
   * How much banked money ONE obelisk supports before it stops trickling. The cap scales with the
   * obelisk count, so an idle economy fills up and stalls — the pressure to expand and spend is the
   * cap, not a depleting resource. Take more ground (more obelisks) and both the rate and the
   * ceiling rise together.
   */
  CAP_PER_OBELISK: 1500,
};

export type RtsListener = () => void;

/** One unit waiting in a building's production queue. */
export interface QueueItem {
  unit: RtsUnitId;
  /** Seconds left to build. */
  remainingS: number;
  /** The full build time, so the UI can draw a progress bar. */
  totalS: number;
}

export class RtsGame {
  private _money = RTS_ECON.START_MONEY;
  /**
   * Global obelisk index of the Nexus. The scene resolves this from Washington's downtown site and
   * hands it in; the match reads it to know which site's loss ends the game.
   */
  readonly nexusIndex: number;
  private listeners = new Set<RtsListener>();

  /** Everything the player has built, the Nexus first. Position/type/health live here; the scene renders it. */
  readonly structures: Structure[] = [];
  private nextStructureId = 1;

  /** Production queues, keyed by the producing structure's id. */
  readonly production = new Map<number, QueueItem[]>();
  /** Rally points, keyed by structure id — where a produced unit heads on rollout. */
  readonly rally = new Map<number, { lon: number; lat: number }>();
  /** Supply consumed by living + queued units. Cap comes from the structures (see supplyCap). */
  private _supplyUsed = 0;

  /** Research completed — a set of standing capabilities (e.g. auto-fine). */
  private _researched = new Set<ResearchId>();
  /** Research in progress, keyed by the researching structure's id: {id, remaining, total}. */
  readonly researching = new Map<number, { id: ResearchId; remainingS: number; totalS: number }>();

  constructor(nexusIndex: number, nexusLon: number, nexusLat: number) {
    this.nexusIndex = nexusIndex;
    // The Nexus is a structure like any other — it just happens to be the one you start with and the
    // one whose loss ends the game.
    this.structures.push({
      id: this.nextStructureId++,
      type: 'nexus',
      lon: nexusLon,
      lat: nexusLat,
      hp: STRUCTURES.nexus.maxHp,
      maxHp: STRUCTURES.nexus.maxHp,
      siteIndex: nexusIndex,
    });
  }

  /** Register a newly-built structure. The scene has already validated the spot and charged for it. */
  addStructure(type: StructureType, lon: number, lat: number, siteIndex?: number): Structure {
    const def = STRUCTURES[type];
    const s: Structure = { id: this.nextStructureId++, type, lon, lat, hp: def.maxHp, maxHp: def.maxHp, siteIndex };
    this.structures.push(s);
    this.changed();
    return s;
  }

  /** Structures of a given type — the command bar reads this to know what you can already produce from. */
  structuresOfType(type: StructureType): Structure[] {
    return this.structures.filter((s) => s.type === type);
  }

  /** The Nexus structure, or undefined if it has fallen (defeat). */
  get nexus(): Structure | undefined {
    return this.structures.find((s) => s.type === 'nexus');
  }

  /** Obelisks on the map — the Nexus counts as one. Drives the data-center prerequisite. */
  obeliskCount(): number {
    return this.structures.filter((s) => s.type === 'obelisk' || s.type === 'nexus').length;
  }

  /** Whether a structure type has been built at least once. */
  hasStructure(type: StructureType): boolean {
    return this.structures.some((s) => s.type === type);
  }

  /**
   * Why a structure can't be built yet — its tech-tree prerequisite, or null. The chain is
   * 3 obelisks → data center → robotics → tech → aviation, so each rung reads its own gate here.
   */
  structureBlocker(type: StructureType): string | null {
    const req = STRUCTURES[type].requires;
    if (!req) return null;
    if (req.obelisks && this.obeliskCount() < req.obelisks) {
      return `NEEDS ${req.obelisks} OBELISKS`;
    }
    if (req.structure && !this.hasStructure(req.structure)) {
      return `NEEDS ${STRUCTURES[req.structure].name}`;
    }
    return null;
  }

  // ---- supply --------------------------------------------------------------------------------

  /** Total supply the standing structures provide — the ceiling on your army. */
  supplyCap(): number {
    let c = 0;
    for (const s of this.structures) c += STRUCTURES[s.type].supplyProvided ?? 0;
    return c;
  }

  get supplyUsed(): number {
    return this._supplyUsed;
  }

  /** Charge supply for a unit that's being fielded outside the queue (the opening worker). */
  reserveSupply(n: number): void {
    this._supplyUsed += n;
    this.changed();
  }

  /** Release supply when a unit dies (Phase 4). */
  releaseSupply(n: number): void {
    this._supplyUsed = Math.max(0, this._supplyUsed - n);
    this.changed();
  }

  // ---- production ----------------------------------------------------------------------------

  /** Why a unit can't be queued right now, or null if it can. */
  enqueueBlocker(unit: RtsUnitId): string | null {
    const def = RTS_UNITS[unit];
    if (def.requiresStructure && !this.hasStructure(def.requiresStructure)) {
      return `NEEDS ${STRUCTURES[def.requiresStructure].name}`;
    }
    if (this._money < def.cost) return 'INSUFFICIENT FUNDS';
    if (this._supplyUsed + def.supply > this.supplyCap()) return 'BUILD A DATA CENTER';
    return null;
  }

  /**
   * Queue a unit at a producing structure. Charges the money and reserves the supply UP FRONT — the
   * unit is paid for the moment it's ordered, the way an RTS commits resources on queue, so you can't
   * queue an army you can't pay for and have it all roll out free.
   */
  enqueue(structureId: number, unit: RtsUnitId): boolean {
    if (this.enqueueBlocker(unit)) return false;
    const def = RTS_UNITS[unit];
    this._money -= def.cost;
    this._supplyUsed += def.supply;
    const q = this.production.get(structureId) ?? [];
    q.push({ unit, remainingS: def.buildTimeS, totalS: def.buildTimeS });
    this.production.set(structureId, q);
    this.changed();
    return true;
  }

  /** The queue at a structure, for the command card. */
  queueAt(structureId: number): QueueItem[] {
    return this.production.get(structureId) ?? [];
  }

  /**
   * Advance every production queue and return the units that finished this tick. Only the FRONT of
   * each queue builds — the classic one-at-a-time facility — so a queued army rolls out in order.
   * The scene spawns each completion and sends it to the rally point.
   */
  tickProduction(dt: number): { structureId: number; unit: RtsUnitId }[] {
    const done: { structureId: number; unit: RtsUnitId }[] = [];
    for (const [sid, q] of this.production) {
      if (!q.length) continue;
      q[0].remainingS -= dt;
      if (q[0].remainingS <= 0) {
        done.push({ structureId: sid, unit: q.shift()!.unit });
      }
    }
    if (done.length) this.changed();
    return done;
  }

  setRally(structureId: number, lon: number, lat: number): void {
    this.rally.set(structureId, { lon, lat });
    this.changed();
  }

  // ---- research ------------------------------------------------------------------------------

  hasResearch(id: ResearchId): boolean {
    return this._researched.has(id);
  }

  /** Why a research can't be started right now, or null. */
  researchBlocker(id: ResearchId): string | null {
    if (this._researched.has(id)) return 'DONE';
    if ([...this.researching.values()].some((r) => r.id === id)) return 'IN PROGRESS';
    if (this._money < RESEARCH[id].cost) return 'INSUFFICIENT FUNDS';
    return null;
  }

  /** Begin a research project at a structure. Charges up front, like production. */
  startResearch(structureId: number, id: ResearchId): boolean {
    if (this.researchBlocker(id)) return false;
    const def = RESEARCH[id];
    this._money -= def.cost;
    this.researching.set(structureId, { id, remainingS: def.timeS, totalS: def.timeS });
    this.changed();
    return true;
  }

  /** Advance research; mark anything finished as done. */
  tickResearch(dt: number): void {
    let changed = false;
    for (const [sid, r] of this.researching) {
      r.remainingS -= dt;
      if (r.remainingS <= 0) {
        this._researched.add(r.id);
        this.researching.delete(sid);
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /** The research a structure is working on, for the command card's progress. */
  researchAt(structureId: number): { id: ResearchId; remainingS: number; totalS: number } | undefined {
    return this.researching.get(structureId);
  }

  /** Banked money, floored — fractional accrual is real but never shown as a fraction. */
  get money(): number {
    return Math.floor(this._money);
  }

  /** The banked ceiling at the current obelisk count. Shown next to money so the cap is legible. */
  cap(obeliskCount: number): number {
    return Math.max(1, obeliskCount) * RTS_ECON.CAP_PER_OBELISK;
  }

  onChange(fn: RtsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /**
   * Advance the economy. Called every frame from the scene with the live obelisk count.
   *
   * Each obelisk contributes {@link RTS_ECON.INCOME_PER_OBELISK_S} per second until the bank reaches
   * the scaled cap, then it stalls. Kept idempotent-ish: at the cap this is a cheap no-op.
   */
  tick(dt: number, obeliskCount: number): void {
    const cap = this.cap(obeliskCount);
    if (this._money >= cap) return;
    this._money = Math.min(cap, this._money + obeliskCount * RTS_ECON.INCOME_PER_OBELISK_S * dt);
    this.changed();
  }

  /** Spend money if it's there. Refuses rather than going negative — the caller checks the return. */
  spend(amount: number): boolean {
    if (amount <= 0 || this._money < amount) return false;
    this._money -= amount;
    this.changed();
    return true;
  }

  /** A direct credit — a collected traffic bounty, a bonus. */
  award(amount: number): void {
    if (amount <= 0) return;
    this._money += amount;
    this.changed();
  }
}
