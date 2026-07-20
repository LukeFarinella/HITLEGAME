import type { Region, StateTerritory, Territory, Tier } from './territory';
import { tolerance } from './tolerance';
import { slotKey, onSlotChange } from './saves';
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
 * What the player owns: funding tokens (the currency), the assets they've commissioned, and how far each
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
  /** Tasking that must be cleared before this is offered at all. */
  requiresMission?: string;
}

/**
 * The commissionable assets. Costs sit in the same currency as territory, and are set so a single
 * mid-size state is roughly the price of the drone — taking ground and fielding hardware compete.
 */
/**
 * Fixed infrastructure. Anything mobile is a PLATFORM (see platforms.ts) and anything that bolts
 * onto one is GEAR — this list is only what upgrades the obelisk net itself.
 */
/**
 * What one airdropped site costs to place.
 *
 * Small on purpose. The interesting decision is WHERE to put coverage and whether it is worth
 * losing when the sortie ends — not whether you can afford another one.
 */
export const AIRDROP_COST = 400;

export const ASSETS: Asset[] = [
  {
    id: 'obelisk-uprate',
    requiresMission: 'trial',
    name: 'OBELISK SENSOR UPRATE',
    blurb: 'Every obelisk watches 1.2 km instead of 750 m. Applies across all held territory.',
    cost: 7000,
  },
  {
    id: 'obelisk-laser',
    requiresMission: 'containment',
    name: 'OBELISK DIRECTED ENERGY',
    blurb:
      'Arms every held obelisk. Contacts marked for execution are serviced automatically on entering its range.',
    cost: 11_000,
  },
  {
    id: 'airdrop',
    requiresMission: 'canvass',
    name: 'RAPID SITE DEPLOYMENT',
    blurb:
      'Drop a temporary obelisk anywhere in a theater for ' +
      `${AIRDROP_COST} tokens. Full sensor coverage and every network upgrade, but it is gone when you leave.`,
    // Deliberately cheap and early. The opening problem is not money, it is that the operator can
    // only act inside coverage they inherited — this is the first thing that lets them choose where
    // they can see, and it should arrive while that still feels like a constraint.
    cost: 5500,
  },
  {
    id: 'emergency-powers',
    requiresMission: 'permanence',
    name: 'EMERGENCY POWERS',
    blurb:
      'Suspends the public-tolerance test entirely. Any contact under sensor coverage becomes orderable.',
    cost: 40_000,
    /** Only offered once the climate is already permissive — it formalises what is nearly true. */
    minTolerance: 0.75,
  },
  {
    id: 'auto-investigate',
    requiresMission: 'quarantine',
    name: 'AUTOMATED FLAGGING',
    blurb:
      'Flags contacts for investigation on its own, strongest case first, at the threshold you set.',
    cost: 26_000,
    minTolerance: 0.6,
  },
  {
    id: 'auto-execute',
    requiresMission: 'consolidation',
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
 * Starting funding.
 *
 * Deliberately almost nothing. The campaign opens with a granted quadruped, one downtown site and
 * a trial to run, and 500 tokens buys none of the catalog — the first real money is the trial's
 * clearance. That is the intended shape: a contractor on probation, not a department with a budget.
 *
 * This used to be 250,000, which existed so the store could be explored before there was anything
 * to spend on. There is now a mission chain paying out and incidents charging in, so the number
 * can mean something.
 */
export const START_TOKENS = 500;

// Bumped from v1: platforms and loadouts replaced the old drone/drone-laser/drone-uprate assets,
// and a save written against those would restore a campaign that owns nothing recognisable. A
// clean reset is more honest than a partial migration.
const SAVE_BASE = 'progression.v2';

/** The whole ledger, as persisted and as snapshotted for mission rollback. */
export interface Saved {
  tokens: number;
  /**
   * The pre-rename name for {@link tokens}. Read on load, never written.
   *
   * The currency was called "officers" until it became funding tokens. Saves written before that
   * carry the old key, and dropping it would silently zero the balance of every existing campaign.
   */
  officers?: number;
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
  private _tokens = START_TOKENS;
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
  /**
   * Whether a given tasking has been cleared.
   *
   * Injected for the same reason as {@link authCheck}: missions.ts imports progression (it
   * snapshots the ledger for rollback), so progression cannot import missions back.
   */
  private missionCheck: (id: string) => boolean = () => false;
  /** Display name for a tasking id, so a gated purchase can name what it waits on. */
  private missionNameOf: (id: string) => string = (id) => id;

  constructor() {
    this.load();
    // Opening a save slot swaps the whole campaign underneath; closing one leaves the module at
    // its founding defaults so the title screen has nothing granted behind it.
    onSlotChange(() => {
      this.clear();
      this.load();
      this.changed();
    });
  }

  setAuthProvider(fn: (a: string) => boolean): void {
    this.authCheck = fn;
  }

  setMissionProvider(fn: (id: string) => boolean, nameOf: (id: string) => string): void {
    this.missionCheck = fn;
    this.missionNameOf = nameOf;
  }

  /** Name of the tasking a purchase is waiting on, or null if it isn't gated. */
  private missionGate(requires: string | undefined, nameOf: (id: string) => string): string | null {
    if (!requires || this.missionCheck(requires)) return null;
    return `REQUIRES ${nameOf(requires)}`;
  }

  get tokens(): number {
    return this._tokens;
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
    // The campaign opens with one quadruped and nothing else — the humblest thing in the catalog.
    const opener = PLATFORM_BY_ID.get('dog');
    if (opener) {
      this.counts.set('dog', 1);
      if (!this.loadouts.has('dog')) this.loadouts.set('dog', emptyLoadout(opener));
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
    const gate = this.missionGate(a.requiresMission, this.missionNameOf);
    if (gate) return gate;
    if (this._tokens < a.cost) return 'INSUFFICIENT FUNDING';
    return null;
  }

  buyAsset(a: Asset): boolean {
    if (this.assetBlocker(a)) return false;
    this._tokens -= a.cost;
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
    if (!next || this._tokens < next.cost) return false;
    this._tokens -= next.cost;
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
    if (!next || this._tokens < next.cost) return false;
    this._tokens -= next.cost;
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
    const gate = this.missionGate(def.requiresMission, this.missionNameOf);
    if (gate) return gate;
    if (this._tokens < def.cost) return 'INSUFFICIENT FUNDING';
    return null;
  }

  /** Why the fleet expansion isn't available, or null if it is. */
  expansionBlocker(def: PlatformDef): string | null {
    if (!def.expansion) return 'NO EXPANSION';
    if (!this.hasPlatform(def.id)) return 'PLATFORM NOT FIELDED';
    if (this.countOf(def.id) >= def.maxCount) return 'AT FULL STRENGTH';
    if (this._tokens < def.expansion.cost) return 'INSUFFICIENT FUNDING';
    return null;
  }

  buyExpansion(def: PlatformDef): boolean {
    if (!def.expansion || this.expansionBlocker(def)) return false;
    this._tokens -= def.expansion.cost;
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
    this._tokens -= def.cost;
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
    const gate = this.missionGate(gear.requiresMission, this.missionNameOf);
    if (gate) return gate;
    if (loadout.includes(gear.id)) return 'FITTED';
    if (!loadout.includes(null)) return 'NO FREE HARDPOINT';
    if (this._tokens < gear.cost) return 'INSUFFICIENT FUNDING';
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
    this._tokens -= gear.cost;
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
    if (gear) this._tokens += Math.floor(gear.cost / 2);
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
      tokens: this._tokens,
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

  /** Roll back to a snapshot, optionally charging a penalty on the way. Funding tokens never go below 0. */
  restore(snap: Saved, penalty = 0): void {
    this._tokens = Math.max(0, snap.tokens - penalty);
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
    this._tokens += amount;
    this.changed();
  }

  /**
   * Charge for something bought outside the catalog.
   *
   * Airdropped sites are the only such purchase: they are placed in a theater rather than picked
   * from the store, so they have no Asset entry to route through {@link buyAsset}. Refuses rather
   * than going negative.
   */
  spend(amount: number): boolean {
    if (amount <= 0 || this._tokens < amount) return false;
    this._tokens -= amount;
    this.changed();
    return true;
  }

  /** Dev sandbox only. */
  setTokens(n: number): void {
    this._tokens = Math.max(0, Math.round(n));
    this.changed();
  }

  // ---- persistence -----------------------------------------------------------------------------

  private save(): void {
    const key = slotKey(SAVE_BASE);
    if (!key) return; // no campaign open — nothing to persist and nowhere to put it
    try {
      localStorage.setItem(key, JSON.stringify(this.snapshot()));
    } catch {
      // Private browsing / disabled storage: the campaign just doesn't persist. Not fatal.
    }
  }

  /** Drop every campaign-scoped field back to its founding value. */
  private clear(): void {
    this._tokens = START_TOKENS;
    this._homeState = null;
    this.assets.clear();
    this.tiers.clear();
    this.counts.clear();
    this.loadouts.clear();
    this.autoThresholds.clear();
  }

  private load(): void {
    const key = slotKey(SAVE_BASE);
    if (!key) return; // title screen: founding defaults, nothing read
    let saved: Saved | undefined;
    try {
      const raw = localStorage.getItem(key);
      if (raw) saved = JSON.parse(raw) as Saved;
    } catch {
      saved = undefined;
    }
    if (!saved) return; // nothing granted until a home state is chosen
    // Old saves carry `officers`; new ones carry `tokens`. Prefer the new key, fall back.
    this._tokens =
      typeof saved.tokens === 'number'
        ? saved.tokens
        : typeof saved.officers === 'number'
          ? saved.officers
          : START_TOKENS;
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
    this._tokens = START_TOKENS;
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
