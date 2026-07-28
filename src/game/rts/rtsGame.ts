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

import { ABILITY_BY_ID, STRUCTURES, type AbilityId, type Structure, type StructureType } from './structures';
import { RTS_UNITS, RTS_REGEN, type RtsUnitId } from './units';
import { RESEARCH, type ResearchId } from './research';
import { hardpointsOf } from './combat';
import { MOUNT_BY_ID, mountFits, type RtsLoadout, type WeaponId } from './weapons';

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

/**
 * A fielded unit's live state, keyed by its index in the UnitField.
 *
 * Deliberately NOT where hit points live. The UnitField owns position, movement AND combat hp (the
 * combat pass stamps hp onto a unit when it's armed — see cesium/units.ts `armRtsCombat`), because
 * both armies field the same chassis and the fight has to read one number. This owns only what the
 * roster adds on top: which unit it is, and the shield/energy the combat model has no concept of.
 */
export interface RtsUnitState {
  index: number;
  unit: RtsUnitId;
  shield: number;
  energy: number;
  /**
   * What is bolted into this unit's hardpoints, one entry per slot. Per-UNIT, not per-type: two
   * marshals rolled off the same line can carry different weapons, which is the whole point of
   * fitting rather than researching. Empty slots are null.
   */
  loadout: RtsLoadout;
}

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

  /** Every fielded unit's live state, keyed by its UnitField index. */
  readonly unitStates = new Map<number, RtsUnitState>();

  /**
   * Ability cooldowns in seconds remaining, keyed by the structure that fired and then the ability.
   *
   * Per-BUILDING, not per-player: two skyhooks give you two independent strikes, which is the whole
   * reason a second one is worth 800. Keyed by structure id so a tether's fall takes its cooldown
   * with it — and, more to the point, so rebuilding does not hand you a fresh strike for free while
   * the old one was still charging, because the new building's id is not the dead one's.
   */
  private abilityCd = new Map<number, Map<AbilityId, number>>();

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

  /**
   * A structure has fallen. Removes it from the match — and everything that hung off it: its
   * production queue (releasing the supply those queued units had reserved — they were paid for
   * and will never exist, but supply is a headcount, not money), its rally point, and any research
   * it was running (the project is lost, not refunded — Millstone burned the lab). The scene owns
   * the visual teardown and what the loss MEANS (a freed site, a defeat).
   */
  removeStructure(id: number): Structure | undefined {
    const i = this.structures.findIndex((s) => s.id === id);
    if (i < 0) return undefined;
    const [s] = this.structures.splice(i, 1);
    const q = this.production.get(id);
    if (q) {
      for (const item of q) this._supplyUsed -= RTS_UNITS[item.unit].supply;
      this._supplyUsed = Math.max(0, this._supplyUsed);
    }
    this.production.delete(id);
    this.rally.delete(id);
    this.researching.delete(id);
    this.abilityCd.delete(id);
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

  // ---- fielded units -------------------------------------------------------------------------

  /**
   * Register a unit the field has just spawned, at full health.
   *
   * `chargeSupply` is false for anything that came out of a production queue: {@link enqueue} already
   * reserved that supply when the unit was ordered, and the reservation simply becomes the unit's own
   * on rollout. It is true for units fielded outside the queue — the opening workers — which nothing
   * has charged for yet.
   */
  registerUnit(index: number, unit: RtsUnitId, chargeSupply = true): RtsUnitState {
    const def = RTS_UNITS[unit];
    const s: RtsUnitState = {
      index,
      unit,
      shield: def.maxShield,
      energy: def.maxEnergy,
      // Rolls out with every slot empty. A unit is never born with a weapon it didn't get fitted —
      // the basic attack is the chassis', and everything else is bought.
      loadout: new Array(hardpointsOf(def.meshKind)).fill(null),
    };
    this.unitStates.set(index, s);
    if (chargeSupply) this._supplyUsed += def.supply;
    this.changed();
    return s;
  }

  // ---- hardpoints ------------------------------------------------------------------------------

  /**
   * Why a mount can't go into a slot right now, or null if it can.
   *
   * Fitting is deliberately cheap to check and impossible to undo: there's no "unfit and refund"
   * path, because a pod bolted to a chassis in the field is spent. Replacing one costs full price,
   * which is what stops the loadout screen becoming a free toybox to fiddle with between waves.
   */
  fitBlocker(index: number, slot: number, mount: WeaponId): string | null {
    const s = this.unitStates.get(index);
    if (!s) return 'NO SUCH UNIT';
    if (slot < 0 || slot >= s.loadout.length) return 'NO SUCH HARDPOINT';
    const def = MOUNT_BY_ID.get(mount);
    if (!def) return 'NO SUCH MOUNT';
    if (!mountFits(def, RTS_UNITS[s.unit].meshKind)) return 'DOES NOT FIT';
    if (s.loadout[slot] === mount) return 'ALREADY FITTED';
    if (this._money < def.cost) return 'INSUFFICIENT FUNDS';
    return null;
  }

  /**
   * Bolt a mount into one of a unit's hardpoints, charging for it. Returns false and changes
   * nothing if {@link fitBlocker} would have refused. The caller re-arms the unit in the field —
   * this owns the money and the record of what is fitted, not the combat stats.
   */
  fitMount(index: number, slot: number, mount: WeaponId): boolean {
    if (this.fitBlocker(index, slot, mount)) return false;
    const s = this.unitStates.get(index)!;
    this._money -= MOUNT_BY_ID.get(mount)!.cost;
    s.loadout[slot] = mount;
    this.changed();
    return true;
  }

  /** What a unit is carrying, or an empty list if it isn't ours. */
  loadoutOf(index: number): RtsLoadout {
    return this.unitStates.get(index)?.loadout ?? [];
  }

  /**
   * Hand back what a queued unit reserved when it can't actually be fielded — the littoral hull with
   * no water to launch onto. Money AND supply, because nothing was ever built.
   */
  refundQueued(unit: RtsUnitId): void {
    const def = RTS_UNITS[unit];
    this._money += def.cost;
    this._supplyUsed = Math.max(0, this._supplyUsed - def.supply);
    this.changed();
  }

  unitStateOf(index: number): RtsUnitState | undefined {
    return this.unitStates.get(index);
  }

  /** What kind of unit this is, or undefined if it isn't one of ours. */
  unitIdOf(index: number): RtsUnitId | undefined {
    return this.unitStates.get(index)?.unit;
  }

  /** Drop a unit from the roster (destroyed), releasing its supply. */
  removeUnit(index: number): void {
    const s = this.unitStates.get(index);
    if (!s) return;
    this.unitStates.delete(index);
    this._supplyUsed = Math.max(0, this._supplyUsed - RTS_UNITS[s.unit].supply);
    this.changed();
  }

  /** Regenerate shields and energy on everything fielded. HP is deliberately NOT regenerated. */
  tickUnits(dt: number): void {
    for (const s of this.unitStates.values()) {
      const def = RTS_UNITS[s.unit];
      if (s.shield < def.maxShield) s.shield = Math.min(def.maxShield, s.shield + RTS_REGEN.shield * dt);
      if (s.energy < def.maxEnergy) s.energy = Math.min(def.maxEnergy, s.energy + RTS_REGEN.energy * dt);
    }
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

  // ---- structure abilities ---------------------------------------------------------------------
  //
  // Something a building DOES on command, rather than something it produces or researches. The match
  // owns the money and the cooldown; what the ability means in the world is the scene's (an orbital
  // strike is a round dropped from 120 km, and only the scene knows where the ground is).

  /** Seconds left before a building can fire an ability again. 0 when it's ready. */
  abilityCooldown(structureId: number, id: AbilityId): number {
    return this.abilityCd.get(structureId)?.get(id) ?? 0;
  }

  /** Whether any ability on this building is still charging — drives the card's live repaint. */
  abilityBusy(structureId: number): boolean {
    const m = this.abilityCd.get(structureId);
    if (!m) return false;
    for (const s of m.values()) if (s > 0) return true;
    return false;
  }

  /** Why a building can't fire an ability right now, or null. */
  abilityBlocker(structureId: number, id: AbilityId): string | null {
    const def = ABILITY_BY_ID.get(id);
    if (!def) return 'UNKNOWN';
    if (!this.structures.some((s) => s.id === structureId && s.type === def.from)) return 'NO BUILDING';
    const cd = this.abilityCooldown(structureId, id);
    if (cd > 0) return `CHARGING ${Math.ceil(cd)}s`;
    if (this._money < def.cost) return 'INSUFFICIENT FUNDS';
    return null;
  }

  /**
   * Fire an ability: charge for it and start its cooldown.
   *
   * Charging HERE, before the scene does anything, is deliberate — the money goes when the order is
   * given, so a strike you aimed and paid for is spent whether or not anything was standing in it.
   */
  fireAbility(structureId: number, id: AbilityId): boolean {
    if (this.abilityBlocker(structureId, id)) return false;
    const def = ABILITY_BY_ID.get(id)!;
    this._money -= def.cost;
    const m = this.abilityCd.get(structureId) ?? new Map<AbilityId, number>();
    m.set(id, def.cooldownS);
    this.abilityCd.set(structureId, m);
    this.changed();
    return true;
  }

  /** Run down every ability cooldown. */
  tickAbilities(dt: number): void {
    if (!this.abilityCd.size) return;
    let ready = false;
    for (const m of this.abilityCd.values()) {
      for (const [id, s] of m) {
        const left = s - dt;
        if (left <= 0) {
          m.delete(id);
          ready = true;
        } else {
          m.set(id, left);
        }
      }
    }
    // Only announce the transition to READY. Announcing every frame of a 50-second charge would
    // repaint the whole command card fifty times a second for a number nobody is reading.
    if (ready) this.changed();
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
