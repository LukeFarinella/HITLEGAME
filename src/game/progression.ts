import type { StateTerritory, Territory, Tier } from './territory';
import {
  emptyLoadout,
  gearFits,
  GEAR_BY_ID,
  PLATFORM_BY_ID,
  WIDE_SENSOR_MULT,
  type Capability,
  type GearDef,
  type Loadout,
  type PlatformDef,
  type PlatformId,
} from './platforms';

/**
 * What the player owns: officers (the currency), the assets they've commissioned, and how far each
 * state has been built out.
 *
 * This module is deliberately dumb about what a purchase *does* — it owns ids, prices and the
 * ledger, and the scene asks it questions (`has('drone')`, `tierOf(state)`). Anything that reacts to
 * a purchase subscribes via {@link Progression.onChange}, so adding an asset later means adding a
 * catalog entry plus one read at the point it matters, not threading state through the scene.
 */

export type AssetId = string;

export interface Asset {
  id: AssetId;
  name: string;
  /** One line on what it does, shown under the name. */
  blurb: string;
  cost: number;
  /** Must be owned first — the store greys the entry out and says so. */
  requires?: AssetId;
  /**
   * Not yet implemented. Listed so the roadmap is visible in-game, but never purchasable — a
   * priced-but-inert button would be a lie.
   */
  pending?: boolean;
}

/**
 * The commissionable assets. Costs sit in the same currency as territory, and are set so a single
 * mid-size state is roughly the price of the drone — taking ground and fielding hardware compete.
 */
/**
 * Fixed infrastructure. Anything mobile is a PLATFORM (see platforms.ts) and anything that bolts
 * onto one is GEAR — this list is only what upgrades the obelisk net itself.
 */
export const ASSETS: Asset[] = [
  {
    id: 'obelisk-uprate',
    name: 'OBELISK SENSOR UPRATE',
    blurb: 'Every obelisk watches 1.2 km instead of 750 m. Applies across all held territory.',
    cost: 7000,
  },
  {
    id: 'obelisk-laser',
    name: 'OBELISK DIRECTED ENERGY',
    blurb:
      'Arms every held obelisk. Contacts marked for execution are serviced automatically on entering its range.',
    cost: 11_000,
  },
  {
    id: 'relay',
    name: 'ORBITAL RELAY',
    blurb: 'Persistent overhead coverage between obelisk nets.',
    cost: 18_000,
    pending: true,
  },
];

/** The state the campaign opens with. FIPS 53 = Washington. */
export const HOME_STATE = '53';

/**
 * Starting officers. Enough to take the whole map and commission everything with room to spare —
 * earning officers is a later update, and until then the store is meant to be explored, not
 * budgeted against.
 */
export const START_OFFICERS = 250_000;

// Bumped from v1: platforms and loadouts replaced the old drone/drone-laser/drone-uprate assets,
// and a save written against those would restore a campaign that owns nothing recognisable. A
// clean reset is more honest than a partial migration.
const SAVE_KEY = 'gorgon.progression.v2';

/** The whole ledger, as persisted and as snapshotted for mission rollback. */
export interface Saved {
  officers: number;
  assets: AssetId[];
  tiers: Record<string, Tier>;
  /** Owned platforms and what's bolted to each hardpoint. */
  loadouts: Record<string, Loadout>;
}

export class Progression {
  private _officers = START_OFFICERS;
  private assets = new Set<AssetId>();
  private tiers = new Map<string, Tier>();
  /** Present as a key = platform owned. Value is one slot per hardpoint. */
  private loadouts = new Map<PlatformId, Loadout>();
  private listeners = new Set<() => void>();

  constructor() {
    this.load();
  }

  get officers(): number {
    return this._officers;
  }

  has(id: AssetId): boolean {
    return this.assets.has(id);
  }

  tierOf(state: StateTerritory | string): Tier {
    const id = typeof state === 'string' ? state : state.id;
    return this.tiers.get(id) ?? 0;
  }

  isUnlocked(state: StateTerritory | string): boolean {
    return this.tierOf(state) > 0;
  }

  /** Subscribe to any ledger change. Returns an unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.save();
    for (const fn of this.listeners) fn();
  }

  // ---- purchases -------------------------------------------------------------------------------

  /** Whether an asset can be bought right now, and why not if it can't. */
  assetBlocker(a: Asset): string | null {
    if (a.pending) return 'PENDING AUTHORIZATION';
    if (this.assets.has(a.id)) return 'COMMISSIONED';
    if (a.requires && !this.assets.has(a.requires)) {
      const req = ASSETS.find((x) => x.id === a.requires);
      return `REQUIRES ${req?.name ?? a.requires}`;
    }
    if (this._officers < a.cost) return 'INSUFFICIENT OFFICERS';
    return null;
  }

  buyAsset(a: Asset): boolean {
    if (this.assetBlocker(a)) return false;
    this._officers -= a.cost;
    this.assets.add(a.id);
    this.changed();
    return true;
  }

  /** The cost of moving a state up one tier, or null if it's already at proliferation. */
  nextTierCost(s: StateTerritory): { tier: Tier; cost: number } | null {
    const t = this.tierOf(s);
    if (t === 0) return { tier: 1, cost: s.costs.unlock };
    if (t === 1) return { tier: 2, cost: s.costs.city };
    if (t === 2) return { tier: 3, cost: s.costs.full };
    return null;
  }

  buyNextTier(s: StateTerritory): boolean {
    const next = this.nextTierCost(s);
    if (!next || this._officers < next.cost) return false;
    this._officers -= next.cost;
    this.tiers.set(s.id, next.tier);
    this.changed();
    return true;
  }

  // ---- derived views ---------------------------------------------------------------------------

  /**
   * A mask over every obelisk index: 1 where the site is live under current ownership.
   *
   * This is what both renderings of the obelisk field filter on, so the orbit heatmap and a
   * theater's real geometry can never disagree about what the player actually owns.
   */
  obeliskMask(territory: Territory, total: number): Uint8Array {
    const mask = new Uint8Array(total);
    for (const s of territory.states) {
      const tier = this.tierOf(s);
      if (tier === 0) continue;
      const live = territory.atTier(s, tier);
      for (let k = 0; k < live.length; k++) mask[live[k]] = 1;
    }
    return mask;
  }

  /** Live obelisk count, for the store header. */
  activeObelisks(territory: Territory): number {
    let n = 0;
    for (const s of territory.states) {
      const tier = this.tierOf(s);
      if (tier > 0) n += territory.atTier(s, tier).length;
    }
    return n;
  }

  // ---- platforms + gear ------------------------------------------------------------------------

  hasPlatform(id: PlatformId): boolean {
    return this.loadouts.has(id);
  }

  ownedPlatforms(): PlatformId[] {
    return [...this.loadouts.keys()];
  }

  /**
   * A platform's fitted gear, one slot per hardpoint. Empty array if it isn't owned.
   *
   * Returns a COPY. The internal loadout is a mutable array, and handing the live one out let a
   * caller rearrange a platform's hardpoints without paying for the gear or triggering a save.
   */
  loadoutOf(id: PlatformId): Loadout {
    const l = this.loadouts.get(id);
    return l ? [...l] : [];
  }

  buyPlatform(def: PlatformDef): boolean {
    if (this.loadouts.has(def.id) || this._officers < def.cost) return false;
    this._officers -= def.cost;
    this.loadouts.set(def.id, emptyLoadout(def));
    this.changed();
    return true;
  }

  /** Why a piece of gear can't go on this platform right now, or null if it can. */
  gearBlocker(gear: GearDef, id: PlatformId): string | null {
    const loadout = this.loadouts.get(id);
    if (!loadout) return 'PLATFORM NOT OWNED';
    if (!gearFits(gear, id)) return 'INCOMPATIBLE';
    if (loadout.includes(gear.id)) return 'FITTED';
    if (!loadout.includes(null)) return 'NO FREE HARDPOINT';
    if (this._officers < gear.cost) return 'INSUFFICIENT OFFICERS';
    return null;
  }

  /** Install gear into the platform's first free hardpoint. */
  fitGear(gear: GearDef, id: PlatformId): boolean {
    if (this.gearBlocker(gear, id)) return false;
    const loadout = this.loadouts.get(id)!;
    loadout[loadout.indexOf(null)] = gear.id;
    this._officers -= gear.cost;
    this.changed();
    return true;
  }

  /**
   * Strip a hardpoint. Refunds half — gear comes off intact, but pulling it is a decision with a
   * cost, so loadouts can't be churned for free between theaters.
   */
  stripHardpoint(id: PlatformId, slot: number): boolean {
    const loadout = this.loadouts.get(id);
    const fitted = loadout?.[slot];
    if (!loadout || !fitted) return false;
    const gear = GEAR_BY_ID.get(fitted);
    loadout[slot] = null;
    if (gear) this._officers += Math.floor(gear.cost / 2);
    this.changed();
    return true;
  }

  /** Whether a specific platform carries a capability. */
  platformHas(id: PlatformId, cap: Capability): boolean {
    const loadout = this.loadouts.get(id);
    if (!loadout) return false;
    return loadout.some((g) => g && GEAR_BY_ID.get(g)?.grants === cap);
  }

  /** Whether ANY owned platform carries a capability. */
  anyPlatformHas(cap: Capability): boolean {
    for (const id of this.loadouts.keys()) if (this.platformHas(id, cap)) return true;
    return false;
  }

  /** A platform's effective sensor radius, with fitted gear applied. */
  sensorRangeOf(id: PlatformId): number {
    const def = PLATFORM_BY_ID.get(id);
    if (!def) return 0;
    return this.platformHas(id, 'wide-sensor') ? def.sensorM * WIDE_SENSOR_MULT : def.sensorM;
  }

  // ---- snapshots -------------------------------------------------------------------------------

  /**
   * A restore point. Taken when a mission is accepted: a failed mission rolls the campaign back to
   * where it stood before the operator started making calls, then charges the penalty on top.
   */
  snapshot(): Saved {
    return {
      officers: this._officers,
      assets: [...this.assets],
      tiers: Object.fromEntries(this.tiers),
      // Deep-copied: a loadout is a mutable array, and a snapshot that aliased the live one would
      // quietly track every hardpoint change made after it was taken.
      loadouts: Object.fromEntries([...this.loadouts].map(([id, l]) => [id, [...l]])),
    };
  }

  /** Roll back to a snapshot, optionally charging a penalty on the way. Officers never go below 0. */
  restore(snap: Saved, penalty = 0): void {
    this._officers = Math.max(0, snap.officers - penalty);
    this.assets = new Set(snap.assets);
    this.tiers = new Map(Object.entries(snap.tiers) as [string, Tier][]);
    this.loadouts = new Map(
      Object.entries(snap.loadouts ?? {}).map(([id, l]) => [id as PlatformId, [...l]]),
    );
    this.changed();
  }

  /** Straight award, for mission completion. */
  award(amount: number): void {
    this._officers += amount;
    this.changed();
  }

  // ---- persistence -----------------------------------------------------------------------------

  private save(): void {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.snapshot()));
    } catch {
      // Private browsing / disabled storage: the campaign just doesn't persist. Not fatal.
    }
  }

  private load(): void {
    let saved: Saved | undefined;
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) saved = JSON.parse(raw) as Saved;
    } catch {
      saved = undefined;
    }
    if (!saved) {
      // A fresh campaign owns Washington's downtown site and nothing else.
      this.tiers.set(HOME_STATE, 1);
      return;
    }
    this._officers = typeof saved.officers === 'number' ? saved.officers : START_OFFICERS;
    for (const id of saved.assets ?? []) this.assets.add(id);
    for (const [id, tier] of Object.entries(saved.tiers ?? {})) this.tiers.set(id, tier);
    for (const [id, l] of Object.entries(saved.loadouts ?? {})) {
      // Drop anything the catalog no longer knows about rather than carrying a dead slot forward.
      const def = PLATFORM_BY_ID.get(id as PlatformId);
      if (!def) continue;
      const slots = emptyLoadout(def);
      for (let i = 0; i < Math.min(slots.length, l.length); i++) {
        if (l[i] && GEAR_BY_ID.has(l[i]!)) slots[i] = l[i];
      }
      this.loadouts.set(id as PlatformId, slots);
    }
    if (this.tiers.size === 0) this.tiers.set(HOME_STATE, 1);
  }

  /** Wipe the campaign back to its opening position. Wired to the dev panel. */
  reset(): void {
    this._officers = START_OFFICERS;
    this.assets.clear();
    this.tiers.clear();
    this.loadouts.clear();
    this.tiers.set(HOME_STATE, 1);
    this.changed();
  }
}

export const progression = new Progression();
