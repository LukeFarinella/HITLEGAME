import type { Region, StateTerritory, Territory, Tier } from './territory';
import { tolerance } from './tolerance';
import {
  PLATFORMS,
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
  /** Public tolerance that must be reached before this is even offered. */
  minTolerance?: number;
  /** Standing authorization required, granted by the mission chain rather than bought. */
  requiresAuth?: 'detain' | 'execute';
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
    id: 'emergency-powers',
    name: 'EMERGENCY POWERS',
    blurb:
      'Suspends the public-tolerance test entirely. Any contact under sensor coverage becomes orderable.',
    cost: 40_000,
    /** Only offered once the climate is already permissive — it formalises what is nearly true. */
    minTolerance: 0.75,
  },
  {
    id: 'auto-investigate',
    name: 'AUTOMATED FLAGGING',
    blurb:
      'Flags contacts for investigation on its own, strongest case first, at the threshold you set.',
    cost: 26_000,
    minTolerance: 0.6,
  },
  {
    id: 'auto-execute',
    name: 'AUTOMATED SANCTION',
    blurb: 'The same, issuing execution orders. Requires lethal authority.',
    cost: 48_000,
    minTolerance: 0.85,
    requiresAuth: 'execute',
  },
  {
    id: 'relay',
    name: 'ORBITAL RELAY',
    blurb: 'Persistent overhead coverage between obelisk nets.',
    cost: 18_000,
    pending: true,
  },
];

/**
 * The campaign no longer opens anywhere in particular — the operator picks their own ground from
 * the ten headline states before the first sortie. Until they have, `homeState` is null and the
 * start window is what the game shows.
 */

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
  /** Fitted gear per platform type. */
  loadouts: Record<string, Loadout>;
  /** Units fielded per platform type. */
  counts: Record<string, number>;
  /** FIPS of the state the campaign was founded in, or null if not yet chosen. */
  homeState: string | null;
  /** Case-strength thresholds the marking automation works to, per order kind. */
  autoThresholds: Record<string, number>;
}

export class Progression {
  private _officers = START_OFFICERS;
  private assets = new Set<AssetId>();
  private tiers = new Map<string, Tier>();
  /** The state this campaign was founded in. Null until the operator has chosen. */
  private _homeState: string | null = null;
  /** Fitted gear per platform TYPE — every unit of a type carries the same loadout. */
  private loadouts = new Map<PlatformId, Loadout>();
  /** How many units of each platform are fielded. */
  private counts = new Map<PlatformId, number>();
  /** Case strength the automation will act at, per order kind. Set by the operator. */
  private autoThresholds = new Map<string, number>([
    ['investigate', 0.7],
    ['execute', 0.85],
  ]);
  private listeners = new Set<() => void>();

  /**
   * Whether a standing authorization is held. Injected by the mission chain rather than imported
   * from it: missions already depends on progression (it snapshots and awards), so importing back
   * would close a cycle. Registration keeps the dependency one-directional.
   */
  private authCheck: (a: string) => boolean = () => false;

  constructor() {
    this.load();
  }

  setAuthProvider(fn: (a: string) => boolean): void {
    this.authCheck = fn;
  }

  get officers(): number {
    return this._officers;
  }

  has(id: AssetId): boolean {
    return this.assets.has(id);
  }

  get homeState(): string | null {
    return this._homeState;
  }

  /**
   * Found the campaign in a state: it becomes home, unlocked at downtown tier, and the opening
   * arachnid is fielded. Only valid once, and only before anything else has been taken.
   */
  chooseHome(fips: string): boolean {
    if (this._homeState) return false;
    this._homeState = fips;
    this.tiers.set(fips, 1);
    const spider = PLATFORM_BY_ID.get('spider');
    if (spider) {
      this.counts.set('spider', 1);
      if (!this.loadouts.has('spider')) this.loadouts.set('spider', emptyLoadout(spider));
    }
    this.changed();
    return true;
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

  private batching = 0;
  private dirty = false;

  private changed(): void {
    if (this.batching > 0) {
      this.dirty = true;
      return;
    }
    this.save();
    for (const fn of this.listeners) fn();
  }

  /**
   * Run a group of purchases as one transaction.
   *
   * Every purchase normally saves and notifies, and one of those listeners rebuilds the orbit heat
   * field from all 115k sites — so a bulk operation (taking all 52 states to proliferation is 156
   * purchases) paid for that rebuild 156 times and blocked for three seconds. Batching collapses it
   * to a single save and a single notify at the end.
   */
  batch(fn: () => void): void {
    this.batching++;
    try {
      fn();
    } finally {
      this.batching--;
      if (this.batching === 0 && this.dirty) {
        this.dirty = false;
        this.save();
        for (const l of this.listeners) l();
      }
    }
  }

  // ---- purchases -------------------------------------------------------------------------------

  /** Whether an asset can be bought right now, and why not if it can't. */
  assetBlocker(a: Asset): string | null {
    if (a.pending) return 'PENDING AUTHORIZATION';
    if (this.assets.has(a.id)) return 'COMMISSIONED';
    if (a.requiresAuth && !this.authCheck(a.requiresAuth)) {
      return a.requiresAuth === 'execute' ? 'REQUIRES LETHAL AUTHORITY' : 'REQUIRES CUSTODY AUTHORITY';
    }
    if (a.minTolerance !== undefined && tolerance.level < a.minTolerance) {
      return `NEEDS ${Math.round(a.minTolerance * 100)}% TOLERANCE`;
    }
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

  // ---- regions ---------------------------------------------------------------------------------
  //
  // Territory is SOLD by the block but still STORED per state. That keeps everything downstream
  // (the obelisk mask, theater entry, the campaign's opening grant of Washington alone) working on
  // states exactly as before — only the buying is grouped.

  /**
   * A block's tier is its weakest member's: a block reads as unlocked only when every state in it
   * is, so the label can never claim more than the player actually holds.
   */
  tierOfRegion(r: Region): Tier {
    if (!r.states.length) return 0;
    let min: Tier = 3;
    for (const s of r.states) {
      const t = this.tierOf(s);
      if (t < min) min = t;
    }
    return min;
  }

  /**
   * What it costs to bring every state in a block up to the next tier, and which tier that is.
   * States already at or past that tier are skipped, so a block containing the campaign's free
   * home state doesn't charge for it.
   */
  nextRegionTier(r: Region): { tier: Tier; cost: number; states: number } | null {
    const current = this.tierOfRegion(r);
    if (current >= 3) return null;
    const tier = (current + 1) as Tier;
    let cost = 0;
    let n = 0;
    for (const s of r.states) {
      if (this.tierOf(s) >= tier) continue;
      n++;
      cost += tier === 1 ? s.costs.unlock : tier === 2 ? s.costs.city : s.costs.full;
    }
    return { tier, cost, states: n };
  }

  buyRegionTier(r: Region): boolean {
    const next = this.nextRegionTier(r);
    if (!next || this._officers < next.cost) return false;
    this._officers -= next.cost;
    for (const s of r.states) {
      if (this.tierOf(s) < next.tier) this.tiers.set(s.id, next.tier);
    }
    this.changed();
    return true;
  }

  /**
   * Whether the whole national network is fully proliferated — the gate on anything beyond the
   * states. Covers the headline states as well as the blocks, since they're bought separately.
   */
  allTerritoryHeld(territory: Territory): boolean {
    return (
      territory.headline.every((s) => this.tierOf(s) >= 3) &&
      territory.regions.every((r) => this.tierOfRegion(r) >= 3)
    );
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
    return (this.counts.get(id) ?? 0) > 0;
  }

  /** How many of a platform are fielded. */
  countOf(id: PlatformId): number {
    return this.counts.get(id) ?? 0;
  }

  /** The platform TYPES fielded, in catalog order. */
  ownedPlatforms(): PlatformId[] {
    return PLATFORMS.filter((p) => this.hasPlatform(p.id)).map((p) => p.id);
  }

  /**
   * Every fielded unit as a flat list, repeating a type once per unit. This is what the theater
   * spawns from — four arachnids are four entries.
   */
  fieldedUnits(): PlatformId[] {
    const out: PlatformId[] = [];
    for (const p of PLATFORMS) {
      for (let i = 0; i < this.countOf(p.id); i++) out.push(p.id);
    }
    return out;
  }

  /** Why a platform can't be commissioned right now, or null if it can. */
  platformBlocker(def: PlatformDef): string | null {
    if (this.hasPlatform(def.id)) return 'FIELDED';
    if (def.requires && !this.hasPlatform(def.requires)) {
      return `REQUIRES ${PLATFORM_BY_ID.get(def.requires)?.name ?? def.requires}`;
    }
    if (this._officers < def.cost) return 'INSUFFICIENT OFFICERS';
    return null;
  }

  /** Why the fleet expansion isn't available, or null if it is. */
  expansionBlocker(def: PlatformDef): string | null {
    if (!def.expansion) return 'NO EXPANSION';
    if (!this.hasPlatform(def.id)) return 'PLATFORM NOT FIELDED';
    if (this.countOf(def.id) >= def.maxCount) return 'AT FULL STRENGTH';
    if (this._officers < def.expansion.cost) return 'INSUFFICIENT OFFICERS';
    return null;
  }

  buyExpansion(def: PlatformDef): boolean {
    if (!def.expansion || this.expansionBlocker(def)) return false;
    this._officers -= def.expansion.cost;
    this.counts.set(def.id, Math.min(def.maxCount, this.countOf(def.id) + def.expansion.count));
    this.changed();
    return true;
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
    if (this.platformBlocker(def)) return false;
    this._officers -= def.cost;
    this.counts.set(def.id, 1);
    if (!this.loadouts.has(def.id)) this.loadouts.set(def.id, emptyLoadout(def));
    this.changed();
    return true;
  }

  /** Why a piece of gear can't go on this platform right now, or null if it can. */
  gearBlocker(gear: GearDef, id: PlatformId): string | null {
    const loadout = this.loadouts.get(id);
    if (!loadout) return 'PLATFORM NOT OWNED';
    if (gear.requiresAuth && !this.authCheck(gear.requiresAuth)) {
      return gear.requiresAuth === 'execute' ? 'REQUIRES LETHAL AUTHORITY' : 'REQUIRES CUSTODY AUTHORITY';
    }
    if (!gearFits(gear, id)) return 'INCOMPATIBLE';
    if (loadout.includes(gear.id)) return 'FITTED';
    if (!loadout.includes(null)) return 'NO FREE HARDPOINT';
    if (this._officers < gear.cost) return 'INSUFFICIENT OFFICERS';
    return null;
  }

  /** Install gear into the platform's first free hardpoint. */
  fitGear(gear: GearDef, id: PlatformId): boolean {
    const loadout = this.loadouts.get(id);
    if (!loadout) return false;
    const free = loadout.indexOf(null);
    return free < 0 ? false : this.fitGearAt(gear, id, free);
  }

  /**
   * Install gear into a SPECIFIC hardpoint — what the slot menu calls, since the player picks the
   * mount. The "no free hardpoint" blocker doesn't apply when the slot is named and empty.
   */
  fitGearAt(gear: GearDef, id: PlatformId, slot: number): boolean {
    const loadout = this.loadouts.get(id);
    if (!loadout || slot < 0 || slot >= loadout.length) return false;
    if (loadout[slot] !== null) return false;
    const blocker = this.gearBlocker(gear, id);
    if (blocker && blocker !== 'NO FREE HARDPOINT') return false;
    loadout[slot] = gear.id;
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

  // ---- automation ------------------------------------------------------------------------------

  /** The case strength the marking automation acts at for one order kind. */
  autoThreshold(kind: 'investigate' | 'execute'): number {
    return this.autoThresholds.get(kind) ?? 0.7;
  }

  setAutoThreshold(kind: 'investigate' | 'execute', v: number): void {
    this.autoThresholds.set(kind, Math.min(1, Math.max(0, v)));
    this.changed();
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
      counts: Object.fromEntries(this.counts),
      homeState: this._homeState,
      autoThresholds: Object.fromEntries(this.autoThresholds),
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
    this.counts = new Map(Object.entries(snap.counts ?? {}) as [PlatformId, number][]);
    this._homeState = snap.homeState ?? null;
    for (const [k, v] of Object.entries(snap.autoThresholds ?? {})) this.autoThresholds.set(k, v);
    this.changed();
  }

  /** Straight award, for mission completion. */
  award(amount: number): void {
    this._officers += amount;
    this.changed();
  }

  /** Dev sandbox only. */
  setOfficers(n: number): void {
    this._officers = Math.max(0, Math.round(n));
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
    if (!saved) return; // nothing granted until a home state is chosen
    this._officers = typeof saved.officers === 'number' ? saved.officers : START_OFFICERS;
    for (const id of saved.assets ?? []) this.assets.add(id);
    for (const [id, tier] of Object.entries(saved.tiers ?? {})) this.tiers.set(id, tier);
    for (const [k, v] of Object.entries(saved.autoThresholds ?? {})) this.autoThresholds.set(k, v);
    for (const [id, n] of Object.entries(saved.counts ?? {})) {
      const def = PLATFORM_BY_ID.get(id as PlatformId);
      if (def && n > 0) this.counts.set(id as PlatformId, Math.min(def.maxCount, n));
    }
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
    this._homeState = saved.homeState ?? null;
  }

  /** Wipe the campaign back to its opening position. Wired to the dev panel. */
  reset(): void {
    this._officers = START_OFFICERS;
    this.assets.clear();
    this.tiers.clear();
    this.loadouts.clear();
    this.counts.clear();
    this.autoThresholds = new Map([
      ['investigate', 0.7],
      ['execute', 0.85],
    ]);
    // Back to the very beginning: no ground, no platform, and the start window again.
    this._homeState = null;
    this.changed();
  }
}

export const progression = new Progression();
