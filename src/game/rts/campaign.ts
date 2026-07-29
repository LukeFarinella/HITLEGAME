import { slotKey, onSlotChange } from '../saves';

/**
 * The campaign ladder — the shape the whole game hangs off now that the RTS match IS the game.
 *
 * A match on its own is a sandbox: you raze Millstone, you get a modal, and nothing remembers. The
 * ladder is what turns seventeen of those into a campaign, and it does it with the smallest possible
 * structure — three TIERS, each a set of theaters you may take in any order, each tier opening only
 * when the one before it is finished:
 *
 *   1. NINE STATES     The headline economies, one at a time. This is the tutorial the objectives
 *                      chain already writes; the choice is only WHERE, and every option is winnable.
 *   2. THREE BLOCKS    The remainder of the map, taken in the regional blocks the survey groups it
 *                      into. Bigger ground, and the first missions that aren't a single metro.
 *   3. FIVE THEATERS   Overseas. Europe, the Americas, Africa, Russia, Asia-Pacific. The contract
 *                      stops being domestic.
 *
 * Free choice WITHIN a tier and hard gating BETWEEN tiers is the entire progression rule. It gives
 * the player an actual decision every mission (which prize, which order) without any of them being a
 * dead end, and it means "how far am I" is one number — how many of the seventeen are done.
 *
 * Nothing here imports Cesium, the scene, or a UI module. A mission is an ID, a tier, and enough
 * information to resolve WHERE it deploys; the scene turns that into ground.
 */

export type MissionTier = 'state' | 'block' | 'theater';

/** The tiers in the order they unlock. */
export const TIERS: readonly MissionTier[] = ['state', 'block', 'theater'] as const;

export const TIER_NAME: Record<MissionTier, string> = {
  state: 'PHASE I · DOMESTIC',
  block: 'PHASE II · REGIONAL BLOCKS',
  theater: 'PHASE III · OVERSEAS THEATERS',
};

export const TIER_NOTE: Record<MissionTier, string> = {
  state: 'Nine headline economies. Click any ground on the globe to deploy.',
  block: 'The rest of the map, in blocks. Click any ground on the globe to deploy.',
  theater: 'Foreign ground. Click any ground on the globe to deploy.',
};

export interface MissionDef {
  /** Stable persistence key. Never renumber these — a save is a set of them. */
  id: string;
  tier: MissionTier;
  name: string;
  /** The one-line descriptor under the name on the card. */
  sub: string;
  blurb: string;
  /**
   * FIPS of the state to deploy into. STATE missions only — the nexus is that state's downtown site.
   */
  fips?: string;
  /**
   * Survey region id whose states form the pool. BLOCK missions only — the nexus is the downtown of
   * the block's largest member, so the block always deploys somewhere worth deploying.
   */
  regionId?: string;
  /**
   * A hard lon/lat. THEATER missions only.
   *
   * Overseas ground is anchored rather than surveyed because the site field is domestic: it spans
   * lon [-159.6, -64.7], lat [17.7, 48.9] and there is not one site outside it (measured against
   * `public/obelisks.bin`, 115,502 points). Foreign theaters get a synthesised site field seeded at
   * this anchor — see `syntheticSitesAt` in cesium/obelisks — so every one of these is a real metro
   * chosen well inland, because a 200-mile disc centred on a coastal city is half ocean.
   */
  anchor?: { lon: number; lat: number };
  /**
   * Where this mission's ARROW stands on the globe, when that isn't where it deploys.
   *
   * Only the blocks need it, and they need it badly: a block's natural pin is the mean of its
   * members, which for all three lands squarely on top of a headline state's arrow — the northern
   * block's centroid sits between New York and Pennsylvania. These are hand-placed into empty ground
   * inside each block instead, because two overlapping arrows is two missions you cannot click.
   */
  pin?: { lon: number; lat: number };
  /**
   * The ladder mission a win here fills in, when that isn't this mission itself.
   *
   * FREE DEPLOY only. A click on open globe builds a contract that is about the ground under the
   * pointer — its own name, its own coordinates, its own Nexus — but the ladder is still seventeen
   * fixed rungs, so the win has to land on one of them. The centre of the selection picks it: the
   * state it falls in, or the block that state belongs to, or the nearest overseas theater. See
   * `freeMissionAt` in cesium/gorgonGlobe.
   */
  credits?: string;
  /** True for a contract the operator drew on the globe rather than one off the ladder. */
  free?: boolean;
}

/** Which ladder rung a win on this mission marks off. */
export function creditFor(m: MissionDef): string {
  return m.credits ?? m.id;
}

/**
 * The ladder. Seventeen missions, fixed.
 *
 * The nine states are the survey's headline economies and the three blocks are its regions, so the
 * first two tiers are the existing territory model read as a mission list rather than a store.
 */
export const MISSIONS: readonly MissionDef[] = [
  // ---- PHASE I: the nine headline economies -----------------------------------------------------
  {
    id: 'st-ca',
    tier: 'state',
    fips: '06',
    name: 'CALIFORNIA',
    sub: 'RANK 1 ECONOMY',
    blurb: 'The largest contract on the board and the loudest public. Expect unrest to bite early.',
  },
  {
    id: 'st-tx',
    tier: 'state',
    fips: '48',
    name: 'TEXAS',
    sub: 'RANK 2 ECONOMY',
    blurb: 'Wide ground, long sightlines, and more road than any network can watch at once.',
  },
  {
    id: 'st-ny',
    tier: 'state',
    fips: '36',
    name: 'NEW YORK',
    sub: 'RANK 3 ECONOMY',
    blurb: 'Dense, vertical, and cheap to cover. The obelisks earn here faster than anywhere.',
  },
  {
    id: 'st-fl',
    tier: 'state',
    fips: '12',
    name: 'FLORIDA',
    sub: 'RANK 4 ECONOMY',
    blurb: 'Coastal approaches on every side. Millstone lands hulls where you are not looking.',
  },
  {
    id: 'st-il',
    tier: 'state',
    fips: '17',
    name: 'ILLINOIS',
    sub: 'RANK 5 ECONOMY',
    blurb: 'One metro carrying a whole state. Hold the centre and the rest follows.',
  },
  {
    id: 'st-pa',
    tier: 'state',
    fips: '42',
    name: 'PENNSYLVANIA',
    sub: 'RANK 6 ECONOMY',
    blurb: 'Old industry, tight valleys, and ground that funnels an advance into places you chose.',
  },
  {
    id: 'st-oh',
    tier: 'state',
    fips: '39',
    name: 'OHIO',
    sub: 'RANK 7 ECONOMY',
    blurb: 'Three mid-sized metros and no single anchor. Expansion is not optional here.',
  },
  {
    id: 'st-ga',
    tier: 'state',
    fips: '13',
    name: 'GEORGIA',
    sub: 'RANK 8 ECONOMY',
    blurb: 'A single hub with the whole southeast routed through it. Everything moves past you.',
  },
  {
    id: 'st-wa',
    tier: 'state',
    fips: '53',
    name: 'WASHINGTON',
    sub: 'RANK 9 ECONOMY',
    blurb: 'Where the company started. Water on one flank, mountains on the other, no room to be sloppy.',
  },

  // ---- PHASE II: the regional blocks ------------------------------------------------------------
  {
    id: 'bl-west',
    tier: 'block',
    regionId: 'west',
    name: 'WESTERN BLOCK',
    sub: 'WEST OF THE 100TH MERIDIAN',
    blurb: 'Sparse, cheap, and mostly dark between cities. Coverage costs more than it returns.',
    pin: { lon: -113.5, lat: 41.5 }, // the Great Basin — no headline state within 800 km
  },
  {
    id: 'bl-south',
    tier: 'block',
    regionId: 'south',
    name: 'SOUTHERN BLOCK',
    sub: 'REMAINING SOUTHERN STATES',
    blurb: 'Sprawl without density. The network has to be wide before it can be deep.',
    pin: { lon: -91.5, lat: 33.5 }, // the lower Mississippi, clear of Texas and Georgia
  },
  {
    id: 'bl-north',
    tier: 'block',
    regionId: 'north',
    name: 'NORTHERN BLOCK',
    sub: 'REMAINING NORTHERN STATES',
    blurb: 'The last of the domestic map, and the most watched. Public patience is thin.',
    pin: { lon: -95.0, lat: 46.5 }, // upper Midwest, well north of Illinois and west of New York
  },

  // ---- PHASE III: overseas ----------------------------------------------------------------------
  //
  // Anchors are inland metros on purpose: the theater is a 200-mile disc, and a coastal anchor puts
  // half of it in water where nothing can be built.
  {
    id: 'th-europe',
    tier: 'theater',
    name: 'EUROPE',
    sub: 'RHINE-MAIN THEATER',
    blurb: 'The first contract outside the country. Dense ground, and nobody who asked you to come.',
    anchor: { lon: 8.68, lat: 50.11 },
  },
  {
    id: 'th-americas',
    tier: 'theater',
    name: 'AMERICAS',
    sub: 'VALLEY OF MEXICO THEATER',
    blurb: 'A basin holding twenty million people and one way in. Coverage is trivial; consent is not.',
    anchor: { lon: -99.13, lat: 19.43 },
  },
  {
    id: 'th-africa',
    tier: 'theater',
    name: 'AFRICA',
    sub: 'HIGHVELD THEATER',
    blurb: 'High, flat and open. Nothing between your sites and whatever is coming for them.',
    anchor: { lon: 28.05, lat: -26.2 },
  },
  {
    id: 'th-russia',
    tier: 'theater',
    name: 'RUSSIA',
    sub: 'MOSCOW THEATER',
    blurb: 'Ring roads all the way out. Millstone has been operating here longer than you have.',
    anchor: { lon: 37.62, lat: 55.75 },
  },
  {
    id: 'th-asia',
    tier: 'theater',
    name: 'ASIA-PACIFIC',
    sub: 'INDO-GANGETIC THEATER',
    blurb: 'The last contract. More contacts inside one disc than the entire domestic campaign.',
    anchor: { lon: 77.21, lat: 28.61 },
  },
];

const BY_ID = new Map(MISSIONS.map((m) => [m.id, m]));

export function missionById(id: string): MissionDef | undefined {
  return BY_ID.get(id);
}

export function missionsInTier(tier: MissionTier): MissionDef[] {
  return MISSIONS.filter((m) => m.tier === tier);
}

// ---- persistence --------------------------------------------------------------------------------
//
// Per save slot, like every other campaign module: `slotKey` returns null at the menu, and a null key
// means every write here is a no-op. That is what lets the ladder be read at the title screen without
// a slot open — see `readCampaignRecord`, which reads a slot's file WITHOUT opening it.

export const CAMPAIGN_KEY = 'rts.campaign.v1';

let done = new Set<string>();

function load(): void {
  done = new Set();
  const key = slotKey(CAMPAIGN_KEY);
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const v = JSON.parse(raw) as { done?: unknown };
    if (Array.isArray(v?.done)) {
      // Filter against the live ladder: a save from a build with a mission that no longer exists
      // should not count toward "all seventeen".
      for (const id of v.done) if (typeof id === 'string' && BY_ID.has(id)) done.add(id);
    }
  } catch {
    // Corrupt or unavailable storage reads as a fresh campaign rather than throwing at the menu.
  }
}

function save(): void {
  const key = slotKey(CAMPAIGN_KEY);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({ started: true, done: [...done] }));
  } catch {
    // Private browsing. The campaign still plays; it just won't survive a reload.
  }
}

onSlotChange(load);

/**
 * Stamp the slot as IN USE, whether or not anything has been won yet.
 *
 * Without this a campaign that has been opened and lost every mission in is byte-identical to one
 * that was never touched, and the title screen would keep offering it as an empty slot. Called when
 * the operations board opens.
 */
export function markStarted(): void {
  const key = slotKey(CAMPAIGN_KEY);
  if (!key) return;
  if (localStorage.getItem(key)) return;
  save();
}

/** Which missions this campaign has cleared. */
export function completedMissions(): ReadonlySet<string> {
  return done;
}

export function isComplete(id: string): boolean {
  return done.has(id);
}

/**
 * Record a win. Idempotent — replaying a cleared theater is allowed and changes nothing.
 *
 * Returns true if this was the mission that finished the campaign, so the caller can show the
 * victory screen instead of dropping back to the map.
 */
export function markComplete(id: string): boolean {
  if (!BY_ID.has(id)) return false;
  const already = done.has(id);
  done.add(id);
  if (!already) save();
  return campaignWon();
}

/**
 * Every tier is open, always.
 *
 * The tiers used to gate: blocks sealed until all nine states were held, overseas sealed until all
 * three blocks were. That structure died the moment the globe became a place you can click
 * ANYWHERE — a sealed marker sitting on ground that a click two pixels to its left deploys into is
 * not a rule, it is a bug the operator has to work around. The three phases survive as what they
 * were always best at: a way to read progress and to name where you are in the contract.
 *
 * Kept as a function rather than deleted at every call site, because "is this tier open" is still
 * the honest question — the answer just stopped being conditional.
 */
export function tierUnlocked(_tier: MissionTier): boolean {
  return true;
}

/** Whether a tier has anything left to take. What the phase readout is actually asking. */
export function tierOutstanding(tier: MissionTier): number {
  return missionsInTier(tier).filter((m) => !done.has(m.id)).length;
}

export function isUnlocked(id: string): boolean {
  const m = BY_ID.get(id);
  return m ? tierUnlocked(m.tier) : false;
}

/** How far the campaign has got, as a fraction of the whole ladder. */
export function campaignProgress(): { done: number; total: number } {
  return { done: done.size, total: MISSIONS.length };
}

/** Every mission cleared — the game is won. */
export function campaignWon(): boolean {
  return MISSIONS.every((m) => done.has(m.id));
}

/** Wipe the ladder for this slot. Used by the dev panel. */
export function resetCampaign(): void {
  done = new Set();
  save();
}

/**
 * Read a slot's ladder WITHOUT opening it — what the title screen's slot cards show.
 *
 * Deliberately duplicates the storage key rather than opening the slot: the menu must be able to
 * summarise three campaigns at once, and `setActiveSlot` is a global mode switch.
 */
export function readCampaignRecord(slot: number): {
  started: boolean;
  done: number;
  total: number;
  won: boolean;
  /** The phase the campaign is currently working through — what the slot card is named after. */
  phase: MissionTier;
} {
  const total = MISSIONS.length;
  const blank = { started: false, done: 0, total, won: false, phase: TIERS[0] };
  try {
    const raw = localStorage.getItem(`gorgon.s${slot}.${CAMPAIGN_KEY}`);
    if (!raw) return blank;
    const v = JSON.parse(raw) as { done?: unknown };
    const ids = Array.isArray(v?.done) ? v.done.filter((x): x is string => typeof x === 'string') : [];
    const live = new Set(ids.filter((id) => BY_ID.has(id)));
    // The current phase is the first one with anything still open in it.
    const phase = TIERS.find((t) => missionsInTier(t).some((m) => !live.has(m.id))) ?? TIERS[TIERS.length - 1];
    return { started: true, done: live.size, total, won: live.size >= total, phase };
  } catch {
    return blank;
  }
}
