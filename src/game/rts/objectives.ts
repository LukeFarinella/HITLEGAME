import type { StructureType } from './structures';
import type { UnitKind } from '../../cesium/unitModels';

/**
 * The RTS objective chain — a tutorial that does not know it is one.
 *
 * The skirmish had no on-ramp. A new player was handed an economy, a nine-building tech tree, a
 * fourteen-project research list and an enemy on a clock, with nothing anywhere saying "raise an
 * obelisk first". The chain fixes that by naming the next sensible thing, in order, all the way to
 * the win — so following it top to bottom IS the build order, and the player learns the tree by
 * doing it rather than by reading it.
 *
 * Three deliberate design choices:
 *
 *   NOT GATED. Every objective is checked independently and completes the moment its condition holds,
 *   whatever order things happened in. A chain that stalls because you built robotics before the data
 *   center would be a worse teacher than no chain, and a player who already knows the game should
 *   watch the list tick itself off behind them rather than fight it.
 *
 *   EASY ON PURPOSE. Each one asks for a single obvious act — one building, four quadrupeds — and
 *   pays a bounty for it. The bounty is the point as much as the instruction: it front-loads the
 *   economy so the opening is forgiving, and it means following the tutorial is strictly better than
 *   ignoring it without ever being mandatory.
 *
 *   NO FAILURE. Nothing here can be failed, expire, or be missed. It is a map of the game, not a
 *   scoring system — the campaign already has one of those, and it is a different game.
 */

export type ObjectiveId =
  | 'expand'
  | 'data-center'
  | 'robotics'
  | 'first-army'
  | 'tech'
  | 'first-upgrade'
  | 'aviation'
  | 'special'
  | 'skyhook'
  | 'capstone'
  | 'orbital'
  | 'raze';

/** Everything an objective can ask about, sampled from the match once per check. */
export interface MatchFacts {
  obelisks: number;
  has: (t: StructureType) => boolean;
  /** How many live units of a chassis the player fields. */
  units: (k: UnitKind) => number;
  researchDone: number;
  orbitalFired: boolean;
  millstoneRazed: boolean;
}

export interface ObjectiveDef {
  id: ObjectiveId;
  name: string;
  /** One line telling the player exactly what to do. Imperative — this is instruction, not flavour. */
  hint: string;
  /** Money paid on completion. */
  bounty: number;
  done: (f: MatchFacts) => boolean;
}

export const OBJECTIVES: ObjectiveDef[] = [
  {
    id: 'expand',
    name: 'TAKE GROUND',
    hint: 'Select a worker and raise 2 more OBELISKS (E) on surveyed sites. Obelisks are income, vision, and the only thing that powers a building.',
    bounty: 150,
    done: (f) => f.obelisks >= 3,
  },
  {
    id: 'data-center',
    name: 'RAISE THE CAP',
    hint: 'Build a DATA CENTER (D) for supply. Be warned: every one you plant makes the public angrier, and angry ground brings Millstone sooner.',
    bounty: 150,
    done: (f) => f.has('supply'),
  },
  {
    id: 'robotics',
    name: 'OPEN A FACTORY',
    hint: 'Build the ROBOTICS FACILITY (R). It makes the quadrupeds your whole opening line is built from.',
    bounty: 200,
    done: (f) => f.has('robotics'),
  },
  {
    id: 'first-army',
    name: 'FIELD A LINE',
    hint: 'Select the robotics facility and build 4 QUADRUPEDS (Q). Right-click to move them; they hold ground and shoot what comes at it.',
    bounty: 200,
    done: (f) => f.units('dog') >= 4,
  },
  {
    id: 'tech',
    name: 'STAND UP A LAB',
    hint: 'Build the TECH FACILITY (T). It unlocks the kite and the littoral, and it is where every upgrade is researched.',
    bounty: 250,
    done: (f) => f.has('tech'),
  },
  {
    id: 'first-upgrade',
    name: 'IMPROVE THE LINE',
    hint: 'Select the tech facility and research anything — HEAVY BARRELS (Q) is the obvious first. Upgrades refit every machine you already own.',
    bounty: 250,
    done: (f) => f.researchDone >= 1,
  },
  {
    id: 'aviation',
    name: 'GET OFF THE GROUND',
    hint: 'Build the AVIATION FACILITY (V) and field an INTERCEPTOR. Air crosses the theater in seconds and outranges anything walking.',
    bounty: 300,
    done: (f) => f.has('aviation'),
  },
  {
    id: 'special',
    name: 'BUILD THE HEAVY LINE',
    hint: 'Build the SPECIAL FACILITY (S). Arachnids and marshals come from here — the units that win a fight the quadrupeds only survive.',
    bounty: 350,
    done: (f) => f.has('special'),
  },
  {
    id: 'skyhook',
    name: 'RAISE THE TETHER',
    hint: 'Build the SKYHOOK (K). It unlocks the top of the roster and it is the only thing that can call an orbital strike.',
    bounty: 400,
    done: (f) => f.has('skyhook'),
  },
  {
    id: 'capstone',
    name: 'FIELD THE CAPSTONE',
    hint: 'Build a GIGA WALKER (G) from the special facility. One of them anchors an assault; it does not replace the army around it.',
    bounty: 400,
    done: (f) => f.units('walker') >= 1,
  },
  {
    id: 'orbital',
    name: 'CALL IT DOWN',
    hint: 'Select the skyhook and fire an ORBITAL STRIKE (B) at ground you pick. Ten seconds of fall, 420 m of blast, and it does not care whose units are in it.',
    bounty: 400,
    done: (f) => f.orbitalFired,
  },
  {
    id: 'raze',
    name: 'RAZE MILLSTONE',
    hint: 'March on the enemy Nexus and put it down. That ends the match.',
    bounty: 0,
    done: (f) => f.millstoneRazed,
  },
];

export const OBJECTIVE_BY_ID = new Map(OBJECTIVES.map((o) => [o.id, o]));

/**
 * Which objectives have newly completed, given what is already done.
 *
 * Returns them in chain order so a burst — a player who built four things while the panel was
 * collapsed — pays out and reads top to bottom rather than at random.
 */
export function newlyDone(facts: MatchFacts, already: ReadonlySet<ObjectiveId>): ObjectiveDef[] {
  return OBJECTIVES.filter((o) => !already.has(o.id) && o.done(facts));
}
