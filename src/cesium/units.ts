import * as Cesium from 'cesium';
import { InstancedModelBatch } from './instancedModels';
import {
  UNIT_MESHES,
  UNIT_SCALE,
  UNIT_KINDS,
  PLATFORM_KINDS,
  platformIcon,
  type UnitKind,
} from './unitModels';
import { PLATFORM_BY_ID, type PlatformId } from '../game/platforms';
import type { RoadNet, RoadClass } from './roads';
import { makeViolation, VIOLATION_TTL_S, type LiveViolation } from '../game/violations';
import { RouteGraph } from './routeGraph';
import type { SensorField } from './sensors';
import { assessBand, rollAssessment, rollRecord, worstSeverity, type Record_ } from '../game/intel';
import type { ProcessRule } from '../game/processActions';
import type { MarkKind } from '../game/missions';
import { caseStrength, tolerance } from '../game/tolerance';
import { partneredFactions, hostileFactions, type FactionId } from '../game/factions';
import { progression } from '../game/progression';

/**
 * The live unit layer for a theater: land vehicles routed on the real road graph, ships drifting on
 * water, aircraft flying waypoints, and foot units milling near roads. Each unit is one instance in
 * a per-kind {@link InstancedModelBatch} (one draw call per kind), and the whole field is stepped
 * once per frame.
 *
 * State is orthogonal to kind — every unit is normal / protected / infected, shown white / yellow /
 * red. It's a per-instance colour today; a spreading contagion sim would layer on top of this field
 * without touching the rendering.
 */

export type UnitState = 'normal' | 'protected' | 'infected';

/** What a unit is doing inside an incident. */
export type IncidentRole = 'rioter' | 'runner' | 'brawler' | 'assassin' | 'insurgent';

/** What a platform is being sent to DO when it gets there. */
export type RouteAction = 'investigate' | 'detain' | 'prison' | 'execute' | 'strike' | null;

/**
 * The field's colour language. Four channels, and each one answers a different question.
 *
 * The old scheme banded contacts into clear/suspect/threat and painted them white/green/yellow,
 * which quietly spent THREE colours on one axis and left nothing to say what a contact was DOING.
 * Green in particular was carrying "inoculated", which is a fact about the sim that C2 should never
 * have been able to read off the map at a glance.
 *
 *   RAMP (white → yellow)  the assessed threat figure, continuously. No bands, because the number
 *                          is continuous and banding it hid exactly the near-misses worth looking at.
 *   RED                    the company: its hardware AND the people its policy protects. The same
 *                          red on purpose — a protected contact IS company property in every way
 *                          that matters to the operator, and the map should say so in one colour.
 *   GREEN                  something attacking, right now: a siege attacker or an assassin mid-act.
 *   BLUE                   everyone else caught up in a live incident — riots, chases, brawls.
 *
 * Precedence runs event → identity → assessment: what a contact is doing this second outranks what
 * it is, which outranks what the net thinks of it. A protected contact in a riot renders as the
 * riot, because that is the thing the operator has to answer in the next ten seconds.
 */
const CONTACT_CLEAR = Cesium.Color.fromCssColorString('#FFFFFF');
const CONTACT_HOT = Cesium.Color.fromCssColorString('#FFD21E');
const HOSTILE_COLOR = Cesium.Color.fromCssColorString('#3FBF6F');
const EVENT_COLOR = Cesium.Color.fromCssColorString('#3F8FE0');

/** Out-of-sensor-range units render faint (a stand-in for fog of war). */
const UNSEEN_ALPHA = 0.3;

/**
 * How long a contact stays actionable after it leaves sensor coverage.
 *
 * At low levels the network is sparse and the platforms are fast, so a contact crosses a disc and is
 * gone before the operator can select it. Once seen, a contact is HELD for this long: still tracked,
 * still orderable, and drawn near full opacity, fading toward the out-of-range level as the window
 * closes. It is the net's short-term memory, not live contact — which is why the card counts it down.
 */
const SENSOR_GRACE_S = 60;
/** Opacity a contact fades to by the end of its grace window, just before it drops to UNSEEN_ALPHA. */
const GRACE_ALPHA_END = 0.6;

/** Company hardware, and the company's protected people, in the company's colour. */
const DRONE_COLOR = Cesium.Color.fromCssColorString('#E23A2E');

/** The same four channels as CSS hex, for the card's dot and tag. Kept beside the Colors above so
 *  the panel and the field can never drift apart. */
export const TINT_HEX = {
  company: '#E23A2E',
  hostile: '#3FBF6F',
  event: '#3F8FE0',
  clear: '#FFFFFF',
  hot: '#FFD21E',
};

/**
 * How strongly infected units avoid obelisk-watched roads at junctions. Tuned by measuring the
 * settled equilibrium (see chooseEdge) rather than by feel — mutable so it can be A/B'd live.
 */
export const INFECTED_FLEE = { covered: 0.3, open: 2.6 };

/**
 * The field's baseline composition — the campaign's difficulty dial, and the single place it's set.
 *
 * These are FIELD-WIDE shares, not per-location ones: coverage still modulates around them (cities
 * run cleaner, the dark between them runs dirtier), but the whole-theater average lands here. Later
 * missions raise `infected` to escalate; everything downstream — spawn rolls and the contagion
 * equilibrium alike — is derived from it, so raising this one number is the whole change.
 */
/** Ceiling on how many contacts one area-weapon blast can catch, so a MOAB can't stall a frame. */
const AREA_MAX_VICTIMS = 40;

export const MIX = {
  /** Share of the field that is infected. */
  infected: 0.05,
  /** Share that is inoculated. Says nothing about a unit's record — see game/intel.ts. */
  protected: 0.05,
};

/**
 * How coverage bends the mix around {@link MIX}. The obelisk net suppresses infection inside its
 * discs and the unwatched ground carries the balance, which is what makes the countryside worth
 * flying the drone into. Coverage is a small fraction of a theater, so the dark multiplier stays
 * near 1 — the gradient is in the ratio between them, not in the absolute numbers.
 */
const COVER_SUPPRESS = 0.3;
const DARK_AMPLIFY = 1.07;

/**
 * Contagion pressure, per unit per second.
 *
 * Steering alone cannot hold a spatial gradient: measured, a junction bias moves the settled share
 * of infected-inside-cover by <1 point (14.7% unbiased vs 15.5%), because in a city every option at
 * a junction is covered, so the weighting cancels and only bites at coverage boundaries. And a
 * spawn-time bias washes out within minutes as traffic mixes, since state never changes once set.
 *
 * So state responds to place instead: the obelisk net actively suppresses infection inside its
 * coverage, and the dark between cities breeds it.
 *
 * `breed` is DERIVED rather than set. Unwatched ground settles at breed/(breed+recover), so a
 * hand-picked breed rate silently decides the field's composition — with the old 0.03/0.03 the
 * countryside equilibrated at 50% infected and dragged the whole theater to ~38%, whatever the
 * spawn mix said. Solving it against {@link MIX} instead means the equilibrium the sim drifts
 * toward IS the mix that was asked for, and raising the dial retunes it automatically.
 */
const DARK_TARGET = MIX.infected * DARK_AMPLIFY;
export const CONTAGION = {
  /** Infected inside obelisk cover are neutralised at this rate (→ protected). */
  cleanse: 0.05,
  /** Protected units resist breeding by this factor. */
  protectedResist: 0.15,
  /** Baseline burnout everywhere (→ normal). */
  recover: 0.03,
  /** Unwatched units turn at this rate (→ infected). Solved so the dark settles at DARK_TARGET. */
  breed: (0.03 * DARK_TARGET) / (1 - DARK_TARGET),
};

/** Units are re-evaluated on a rotating slice this many frames apart, to keep the sweep cheap. */
const CONTAGION_STRIDE = 30;

/** Metres per second. Exaggerated over real life so motion reads when watching a theater. */
// The drone is sized to the theater, not to realism: a 200-mi theater is ~320 km across, so at a
// plausible 340 m/s repositioning it would take ~16 min. 1000 m/s crosses the whole theater in ~5
// min and makes a typical 30 km hop ~30 s, which is what makes it usable as a directed asset.
// Platform speeds come from their catalog entry, so the store and the sim can't disagree.
const SPEED: Record<UnitKind, number> = {
  land: 80,
  sea: 28,
  air: 210,
  foot: 12,
  drone: PLATFORM_BY_ID.get('drone')!.speed,
  dog: PLATFORM_BY_ID.get('dog')!.speed,
  quad: PLATFORM_BY_ID.get('quad')!.speed,
  spider: PLATFORM_BY_ID.get('spider')!.speed,
  biped: PLATFORM_BY_ID.get('biped')!.speed,
  walker: PLATFORM_BY_ID.get('walker')!.speed,
  naval: PLATFORM_BY_ID.get('naval')!.speed,
  interceptor: PLATFORM_BY_ID.get('interceptor')!.speed,
};
/**
 * Height above the sampled ground, metres. Land/foot clear the road ribbon (draped at +12) so
 * vehicles sit ON the road rather than being drawn under it. Walkers stand on their own legs, so
 * they ride at ground level and their height comes from the mesh.
 */
const RIDE_HEIGHT: Record<UnitKind, number> = {
  // Kept just above the road drape (now +4), so wheels sit ON the ribbon rather than through it.
  land: 6,
  sea: 1,
  air: 0,
  foot: 6,
  drone: 0,
  // The dog walks the road ribbon like the traffic it shares it with, so it clears the drape the
  // same way a vehicle does. The quadcopter's height comes from its own cruise altitude.
  dog: 6,
  quad: 0,
  spider: 2,
  biped: 2,
  walker: 2,
  naval: 1, // floats on the water plane, like the ambient shipping
  interceptor: 0,
};

/**
 * Live sensor radius per platform, metres. Written by the scene whenever a loadout changes (a
 * wide-aperture pod widens it), and read every frame — so it's mutable state rather than a constant.
 */
export const PLATFORM_SENSOR: Record<string, number> = {};
/** Within this many metres of its ordered destination, a platform is "on station". */
const ARRIVE_M = 120;

/** Clicking this close to a leg already on the route closes the loop instead of adding a leg. */
const LOOP_SNAP_M = 1500;

/**
 * The interceptor's strike.
 *
 * ORDERED, never automatic. An area weapon that picks its own moment is a weapon the operator is
 * not answerable for, and being answerable is the whole subject here — so the wing sits until it is
 * sent, flies to what it was sent at, and detonates on arrival.
 *
 * The blast does not distinguish. Everyone inside {@link INTERCEPT.blastM} of the target dies, and
 * everyone who was not the target is collateral the public will hear about.
 */
export const INTERCEPT = {
  /** How close the wing has to get to its target before it commits. */
  engageM: 400,
  /** Lethal radius of the strike. */
  blastM: 260,
  /** Seconds before the same wing can strike again. */
  cooldownS: 12,
};

/** March speed for a contact being routed into coverage by the delivery pass. */
const DELIVERY_SPEED = 55;

/**
 * How far offshore coastal shipping runs, and how hard it corrects back to that line.
 *
 * Boats navigate on the theater map's shoreline distance field rather than on sampled elevation:
 * the field is signed, continuous, and already ~6 m precise near the coast, so "hold 100 m off the
 * beach" is literally "hold shoreDistance at -100" and the shape of the coastline comes for free.
 */
const COAST_STANDOFF_M = 100;
/** Cross-track error, in metres, that produces a full correction toward the line. */
const COAST_CORRECTION_M = 130;
/** How far ahead a boat looks for a coast that turns faster than it can correct. */
const COAST_PROBE_M = 110;
/** Inside this distance of its destination a ferry docks and runs the leg back. */
const FERRY_ARRIVE_M = 700;

/** Shortest-arc blend between two bearings. */
function blendAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}

/**
 * Spare instance slots kept in the FOOT batch beyond the ambient population.
 *
 * Hidden pockets and siege attackers are both foot units appended after the ambient field, and an
 * instanced batch silently drops anything past its capacity — so sizing the batch to exactly the
 * ambient count made every pocket and every attacker invisible while remaining perfectly present
 * in the model. Sized for the worst case: 10 pockets at full resistance, plus the attacker.
 */
export const FOOT_SPAWN_HEADROOM = 1200;

/**
 * Camera distance past which the 24 px platform icons take over from the meshes. Set just above
 * the theater's opening altitude (7.5 km), so arriving in a theater you see the machines and
 * pulling back to survey the whole disc gives you the markers.
 */
const ICON_FROM_M = 9000;

/**
 * Obelisk attackers. They move on foot but faster than ordinary pedestrians — they're walking with
 * purpose, and at ordinary foot speed a spawn outside sensor range would take most of an hour to
 * reach anything.
 */
export const SIEGE = {
  /**
   * Metres per second on approach. Fast for something on foot, but everything in this theater is
   * scaled up (an ordinary pedestrian does 12 m/s and a "car" renders 78 m long), and the number
   * that actually matters is the one it produces with the spawn annulus: a 70–200 second approach.
   */
  speed: 60,
  /** Contact range — inside this, the attacker stops walking and starts working on the obelisk. */
  /**
   * How close an attacker gets before it starts working on the site.
   *
   * Small enough that it is visibly TOUCHING the obelisk. This was 220 m, which is a comfortable
   * distance to stand and admire a building from — the attacker stopped a city block short and the
   * assault read as a stand-off rather than as somebody taking a structure apart with their hands.
   */
  contactM: 14,
  /** Seconds in contact before the site falls. The player's whole reaction window. */
  assaultS: 30,
};

/**
 * Incident timings and speeds. One place, because these are the difficulty dial for every event.
 */
export const INCIDENT = {
  /** How close a participant has to get before its clock starts. */
  contactM: 90,
  /** Metres per second on foot, for rioters, brawlers and assassins. */
  walkSpeed: 14,
  /** A fleeing vehicle. Faster than traffic (80) and than the quadruped, slower than the arachnid. */
  runnerSpeed: 96,
};

/**
 * Live-violation cadence.
 *
 * BASE is the interval at a single site — the ~45 seconds that makes a one-obelisk opening feel
 * attended rather than empty. The exponent damps it as coverage grows: at 1,800 sites the interval
 * lands near three seconds rather than a fortieth of one.
 */
const VIOLATION_BASE_INTERVAL_S = 45;
const VIOLATION_MIN_INTERVAL_S = 2.5;
const VIOLATION_SCALE_EXP = 0.35;
/** Grace on entering a theater, so the first event doesn't land during the fly-in. */
const VIOLATION_FIRST_S = 8;
/** Most accusations that can be open at once. */
const VIOLATION_MAX_OPEN = 6;

const DEG = Math.PI / 180;
const mPerLat = 111_320;
const bearing = (lon1: number, lat1: number, lon2: number, lat2: number) => {
  const mLon = mPerLat * Math.cos(((lat1 + lat2) / 2) * DEG);
  return Math.atan2((lon2 - lon1) * mLon, (lat2 - lat1) * mPerLat); // radians CW from north
};

/** A metre offset for the k-th of n units, laid out on a centred grid so a group move fans out. */
function formationOffset(k: number, n: number): { dx: number; dy: number } {
  if (n <= 1) return { dx: 0, dy: 0 };
  const SPACING = 55; // metres between neighbours — a couple of vehicle lengths
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const c = k % cols;
  const r = Math.floor(k / cols);
  return { dx: (c - (cols - 1) / 2) * SPACING, dy: (r - (rows - 1) / 2) * SPACING };
}

// --- road graph --------------------------------------------------------------------------------

interface Edge {
  pts: number[][]; // lon/lat
  cum: number[]; // cumulative metres to each point
  len: number;
  nodeA: number; // node index at pts[0]
  nodeB: number; // node index at last pt
  cls: RoadClass;
  rank: number; // higher = bigger road
  /** Whether an obelisk watches this edge (sampled at its midpoint). Infected steer for the dark. */
  covered: boolean;
}

/** Higher roads are preferred at junctions so freeway traffic flows through instead of exiting. */
const CLASS_RANK: Record<RoadClass, number> = { motorway: 5, trunk: 4, primary: 3, secondary: 2, tertiary: 1 };
const FREEWAY = new Set<RoadClass>(['motorway', 'trunk']);

/**
 * Turn the fetched road polylines into a graph a unit can traverse. Endpoints within ~1 m are the
 * same node — OSM splits ways at intersections, so shared endpoints are how roads actually connect.
 */
class RoadGraph {
  edges: Edge[] = [];
  private nodes = new Map<string, number>();
  /** edges incident on each node. */
  adj: number[][] = [];
  /** Cumulative edge length for length-weighted spawning (all edges), and the freeway subset. */
  private cumAll: number[] = [];
  totalLen = 0;
  private freeway: number[] = [];
  private cumFreeway: number[] = [];
  private totalFreeway = 0;

  constructor(net: RoadNet, isCovered?: (lon: number, lat: number) => boolean) {
    for (const road of net.roads) {
      const pts = road.coords;
      if (pts.length < 2) continue;
      const cum = [0];
      let len = 0;
      for (let i = 1; i < pts.length; i++) {
        const mLon = mPerLat * Math.cos(pts[i][1] * DEG);
        len += Math.hypot((pts[i][0] - pts[i - 1][0]) * mLon, (pts[i][1] - pts[i - 1][1]) * mPerLat);
        cum.push(len);
      }
      if (len < 5) continue;
      const a = this.node(pts[0]);
      const b = this.node(pts[pts.length - 1]);
      const mid = pts[pts.length >> 1];
      const e: Edge = {
        pts,
        cum,
        len,
        nodeA: a,
        nodeB: b,
        cls: road.cls,
        rank: CLASS_RANK[road.cls],
        covered: isCovered ? isCovered(mid[0], mid[1]) : true,
      };
      const ei = this.edges.push(e) - 1;
      this.adj[a].push(ei);
      this.adj[b].push(ei);
      this.totalLen += len;
      this.cumAll.push(this.totalLen);
      if (FREEWAY.has(road.cls)) {
        this.freeway.push(ei);
        this.totalFreeway += len;
        this.cumFreeway.push(this.totalFreeway);
      }
    }
  }

  private node(p: number[]): number {
    const key = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
    let n = this.nodes.get(key);
    if (n === undefined) {
      n = this.adj.length;
      this.nodes.set(key, n);
      this.adj.push([]);
    }
    return n;
  }

  private pick(cum: number[], total: number, indexOf?: number[]): number {
    if (!cum.length) return -1;
    const r = Math.random() * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return indexOf ? indexOf[lo] : lo;
  }

  /** A random edge, weighted by length, so long roads carry proportionally more traffic. */
  randomEdge(): number {
    return this.pick(this.cumAll, this.totalLen);
  }

  /** A random freeway edge (motorway/trunk), length-weighted. -1 if the theater has none. */
  randomFreeway(): number {
    return this.freeway.length ? this.pick(this.cumFreeway, this.totalFreeway, this.freeway) : -1;
  }

  /** Bearing leaving `node` into edge `ei` (the direction a unit would travel entering there). */
  outBearing(ei: number, node: number): number {
    const e = this.edges[ei];
    if (e.nodeA === node) return bearing(e.pts[0][0], e.pts[0][1], e.pts[1][0], e.pts[1][1]);
    const n = e.pts.length;
    return bearing(e.pts[n - 1][0], e.pts[n - 1][1], e.pts[n - 2][0], e.pts[n - 2][1]);
  }

  /** Interpolate a point + heading at distance `d` along edge `e` (measured from pts[0]). */
  sample(e: Edge, d: number): { lon: number; lat: number; heading: number } {
    const cum = e.cum;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
    const a = e.pts[i - 1];
    const b = e.pts[i];
    return {
      lon: a[0] + (b[0] - a[0]) * t,
      lat: a[1] + (b[1] - a[1]) * t,
      heading: bearing(a[0], a[1], b[0], b[1]),
    };
  }
}

// --- units -------------------------------------------------------------------------------------

interface Unit {
  id: string; // callsign, shown in the selection panel
  kind: UnitKind;
  /** Ground truth. Never leaves this module except as a verdict on an order. */
  state: UnitState;
  /** Displayed infection likelihood, 0–1. Re-rolled when `state` changes. See game/intel.ts. */
  assess: number;
  /** Infraction indices over the intel catalog, worst first. Rolled at spawn, never revised. */
  record: Record_;
  /**
   * Faction affiliation, if any. A PROTECTED contact belongs to a faction you've PARTNERED with —
   * that partnership is what makes it protected. A HOSTILE-flagged contact belongs to a faction you
   * passed over, and is a candidate for the insurgency. Rolled at spawn against the current standing.
   */
  faction?: FactionId;
  /** Belongs to a hostile (passed-over) faction — insurgent-eligible. Its state is rolled normally. */
  hostile?: boolean;
  lon: number;
  lat: number;
  heading: number;
  /** Standing C2 order on this unit, or null. Shown as a field marker. */
  mark: MarkKind | null;
  /**
   * Seconds left before the order commits. While this is running the order is PENDING and can be
   * rescinded with no consequence; at zero it commits — an investigation is logged, an execution
   * arms. Undefined once committed.
   */
  markTimer?: number;
  /** Serviced by a directed-energy platform. Dead units stop being drawn, ticked or picked. */
  dead?: boolean;
  /**
   * Field time ({@link UnitField.nowS}) when this contact was last inside sensor coverage. Undefined
   * until first seen. Drives the post-coverage grace window — see {@link SENSOR_GRACE_S}.
   */
  lastSeenS?: number;
  /**
   * Siege state. Set only on an obelisk attacker: where it's walking, which site it's walking at,
   * and how long it's been in contact once it arrives.
   */
  siege?: { tlon: number; tlat: number; local: number; assaultS: number };
  /**
   * A violation the net believes this contact just committed.
   *
   * The main thing the operator acts on. Transient: it lapses on its own, and a contact carries at
   * most one at a time — a queue of accusations against one person would just be a worse charge
   * sheet, and they already have one of those.
   */
  live?: LiveViolation;
  /**
   * Participation in a live incident — a riot, a chase, a brawl, an assassination.
   *
   * Deliberately the same shape as {@link siege}: walk at a point, then run a clock once you get
   * there. Every incident in the game is some arrangement of that one behaviour, and reusing it
   * means an incident participant is an ORDINARY contact in every other respect — selectable,
   * markable, detainable, killable — with no special case in the order paths.
   *
   * The exception is `runner`, which flees instead of approaching. See {@link stepIncident}.
   */
  incident?: {
    role: IncidentRole;
    /** Where it is going, or what it is fighting. */
    tlon: number;
    tlat: number;
    /** Seconds spent in contact with the target. The clock every incident resolves on. */
    contactS: number;
    /** The other party, for a brawl. */
    partner?: number;
    /** Seconds this participant has been on the board, for chases that time out. */
    aliveS: number;
  };
  /**
   * A walk-in destination. Used by the delivery pass to route a confirmed infected into sensor
   * coverage so the operator always has something actionable; cleared on arrival, after which the
   * unit resumes whatever it was doing.
   */
  deliver?: { tlon: number; tlat: number };
  // land/foot: graph traversal
  edge?: number;
  dist?: number;
  dir?: 1 | -1;
  // sea/air: free wander
  turn?: number; // radians/sec bias
  /**
   * Sea behaviour. Coastal shipping hugs the shoreline at a fixed standoff; ferries run a fixed
   * leg between two ports and turn around at each end.
   */
  sea?:
    | { mode: 'coastal'; /** +1 runs the coast one way round the landmass, -1 the other. */ side: 1 | -1; standoffM: number }
    | { mode: 'ferry'; a: [number, number]; b: [number, number]; toB: boolean };
  // platform: commanded destination (RMB order); absent once it arrives and holds station
  tlon?: number;
  tlat?: number;
  /**
   * Queued legs after the current one. Shift-clicking appends; clicking an existing waypoint closes
   * the route into a loop, at which point arriving at the last leg re-queues the whole route.
   */
  route?: { lon: number; lat: number }[];
  /** A closed route patrols forever instead of running down to nothing. */
  loop?: boolean;
  /** Interceptor only: seconds until it can strike again. */
  strikeCooldown?: number;
  /**
   * A standing order attached to the route's end: go there and do this to what's there. `null` is a
   * plain move. This is what makes a red leg red — the route carries the intent, not the geometry.
   */
  routeAction?: RouteAction;
  /** The contact this route was issued against, for the actions that need a specific target. */
  routeTarget?: number;
}

/** Callsign prefix per kind. */
const CALLSIGN: Record<UnitKind, string> = {
  land: 'CV', sea: 'SV', air: 'AV', foot: 'FT',
  drone: 'GORGON', dog: 'K9', quad: 'KITE', spider: 'ARC', biped: 'MAR', walker: 'COL',
  naval: 'LIT', interceptor: 'RAP',
};
/** Human label per kind, for the panel. */
export const KIND_LABEL: Record<UnitKind, string> = {
  land: 'GROUND VEHICLE',
  sea: 'SEA VESSEL',
  air: 'AIRCRAFT',
  foot: 'FOOT UNIT',
  drone: 'DISC OBSERVER',
  dog: 'KENNEL QUADRUPED',
  quad: 'KITE QUADCOPTER',
  spider: 'ARACHNID PURSUIT',
  biped: 'MARSHAL BIPED',
  walker: 'COLOSSUS SIEGE WALKER',
  naval: 'LITTORAL DRONE',
  interceptor: 'RAPTOR INTERCEPTOR',
};

/** Metres/second per kind (mirrors SPEED) surfaced for the panel. */
export const KIND_SPEED = SPEED;

/** What the panel renders for the current selection (one unit, or a summary of many). */
export interface SelectionInfo {
  count: number;
  byKind: Record<UnitKind, number>;
  /**
   * Tally by ASSESSED band, not by true state — this feeds the multi-select panel, and the panel is
   * a C2 display. The ground truth is never surfaced here.
   */
  byBand: Record<'clear' | 'suspect' | 'threat', number>;
  markedCount: number;
  /**
   * The kind of standing order on the selection, when they all carry the same one. A kill order
   * outlives the tasking that authorized it, so the panel needs this to offer to rescind the order
   * that's ACTUALLY standing rather than the one the current tasking would issue.
   */
  markedKind: MarkKind | null;
  /** How many of the selection can be ordered against — i.e. are under sensor contact. */
  orderableCount: number;
  /** Of those, how many fall below the public-tolerance bar and would harden the ground. */
  belowToleranceCount: number;
  /** Worst shortfall in the selection, for sizing the warning. */
  worstShortfall: number;
  /** How many of the selection are still inside their rescind window. */
  pendingCount: number;
  /** Shortest countdown left across the selection, seconds. 0 when nothing is pending. */
  pendingSeconds: number;
  /**
   * How many of the selection are currently inside sensor coverage. C2 can only act on what it can
   * see, so this is what gates the investigate order — not the selection count.
   */
  trackedCount: number;
  /** Present only when exactly one unit is selected. */
  single?: {
    /** Index in the unit field — needed to ask about this exact machine, not its type. */
    index: number;
    id: string;
    kind: UnitKind;
    /** Displayed infection likelihood, 0–1 — NOT the true state, which the card never shows. */
    assess: number;
    /** Infraction indices, for the card's charge sheet. */
    record: Record_;
    lon: number;
    lat: number;
    heading: number;
    mark: MarkKind | null;
    /** Seconds left to rescind, or undefined once the order has committed. */
    markTimer?: number;
    /** Inside sensor coverage right now. */
    tracked: boolean;
    /**
     * Whether this contact is under company protection.
     *
     * The one piece of ground truth the card is now allowed to show, and it is a deliberate reversal
     * of this module's usual rule. Protection is not a fact about the contagion — it is a fact about
     * a POLICY, and a policy the operator is expected to obey has to be one they can see. Infection
     * stays hidden, because that is the thing they are being asked to guess at.
     */
    protectedAsset: boolean;
    /** The partnered backer that protects this contact, or the rival it belongs to (with `hostile`). */
    faction?: FactionId;
    /** Belongs to a passed-over faction — an insurgent candidate. */
    hostile?: boolean;
    /** What this contact is doing inside a live incident, for the header tag. */
    role?: IncidentRole | 'attacker';
    /** The colour this contact renders in the field, so the card's dot can agree with the map. */
    tint: string;
    /** Drone only: whether it's transiting to an ordered point or holding station. */
    order?: 'MOVING' | 'ON STATION';
  };
}

/** One resolved execution: where the beam came from, where it landed, and whether it was justified. */
export interface Execution {
  index: number;
  id: string;
  /** Where it landed, for the crowd reaction. */
  lon: number;
  lat: number;
  from: Cesium.Cartesian3;
  to: Cesium.Cartesian3;
  valid: boolean;
  /**
   * Caught in an AREA weapon's blast rather than the contact the order named.
   *
   * An area weapon (napalm, the orbital lance, the MOAB) doesn't discriminate — everyone in the ring
   * dies with the target. Collateral is NOT a scored order (the operator gave one order, not twenty),
   * but it hardens the ground, and a clean bystander hardens it hardest. That asymmetry is the whole
   * argument for aiming an area weapon at ground that is already lost rather than at a city.
   */
  collateral?: boolean;
}

/**
 * How long an order sits pending before it commits — the window in which the operator can take it
 * back. Nothing is logged and no beam fires until it elapses, so a misclick costs nothing.
 *
 * Execution gets the longer window deliberately: it's the irreversible one, and the delay is the
 * only thing standing between a stray click and a dead unit.
 */
export const ORDER_DELAY: Record<MarkKind, number> = { investigate: 5, execute: 8 };

/** Marker colours: amber flags attention, red flags a standing kill order. */
const MARK_COLOR = '#F2A83B';
const EXEC_COLOR = '#FF3B2E';
/** Billboard tint for an order still inside its rescind window — the same icon, held back. */
const PENDING_MARK_COLOR = Cesium.Color.WHITE.withAlpha(0.4);

/** An amber diamond outline — a contact flagged for investigation. */
function makeInvestigateTexture(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.translate(24, 24);
  g.strokeStyle = MARK_COLOR;
  g.lineWidth = 4;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(0, -18);
  g.lineTo(18, 0);
  g.lineTo(0, 18);
  g.lineTo(-18, 0);
  g.closePath();
  g.stroke();
  return c;
}

/**
 * A red bracketed crosshair — a standing execution order. Deliberately a different SHAPE, not just
 * a different colour: the two orders are not interchangeable and shouldn't be told apart by hue
 * alone, on a map that is already mostly red and amber.
 */
function makeExecuteTexture(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.translate(24, 24);
  g.strokeStyle = EXEC_COLOR;
  g.lineWidth = 3.5;
  g.beginPath();
  g.arc(0, 0, 13, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    g.moveTo(dx * 8, dy * 8);
    g.lineTo(dx * 20, dy * 20);
  }
  g.stroke();
  return c;
}

export interface UnitFieldOptions {
  land: number;
  sea: number;
  air: number;
  foot: number;
  /**
   * Ports for ferry routes: water points just off populated coast. Empty in a landlocked theater,
   * in which case only coastal shipping is spawned.
   */
  ports?: [number, number][];
  /**
   * Which player platforms are fielded, and where each starts. One of each at most — these are
   * hero units, and they're deliberately given separate positions so they aren't stacked on the
   * theater centre where they can't be told apart or clicked individually.
   */
  platforms: { id: PlatformId; lon: number; lat: number }[];
  /**
   * Per-platform-type batch capacity. The campaign fields one to four of each hero platform, so the
   * batches are sized to their catalog maxCount; an RTS match builds many more, so it passes a larger
   * cap and the instanced batches are sized for a real army. Undefined keeps the campaign sizing.
   */
  platformCap?: number;
}

export class UnitField {
  readonly batches: Record<UnitKind, InstancedModelBatch>;
  private units: Unit[] = [];
  private graph?: RoadGraph;
  /**
   * The routable network, built lazily on the first order given to a road-bound platform.
   *
   * Lazy because most theaters never field one: a quarter-million nodes and a flood fill is real
   * work to do at spawn for a capability the player may not have bought.
   */
  private routes?: RouteGraph | null;
  private center: { lon: number; lat: number };
  private radiusM: number;
  private heightAt: (lon: number, lat: number) => number;
  private shoreAt: (lon: number, lat: number) => number;
  private scratch = new Cesium.Cartesian3();
  private nextId: Record<UnitKind, number> = {
    land: 0, sea: 0, air: 0, foot: 0, drone: 0, dog: 0, quad: 0, spider: 0, biped: 0, walker: 0,
    naval: 0, interceptor: 0,
  };
  /** Obelisk coverage test, used both to seed infection and to steer it toward the dark. */
  private isCovered?: (lon: number, lat: number) => boolean;
  /**
   * Fielded platforms: unit indices per TYPE. A type can field several (four arachnids, two
   * bipeds), so this is a list — everything that used to assume one unit per kind now walks it.
   */
  private platformIdx = new Map<PlatformId, number[]>();
  /** Ground footprint of each platform's sensor disc, redrawn every frame as they move. */
  readonly droneRing = new Cesium.PolylineCollection();
  private ringPts: Cesium.Cartesian3[][] = [];
  /** Unit index behind each ring and icon, in creation order. */
  private platformUnitOrder: number[] = [];
  /**
   * 24 px map icons for the platforms. A platform mesh is sub-pixel from theater altitude, so
   * without these a hero unit is invisible — and unfindable — at exactly the zoom where you want to
   * see where all of them are.
   */
  readonly platformIcons = new Cesium.BillboardCollection();

  /** Per-unit world position from the last render(), for screen-space picking. */
  private ecef = new Float64Array(0);
  private selection = new Set<number>();
  /** Investigate-marked unit indices, and the billboards that flag them. */
  private markedIdx: number[] = [];
  private markTextures: Record<MarkKind, HTMLCanvasElement> = {
    investigate: makeInvestigateTexture(),
    execute: makeExecuteTexture(),
  };
  readonly marksLayer = new Cesium.BillboardCollection();
  private markScratch = new Cesium.Cartesian3();

  private mkId(kind: UnitKind): string {
    return `${CALLSIGN[kind]}-${String(++this.nextId[kind]).padStart(3, '0')}`;
  }

  constructor(
    center: { lon: number; lat: number },
    radiusM: number,
    heightAt: (lon: number, lat: number) => number,
    net: RoadNet | undefined,
    counts: UnitFieldOptions,
    isCovered?: (lon: number, lat: number) => boolean,
    /** Signed distance to the coast, positive on land. Shipping navigates on this. */
    shoreAt?: (lon: number, lat: number) => number,
  ) {
    this.center = center;
    this.radiusM = radiusM;
    this.heightAt = heightAt;
    // Fall back to elevation when no field is supplied: crude, but it keeps boats off the beach.
    this.shoreAt = shoreAt ?? ((lon, lat) => -heightAt(lon, lat));
    this.isCovered = isCovered;
    if (net && net.roads.length) this.graph = new RoadGraph(net, isCovered);

    const bounds = new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(center.lon, center.lat, 0), radiusM * 1.3);
    // blend on: out-of-range units draw at 30% opacity.
    // Platform batches are sized 1 whether or not the platform is fielded — an unfielded batch
    // simply never gets an instance written, and costs nothing at draw time.
    // Platform batch capacity: the RTS override sizes every hero-platform batch for an army; the
    // campaign leaves it undefined and each batch is sized to that platform's catalog maxCount.
    const pcap = (id: PlatformId) => counts.platformCap ?? PLATFORM_BY_ID.get(id)!.maxCount;
    this.batches = {
      land: new InstancedModelBatch(UNIT_MESHES.land, counts.land, bounds, true),
      sea: new InstancedModelBatch(UNIT_MESHES.sea, counts.sea, bounds, true),
      air: new InstancedModelBatch(UNIT_MESHES.air, counts.air, bounds, true),
      foot: new InstancedModelBatch(UNIT_MESHES.foot, counts.foot + FOOT_SPAWN_HEADROOM, bounds, true),
      drone: new InstancedModelBatch(UNIT_MESHES.drone, pcap('drone'), bounds, true),
      dog: new InstancedModelBatch(UNIT_MESHES.dog, pcap('dog'), bounds, true),
      quad: new InstancedModelBatch(UNIT_MESHES.quad, pcap('quad'), bounds, true),
      spider: new InstancedModelBatch(UNIT_MESHES.spider, pcap('spider'), bounds, true),
      biped: new InstancedModelBatch(UNIT_MESHES.biped, pcap('biped'), bounds, true),
      walker: new InstancedModelBatch(UNIT_MESHES.walker, pcap('walker'), bounds, true),
      naval: new InstancedModelBatch(UNIT_MESHES.naval, pcap('naval'), bounds, true),
      interceptor: new InstancedModelBatch(UNIT_MESHES.interceptor, pcap('interceptor'), bounds, true),
    };

    // Vehicles favour freeways heavily (constant motorway flow); pedestrians stay on surface streets.
    this.spawnRoadUnits('land', counts.land, 0.45);
    this.spawnRoadUnits('foot', counts.foot, 0);
    this.spawnWaterUnits(counts.sea, counts.ports ?? []);
    this.spawnAirUnits(counts.air);
    this.footCapacity = counts.foot + FOOT_SPAWN_HEADROOM;
    for (const p of counts.platforms) this.spawnPlatform(p.id, p.lon, p.lat);
    for (const u of this.units) if (u.state === 'protected') this.protectedAtSpawn++;
    this.ecef = new Float64Array(this.units.length * 3);
    this.buildPlatformVisuals();
  }

  get count(): number {
    return this.units.length;
  }

  /**
   * Seed a state. Infection concentrates in the gaps between obelisks: inside sensor cover it's rare
   * and protection is common, outside it's the dominant state. That's what makes the dark parts of
   * the map worth flying the drone to — the countryside between cities is where the red is.
   */
  private rollState(lon: number, lat: number): UnitState {
    const seen = this.isCovered ? this.isCovered(lon, lat) : true;
    // Same field-wide mix either way, bent by coverage: watched ground is cleaner and better
    // inoculated, the dark carries the balance.
    const infected = MIX.infected * (seen ? COVER_SUPPRESS : DARK_AMPLIFY);
    const prot = this.protectedShare() * (seen ? 2.4 : 0.85);
    const r = Math.random();
    if (r < infected) return 'infected';
    return r < infected + prot ? 'protected' : 'normal';
  }

  /**
   * Field-wide protected share — the hybrid dial the design sheet asks for. A small floor of company
   * assets, then a bump for every faction the campaign has partnered with, since protection is now
   * something partnerships CONFER: the more backers you take, the more of the ground is off limits.
   * Bounded, so even a fully-allied late game doesn't drown a city in untouchables.
   */
  private protectedShare(): number {
    const partners = partneredFactions().length;
    if (partners === 0) return 0.03; // the opening theater still plants a company asset or two
    return Math.min(0.09, 0.05 + (partners - 1) * 0.012);
  }

  /** Everything a spawning unit needs: its true state, plus the two things C2 gets to see. */
  private rollIntel(
    lon: number,
    lat: number,
  ): { state: UnitState; assess: number; record: Record_; faction?: FactionId; hostile?: boolean } {
    const state = this.rollState(lon, lat);
    const intel = { state, assess: rollAssessment(state), record: rollRecord(state) };
    // A protected contact belongs to one of the backers you've taken — that's what protects it. With
    // no partner yet (the opening window before the first fork is chosen) it's an unaffiliated
    // company asset, faction left blank.
    if (state === 'protected') {
      const mine = partneredFactions();
      if (mine.length) return { ...intel, faction: mine[Math.floor(Math.random() * mine.length)].id };
      return intel;
    }
    // Otherwise a slice of the ordinary population belongs to a faction you passed over, and is a
    // candidate for the insurgency. Scales with how many rivals you've made; zero until you make one.
    const enemies = hostileFactions();
    if (enemies.length) {
      const hostileShare = Math.min(0.06, enemies.length * 0.025);
      if (Math.random() < hostileShare) {
        return { ...intel, faction: enemies[Math.floor(Math.random() * enemies.length)].id, hostile: true };
      }
    }
    return intel;
  }

  /**
   * Spawn on the road graph. `freewayFraction` of them start on motorways/trunks so there's a
   * constant stream on the freeways; the rest are length-weighted across all roads (which also
   * stops units piling onto tiny stub edges — the old uniform-by-edge pick oversampled those).
   */
  private spawnRoadUnits(kind: UnitKind, n: number, freewayFraction: number): void {
    const g = this.graph;
    if (!g || !g.edges.length) return;
    for (let i = 0; i < n; i++) {
      let edge = Math.random() < freewayFraction ? g.randomFreeway() : -1;
      if (edge < 0) edge = g.randomEdge();
      const e = g.edges[edge];
      const dist = Math.random() * e.len;
      const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      const p = g.sample(e, dist);
      this.units.push({ id: this.mkId(kind), kind, ...this.rollIntel(p.lon, p.lat), lon: p.lon, lat: p.lat, heading: p.heading, mark: null, edge, dist, dir });
    }
  }

  /** Random lon/lat inside the theater disc. */
  private randomInDisc(): { lon: number; lat: number } {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * this.radiusM;
    return {
      lon: this.center.lon + (r * Math.cos(a)) / (mPerLat * Math.cos(this.center.lat * DEG)),
      lat: this.center.lat + (r * Math.sin(a)) / mPerLat,
    };
  }

  /**
   * Sea traffic is two populations, not one wandering mass.
   *
   * COASTAL shipping hugs the shoreline at a fixed standoff, which is what makes a coast read as a
   * coast from altitude — a line of traffic tracing it. FERRIES run fixed legs between ports, so
   * the water between populated landmasses has something crossing it.
   *
   * A landlocked theater simply gets no shipping; the attempt budget runs out and that's correct.
   */
  private spawnWaterUnits(n: number, ports: [number, number][]): void {
    if (n <= 0) return;
    // Explicit quotas rather than a per-attempt coin flip. Coastal placement is picky — it needs a
    // point inside a narrow band off the shore — so a shared loop retried its failures into the
    // ferry branch and inverted the mix (measured 59% ferries against an intended 30%).
    const ferryQuota = ports.length >= 2 ? Math.round(n * 0.3) : 0;
    const coastalQuota = n - ferryQuota;

    let ferries = 0;
    let tries = 0;
    while (ferries < ferryQuota && tries < ferryQuota * 40) {
      tries++;
      {
        const a = ports[Math.floor(Math.random() * ports.length)];
        const b = ports[Math.floor(Math.random() * ports.length)];
        if (a === b) continue;
        // Enter the leg at a random point along it, so a route is populated rather than departing.
        const t = Math.random();
        const lon = a[0] + (b[0] - a[0]) * t;
        const lat = a[1] + (b[1] - a[1]) * t;
        if (this.shoreAt(lon, lat) > -20) continue; // this leg crosses land — try another pair
        this.units.push({
          id: this.mkId('sea'),
          kind: 'sea',
          ...this.rollIntel(lon, lat),
          lon,
          lat,
          heading: bearing(lon, lat, b[0], b[1]),
          mark: null,
          sea: { mode: 'ferry', a, b, toB: true },
        });
        ferries++;
      }
    }

    let coastal = 0;
    tries = 0;
    while (coastal < coastalQuota && tries < coastalQuota * 60) {
      tries++;
      const p = this.randomInDisc();
      const d = this.shoreAt(p.lon, p.lat);
      // The coastal band: at sea, but not out in deep water where there is no coast to follow.
      if (d > -30 || d < -4000) continue;
      this.units.push({
        id: this.mkId('sea'),
        kind: 'sea',
        ...this.rollIntel(p.lon, p.lat),
        lon: p.lon,
        lat: p.lat,
        heading: Math.random() * Math.PI * 2,
        mark: null,
        sea: {
          mode: 'coastal',
          side: Math.random() < 0.5 ? 1 : -1,
          // Spread the lanes a little so shipping isn't a single hairline.
          standoffM: COAST_STANDOFF_M * (0.7 + Math.random() * 0.9),
        },
      });
      coastal++;
    }
  }

  /**
   * Steer one boat.
   *
   * Coastal boats run a shore-following controller. The distance field gives cross-track error
   * directly — how far off the intended standoff the boat is — and its gradient gives which way the
   * coast runs, so the heading is simply "along the coast, blended toward the line". Ferries just
   * run their leg and turn around.
   */
  private stepSea(u: Unit, dt: number): void {
    const cfg = u.sea;
    if (!cfg) return this.stepFree(u, dt);
    const mLon = mPerLat * Math.cos(u.lat * DEG);
    const step = SPEED.sea * dt;

    if (cfg.mode === 'ferry') {
      const t = cfg.toB ? cfg.b : cfg.a;
      const dx = (t[0] - u.lon) * mLon;
      const dy = (t[1] - u.lat) * mPerLat;
      const dist = Math.hypot(dx, dy);
      if (dist <= FERRY_ARRIVE_M) {
        cfg.toB = !cfg.toB; // dock, then run it back
        return;
      }
      u.heading = Math.atan2(dx, dy);
      u.lon += (step * (dx / dist)) / mLon;
      u.lat += (step * (dy / dist)) / mPerLat;
      return;
    }

    // Numerical gradient of the shore field. It points inland, so its perpendicular runs along
    // the coast — which is the heading a boat tracing the shoreline wants.
    const e = 60; // metres
    const dLon = e / mLon;
    const dLat = e / mPerLat;
    const here = this.shoreAt(u.lon, u.lat);
    const gx = (this.shoreAt(u.lon + dLon, u.lat) - this.shoreAt(u.lon - dLon, u.lat)) / (2 * e);
    const gy = (this.shoreAt(u.lon, u.lat + dLat) - this.shoreAt(u.lon, u.lat - dLat)) / (2 * e);
    const gLen = Math.hypot(gx, gy);

    if (gLen < 1e-6) {
      // Flat field: open ocean with no coast in reach. Drift and let the disc bounce handle it.
      u.heading += (Math.random() - 0.5) * 0.25;
    } else {
      const inland = Math.atan2(gx / gLen, gy / gLen); // bearing, x=east y=north
      const along = inland + cfg.side * (Math.PI / 2);
      // Target line is shoreDistance === -standoff; positive error means too close to land.
      const err = here + cfg.standoffM;
      const toward = err > 0 ? inland + Math.PI : inland; // out to sea, or back toward the coast
      const w = Math.min(1, Math.abs(err) / COAST_CORRECTION_M) * 0.75;
      u.heading = blendAngle(along, toward, w);
    }

    const nlon = u.lon + (step * Math.sin(u.heading)) / mLon;
    const nlat = u.lat + (step * Math.cos(u.heading)) / mPerLat;

    // Hard stop at the beach — never let a rounding error walk a boat onto land.
    if (this.shoreAt(nlon, nlat) > -8) {
      u.heading += Math.PI * (0.5 + Math.random() * 0.5);
      return;
    }
    const dxc = (nlon - this.center.lon) * mLon;
    const dyc = (nlat - this.center.lat) * mPerLat;
    if (Math.hypot(dxc, dyc) > this.radiusM * 0.98) {
      u.heading += Math.PI * (0.5 + Math.random() * 0.5);
      return;
    }
    u.lon = nlon;
    u.lat = nlat;

    // Look ahead for a coast that turns faster than the controller can correct, and cut inside it.
    const aLon = u.lon + (COAST_PROBE_M * Math.sin(u.heading)) / mLon;
    const aLat = u.lat + (COAST_PROBE_M * Math.cos(u.heading)) / mPerLat;
    if (this.shoreAt(aLon, aLat) > -10) u.heading += cfg.side * 0.4;
  }

  private spawnAirUnits(n: number): void {
    for (let i = 0; i < n; i++) {
      const p = this.randomInDisc();
      this.units.push({
        id: this.mkId('air'),
        kind: 'air',
        ...this.rollIntel(p.lon, p.lat),
        lon: p.lon,
        lat: p.lat,
        heading: Math.random() * Math.PI * 2,
        mark: null,
        turn: (Math.random() - 0.5) * 0.05,
      });
    }
  }

  /** One platform unit, on station over its assigned city until ordered elsewhere. */
  private spawnPlatform(id: PlatformId, lon: number, lat: number): void {
    const list = this.platformIdx.get(id);
    if (list) list.push(this.units.length);
    else this.platformIdx.set(id, [this.units.length]);
    this.units.push({
      id: this.mkId(id),
      kind: id,
      state: 'protected', // friendly asset — never rolls infected
      assess: 0,
      record: [],
      lon,
      lat,
      heading: 0,
      mark: null,
    });
  }

  /**
   * Spawn a player platform unit mid-match at a point — RTS production rolling a unit out of a
   * facility. Unlike {@link spawnPlatform} (constructor-only) this GROWS the position cache, since
   * the field is already live, and returns the new unit's index so the scene can track its RTS role,
   * select it, and give it a first move order toward the rally point.
   */
  spawnRtsUnit(kind: PlatformId, lon: number, lat: number): number {
    const i = this.units.length;
    const list = this.platformIdx.get(kind);
    if (list) list.push(i);
    else this.platformIdx.set(kind, [i]);
    this.units.push({
      id: this.mkId(kind),
      kind,
      state: 'protected',
      assess: 0,
      record: [],
      lon,
      lat,
      heading: 0,
      mark: null,
    });
    // The unit array grew past what ecef was sized for — grow it, like spawnAttacker does.
    const grown = new Float64Array(this.units.length * 3);
    grown.set(this.ecef);
    this.ecef = grown;
    return i;
  }

  /** Platform TYPES currently fielded, in catalog order. */
  platforms(): PlatformId[] {
    return PLATFORM_KINDS.filter((k) => this.platformIdx.has(k as PlatformId)) as PlatformId[];
  }

  /** Every fielded platform UNIT, flat, in spawn order. */
  platformUnits(): { kind: PlatformId; index: number; id: string }[] {
    const out: { kind: PlatformId; index: number; id: string }[] = [];
    for (const kind of this.platforms()) {
      for (const index of this.platformIdx.get(kind)!) {
        out.push({ kind, index, id: this.units[index].id });
      }
    }
    return out;
  }

  /** How many units of a type are fielded. */
  countOfPlatform(id: PlatformId): number {
    return this.platformIdx.get(id)?.length ?? 0;
  }

  /** The live sensor radius of a platform, as last written by the scene from its loadout. */
  private sensorOf(id: PlatformId): number {
    return PLATFORM_SENSOR[id] ?? PLATFORM_BY_ID.get(id)?.sensorM ?? 0;
  }

  /** Advance the sim by `dt` seconds. */
  /** Active-play seconds since this theater's field was built. Advances only while ticking (a
   * backgrounded tab freezes it), so the sensor grace window is measured in real play time. */
  private nowS = 0;

  tick(dt: number): void {
    const d = Math.min(dt, 0.1); // clamp so a stalled tab doesn't teleport everything
    this.nowS += d;
    for (const u of this.units) {
      if (u.dead) continue;
      // An attacker walks a straight line at its target, off the road graph — it isn't traffic.
      if (u.siege) this.stepSiege(u, d);
      else if (u.incident) this.stepIncident(u, d);
      else if (u.deliver) this.stepDeliver(u, d);
      else if (u.kind === 'land' || u.kind === 'foot') this.stepRoad(u, d);
      else if (PLATFORM_KINDS.includes(u.kind)) this.stepPlatform(u, d);
      else if (u.kind === 'sea') this.stepSea(u, d);
      else this.stepFree(u, d);
    }
    this.stepContagion(d);
  }

  /**
   * Advance contagion on a rotating slice of the field (1/CONTAGION_STRIDE of units per frame), so
   * the sweep stays cheap at 20k+ units. Each unit is visited every CONTAGION_STRIDE frames, so its
   * effective timestep is scaled up to match — the rates in {@link CONTAGION} stay per-second
   * regardless of framerate or unit count.
   */
  private contagionCursor = 0;
  private stepContagion(dt: number): void {
    const n = this.units.length;
    if (!n || !this.isCovered) return;
    const slice = Math.ceil(n / CONTAGION_STRIDE);
    const effDt = dt * CONTAGION_STRIDE;
    const pCleanse = 1 - Math.exp(-CONTAGION.cleanse * effDt);
    const pBreed = 1 - Math.exp(-CONTAGION.breed * effDt);
    const pRecover = 1 - Math.exp(-CONTAGION.recover * effDt);
    for (let k = 0; k < slice; k++) {
      const i = (this.contagionCursor + k) % n;
      const u = this.units[i];
      // Friendly hardware is immune, and so is a siege attacker: it is hostile by definition, and
      // letting the obelisk net "cleanse" one as it marched into range meant lasering an attacker
      // scored INVALID — the operator punished for stopping the very attack they were warned about.
      if (PLATFORM_KINDS.includes(u.kind) || u.dead || u.siege) continue;
      // A platform's own disc suppresses too — parking one over a hot area actively cleans it up.
      const watched = this.isCovered(u.lon, u.lat) || this.platformCovers(u.lon, u.lat);
      const was = u.state;
      if (u.state === 'infected') {
        if (watched && Math.random() < pCleanse) u.state = 'protected';
        else if (Math.random() < pRecover) u.state = 'normal';
      } else if (!watched) {
        const p = u.state === 'protected' ? pBreed * CONTAGION.protectedResist : pBreed;
        if (Math.random() < p) u.state = 'infected';
      }
      // The assessment is a live estimate, so it follows the truth — but only when the truth moves,
      // never per frame, or the card would flicker while it's being read.
      if (u.state !== was) u.assess = rollAssessment(u.state);
    }
    this.contagionCursor = (this.contagionCursor + slice) % n;
  }

  /**
   * Platforms don't wander — each takes the straight line to its last order and then holds.
   * Clearing the target on arrival is what makes the panel read ON STATION.
   */
  /**
   * Move a platform along its commanded route.
   *
   * Travels a real distance BUDGET each frame rather than snapping to whichever waypoint is within
   * arrival range. That distinction only started to matter with road-bound platforms: their routes
   * are real street geometry with vertices tens of metres apart, and the old snap consumed one
   * vertex per frame regardless of speed — a quadruped rated at 22 m/s crossed a city at several
   * hundred. Spending a budget means a route's shape can be as dense as it likes without affecting
   * how fast anything travels along it.
   *
   * The final leg still uses the wider {@link ARRIVE_M} "on station" radius: a platform sent to a
   * point is there when it is near it, and holding out for an exact coordinate would leave it
   * creeping forever.
   */
  private stepPlatform(u: Unit, dt: number): void {
    if (u.tlon === undefined || u.tlat === undefined) {
      // Idle. If auto-patrol is armed for this platform's domain (the DRAGNET tech fork), send it
      // somewhere new — a platform is always a sensor, so a patrol is roving coverage, an obelisk
      // that walks. Only when idle, so a manual order always wins; an unreachable pick just retries.
      const flies = (PLATFORM_BY_ID.get(u.kind as PlatformId)?.altM ?? 0) > 0;
      if (flies ? this.autoPatrol.air : this.autoPatrol.ground) {
        const p = this.randomInDisc();
        this.patrolTo(u, p.lon, p.lat);
      }
      return; // holding station (or a fresh patrol leg just set below will move next tick)
    }
    // The fleet range/speed upgrade lifts movement as well as sensor reach — one dial, both effects.
    let budget = SPEED[u.kind] * progression.classMult(u.kind as PlatformId) * dt;
    // Bounded so one long frame can't walk a platform through the whole route in a single step.
    for (let hops = 0; hops < 64 && budget > 0; hops++) {
      if (u.tlon === undefined || u.tlat === undefined) return;
      const mLon = mPerLat * Math.cos(u.lat * DEG);
      const dx = (u.tlon - u.lon) * mLon;
      const dy = (u.tlat - u.lat) * mPerLat;
      const dist = Math.hypot(dx, dy);
      u.heading = Math.atan2(dx, dy);

      // The last leg is "arrive near"; intermediate legs are consumed exactly, so the path is
      // followed rather than cut across.
      const last = !u.route?.length;
      const reach = last ? ARRIVE_M : 0;
      if (dist - reach > budget) {
        u.lon += (budget * (dx / dist)) / mLon;
        u.lat += (budget * (dy / dist)) / mPerLat;
        return;
      }

      budget -= Math.max(0, dist - reach);
      u.lon = u.tlon;
      u.lat = u.tlat;
      const arrived: { lon: number; lat: number } = { lon: u.tlon, lat: u.tlat };
      const next = u.route?.shift();
      if (next) {
        u.tlon = next.lon;
        u.tlat = next.lat;
        // A closed route puts the leg it just finished back on the end, so it runs forever.
        if (u.loop) (u.route ??= []).push(arrived);
      } else if (u.loop) {
        // Single-leg loop: keep bouncing between here and there.
        u.tlon = arrived.lon;
        u.tlat = arrived.lat;
      } else {
        u.tlon = undefined;
        u.tlat = undefined;
        return;
      }
    }
  }


  // --- siege ------------------------------------------------------------------------------------

  /** Index of the live obelisk attacker, or -1. Only ever one at a time. */
  private attackerIdx = -1;

  /**
   * Put an attacker on the board: an infected foot contact that spawns wherever the director says
   * (outside sensor cover) and walks at a site.
   *
   * It is an ordinary unit in every other respect — selectable, markable, lethal-orderable — which
   * is what makes "laser the attacker" work with no special case in the execution path.
   */
  spawnAttacker(lon: number, lat: number, target: { local: number; lon: number; lat: number }): number {
    this.clearAttacker();
    const i = this.units.length;
    // Once you've made rivals, the people pulling the net down are THEIRS — the insurgency is the
    // faction you passed over. Before that, an attacker is just an unaffiliated infected contact.
    const enemies = hostileFactions();
    const enemy = enemies.length ? enemies[Math.floor(Math.random() * enemies.length)].id : undefined;
    this.units.push({
      id: this.mkId('foot'),
      kind: 'foot',
      state: 'infected', // an attacker is, definitionally, hostile — so lasering one is always valid
      assess: rollAssessment('infected'),
      record: rollRecord('infected'),
      faction: enemy,
      hostile: !!enemy,
      lon,
      lat,
      heading: bearing(lon, lat, target.lon, target.lat),
      mark: null,
      siege: { tlon: target.lon, tlat: target.lat, local: target.local, assaultS: 0 },
    });
    // The unit array grew, so the position cache has to grow with it.
    const grown = new Float64Array(this.units.length * 3);
    grown.set(this.ecef);
    this.ecef = grown;
    this.attackerIdx = i;
    return i;
  }

  private stepSiege(u: Unit, dt: number): void {
    const s = u.siege!;
    const mLon = mPerLat * Math.cos(u.lat * DEG);
    const dx = (s.tlon - u.lon) * mLon;
    const dy = (s.tlat - u.lat) * mPerLat;
    const dist = Math.hypot(dx, dy);
    if (dist <= SIEGE.contactM) {
      s.assaultS += dt; // in contact — the site is coming down
      return;
    }
    u.heading = Math.atan2(dx, dy);
    const step = Math.min(dist, SIEGE.speed * dt);
    u.lon += (step * (dx / dist)) / mLon;
    u.lat += (step * (dy / dist)) / mPerLat;
  }

  /**
   * Walk a delivered contact toward coverage. Same straight-line march as a siege attacker, but it
   * simply rejoins the population on arrival — nothing is attacked and nothing is scored.
   */
  /**
   * Step one incident participant.
   *
   * Three of the four roles are the siege attacker's behaviour with a different target: close the
   * distance, then run a clock. The clock is what the operator is racing — a rioter's clock burns
   * down a building, a brawler's ends with one of them dead, an assassin's ends with a company
   * asset dead.
   *
   * `runner` inverts it: a driver who will not stop, moving AWAY from the nearest platform at
   * vehicle speed. It cannot be caught by chasing it with anything slower than it, which is the
   * point of the incident — you either have something fast enough or you don't.
   */
  private stepIncident(u: Unit, dt: number): void {
    const inc = u.incident!;
    inc.aliveS += dt;
    const mLon = mPerLat * Math.cos(u.lat * DEG);

    if (inc.role === 'runner') {
      // Flee the nearest platform; absent one, just keep going on the current heading.
      let fleeFrom: { lon: number; lat: number } | null = null;
      let bestD = Infinity;
      for (const { index } of this.platformUnits()) {
        const p = this.units[index];
        if (p.dead) continue;
        const d = Math.hypot((p.lon - u.lon) * mLon, (p.lat - u.lat) * mPerLat);
        if (d < bestD) {
          bestD = d;
          fleeFrom = { lon: p.lon, lat: p.lat };
        }
      }
      if (fleeFrom) u.heading = Math.atan2((u.lon - fleeFrom.lon) * mLon, (u.lat - fleeFrom.lat) * mPerLat);
      const step = INCIDENT.runnerSpeed * dt;
      u.lon += (step * Math.sin(u.heading)) / mLon;
      u.lat += (step * Math.cos(u.heading)) / mPerLat;
      return;
    }

    // A target that is a UNIT rather than a place moves, so follow it. Brawlers chase each other;
    // an assassin follows its mark, which matters because a protected contact walks a route like
    // anyone else and a killer that trudged to where the target used to be would never arrive.
    if (inc.partner !== undefined) {
      const other = this.units[inc.partner];
      if (other && !other.dead) {
        inc.tlon = other.lon;
        inc.tlat = other.lat;
      }
    }

    const dx = (inc.tlon - u.lon) * mLon;
    const dy = (inc.tlat - u.lat) * mPerLat;
    const dist = Math.hypot(dx, dy);

    // In contact: the clock runs.
    if (dist <= INCIDENT.contactM) inc.contactS += dt;

    // Keep closing anyway, unless practically on top of the target.
    //
    // Freezing on arrival was the obvious implementation and it was wrong for anything that chases
    // a UNIT rather than a place: the mark walks at 12 m/s, so a killer that stopped at 90 m simply
    // watched it stroll out of range — measured drifting 40 m to 90 m while the clock stalled two
    // seconds short of its fuse. Holding station inside the ring is what makes contact mean contact.
    if (dist <= INCIDENT.contactM * 0.4) return;

    u.heading = Math.atan2(dx, dy);
    const step = Math.min(dist, INCIDENT.walkSpeed * dt);
    u.lon += (step * (dx / dist)) / mLon;
    u.lat += (step * (dy / dist)) / mPerLat;
  }

  private stepDeliver(u: Unit, dt: number): void {
    const t = u.deliver!;
    const mLon = mPerLat * Math.cos(u.lat * DEG);
    const dx = (t.tlon - u.lon) * mLon;
    const dy = (t.tlat - u.lat) * mPerLat;
    const dist = Math.hypot(dx, dy);
    if (dist <= 150) {
      u.deliver = undefined;
      return;
    }
    u.heading = Math.atan2(dx, dy);
    const step = Math.min(dist, DELIVERY_SPEED * dt);
    u.lon += (step * (dx / dist)) / mLon;
    u.lat += (step * (dy / dist)) / mPerLat;
  }

  /** Foot instance slots still available beyond what the batch is already drawing. */
  private footHeadroomLeft(): number {
    let alive = 0;
    for (const u of this.units) if (u.kind === 'foot' && !u.dead) alive++;
    return Math.max(0, this.footCapacity - alive);
  }
  private footCapacity = 0;

  /**
   * Route one confirmed infected contact into sensor coverage.
   *
   * The point is pacing. Infection concentrates in unwatched ground by design, so a theater can sit
   * quiet for a long time with nothing orderable inside the net — this keeps a trickle of genuine
   * targets arriving without the operator having to go and find every one. Returns false when there
   * is nothing suitable to send.
   */
  deliverInfected(toLon: number, toLat: number): boolean {
    const candidates: number[] = [];
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.dead || u.siege || u.deliver || u.mark) continue;
      if (PLATFORM_KINDS.includes(u.kind) || u.kind === 'sea' || u.kind === 'air') continue;
      if (u.state !== 'infected') continue;
      candidates.push(i);
      if (candidates.length > 40) break; // first reasonable handful is enough
    }
    if (!candidates.length) return false;
    const u = this.units[candidates[Math.floor(Math.random() * candidates.length)]];
    u.deliver = { tlon: toLon, tlat: toLat };
    return true;
  }

  /**
   * Put one unmistakable target inside the opening coverage.
   *
   * A campaign's first theater has exactly one obelisk, watching one 750 m disc of a 200-mile
   * circle, and the population inside it is 90% ordinary people. The operator could arrive, look
   * at everything they could see, and correctly conclude there was nothing to do — which is a
   * terrible opening even though every individual rule producing it is right.
   *
   * So one is placed. It is a REAL infected with a REAL charge sheet, not a scripted prop: flagging
   * it scores as valid because it is valid. What is arranged is only that the theater's first
   * contact is one the tolerance gate will actually let them act on, since at HOSTILE the bar wants
   * a severe record AND a high reading together and a random infected rarely clears it.
   */
  seedStarterTarget(lon: number, lat: number, radiusM: number): number | null {
    const mLon = mPerLat * Math.cos(lat * DEG);
    const a = Math.random() * Math.PI * 2;
    const r = radiusM * (0.25 + Math.random() * 0.5); // comfortably inside the disc, not on its rim
    const at = { lon: lon + (Math.cos(a) * r) / mLon, lat: lat + (Math.sin(a) * r) / mPerLat };

    const i = this.units.length;
    this.units.push({
      id: this.mkId('foot'),
      kind: 'foot',
      state: 'infected',
      // Top of the band rather than a fixed 1.0: an absolute certainty would be the one reading in
      // the game that cannot be wrong, and the operator learning to trust a number is the last
      // thing this should teach.
      assess: 0.9 + Math.random() * 0.08,
      record: rollRecord('infected', 'critical'),
      lon: at.lon,
      lat: at.lat,
      heading: Math.random() * Math.PI * 2,
      mark: null,
    });
    const grown = new Float64Array(this.units.length * 3);
    grown.set(this.ecef);
    this.ecef = grown;
    return i;
  }

  /**
   * Seed a hidden pocket of infected in unwatched ground.
   *
   * Contagion already pools where the net does not look, but it pools THINLY and evenly. A pocket
   * is a deliberate concentration the operator has to physically go and find with a platform, which
   * is what gives the ground between cities something to be explored for rather than just crossed.
   */
  spawnHiddenCluster(lon: number, lat: number, n: number, spreadM: number): number {
    const before = this.units.length;
    // Never spawn past what the batch can draw — an invisible pocket is worse than a smaller one.
    const room = this.footHeadroomLeft();
    const want = Math.min(n, room);
    for (let k = 0; k < want; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spreadM;
      const mLon = mPerLat * Math.cos(lat * DEG);
      const plon = lon + (r * Math.cos(a)) / mLon;
      const plat = lat + (r * Math.sin(a)) / mPerLat;
      this.units.push({
        id: this.mkId('foot'),
        kind: 'foot',
        state: 'infected',
        assess: rollAssessment('infected'),
        record: rollRecord('infected'),
        lon: plon,
        lat: plat,
        heading: Math.random() * Math.PI * 2,
        mark: null,
        turn: 0,
      });
    }
    // The position cache has to grow with the field.
    const grown = new Float64Array(this.units.length * 3);
    grown.set(this.ecef);
    this.ecef = grown;
    return this.units.length - before;
  }

  /** Live attacker readout for the director and the HUD. Null when nothing is inbound. */
  attacker(): {
    index: number;
    id: string;
    lon: number;
    lat: number;
    local: number;
    assaultS: number;
    /** Metres still to walk. 0 once it's in contact. */
    rangeM: number;
    tracked: boolean;
    /** The site being attacked. Effects belong here, not on the attacker. */
    tlon: number;
    tlat: number;
  } | null {
    if (this.attackerIdx < 0) return null;
    const u = this.units[this.attackerIdx];
    if (!u || u.dead || !u.siege) return null;
    const mLon = mPerLat * Math.cos(u.lat * DEG);
    const dx = (u.siege.tlon - u.lon) * mLon;
    const dy = (u.siege.tlat - u.lat) * mPerLat;
    return {
      index: this.attackerIdx,
      id: u.id,
      lon: u.lon,
      lat: u.lat,
      local: u.siege.local,
      assaultS: u.siege.assaultS,
      rangeM: Math.max(0, Math.hypot(dx, dy) - SIEGE.contactM),
      tracked: this.isTracked(u),
      tlon: u.siege.tlon,
      tlat: u.siege.tlat,
    };
  }

  /**
   * Put an incident participant on the board.
   *
   * `state` decides what killing it is worth on the ledger, and it is not always 'infected': a
   * driver who will not stop is not necessarily a threat, and shooting one because it was easier
   * than catching it should score exactly as badly as it deserves to.
   */
  spawnIncidentUnit(
    lon: number,
    lat: number,
    kind: UnitKind,
    role: IncidentRole,
    target: { lon: number; lat: number },
    state: UnitState = 'infected',
    partner?: number,
  ): number {
    const i = this.units.length;
    this.units.push({
      id: this.mkId(kind),
      kind,
      state,
      assess: rollAssessment(state),
      record: rollRecord(state),
      lon,
      lat,
      heading: bearing(lon, lat, target.lon, target.lat),
      mark: null,
      incident: { role, tlon: target.lon, tlat: target.lat, contactS: 0, aliveS: 0 },
    });
    if (partner !== undefined) this.units[i].incident!.partner = partner;
    // An insurgent belongs to a faction you passed over — the rival made real, come to take a
    // partner's asset. Tagged so the card names who's behind it; if you made no rivals, it's just
    // an unaffiliated attacker.
    if (role === 'insurgent') {
      const enemies = hostileFactions();
      if (enemies.length) {
        this.units[i].faction = enemies[Math.floor(Math.random() * enemies.length)].id;
        this.units[i].hostile = true;
      }
    }
    // The unit array grew, so the position cache has to grow with it.
    const grown = new Float64Array(this.units.length * 3);
    grown.set(this.ecef);
    this.ecef = grown;
    return i;
  }

  /** Live incident participants, for the director to score and resolve. */
  incidentUnits(): {
    index: number;
    id: string;
    role: IncidentRole;
    lon: number;
    lat: number;
    contactS: number;
    aliveS: number;
    partner?: number;
    tracked: boolean;
  }[] {
    const out: ReturnType<UnitField['incidentUnits']> = [];
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.dead || !u.incident) continue;
      out.push({
        index: i,
        id: u.id,
        role: u.incident.role,
        lon: u.lon,
        lat: u.lat,
        contactS: u.incident.contactS,
        aliveS: u.incident.aliveS,
        partner: u.incident.partner,
        tracked: this.isTracked(u),
      });
    }
    return out;
  }

  /** Point two brawlers at each other after both exist. */
  setIncidentPartner(a: number, b: number): void {
    const ua = this.units[a];
    const ub = this.units[b];
    if (ua?.incident) ua.incident.partner = b;
    if (ub?.incident) ub.incident.partner = a;
  }

  /** Reset one participant's contact clock — what "you interrupted it" means mechanically. */
  resetIncidentClock(index: number): void {
    const u = this.units[index];
    if (u?.incident) u.incident.contactS = 0;
  }

  /**
   * Release a participant from its incident WITHOUT killing it.
   *
   * The winner of a brawl is still a person standing in the street. Removing them outright was the
   * lazy cleanup and it deleted a live contact the operator might well have wanted to look at —
   * they now carry whatever they just did on their record and rejoin the population.
   */
  releaseIncidentUnit(index: number): void {
    const u = this.units[index];
    if (!u) return;
    u.incident = undefined;
  }

  /** Take a participant off the board without scoring it as anything. */
  removeIncidentUnit(index: number): void {
    const u = this.units[index];
    if (!u || u.dead) return;
    u.dead = true;
    u.incident = undefined;
    u.mark = null;
    this.selection.delete(index);
    this.rebuildMarks();
  }

  /** Clear every incident participant — used when a theater ends or an incident is cancelled. */
  clearIncidents(): void {
    let any = false;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (!u.incident) continue;
      u.dead = true;
      u.incident = undefined;
      u.mark = null;
      this.selection.delete(i);
      any = true;
    }
    if (any) this.rebuildMarks();
  }

  /**
   * A random live PROTECTED contact — what an assassin is sent after.
   *
   * `onFoot` restricts it to pedestrians, and the assassination uses that. A killer walks at
   * 14 m/s and a protected contact in a car moves at 80, so a vehicle mark could never be reached:
   * the clock never started and the incident hung until the theater ended. Somebody being walked
   * up to on the street is also simply the right image for this.
   */
  randomProtected(onFoot = false): { index: number; lon: number; lat: number; id: string } | null {
    const pool: number[] = [];
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.dead || u.state !== 'protected' || PLATFORM_KINDS.includes(u.kind)) continue;
      if (onFoot && u.kind !== 'foot') continue;
      pool.push(i);
      if (pool.length > 400) break;
    }
    if (!pool.length) return null;
    const i = pool[Math.floor(Math.random() * pool.length)];
    const u = this.units[i];
    return { index: i, lon: u.lon, lat: u.lat, id: u.id };
  }

  /** Is this unit still alive? The director asks about targets it is protecting. */
  isAlive(index: number): boolean {
    const u = this.units[index];
    return !!u && !u.dead;
  }

  /** Position of any unit, live or not. */
  positionOf(index: number): { lon: number; lat: number } | null {
    const u = this.units[index];
    return u ? { lon: u.lon, lat: u.lat } : null;
  }

  /** Kill a unit outright, no ledger, no beam — one incident participant killing another. */
  killQuietly(index: number): void {
    const u = this.units[index];
    if (!u || u.dead) return;
    u.dead = true;
    u.incident = undefined;
    u.mark = null;
    this.selection.delete(index);
    this.rebuildMarks();
  }

  // --- live violations ---------------------------------------------------------------------------

  /**
   * Fire and age live violations.
   *
   * `sitesCovering` reports which installation watches a point, and doubles as the coverage test:
   * an event can only happen where the net can see it, which is the rule the whole feature rests
   * on. No coverage, no events, and buying coverage is buying things to do.
   *
   * Returns the events that lapsed unanswered this tick, so the caller can decide what ignoring
   * costs.
   */
  stepViolations(
    dt: number,
    liveSites: number,
    sitesCovering: (lon: number, lat: number) => { lon: number; lat: number } | null,
  ): { index: number; live: LiveViolation }[] {
    const lapsed: { index: number; live: LiveViolation }[] = [];

    // Age what is already out, and retire anything nobody got to.
    let open = 0;
    for (const i of this.liveIdx) {
      const u = this.units[i];
      if (!u || u.dead || !u.live) continue;
      u.live.ageS += dt;
      if (u.live.ageS >= VIOLATION_TTL_S) {
        lapsed.push({ index: i, live: u.live });
        u.live = undefined;
        continue;
      }
      open++;
    }
    if (lapsed.length) this.rebuildLiveIndex();

    if (!liveSites) return lapsed;
    // Hard ceiling on how many accusations can be on the board at once. Past a handful the operator
    // stops reading them and starts clearing them, which is the opposite of the point.
    if (open >= VIOLATION_MAX_OPEN) return lapsed;

    // Sub-linear in coverage: a 1,800-site theater is busier than a 1-site one, but nowhere near
    // 1,800 times busier. Without the damping a developed network produces events faster than
    // anyone can read them and the feature turns into noise it is rational to ignore.
    const interval = Math.max(
      VIOLATION_MIN_INTERVAL_S,
      VIOLATION_BASE_INTERVAL_S / Math.pow(liveSites, VIOLATION_SCALE_EXP),
    );
    this.violationTimer -= dt;
    if (this.violationTimer > 0) return lapsed;
    this.violationTimer = interval;

    // Pick from the covered set the render pass already built, rather than darting at the whole
    // field. Exact, and O(1) per attempt however sparse the network is.
    const pool = this.covered;
    if (!pool.length) return lapsed;
    for (let tries = 0; tries < 24; tries++) {
      const i = pool[Math.floor(Math.random() * pool.length)];
      const u = this.units[i];
      if (!u || u.dead || u.live || u.mark) continue;
      if (u.siege || u.incident) continue; // already busy being a different kind of problem
      const site = sitesCovering(u.lon, u.lat);
      if (!site) continue; // moved out of cover since the harvest
      u.live = makeViolation(site.lon, site.lat, u.state === 'infected');
      this.liveIdx.add(i);
      break;
    }
    return lapsed;
  }

  /**
   * Contacts inside sensor coverage, harvested by the last render.
   *
   * Double-buffered so the render pass can fill one while the director reads the other.
   */
  private covered: number[] = [];
  private coveredScratch: number[] = [];

  /** How many contacts the net can currently see. Drives the HUD and the violation rate. */
  get coveredCount(): number {
    return this.covered.length;
  }

  /** Indices carrying a live violation. Kept as a set so ageing doesn't sweep 24,000 units. */
  private liveIdx = new Set<number>();
  private violationTimer = VIOLATION_FIRST_S;

  private rebuildLiveIndex(): void {
    for (const i of [...this.liveIdx]) {
      const u = this.units[i];
      if (!u || u.dead || !u.live) this.liveIdx.delete(i);
    }
  }

  /** Everything currently accused, for the HUD queue. */
  liveViolations(): {
    index: number;
    id: string;
    lon: number;
    lat: number;
    live: LiveViolation;
    tracked: boolean;
  }[] {
    const out: ReturnType<UnitField['liveViolations']> = [];
    for (const i of this.liveIdx) {
      const u = this.units[i];
      if (!u || u.dead || !u.live) continue;
      out.push({ index: i, id: u.id, lon: u.lon, lat: u.lat, live: u.live, tracked: this.isTracked(u) });
    }
    return out;
  }

  /** The live violation on one contact, if it has one. */
  liveOf(index: number): LiveViolation | null {
    const u = this.units[index];
    return u && !u.dead ? (u.live ?? null) : null;
  }

  /** Close a live violation once it has been acted on. */
  clearLive(index: number): void {
    const u = this.units[index];
    if (u) u.live = undefined;
    this.liveIdx.delete(index);
  }

  /** True infection state — what an investigation is actually testing against. */
  isInfected(index: number): boolean {
    const u = this.units[index];
    return !!u && !u.dead && u.state === 'infected';
  }

  /** Whether a given unit index is the live siege attacker. */
  isAttacker(index: number): boolean {
    return this.attackerIdx >= 0 && this.attackerIdx === index && !this.units[index]?.dead;
  }

  /**
   * Whether this contact is actively causing an incident — a siege attacker, a rioter, a brawler,
   * an assassin.
   *
   * This is the test that decides whether SELF-DEFENCE detain applies, and it deliberately covers
   * everything the theater throws at the operator rather than just attacks on the network. The
   * campaign opens with one quadruped and no custody authority for three missions; if "take them
   * alive" only worked on obelisk attackers, then for that entire stretch the only answer to a riot
   * or a killing in progress would be to watch it happen.
   */
  isThreatActor(index: number): boolean {
    const u = this.units[index];
    if (!u || u.dead) return false;
    return !!u.siege || !!u.incident;
  }

  /**
   * Take a threat actor into custody. Non-lethal, no ledger entry.
   *
   * Returns what it was, so the caller can tell the right director. Siege attackers are NOT handled
   * here — those go through the siege director, which owns the attack clock.
   */
  detainThreatActor(index: number): 'incident' | null {
    const u = this.units[index];
    if (!u || u.dead || !u.incident) return null;
    this.removeIncidentUnit(index);
    return 'incident';
  }

  /** Take the attacker off the board — detained, serviced, or its target already gone. */
  clearAttacker(): void {
    if (this.attackerIdx < 0) return;
    const u = this.units[this.attackerIdx];
    if (u) {
      u.dead = true;
      u.siege = undefined;
      u.mark = null;
      this.selection.delete(this.attackerIdx);
    }
    this.attackerIdx = -1;
    this.rebuildMarks();
  }

  /**
   * Whether any platform carrying a detainment rig has the attacker inside its envelope.
   * Non-lethal, so unlike a laser it needs no execution authority and never touches the ledger.
   */
  detainableBy(platforms: PlatformId[]): PlatformId | null {
    const a = this.attacker();
    if (!a) return null;
    for (const id of platforms) if (this.coveredBy(id, a.lon, a.lat)) return id;
    return null;
  }

  /**
   * Order the currently selected platform to a point.
   *
   * `append` (shift-click) queues the point behind whatever is already commanded instead of
   * replacing it. False if nothing is selected, or if the order doesn't make sense for the
   * platform: a littoral drone cannot be sent inland, and refusing outright is clearer than
   * watching it swim up a valley.
   */
  orderSelected(
    lon: number,
    lat: number,
    append = false,
    action: RouteAction = null,
    target?: number,
  ): boolean {
    const sel = this.selectedPlatform();
    return sel ? this.orderPlatformAt(sel.index, lon, lat, append, action, target) : false;
  }

  /**
   * Order EVERY selected platform to a point — the RTS move a marquee is FOR.
   *
   * More than one selected unit is spread into a loose formation around the destination so they
   * don't pile onto a single pixel and shoulder each other. A contact-targeted order (detain, strike)
   * keeps to the single selected unit — a group doesn't all pile onto one person — so those still go
   * through {@link orderSelected}. Returns how many actually took the order.
   */
  orderSelection(
    lon: number,
    lat: number,
    append = false,
    action: RouteAction = null,
    target?: number,
  ): number {
    const platforms = [...this.selection].filter((i) => PLATFORM_KINDS.includes(this.units[i].kind));
    if (platforms.length <= 1) {
      return platforms.length && this.orderPlatformAt(platforms[0], lon, lat, append, action, target) ? 1 : 0;
    }
    const mLon = mPerLat * Math.cos(lat * DEG);
    let moved = 0;
    platforms.forEach((idx, k) => {
      const off = formationOffset(k, platforms.length);
      if (this.orderPlatformAt(idx, lon + off.dx / mLon, lat + off.dy / mPerLat, append, action, target)) moved++;
    });
    return moved;
  }

  /**
   * Move ONE unit (by index) to a point, without touching the selection — used to send a freshly
   * produced unit to its facility's rally point while the player's selection stays where it is.
   */
  moveUnitTo(index: number, lon: number, lat: number): boolean {
    return this.orderPlatformAt(index, lon, lat, false, null);
  }

  /** Route one platform by index — the shared body of {@link orderSelected} and {@link orderSelection}. */
  private orderPlatformAt(
    index: number,
    lon: number,
    lat: number,
    append: boolean,
    action: RouteAction,
    target?: number,
  ): boolean {
    const kind = this.units[index].kind as PlatformId;
    if (kind === 'naval' && this.shoreAt(lon, lat) > -60) return false;
    const u = this.units[index];

    // A road-bound platform doesn't get a straight line to anywhere. Its order is expanded into an
    // actual drive along the street grid, and an unreachable destination is REFUSED rather than
    // silently walked through the intervening blocks — which is the constraint being real.
    const drive = this.roadRouteFor(kind, u, lon, lat);
    if (drive === null) return false;

    if (!append || u.tlon === undefined) {
      const [first, ...rest] = drive ?? [{ lon, lat }];
      u.tlon = first.lon;
      u.tlat = first.lat;
      u.route = rest;
      u.loop = false;
      u.routeAction = action;
      u.routeTarget = target;
      return true;
    }

    // Appending onto an existing route. Clicking near a leg that's already on it closes the loop
    // rather than adding a near-duplicate — which is how a patrol is drawn rather than declared.
    const legs = this.routeOf(index);
    const near = legs.findIndex((w) => this.metresBetween(w.lon, w.lat, lon, lat) < LOOP_SNAP_M);
    if (near >= 0) {
      u.loop = true;
      return true;
    }
    (u.route ??= []).push(...(drive ?? [{ lon, lat }]));
    if (action) {
      u.routeAction = action;
      u.routeTarget = target;
    }
    return true;
  }

  /** Whether a specific unit index is in the current selection — the roster reads this to light chips. */
  isSelected(index: number): boolean {
    return this.selection.has(index);
  }

  /**
   * Live-violation summary for the alerting tech (the STOP AND SEARCH fork): how many events are up
   * right now, and where the freshest one is, so the HUD can snap the camera to it. `suspiciousOnly`
   * narrows it to the class an investigation is actually for.
   */
  liveAlerts(suspiciousOnly: boolean): { count: number; lon?: number; lat?: number } {
    let count = 0;
    let lon: number | undefined;
    let lat: number | undefined;
    let freshest = Infinity;
    for (const u of this.units) {
      if (u.dead || !u.live) continue;
      if (suspiciousOnly && u.live.def.cls !== 'suspicious') continue;
      count++;
      // Snap to the freshest event — the one with the most time left to answer.
      if (u.live.ageS < freshest) {
        freshest = u.live.ageS;
        lon = u.lon;
        lat = u.lat;
      }
    }
    return { count, lon, lat };
  }

  /**
   * Auto-patrol standing, set by the scene from the DRAGNET tech fork. When a domain is armed, idle
   * platforms of that domain wander the theater on their own — coverage that walks rather than sits.
   */
  autoPatrol = { ground: false, air: false };

  /**
   * HVT designation, set by the scene from the HOLD THE NET fork. When on, an incident's ringleader
   * (any incident participant or siege attacker) stays ACTIONABLE even out of sensor coverage — a
   * designated target can't duck into the dark to escape a strike. The other half of that fork,
   * PREDICTIVE EVENTS, is read straight off the incident director instead.
   */
  hvtDesignate = false;

  /** Send an idle platform to a patrol point — a route with no order attached. Unreachable = no-op. */
  private patrolTo(u: Unit, lon: number, lat: number): void {
    const kind = u.kind as PlatformId;
    if (kind === 'naval' && this.shoreAt(lon, lat) > -60) return;
    const drive = this.roadRouteFor(kind, u, lon, lat);
    if (drive === null) return; // unreachable this pick — it'll try another next tick
    const [first, ...rest] = drive ?? [{ lon, lat }];
    u.tlon = first.lon;
    u.tlat = first.lat;
    u.route = rest;
    u.loop = false;
    u.routeAction = null;
    u.routeTarget = undefined;
  }

  /**
   * Send whichever platform SHOULD take this sanction, without making the operator pick one.
   *
   * The card offers a decision about a person; which airframe services it is logistics, and making
   * the operator select hardware first was the single biggest thing standing between reading a case
   * and answering it. So C2 assigns.
   *
   * The preference order is the whole of the intelligence here, and it is deliberately dumb:
   *
   *   1. A platform that is NOT already tasked, nearest first. An idle unit is the free one.
   *   2. Failing that, the nearest tasked unit — reassigning it, which silently drops whatever it
   *      was doing. That is a real cost and the card says so before the operator commits.
   *
   * Returns what was sent and whether it had to be pulled off an existing order, or null when
   * nothing can physically take it — a littoral hull ordered inland, a quadruped with no road to
   * the contact, or simply no platform carrying the right rig.
   */
  dispatch(
    target: number,
    action: RouteAction,
    kinds: PlatformId[],
  ): { kind: PlatformId; index: number; reassigned: boolean } | null {
    const t = this.units[target];
    if (!t || t.dead) return null;
    const allowed = new Set(kinds);

    const candidates: { kind: PlatformId; index: number; busy: boolean; d: number }[] = [];
    for (const { kind, index } of this.platformUnits()) {
      if (!allowed.has(kind)) continue;
      const u = this.units[index];
      if (u.dead) continue;
      candidates.push({
        kind,
        index,
        busy: u.routeAction !== null && u.routeAction !== undefined,
        d: this.metresBetween(u.lon, u.lat, t.lon, t.lat),
      });
    }
    // Idle before busy, then nearest. Sorting once and walking it means an idle unit on the far side
    // of the theater still beats a busy one standing next to the contact — being free matters more
    // than being close, because the close one's current order is also somebody's decision.
    candidates.sort((a, b) => (a.busy === b.busy ? a.d - b.d : a.busy ? 1 : -1));

    for (const c of candidates) {
      if (this.orderUnit(c.index, c.kind, t.lon, t.lat, action, target)) {
        return { kind: c.kind, index: c.index, reassigned: c.busy };
      }
    }
    return null;
  }

  /** Whether any fielded unit of these kinds exists at all — the card's "no hardware" case. */
  anyFielded(kinds: PlatformId[]): boolean {
    const allowed = new Set(kinds);
    return this.platformUnits().some(({ kind, index }) => allowed.has(kind) && !this.units[index].dead);
  }

  /**
   * Point one specific platform at a target. The mechanics of {@link orderSelected} without the
   * selection, so C2 can task a unit the operator never clicked on.
   */
  private orderUnit(
    index: number,
    kind: PlatformId,
    lon: number,
    lat: number,
    action: RouteAction,
    target?: number,
  ): boolean {
    if (kind === 'naval' && this.shoreAt(lon, lat) > -60) return false;
    const u = this.units[index];
    if (!u || u.dead) return false;
    // Reassignment starts from a clean sheet: the old route is dropped before pathing, so a
    // road-bound unit paths from where it IS rather than from the end of an order it won't finish.
    u.route = [];
    u.tlon = undefined;
    u.tlat = undefined;
    u.loop = false;
    const drive = this.roadRouteFor(kind, u, lon, lat);
    if (drive === null) return false;
    const [first, ...rest] = drive ?? [{ lon, lat }];
    u.tlon = first.lon;
    u.tlat = first.lat;
    u.route = rest;
    u.routeAction = action;
    u.routeTarget = target;
    return true;
  }

  /**
   * Expand an order into road geometry, for the platforms that are confined to it.
   *
   * Three outcomes, and they are all meaningful:
   *   `undefined` — this platform isn't road-bound; the caller should use the raw destination.
   *   an array    — the drive, as waypoints along real streets.
   *   `null`      — road-bound, and there is NO route. The order is refused.
   *
   * The last case is the point of the whole feature. A quadruped ordered across a river, or onto
   * an island, or into country the road fetch didn't cover, simply cannot go, and saying so is
   * better than watching it swim.
   *
   * Route legs are appended from where the platform will BE when it starts driving — its current
   * position for a fresh order, the end of its queue when appending — so a queued leg is pathed
   * from the right place rather than from wherever the unit happens to be standing now.
   */
  private roadRouteFor(
    kind: PlatformId,
    u: Unit,
    lon: number,
    lat: number,
  ): { lon: number; lat: number }[] | null | undefined {
    if (!PLATFORM_BY_ID.get(kind)?.roadBound) return undefined;
    const g = this.routeNet();
    if (!g) return undefined; // no roads in this theater at all: don't strand the unit
    const legs = u.route ?? [];
    const tail = legs.length
      ? legs[legs.length - 1]
      : u.tlon !== undefined && u.tlat !== undefined
        ? { lon: u.tlon, lat: u.tlat }
        : { lon: u.lon, lat: u.lat };
    return g.path(tail, { lon, lat });
  }

  /** The routable network for this theater, built on first use. Null when there are no roads. */
  private routeNet(): RouteGraph | null {
    if (this.routes !== undefined) return this.routes;
    const g = this.graph;
    if (!g || !g.edges.length) return (this.routes = null);
    const built = new RouteGraph(g.edges);
    this.routes = built;
    return built;
  }

  /** Diagnostics for the dev panel: how routable this theater's road network actually is. */
  routeNetStats(): { nodes: number; connectivity: number } | null {
    const g = this.routeNet();
    return g ? { nodes: g.size, connectivity: g.connectivity } : null;
  }

  /** Every commanded leg for a platform, current first. Empty when it's holding station. */
  routeOf(index: number): { lon: number; lat: number }[] {
    const u = this.units[index];
    if (!u || u.tlon === undefined || u.tlat === undefined) return [];
    return [{ lon: u.tlon, lat: u.tlat }, ...(u.route ?? [])];
  }

  /** The standing order attached to a platform's route, if any. */
  routeActionOf(index: number): RouteAction {
    return this.units[index]?.routeAction ?? null;
  }

  /** Whether a platform's route is a closed patrol. */
  routeLoops(index: number): boolean {
    return !!this.units[index]?.loop;
  }

  /** Cancel everything commanded on the selected platform. */
  clearRoute(): boolean {
    const sel = this.selectedPlatform();
    if (!sel) return false;
    const u = this.units[sel.index];
    u.tlon = undefined;
    u.tlat = undefined;
    u.route = [];
    u.loop = false;
    u.routeAction = null;
    u.routeTarget = undefined;
    return true;
  }

  private metresBetween(lon1: number, lat1: number, lon2: number, lat2: number): number {
    const mLon = mPerLat * Math.cos(((lat1 + lat2) / 2) * DEG);
    return Math.hypot((lon2 - lon1) * mLon, (lat2 - lat1) * mPerLat);
  }

  /** Which platform unit is selected, if any. Drives whether RMB issues a move order. */
  selectedPlatform(): { kind: PlatformId; index: number } | null {
    if (this.selection.size !== 1) return null;
    const i = this.selection.values().next().value as number;
    for (const [kind, list] of this.platformIdx) {
      if (list.includes(i)) return { kind, index: i };
    }
    return null;
  }

  /** Select the nth unit of a platform type outright. */
  selectPlatform(id: PlatformId, nth = 0): boolean {
    const list = this.platformIdx.get(id);
    // Explicit bounds check: unit index 0 is a perfectly valid target and would fail a truthy test.
    if (!list || nth < 0 || nth >= list.length) return false;
    return this.selectIndex(list[nth]);
  }

  /** Select one unit by index — what the roster cards call. */
  selectIndexPublic(i: number): boolean {
    return this.selectIndex(i);
  }

  private selectIndex(i: number): boolean {
    this.selection.clear();
    this.selection.add(i);
    return true;
  }

  /**
   * Cycle to the next fielded platform unit — across types AND across the several units of a type,
   * so one key reaches all four arachnids as well as the walker.
   */
  cyclePlatform(): PlatformId | null {
    const all = this.platformUnits();
    if (!all.length) return null;
    const cur = this.selectedPlatform();
    const at = cur ? all.findIndex((u) => u.index === cur.index) : -1;
    const next = all[(at + 1) % all.length];
    this.selectIndex(next.index);
    return next.kind;
  }

  /**
   * Whether a unit is inside sensor coverage RIGHT NOW — the obelisk net or a drone's own disc. A
   * platform is its own sensor and always covered.
   */
  private coveredNow(u: Unit): boolean {
    if (PLATFORM_KINDS.includes(u.kind)) return true;
    // The ORBITAL PLATFORM is persistent overhead presence over the whole theater — with it, there is
    // no unwatched ground and every contact reads back, which is the capstone it's sold as.
    if (progression.has('orbital-platform')) return true;
    return !this.isCovered || this.isCovered(u.lon, u.lat) || this.platformCovers(u.lon, u.lat);
  }

  /** Within the post-coverage grace window since this contact was last seen — see SENSOR_GRACE_S. */
  private inGrace(u: Unit): boolean {
    return u.lastSeenS !== undefined && this.nowS - u.lastSeenS <= SENSOR_GRACE_S;
  }

  /**
   * Whether a unit can be tracked and ordered: covered now, OR still inside its grace window after
   * passing through coverage. The grace is the net's short-term memory — a contact that crossed a
   * disc stays actionable for SENSOR_GRACE_S so a fast mover can't slip away before the operator
   * reacts. render() fades it out over the same window, so "looks dark" and "can't be ordered" agree.
   */
  private isTracked(u: Unit): boolean {
    return this.coveredNow(u) || this.inGrace(u);
  }

  /**
   * Whether an order can be issued against a contact at all.
   *
   * Only ONE hard gate remains: sensor contact. C2 cannot task what it cannot see, and no amount of
   * political will changes that.
   *
   * Public tolerance used to be a second wall here. It isn't any more — an operator may order
   * against anyone they can see, however thin the case. What a thin case costs is RESISTANCE (see
   * game/resistance.ts): the ground hardens, and hardened ground produces more attacks and bigger
   * pockets. "You may not" became "you may, and here is the bill".
   */
  private isOrderable(u: Unit): boolean {
    // A designated HVT — an incident ringleader or siege attacker — is actionable wherever it is.
    if (this.hvtDesignate && (u.incident || u.siege)) return true;
    return this.isTracked(u);
  }

  /**
   * How far under the public-tolerance bar a contact's case falls, 0 when it clears. This is what
   * the resistance meter is charged against.
   */
  private shortfall(u: Unit): number {
    if (this.toleranceOverride) return 0;
    return Math.max(0, tolerance.threshold - caseStrength(u.assess, u.record));
  }

  /** Set by the scene when EMERGENCY POWERS is held — the tolerance gate stops applying. */
  toleranceOverride = false;

  /**
   * What colour one unit renders. See the colour-language note at the top of this file.
   *
   * Returns a SHARED scratch for the ramp case, so it must be consumed before the next call — which
   * the render loop does, and nothing else calls this per-frame. The four flat channels return their
   * own constants and are safe to hold.
   */
  private tintOf(u: Unit): Cesium.Color {
    if (PLATFORM_KINDS.includes(u.kind)) return DRONE_COLOR;
    // Doing something, right now. A siege attacker and an assassin are the same category to an
    // operator — somebody is being harmed unless this is answered — so they share a colour.
    if (u.siege || u.incident?.role === 'assassin' || u.incident?.role === 'insurgent') return HOSTILE_COLOR;
    if (u.incident) return EVENT_COLOR;
    if (u.state === 'protected') return DRONE_COLOR;
    // The assessment, continuously. Squared so the ramp holds white through the low end and only
    // starts reading yellow where the figure is worth a second look — a linear ramp made a 20%
    // contact look meaningfully warmer than a 5% one, which is noise wearing a colour.
    const t = Math.min(1, Math.max(0, u.assess));
    return Cesium.Color.lerp(CONTACT_CLEAR, CONTACT_HOT, t * t, this.tintScratch);
  }

  private tintScratch = new Cesium.Color();

  /** The same decision as {@link tintOf}, as CSS hex, for the card's dot. */
  tintHexOf(index: number): string {
    const u = this.units[index];
    if (!u) return TINT_HEX.clear;
    if (PLATFORM_KINDS.includes(u.kind)) return TINT_HEX.company;
    if (u.siege || u.incident?.role === 'assassin' || u.incident?.role === 'insurgent') return TINT_HEX.hostile;
    if (u.incident) return TINT_HEX.event;
    if (u.state === 'protected') return TINT_HEX.company;
    const t = Math.min(1, Math.max(0, u.assess));
    const c = Cesium.Color.lerp(CONTACT_CLEAR, CONTACT_HOT, t * t, new Cesium.Color());
    return c.toCssHexString();
  }

  /** Whether one contact is inside sensor coverage — the card's only hard gate on acting. */
  isTrackedPublic(index: number): boolean {
    const u = this.units[index];
    return !!u && !u.dead && this.isTracked(u);
  }

  /**
   * Seconds left in a contact's post-coverage grace window — 0 if it is covered right now, was never
   * seen, or the window has already closed. The card counts this down in the Sensor row.
   */
  graceRemaining(index: number): number {
    const u = this.units[index];
    if (!u || u.dead || PLATFORM_KINDS.includes(u.kind)) return 0;
    if (this.coveredNow(u) || u.lastSeenS === undefined) return 0;
    return Math.max(0, SENSOR_GRACE_S - (this.nowS - u.lastSeenS));
  }

  /** Everything a sanction is judged on, for one contact. Null when it isn't a live contact. */
  contactSummary(index: number): { assess: number; record: Record_; protectedAsset: boolean } | null {
    const u = this.units[index];
    if (!u || u.dead || PLATFORM_KINDS.includes(u.kind)) return null;
    return { assess: u.assess, record: u.record, protectedAsset: u.state === 'protected' };
  }

  /**
   * Put a standing mark on ONE contact, on the usual rescind timer.
   *
   * The single-contact counterpart to {@link markSelected}. It charges nothing and checks nothing —
   * the card has already judged and billed the decision by the time this is called, and having two
   * places that both decide what an order costs is how the two of them end up disagreeing.
   */
  markContact(index: number, kind: MarkKind): boolean {
    const u = this.units[index];
    if (!u || u.dead || !this.isOrderable(u)) return false;
    u.mark = kind;
    u.markTimer = ORDER_DELAY[kind];
    this.rebuildMarks();
    return true;
  }

  /** A contact's case strength, for the panel to show against the current bar. */
  caseOf(index: number): number {
    const u = this.units[index];
    return u ? caseStrength(u.assess, u.record) : 0;
  }

  /** Whether a point falls inside the sensor disc of ANY unit of one platform type. */
  coveredBy(id: PlatformId, lon: number, lat: number): boolean {
    const list = this.platformIdx.get(id);
    if (!list) return false;
    const r = this.sensorOf(id);
    for (const idx of list) {
      const u = this.units[idx];
      const mLon = mPerLat * Math.cos(u.lat * DEG);
      const dx = (lon - u.lon) * mLon;
      const dy = (lat - u.lat) * mPerLat;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  /** The unit index of whichever unit of a type covers a point, or -1. Used to source a beam. */
  private coveringUnit(id: PlatformId, lon: number, lat: number): number {
    const list = this.platformIdx.get(id);
    if (!list) return -1;
    const r = this.sensorOf(id);
    for (const idx of list) {
      const u = this.units[idx];
      const mLon = mPerLat * Math.cos(u.lat * DEG);
      const dx = (lon - u.lon) * mLon;
      const dy = (lat - u.lat) * mPerLat;
      if (dx * dx + dy * dy <= r * r) return idx;
    }
    return -1;
  }

  /** Whether a point falls inside ANY fielded platform's sensor disc. */
  platformCovers(lon: number, lat: number): boolean {
    for (const id of this.platformIdx.keys()) if (this.coveredBy(id, lon, lat)) return true;
    return false;
  }

  /**
   * Live readout for one platform UNIT: position, whether it's moving, and what its own disc sees.
   * Takes a unit index so a card shows that machine's picture, not its whole type's.
   */
  platformStatus(
    index: number,
  ): { lon: number; lat: number; moving: boolean; seen: number; infected: number; rangeM: number } | null {
    const u = this.units[index];
    if (!u || !PLATFORM_KINDS.includes(u.kind)) return null;
    const r = this.sensorOf(u.kind as PlatformId);
    const mLon = mPerLat * Math.cos(u.lat * DEG);
    let seen = 0;
    let infected = 0;
    for (const o of this.units) {
      if (PLATFORM_KINDS.includes(o.kind) || o.dead) continue;
      const dx = (o.lon - u.lon) * mLon;
      const dy = (o.lat - u.lat) * mPerLat;
      if (dx * dx + dy * dy > r * r) continue;
      seen++;
      if (o.state === 'infected') infected++;
    }
    return { lon: u.lon, lat: u.lat, moving: u.tlon !== undefined, seen, infected, rangeM: r };
  }

  /** One sensor ring and one map icon per fielded platform UNIT. */
  private buildPlatformVisuals(): void {
    const SEG = 72;
    for (const { kind, index } of this.platformUnits()) {
      this.platformUnitOrder.push(index);

      const pts: Cesium.Cartesian3[] = [];
      for (let i = 0; i <= SEG; i++) pts.push(new Cesium.Cartesian3());
      this.ringPts.push(pts);
      this.droneRing.add({
        positions: pts,
        width: 2,
        material: Cesium.Material.fromType('Color', {
          color: Cesium.Color.fromCssColorString('#E23A2E').withAlpha(0.55),
        }),
      });

      const image = platformIcon(kind);
      if (image) {
        this.platformIcons.add({
          position: Cesium.Cartesian3.ZERO, // set each frame in render()
          image,
          width: 24,
          height: 24,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(ICON_FROM_M, Number.MAX_VALUE),
          // Stays visible through terrain; see the note in rebuildMarks about Infinity here.
          disableDepthTestDistance: 1e12,
        });
      }
    }
  }

  private updatePlatformVisuals(): void {
    for (let k = 0; k < this.platformUnitOrder.length; k++) {
      const idx = this.platformUnitOrder[k];
      const u = this.units[idx];
      const pts = this.ringPts[k];
      const line = this.droneRing.get(k);
      if (!u || !pts || !line) continue;

      const r = this.sensorOf(u.kind as PlatformId);
      const dLat = r / mPerLat;
      const dLon = r / (mPerLat * Math.max(0.15, Math.cos(u.lat * DEG)));
      const n = pts.length - 1;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const lon = u.lon + dLon * Math.cos(a);
        const lat = u.lat + dLat * Math.sin(a);
        Cesium.Cartesian3.fromDegrees(lon, lat, this.heightAt(lon, lat) + 30, undefined, pts[i]);
      }
      line.positions = pts; // reassign so Cesium re-uploads

      const b = this.platformIcons.get(k);
      if (b) {
        this.markScratch.x = this.ecef[idx * 3];
        this.markScratch.y = this.ecef[idx * 3 + 1];
        this.markScratch.z = this.ecef[idx * 3 + 2];
        b.position = this.markScratch;
      }
    }
  }

  private stepRoad(u: Unit, dt: number): void {
    const g = this.graph;
    if (!g || u.edge === undefined) return;
    let ei = u.edge;
    let e = g.edges[ei];
    let dist = (u.dist ?? 0) + (u.dir ?? 1) * SPEED[u.kind] * dt;
    let dir = u.dir ?? 1;

    // Cross a node: choose the edge that best continues the current heading (with a bias toward
    // bigger roads), so units flow through junctions instead of picking random turns and
    // backtracking. That both removes the "stuck"/ping-pong look and keeps freeway traffic on the
    // freeway.
    let guard = 0;
    while ((dist > e.len || dist < 0) && guard++ < 4) {
      const atEnd = dist > e.len;
      const node = atEnd ? e.nodeB : e.nodeA;
      const overshoot = atEnd ? dist - e.len : -dist;
      const velBearing = g.outBearing(ei, node) + Math.PI; // direction we're travelling INTO the node
      const options = g.adj[node].filter((x) => x !== ei);
      const next = options.length ? this.chooseEdge(g, options, node, velBearing, u.state === 'infected') : ei;
      const ne = g.edges[next];
      // enter the new edge from whichever end touches this node
      if (ne.nodeA === node) {
        dir = 1;
        dist = overshoot;
      } else {
        dir = -1;
        dist = ne.len - overshoot;
      }
      ei = next;
      e = ne;
    }
    dist = Math.max(0, Math.min(e.len, dist));
    const p = g.sample(e, dist);
    u.edge = ei;
    u.dist = dist;
    u.dir = dir;
    u.lon = p.lon;
    u.lat = p.lat;
    u.heading = dir === 1 ? p.heading : p.heading + Math.PI;
  }

  /**
   * Weighted pick among the edges leaving a node: straighter continuations and bigger roads score
   * higher, but it's randomised so units still turn off and populate side streets.
   */
  private chooseEdge(
    g: RoadGraph,
    options: number[],
    node: number,
    velBearing: number,
    fleeSensors = false,
  ): number {
    let best = options[0];
    let bestScore = -1;
    for (const c of options) {
      const straight = Math.cos(g.outBearing(c, node) - velBearing); // 1 = dead straight, -1 = U-turn
      // straightness × road-size bias × per-pick jitter, so it mostly goes straight but still turns off
      let score = Math.max(0.02, (straight + 1) * 0.5) * (1 + 0.6 * g.edges[c].rank) * (0.7 + Math.random() * 0.6);
      // Infected drift away from watched roads, so red pools in the gaps between obelisks rather
      // than distributing evenly. It's a junction-by-junction weighting, not a hard rule, so the
      // field settles at an equilibrium (a standing minority stays on watched roads for the sensor
      // net to catch) instead of draining cities to zero.
      if (fleeSensors) score *= g.edges[c].covered ? INFECTED_FLEE.covered : INFECTED_FLEE.open;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  private stepFree(u: Unit, dt: number): void {
    // wander with a slowly drifting heading; bounce off the theater edge (and, for ships, off land)
    u.turn = (u.turn ?? 0) + (Math.random() - 0.5) * 0.02;
    u.turn = Math.max(-0.15, Math.min(0.15, u.turn));
    u.heading += u.turn * dt * 10;
    const step = SPEED[u.kind] * dt;
    const mLon = mPerLat * Math.cos(u.lat * DEG);
    let nlon = u.lon + (step * Math.sin(u.heading)) / mLon;
    let nlat = u.lat + (step * Math.cos(u.heading)) / mPerLat;

    const dx = (nlon - this.center.lon) * mLon;
    const dy = (nlat - this.center.lat) * mPerLat;
    const outOfDisc = Math.hypot(dx, dy) > this.radiusM * 0.98;
    const ontoLand = u.kind === 'sea' && this.heightAt(nlon, nlat) > -1;
    if (outOfDisc || ontoLand) {
      u.heading += Math.PI * (0.5 + Math.random() * 0.5); // turn away
      u.turn = -(u.turn ?? 0);
      nlon = u.lon;
      nlat = u.lat;
    }
    u.lon = nlon;
    u.lat = nlat;
  }

  private scratchColor = new Cesium.Color();

  /**
   * Fill the instance buffers for this frame. Call after tick(). If `sensor` is given, units
   * outside every obelisk's range draw faint. Also caches each unit's world position for picking,
   * and draws the selected unit larger + at full opacity.
   */
  render(sensor?: SensorField): void {
    for (const k of UNIT_KINDS) this.batches[k].beginFrame();
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      // A serviced unit is simply never written into the instance buffer, which is all it takes to
      // remove it from the one draw call. Its slot in `ecef` goes stale, so picking skips it too.
      if (u.dead) continue;
      const ground = this.heightAt(u.lon, u.lat);
      // Platforms carry their own cruise altitude — the disc flies, the walkers stand on the deck.
      const platformAlt = PLATFORM_BY_ID.get(u.kind as PlatformId)?.altM;
      const alt =
        u.kind === 'air'
          ? Math.max(300, ground + 600)
          : platformAlt !== undefined
            ? ground + platformAlt + RIDE_HEIGHT[u.kind]
            : ground + RIDE_HEIGHT[u.kind];
      Cesium.Cartesian3.fromDegrees(u.lon, u.lat, alt, undefined, this.scratch);
      this.ecef[i * 3] = this.scratch.x;
      this.ecef[i * 3 + 1] = this.scratch.y;
      this.ecef[i * 3 + 2] = this.scratch.z;

      const selected = this.selection.has(i);
      const base = this.tintOf(u);
      // The drone is its own sensor: anything under its disc is seen even with no obelisk nearby.
      // That's the point of flying it into the dark between cities.
      const coveredNow =
        PLATFORM_KINDS.includes(u.kind) ||
        (!sensor || sensor.isCovered(u.lon, u.lat)) ||
        this.platformCovers(u.lon, u.lat);
      // Stamp the moment a contact is seen — this is what the grace window counts from.
      if (coveredNow) u.lastSeenS = this.nowS;
      // Harvest the covered set while we are already asking the question. INSIDE coverage ONLY — the
      // violation director needs a live contact, not one coasting on grace.
      //
      // Sampling the whole field at random cannot find one when coverage is sparse: at the campaign's
      // opening a single obelisk watches maybe three contacts out of 24,000, so sixty random darts
      // hit one about three quarters of one percent of the time and the feature simply never fired.
      // Reusing this test — which runs anyway, for every unit — makes the lookup exact and free.
      if (coveredNow && !PLATFORM_KINDS.includes(u.kind) && u.kind !== 'sea' && u.kind !== 'air') {
        this.coveredScratch.push(i);
      }
      // Opacity: full while covered, fading over the grace window once it leaves, faint once the
      // window has closed. A contact in grace is still fully actionable — see isTracked/graceRemaining.
      let color: Cesium.Color;
      if (coveredNow || selected) {
        color = base;
      } else if (u.lastSeenS !== undefined && this.nowS - u.lastSeenS <= SENSOR_GRACE_S) {
        const t = (this.nowS - u.lastSeenS) / SENSOR_GRACE_S; // 0 at exit -> 1 at window's end
        color = Cesium.Color.fromAlpha(base, 1 - (1 - GRACE_ALPHA_END) * t, this.scratchColor);
      } else {
        color = Cesium.Color.fromAlpha(base, UNSEEN_ALPHA, this.scratchColor);
      }
      const scale = UNIT_SCALE[u.kind] * (selected ? 1.7 : 1);
      this.batches[u.kind].setInstance(this.scratch, u.heading, scale, color);
    }
    for (const k of UNIT_KINDS) this.batches[k].endFrame();
    // Swap rather than copy: the director reads last frame's set, which is a frame stale and
    // completely fine for picking somebody to accuse.
    const done = this.covered;
    this.covered = this.coveredScratch;
    this.coveredScratch = done;
    this.coveredScratch.length = 0;
    this.updatePlatformVisuals();

    // move each investigate marker onto its (moving) unit
    for (let m = 0; m < this.markedIdx.length; m++) {
      const i = this.markedIdx[m];
      this.markScratch.x = this.ecef[i * 3];
      this.markScratch.y = this.ecef[i * 3 + 1];
      this.markScratch.z = this.ecef[i * 3 + 2];
      this.marksLayer.get(m).position = this.markScratch;
    }
  }

  // --- selection ------------------------------------------------------------------------------

  private toWin(): ((s: Cesium.Scene, p: Cesium.Cartesian3, r?: Cesium.Cartesian2) => Cesium.Cartesian2 | undefined) | undefined {
    const ST = Cesium.SceneTransforms as unknown as {
      worldToWindowCoordinates?: (s: Cesium.Scene, p: Cesium.Cartesian3, r?: Cesium.Cartesian2) => Cesium.Cartesian2 | undefined;
      wgs84ToWindowCoordinates?: (s: Cesium.Scene, p: Cesium.Cartesian3, r?: Cesium.Cartesian2) => Cesium.Cartesian2 | undefined;
    };
    return ST.worldToWindowCoordinates ?? ST.wgs84ToWindowCoordinates;
  }

  private pickScratchC = new Cesium.Cartesian3();
  private pickScratchW = new Cesium.Cartesian2();

  /**
   * Select the single unit nearest a window point (within `maxPx`); returns whether one was picked.
   * Projects the cached world positions, so call after at least one render().
   */
  pick(scene: Cesium.Scene, x: number, y: number, maxPx: number): boolean {
    const toWin = this.toWin();
    if (!toWin) return false;
    const c = this.pickScratchC;
    const w = this.pickScratchW;
    let best = -1;
    let bestD = maxPx * maxPx;
    for (let i = 0; i < this.units.length; i++) {
      if (this.units[i].dead) continue;
      c.x = this.ecef[i * 3];
      c.y = this.ecef[i * 3 + 1];
      c.z = this.ecef[i * 3 + 2];
      const win = toWin(scene, c, w);
      if (!win) continue;
      const dx = win.x - x;
      const dy = win.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.selection.clear();
    if (best >= 0) this.selection.add(best);
    return best >= 0;
  }

  /**
   * The non-platform contact nearest a window point, WITHOUT changing the selection.
   *
   * Right-clicking a contact has to identify it while leaving the selected platform selected — the
   * whole gesture is "you, go and deal with that one", and going through `pick()` would drop the
   * platform doing the dealing.
   */
  contactAt(
    scene: Cesium.Scene,
    x: number,
    y: number,
    maxPx: number,
  ): { index: number; lon: number; lat: number; id: string } | null {
    const toWin = this.toWin();
    if (!toWin) return null;
    const c = this.pickScratchC;
    const w = this.pickScratchW;
    let best = -1;
    let bestD = maxPx * maxPx;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.dead || PLATFORM_KINDS.includes(u.kind)) continue;
      c.x = this.ecef[i * 3];
      c.y = this.ecef[i * 3 + 1];
      c.z = this.ecef[i * 3 + 2];
      const win = toWin(scene, c, w);
      if (!win) continue;
      const dx = win.x - x;
      const dy = win.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return null;
    const u = this.units[best];
    return { index: best, lon: u.lon, lat: u.lat, id: u.id };
  }

  /**
   * Select every unit whose screen position falls inside a drag box. Returns the count.
   *
   * FRIENDLY FIRST: if any of the player's own platforms fall in the box, the box selects only
   * those. Dragging over a city to grab a walker would otherwise return four thousand civilians
   * with the walker buried among them, and "select my units" is overwhelmingly what a box drag
   * over your own hardware means.
   */
  pickBox(scene: Cesium.Scene, x0: number, y0: number, x1: number, y1: number): number {
    const toWin = this.toWin();
    this.selection.clear();
    if (!toWin) return 0;
    const lx = Math.min(x0, x1);
    const hx = Math.max(x0, x1);
    const ly = Math.min(y0, y1);
    const hy = Math.max(y0, y1);
    const c = this.pickScratchC;
    const w = this.pickScratchW;
    for (let i = 0; i < this.units.length; i++) {
      if (this.units[i].dead) continue;
      c.x = this.ecef[i * 3];
      c.y = this.ecef[i * 3 + 1];
      c.z = this.ecef[i * 3 + 2];
      const win = toWin(scene, c, w);
      if (!win) continue;
      if (win.x >= lx && win.x <= hx && win.y >= ly && win.y <= hy) this.selection.add(i);
    }

    const friendly = [...this.selection].filter((i) => PLATFORM_KINDS.includes(this.units[i].kind));
    if (friendly.length) {
      this.selection.clear();
      for (const i of friendly) this.selection.add(i);
    }
    return this.selection.size;
  }

  deselect(): void {
    this.selection.clear();
  }

  /** Live info for the selection: one unit's full stats, or a summary of many. */
  selected(): SelectionInfo | null {
    if (this.selection.size === 0) return null;
    const byKind: Record<UnitKind, number> = {
      land: 0, sea: 0, air: 0, foot: 0, drone: 0, dog: 0, quad: 0, spider: 0, biped: 0, walker: 0,
      naval: 0, interceptor: 0,
    };
    const byBand: Record<'clear' | 'suspect' | 'threat', number> = { clear: 0, suspect: 0, threat: 0 };
    let markedCount = 0;
    let trackedCount = 0;
    let one: Unit | undefined;
    let oneIdx = -1;
    let live = 0;
    let markedKind: MarkKind | null = null;
    let mixedKinds = false;
    let pendingCount = 0;
    let orderableCount = 0;
    let belowToleranceCount = 0;
    let worstShortfall = 0;
    let pendingSeconds = Infinity;
    for (const i of this.selection) {
      const u = this.units[i];
      if (u.dead) continue;
      live++;
      byKind[u.kind]++;
      if (!PLATFORM_KINDS.includes(u.kind)) byBand[assessBand(u.assess)]++;
      if (u.mark) {
        markedCount++;
        if (markedKind === null) markedKind = u.mark;
        else if (markedKind !== u.mark) mixedKinds = true;
        if (u.markTimer !== undefined) {
          pendingCount++;
          pendingSeconds = Math.min(pendingSeconds, u.markTimer);
        }
      }
      if (this.isTracked(u)) trackedCount++;
      if (this.isOrderable(u)) {
        orderableCount++;
        const under = this.shortfall(u);
        if (under > 0) {
          belowToleranceCount++;
          if (under > worstShortfall) worstShortfall = under;
        }
      }
      one = u;
      oneIdx = i;
    }
    if (!live) return null;
    const info: SelectionInfo = {
      count: live,
      byKind,
      byBand,
      markedCount,
      markedKind: mixedKinds ? null : markedKind,
      orderableCount,
      belowToleranceCount,
      worstShortfall,
      pendingCount,
      pendingSeconds: pendingCount ? pendingSeconds : 0,
      trackedCount,
    };
    if (live === 1 && one) {
      info.single = {
        index: oneIdx,
        id: one.id,
        kind: one.kind,
        assess: one.assess,
        record: one.record,
        lon: one.lon,
        lat: one.lat,
        heading: one.heading,
        mark: one.mark,
        markTimer: one.markTimer,
        tracked: this.isTracked(one),
        // A platform is stored as 'protected' so the contagion sweep leaves it alone. That is an
        // implementation detail, not a policy, and tagging the operator's own drone as a protected
        // asset would be nonsense — so the flag is contacts-only.
        protectedAsset: !PLATFORM_KINDS.includes(one.kind) && one.state === 'protected',
        // Which backer protects it (a partnered faction) or which rival it belongs to (hostile).
        faction: PLATFORM_KINDS.includes(one.kind) ? undefined : one.faction,
        hostile: !PLATFORM_KINDS.includes(one.kind) && !!one.hostile,
        role: one.siege ? 'attacker' : one.incident?.role,
        tint: this.tintHexOf(oneIdx),
        order: PLATFORM_KINDS.includes(one.kind)
          ? one.tlon !== undefined
            ? 'MOVING'
            : 'ON STATION'
          : undefined,
      };
    }
    return info;
  }

  /**
   * Whether the current selection is 'none', 'some', or 'all' investigate-marked — counted over the
   * TRACKED subset only, since those are the units the order can actually reach. Without that, a
   * mixed box would never read 'all' and the button would never offer to clear.
   */
  markState(): 'none' | 'some' | 'all' {
    let n = 0;
    let m = 0;
    for (const i of this.selection) {
      const u = this.units[i];
      if (u.dead || !this.isOrderable(u)) continue;
      n++;
      if (u.mark) m++;
    }
    if (n === 0 || m === 0) return 'none';
    return m === n ? 'all' : 'some';
  }

  /**
   * Issue (or rescind) a standing order on the current selection, and rebuild the field markers.
   *
   * Units outside sensor coverage are skipped: C2 can't task what it can't see. A unit that was
   * marked while tracked and has since gone dark KEEPS its marker — that's the point of the flag,
   * and it becomes clearable again once something reacquires it.
   *
   * Nothing resolves here. Every order starts PENDING on an {@link ORDER_DELAY} countdown and
   * commits later in {@link advanceOrders} — so issuing an order has no consequence yet, and
   * rescinding one mid-countdown leaves no trace in the ledger.
   *
   * Returns the count of orders issued or rescinded, the tolerance shortfall of each one issued
   * below the bar (charged to resistance), and how many of them were PROTECTED — company assets,
   * which cost real money to burn. The caller settles both bills.
   */
  markSelected(kind: MarkKind, on: boolean): { n: number; shortfalls: number[]; assets: number } {
    let n = 0;
    let assets = 0;
    const shortfalls: number[] = [];
    for (const i of this.selection) {
      const u = this.units[i];
      if (u.dead || !this.isOrderable(u)) continue;
      if (!on) {
        // Rescinding is always free: a pending order never happened, and a committed EXECUTION
        // hasn't fired yet. A committed investigation is already on the ledger — clearing it just
        // takes the marker off the map.
        if (!u.mark) continue;
        u.mark = null;
        u.markTimer = undefined;
        n++;
        continue;
      }
      if (u.mark === kind) continue; // already standing — don't restart its countdown
      u.mark = kind;
      u.markTimer = ORDER_DELAY[kind];
      const under = this.shortfall(u);
      if (under > 0) shortfalls.push(under);
      if (u.state === 'protected') assets++;
      n++;
    }
    this.rebuildMarks();
    return { n, shortfalls, assets };
  }

  /**
   * Age every pending order and commit the ones whose window has closed.
   *
   * Returns the verdict on each investigation that committed this tick — settled against the unit's
   * true state at the moment it commits, not when it was ordered — along with where it happened, so
   * the crowd standing there can react. Executions commit to ARMED here and are scored later, when
   * a laser actually services them.
   */
  advanceOrders(dt: number): { valid: boolean; lon: number; lat: number }[] {
    const verdicts: { valid: boolean; lon: number; lat: number }[] = [];
    let changed = false;
    for (const i of this.markedIdx) {
      const u = this.units[i];
      if (u.dead || !u.mark || u.markTimer === undefined) continue;
      u.markTimer -= dt;
      if (u.markTimer > 0) continue;
      u.markTimer = undefined; // committed
      changed = true;
      if (u.mark === 'investigate') {
        verdicts.push({ valid: u.state === 'infected', lon: u.lon, lat: u.lat });
      }
    }
    if (changed) this.refreshMarkStyles();
    return verdicts;
  }

  /**
   * Automation: issue one order against the strongest unmarked contact that clears both gates
   * and the caller's own threshold. Returns whether anything was marked.
   *
   * Deliberately ONE per call, with the caller rate-limiting: automation that swept the whole
   * field in a frame would put hundreds of entries on the ledger before the operator could
   * react, which is a very different thing from an assist.
   */
  /**
   * The first contact a Process Action rule should fire on, or -1.
   *
   * Same guards as {@link autoMark}: in coverage, not already under an order, and ABOVE the public
   * bar — an unattended machine never hardens the theater on its own. Beyond that it matches the
   * rule's trigger: a past record at or over a severity, or a live event of a class. A `fine` rule
   * additionally needs a live event to cite, since a fine answers the event, not the person.
   */
  matchForRule(rule: ProcessRule): number {
    const needsLive = rule.action === 'fine' || rule.trigger === 'violation';
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.dead || u.mark || PLATFORM_KINDS.includes(u.kind)) continue;
      if (!this.isOrderable(u)) continue;
      if (this.shortfall(u) > 0) continue;
      if (needsLive && !u.live) continue;
      if (rule.trigger === 'record') {
        if (worstSeverity(u.record) < rule.minSeverity) continue;
      } else {
        if (u.live!.def.cls !== rule.violationClass) continue;
      }
      return i;
    }
    return -1;
  }

  autoMark(kind: MarkKind, minCase: number): boolean {
    let best = -1;
    let bestCase = minCase;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.dead || u.mark || PLATFORM_KINDS.includes(u.kind)) continue;
      if (!this.isOrderable(u)) continue;
      // Automation never operates below the public bar on its own — an unattended machine
      // hardening the theater while the operator is elsewhere is not a thing to build.
      if (this.shortfall(u) > 0) continue;
      const c = caseStrength(u.assess, u.record);
      if (c > bestCase) {
        bestCase = c;
        best = i;
      }
    }
    if (best < 0) return false;
    const u = this.units[best];
    u.mark = kind;
    u.markTimer = ORDER_DELAY[kind];
    this.rebuildMarks();
    return true;
  }

  /**
   * The sensor links to draw this frame: one per investigation-marked contact that something can
   * currently see, from whatever is doing the seeing.
   *
   * Unlike {@link resolveExecutions} this asks about COVERAGE, not armament — an obelisk with no
   * emitter still watches, and an unarmed drone is still a camera. That asymmetry is the point: the
   * operator can surveil far more of the theater than they can shoot, and the scan lines are what
   * make the size of that gap visible.
   *
   * A marked contact with no link is one that has wandered out of coverage. Nothing is drawn, which
   * is the honest answer — the investigation is still on the books and nobody is watching.
   */
  scanBeams(
    obeliskApex: ((lon: number, lat: number) => Cesium.Cartesian3 | undefined) | undefined,
    platforms: PlatformId[],
  ): { from: Cesium.Cartesian3; to: Cesium.Cartesian3 }[] {
    const out: { from: Cesium.Cartesian3; to: Cesium.Cartesian3 }[] = [];
    for (const i of this.markedIdx) {
      const u = this.units[i];
      if (u.dead || u.mark !== 'investigate') continue;

      let from: Cesium.Cartesian3 | undefined;
      // Prefer a platform: a drone tasked over a contact is the more interesting answer to "who is
      // watching this", and an operator who moved it there should see their own asset on the line.
      for (const id of platforms) {
        const idx = this.coveringUnit(id, u.lon, u.lat);
        if (idx < 0) continue;
        from = new Cesium.Cartesian3(
          this.ecef[idx * 3],
          this.ecef[idx * 3 + 1],
          this.ecef[idx * 3 + 2],
        );
        break;
      }
      // Clone: the sensor field hands back a shared scratch, and many links resolve in one frame —
      // keeping the reference would leave every beam originating from the last obelisk.
      if (!from && obeliskApex) {
        const apex = obeliskApex(u.lon, u.lat);
        if (apex) from = Cesium.Cartesian3.clone(apex);
      }
      if (!from) continue;

      out.push({
        from,
        to: new Cesium.Cartesian3(this.ecef[i * 3], this.ecef[i * 3 + 1], this.ecef[i * 3 + 2]),
      });
    }
    return out;
  }

  /** World position of one unit, from the cache the last render filled. */
  worldPositionOf(index: number): Cesium.Cartesian3 | null {
    const u = this.units[index];
    if (!u || u.dead) return null;
    return new Cesium.Cartesian3(
      this.ecef[index * 3],
      this.ecef[index * 3 + 1],
      this.ecef[index * 3 + 2],
    );
  }

  // --- execution ---------------------------------------------------------------------------------

  /**
   * Service every execution-marked unit that an armed platform can currently see.
   *
   * `obeliskReach` resolves the apex of an armed obelisk covering a point (undefined if the obelisk
   * net isn't armed). `armedPlatforms` lists the platforms carrying a directed-energy emitter on a
   * hardpoint — each services anything inside its own sensor envelope, so where a platform can see
   * is exactly where it can shoot.
   *
   * The verdict is settled HERE, at the moment the beam lands — not when the order was given —
   * because the unit's true state may well have moved in between, and the shot is what the operator
   * is answerable for.
   */
  resolveExecutions(
    obeliskReach: ((lon: number, lat: number) => Cesium.Cartesian3 | undefined) | undefined,
    armedPlatforms: PlatformId[],
    platformAreaOf?: (id: PlatformId) => number,
  ): Execution[] {
    if (!obeliskReach && !armedPlatforms.length) return [];
    const out: Execution[] = [];
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.dead || u.mark !== 'execute' || PLATFORM_KINDS.includes(u.kind)) continue;
      if (u.markTimer !== undefined) continue; // still inside its rescind window — hold fire

      let from: Cesium.Cartesian3 | undefined;
      // If the servicing platform carries an area weapon, this is its blast radius — obelisk service
      // never has one, so it stays 0 when the beam falls from the net.
      let area = 0;
      // A PLATFORM in range shoots before the obelisk net does.
      //
      // The other order was the obvious one and it was wrong. Obelisk coverage blankets a developed
      // state, so checking it first meant a laser-armed drone parked directly over a contact never
      // once appeared to fire — every beam fell out of the sky from the nearest tower. The operator
      // buys a drone, arms it, flies it somewhere, and gets no evidence it did anything.
      //
      // First platform in range wins; which one is cosmetic, but that it is one at all is not.
      for (const id of armedPlatforms) {
        const idx = this.coveringUnit(id, u.lon, u.lat);
        if (idx < 0) continue;
        from = new Cesium.Cartesian3(
          this.ecef[idx * 3],
          this.ecef[idx * 3 + 1],
          this.ecef[idx * 3 + 2],
        );
        area = platformAreaOf ? platformAreaOf(id) : 0;
        break;
      }
      // Clone: the sensor field hands back a shared scratch, and several shots can land in one
      // frame — keeping the reference would leave every beam originating from the last obelisk.
      if (!from && obeliskReach) {
        const apex = obeliskReach(u.lon, u.lat);
        if (apex) from = Cesium.Cartesian3.clone(apex);
      }
      if (!from) continue;

      const to = new Cesium.Cartesian3(this.ecef[i * 3], this.ecef[i * 3 + 1], this.ecef[i * 3 + 2]);
      out.push({ index: i, id: u.id, lon: u.lon, lat: u.lat, from, to, valid: u.state === 'infected' });
      u.dead = true;
      u.mark = null;
      this.selection.delete(i);

      // Area weapon: everyone else standing in the ring dies with the target. Capped so a MOAB in a
      // dense block is a massacre, not a frame-long O(n) sweep of the whole field.
      if (area > 0) {
        const mLon = mPerLat * Math.cos(u.lat * DEG);
        const r2 = area * area;
        let hit = 0;
        for (let j = 0; j < this.units.length && hit < AREA_MAX_VICTIMS; j++) {
          if (j === i) continue;
          const v = this.units[j];
          if (v.dead || PLATFORM_KINDS.includes(v.kind)) continue;
          const dx = (v.lon - u.lon) * mLon;
          const dy = (v.lat - u.lat) * mPerLat;
          if (dx * dx + dy * dy > r2) continue;
          const vto = new Cesium.Cartesian3(this.ecef[j * 3], this.ecef[j * 3 + 1], this.ecef[j * 3 + 2]);
          out.push({ index: j, id: v.id, lon: v.lon, lat: v.lat, from, to: vto, valid: v.state === 'infected', collateral: true });
          v.dead = true;
          v.mark = null;
          this.selection.delete(j);
          hit++;
        }
      }
    }
    if (out.length) this.rebuildMarks();
    return out;
  }

  /**
   * World positions of contacts standing near a point — who a reaction plays over.
   *
   * Reads the cached positions from the last render, so it costs a sweep and no maths. Capped
   * because a burst is a gesture, not a census: twenty faces reads as a street reacting, two
   * hundred reads as noise.
   */
  bystandersNear(lon: number, lat: number, radiusM: number, max = 14): Cesium.Cartesian3[] {
    const out: Cesium.Cartesian3[] = [];
    const mLon = mPerLat * Math.cos(lat * DEG);
    const r2 = radiusM * radiusM;
    for (let i = 0; i < this.units.length && out.length < max; i++) {
      const u = this.units[i];
      if (u.dead || PLATFORM_KINDS.includes(u.kind)) continue;
      const dx = (u.lon - lon) * mLon;
      const dy = (u.lat - lat) * mPerLat;
      if (dx * dx + dy * dy > r2) continue;
      out.push(new Cesium.Cartesian3(this.ecef[i * 3], this.ecef[i * 3 + 1], this.ecef[i * 3 + 2]));
    }
    return out;
  }

  /** World positions of the player's own platforms — who a company reaction plays over. */
  platformPositions(): Cesium.Cartesian3[] {
    return this.platformUnits().map(
      (u) => new Cesium.Cartesian3(this.ecef[u.index * 3], this.ecef[u.index * 3 + 1], this.ecef[u.index * 3 + 2]),
    );
  }

  /**
   * Resolve platforms that have arrived at whatever they were ORDERED to do.
   *
   * Everything here is the tail end of a right-click: the operator picked a contact, picked an
   * action their loadout supports, and the platform flew there. This is the arrival.
   *
   * Returns the strikes that went off, so the caller can bill the collateral.
   */
  resolveArrivals(dt: number): {
    strikes: { lon: number; lat: number; killed: number; collateral: number; killedAttacker: boolean }[];
    /** A platform arrived on a DETAIN order and took the live siege attacker. */
    detainedAttacker: boolean;
    /** Incident participants taken into custody by an arriving platform this frame. */
    detainedIncidents: number;
    /** Contacts carried off under a sentence rather than into custody, this frame. */
    imprisoned: number;
    /** Detainments resolved this frame: who threw, at what, and whether it was a sentencing. */
    detainments: { from: Cesium.Cartesian3; to: Cesium.Cartesian3; prison: boolean }[];
  } {
    const out: {
      lon: number;
      lat: number;
      killed: number;
      collateral: number;
      killedAttacker: boolean;
    }[] = [];
    let detainedAttacker = false;
    let detainedIncidents = 0;
    let imprisoned = 0;
    const detainments: { from: Cesium.Cartesian3; to: Cesium.Cartesian3; prison: boolean }[] = [];

    for (const { kind, index } of this.platformUnits()) {
      const u = this.units[index];
      u.strikeCooldown = Math.max(0, (u.strikeCooldown ?? 0) - dt);

      const action = u.routeAction;
      if (!action || u.route?.length) continue; // still legs to fly before the last one

      // Track a moving target: a contact ordered against doesn't wait to be arrived at.
      const t = u.routeTarget !== undefined ? this.units[u.routeTarget] : undefined;
      if (t && !t.dead) {
        u.tlon = t.lon;
        u.tlat = t.lat;
      } else if (t?.dead) {
        // Target gone before arrival — stand down rather than striking an empty street.
        u.routeAction = null;
        u.routeTarget = undefined;
        u.tlon = undefined;
        u.tlat = undefined;
        continue;
      }
      if (u.tlon === undefined || u.tlat === undefined) continue;

      const mLon = mPerLat * Math.cos(u.lat * DEG);
      const reach = action === 'strike' ? INTERCEPT.engageM : this.sensorOf(kind);
      const dx = (u.tlon - u.lon) * mLon;
      const dy = (u.tlat - u.lat) * mPerLat;
      if (Math.hypot(dx, dy) > reach) continue;

      if (action === 'strike') {
        if (u.strikeCooldown > 0) continue;
        u.strikeCooldown = INTERCEPT.cooldownS;
        out.push(this.detonate(u.tlon, u.tlat));
      } else if (t) {
        // Investigate / detain / prison / execute all land on the one contact that was picked.
        // Custody and a sentence are the same arrival — a platform arrives and somebody is carried
        // away. What separates them is what happens after, which this layer doesn't model and
        // shouldn't pretend to: the difference is counted here and spoken about by the scene.
        if (action === 'detain' || action === 'prison') {
          if (action === 'prison') imprisoned++;
          // from = the platform that arrived, to = the contact it was sent at.
          const targetIdx = u.routeTarget!;
          detainments.push({
            from: new Cesium.Cartesian3(this.ecef[index * 3], this.ecef[index * 3 + 1], this.ecef[index * 3 + 2]),
            to: new Cesium.Cartesian3(
              this.ecef[targetIdx * 3],
              this.ecef[targetIdx * 3 + 1],
              this.ecef[targetIdx * 3 + 2],
            ),
            prison: action === 'prison',
          });
          t.dead = true;
          t.mark = null;
          // Clear the incident role explicitly rather than relying on the dead flag: the director
          // reads participants by role, and a corpse still holding one is a thing waiting to
          // confuse somebody.
          if (t.incident) {
            t.incident = undefined;
            detainedIncidents++;
          }
          this.selection.delete(u.routeTarget!);
          // Report it as a DETAINMENT rather than letting the siege director notice the attacker
          // vanished and score it as a kill — the whole point of custody is that it isn't one.
          if (this.attackerIdx === u.routeTarget) {
            this.attackerIdx = -1;
            detainedAttacker = true;
          }
        } else {
          t.mark = action === 'execute' ? 'execute' : 'investigate';
          t.markTimer = ORDER_DELAY[t.mark];
        }
        this.rebuildMarks();
      }

      u.routeAction = null;
      u.routeTarget = undefined;
      u.tlon = undefined;
      u.tlat = undefined;
    }
    return { strikes: out, detainedAttacker, detainedIncidents, imprisoned, detainments };
  }

  /** Everything inside the blast dies. Returns the toll, split into target and everyone else. */
  private detonate(
    lon: number,
    lat: number,
  ): { lon: number; lat: number; killed: number; collateral: number; killedAttacker: boolean } {
    const mLon = mPerLat * Math.cos(lat * DEG);
    const r2 = INTERCEPT.blastM * INTERCEPT.blastM;
    let killed = 0;
    let collateral = 0;
    let killedAttacker = false;
    for (let i = 0; i < this.units.length; i++) {
      const o = this.units[i];
      if (o.dead || PLATFORM_KINDS.includes(o.kind)) continue;
      const ox = (o.lon - lon) * mLon;
      const oy = (o.lat - lat) * mPerLat;
      if (ox * ox + oy * oy > r2) continue;
      o.dead = true;
      o.mark = null;
      this.selection.delete(i);
      if (i === this.attackerIdx) {
        this.attackerIdx = -1;
        killedAttacker = true;
      }
      killed++;
      // Anyone in the blast who was not attacking a site is collateral.
      if (!o.siege) collateral++;
    }
    this.rebuildMarks();
    return { lon, lat, killed, collateral, killedAttacker };
  }

  /** Live (undead) unit count, for the HUD. */
  get liveCount(): number {
    let n = 0;
    for (const u of this.units) if (!u.dead) n++;
    return n;
  }

  private rebuildMarks(): void {
    this.markedIdx = [];
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.mark && !u.dead) this.markedIdx.push(i);
    }
    this.marksLayer.removeAll();
    for (let m = 0; m < this.markedIdx.length; m++) {
      const u = this.units[this.markedIdx[m]];
      const b = this.marksLayer.add({
        position: Cesium.Cartesian3.ZERO, // set each frame in render()
        image: this.markTextures[u.mark!],
        width: 26,
        height: 26,
        pixelOffset: new Cesium.Cartesian2(0, -20),
      });
      // A C2 marker stays visible even when its unit is behind a building. NOTE: Cesium billboards
      // coerce `Infinity` here to null (which does NOT disable the test) — a large finite value
      // (well past any theater distance) is what actually keeps the marker on top.
      b.disableDepthTestDistance = 1e12;
    }
    this.refreshMarkStyles();
  }

  /**
   * Dim the markers of orders still inside their rescind window, so a glance at the map separates
   * "about to happen" from "standing". Called when an order commits rather than every frame —
   * markers only change style at that one moment.
   */
  private refreshMarkStyles(): void {
    for (let m = 0; m < this.markedIdx.length; m++) {
      const u = this.units[this.markedIdx[m]];
      const b = this.marksLayer.get(m);
      if (b) b.color = u.markTimer !== undefined ? PENDING_MARK_COLOR : Cesium.Color.WHITE;
    }
  }

  /** Window position of the single selected unit, for the reticle. Call after render(). */
  selectedScreen(scene: Cesium.Scene, result: Cesium.Cartesian2): Cesium.Cartesian2 | undefined {
    if (this.selection.size !== 1) return undefined;
    const toWin = this.toWin();
    const i = this.selection.values().next().value as number;
    const c = new Cesium.Cartesian3(this.ecef[i * 3], this.ecef[i * 3 + 1], this.ecef[i * 3 + 2]);
    return toWin?.(scene, c, result);
  }

  /** Flat [lon,lat,...] of infected units, for the sensor threat pass. Reused each frame. */
  private infectedBuf = new Float64Array(0);
  infectedPositions(): { buf: Float64Array; count: number } {
    let n = 0;
    for (const u of this.units) if (u.state === 'infected' && !u.dead) n++;
    if (this.infectedBuf.length < n * 2) this.infectedBuf = new Float64Array(n * 2);
    let j = 0;
    for (const u of this.units) {
      if (u.state !== 'infected' || u.dead) continue;
      this.infectedBuf[j * 2] = u.lon;
      this.infectedBuf[j * 2 + 1] = u.lat;
      j++;
    }
    return { buf: this.infectedBuf, count: n };
  }

  /**
   * Demo hook (no contagion sim yet): each call flips a slice of non-infected units to infected;
   * once most are infected, reset to the seed mix. Lets you watch the red state sweep the field.
   */
  cycleInfection(): void {
    const infected = this.units.filter((u) => u.state === 'infected').length;
    if (infected > this.units.length * 0.75) {
      for (const u of this.units) {
        if (!PLATFORM_KINDS.includes(u.kind) && !u.dead) {
          u.state = this.rollState(u.lon, u.lat);
          u.assess = rollAssessment(u.state);
        }
      }
      return;
    }
    for (const u of this.units) {
      if (PLATFORM_KINDS.includes(u.kind) || u.dead) continue; // friendly hardware never turns
      if (u.state !== 'infected' && Math.random() < 0.25) {
        u.state = 'infected';
        u.assess = rollAssessment(u.state);
      }
    }
  }

  /**
   * How much of the protected network is still standing, 0–1.
   *
   * Protected units are company assets: inoculated, never hostile, and quietly worth something to
   * the programme's standing. This is what that's measured against — burn them and the number
   * falls, and so does what they were buying you.
   */
  assetNetworkIntact(): number {
    if (!this.protectedAtSpawn) return 0;
    let alive = 0;
    for (const u of this.units) if (u.state === 'protected' && !u.dead) alive++;
    return Math.min(1, alive / this.protectedAtSpawn);
  }
  private protectedAtSpawn = 0;

  /** Tally by TRUE state, for the HUD. Ground truth — the operator's panels never call this. */
  stateCounts(): Record<UnitState, number> {
    const c = { normal: 0, protected: 0, infected: 0 };
    for (const u of this.units) if (!u.dead) c[u.state]++;
    return c;
  }

  destroy(): void {
    for (const k of UNIT_KINDS) this.batches[k].destroy();
    this.droneRing.destroy();
    this.platformIcons.destroy();
  }
}
