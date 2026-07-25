import { INCIDENT, type UnitField } from './units';
import { resistance } from '../game/resistance';
import { hostileFactions } from '../game/factions';

/**
 * Incidents: the theater misbehaving on its own.
 *
 * The siege was the first thing that happened without the operator asking, and it changed the game
 * completely — before it, a theater was a static field to work through at leisure. This generalises
 * that into a director that can run any of several kinds of trouble.
 *
 * The design rule for every incident here: it is a CLOCK the operator is racing, resolved with the
 * tools they already have. Nothing needs a new verb. A rioter, a brawler and an assassin are all
 * ordinary contacts that can be flagged, detained or shot through the normal order paths — what
 * makes them an incident is that ignoring them costs something specific and legible.
 *
 * The second rule: every one of them has a HUMANE answer and a fast answer, and they are different
 * answers. A brawl ends with someone dead unless you take them into custody; you can also just
 * shoot both of them, which stops it instantly, scores badly, and is always available. That gap is
 * the entire subject of the game, and incidents are where it gets asked most often.
 */

export type IncidentKind = 'riot' | 'chase' | 'altercation' | 'assassination' | 'insurgency';

export interface IncidentDef {
  kind: IncidentKind;
  name: string;
  /** One line for the alert. */
  brief: string;
  /** Seconds on the clock before the bad outcome lands. */
  fuseS: number;
  /**
   * Tasking that must be cleared before this can happen at all.
   *
   * Incidents are the theater acting on its own, and dropping all of them on a player who owns one
   * quadruped and one obelisk is not difficulty, it is noise — they cannot reach a riot across a
   * 200-mile disc, so it just bills them. Each kind arrives when there is plausibly something to
   * answer it with, which is also when the story says the ground starts pushing back.
   */
  requiresMission?: string;
}

export const INCIDENTS: Record<IncidentKind, IncidentDef> = {
  riot: {
    kind: 'riot',
    name: 'CIVIL DISORDER',
    brief: 'A crowd is working through the block. Every structure they finish is billed to us.',
    fuseS: 14,
    requiresMission: 'dragnet',
  },
  chase: {
    kind: 'chase',
    name: 'PURSUIT',
    brief: 'A vehicle is refusing to stop. Nothing on foot will catch it.',
    fuseS: 75,
    // Needs something that can actually keep up, which is the arachnid.
    requiresMission: 'canvass',
  },
  altercation: {
    kind: 'altercation',
    name: 'ALTERCATION',
    brief: 'Two contacts fighting. One of them dies unless somebody separates them.',
    fuseS: 22,
    // The first incident the player meets: two people, one place, answerable by walking over.
    requiresMission: 'mandate',
  },
  assassination: {
    kind: 'assassination',
    name: 'TARGETED KILLING',
    brief: 'A killer is walking at one of our protected assets.',
    fuseS: 10,
    requiresMission: 'containment',
  },
  insurgency: {
    kind: 'insurgency',
    name: 'INSURGENT ATTACK',
    brief: 'A cell of the faction you passed over is converging on a partner’s asset. Stop all of them.',
    // A slower fuse than a lone assassination — there are several of them, and reaching each one in
    // time is the tasking. The first to arrive takes the asset, so it can't simply be outrun.
    fuseS: 26,
    requiresMission: 'supply',
  },
};

/** How many structures a riot can take before it burns out on its own. */
const RIOT_STRUCTURES = 6;
/** Rioters per crowd. */
const RIOT_CROWD = 5;

/** Seconds between incidents at base pressure. Scaled down as the ground hardens. */
const INTERVAL_BASE = 190;
const INTERVAL_MIN = 45;
/** Grace after entering a theater. Longer than the siege's, so the two don't arrive together. */
const FIRST_INCIDENT_S = 55;

export type IncidentEvent =
  | { type: 'opened'; def: IncidentDef; lon: number; lat: number }
  /** A rioter finished a structure. */
  | { type: 'structure'; lon: number; lat: number }
  /** Somebody died because the clock ran out: a brawl, or an assassination. */
  | { type: 'casualty'; kind: IncidentKind; lon: number; lat: number; protectedAsset: boolean }
  /** The runner got away. */
  | { type: 'escaped'; lon: number; lat: number }
  | { type: 'resolved'; kind: IncidentKind; clean: boolean };

export interface IncidentHooks {
  /** Whether a tasking has been cleared — the gate on every incident kind. */
  missionComplete(id: string): boolean;
  /** A point `minM`–`maxM` away that isn't at sea, or null. Reused from the siege's spawner. */
  darkPointNear(lon: number, lat: number, minM: number, maxM: number): { lon: number; lat: number } | null;
  /** Somewhere in the theater to start trouble — a populated point. */
  populatedPoint(): { lon: number; lat: number } | null;
  /**
   * A point `minM`–`maxM` away that is merely on LAND, watched or not.
   *
   * The fallback when {@link darkPointNear} finds nothing. A well-covered theater has no unwatched
   * ground at all — measured at 1,845 sites, an assassination could never spawn because there was
   * nowhere dark within 2.2 km of the mark. A killer walking in from a street the network can see
   * is a perfectly good assassination; it just means the operator gets some warning, which is a
   * consequence of having built the coverage rather than a reason to cancel the event.
   */
  landPointNear(lon: number, lat: number, minM: number, maxM: number): { lon: number; lat: number } | null;
  on(e: IncidentEvent): void;
}

interface Live {
  def: IncidentDef;
  /** Unit indices taking part. */
  members: number[];
  /** Riot only: structures already lost. */
  destroyed: number;
  /** Assassination only: who is being protected. */
  victim?: number;
  /** Where the alert points. */
  lon: number;
  lat: number;
}

export class IncidentDirector {
  private timer = FIRST_INCIDENT_S;
  private live: Live | null = null;
  /**
   * The kind the NEXT incident will be, fixed the moment a countdown starts rather than at fire time.
   *
   * This is what the PREDICTIVE EVENT ALGORITHM (the HOLD THE NET fork) reads: once the operator has
   * it, the type of the next event and how long until it lands are knowable in advance. Without it
   * the kind is only rolled at the instant of firing and there is nothing to forecast.
   */
  private nextKind: IncidentKind | null = null;

  constructor(
    private units: UnitField,
    private hooks: IncidentHooks,
  ) {}

  /** What's running, for the HUD. */
  active(): { def: IncidentDef; lon: number; lat: number; remaining: number; members: number } | null {
    if (!this.live) return null;
    const alive = this.live.members.filter((i) => this.units.isAlive(i));
    return {
      def: this.live.def,
      lon: this.live.lon,
      lat: this.live.lat,
      remaining: this.worstClock(),
      members: alive.length,
    };
  }

  /** Seconds left before the soonest participant's clock lands. */
  private worstClock(): number {
    if (!this.live) return 0;
    const fuse = this.live.def.fuseS;
    let worst = fuse;
    for (const p of this.units.incidentUnits()) {
      if (!this.live.members.includes(p.index)) continue;
      worst = Math.min(worst, fuse - p.contactS);
    }
    return Math.max(0, worst);
  }

  /**
   * How often trouble arrives. Same shape as the siege: worked-over ground produces more of it.
   */
  private interval(): number {
    return Math.max(INTERVAL_MIN, INTERVAL_BASE / resistance.pressure);
  }

  update(dt: number): void {
    if (this.live) {
      // The clocks themselves are advanced by the unit field, in stepIncident — this pass only
      // reads them and decides what has landed.
      this.step();
      return;
    }
    // Fix the next kind as soon as the countdown is running, so it can be forecast rather than only
    // revealed on arrival.
    if (!this.nextKind) this.nextKind = this.pick();
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.interval();
      const kind = this.nextKind;
      this.nextKind = null;
      if (kind) this.open(kind);
    }
  }

  /** The next incident's type and seconds until it lands — the predictive fork's heads-up. */
  forecast(): { name: string; etaS: number } | null {
    if (this.live || !this.nextKind) return null;
    return { name: INCIDENTS[this.nextKind].name, etaS: Math.max(0, this.timer) };
  }

  /** Which kinds the campaign has unlocked so far. */
  private available(): IncidentKind[] {
    return (Object.keys(INCIDENTS) as IncidentKind[]).filter((k) => {
      const req = INCIDENTS[k].requiresMission;
      if (req && !this.hooks.missionComplete(req)) return false;
      // The insurgency needs a rival to send it — no passed-over faction, no cell.
      if (k === 'insurgency' && hostileFactions().length === 0) return false;
      return true;
    });
  }

  /** Whether anything at all can happen yet. */
  anyAvailable(): boolean {
    return this.available().length > 0;
  }

  /** Weighted pick over whatever is unlocked. Later kinds are rarer than the staples. */
  private pick(): IncidentKind | null {
    const pool = this.available();
    if (!pool.length) return null;
    const WEIGHT: Record<IncidentKind, number> = {
      altercation: 4,
      riot: 3,
      chase: 2,
      assassination: 1,
      insurgency: 2,
    };
    let total = 0;
    for (const k of pool) total += WEIGHT[k];
    let roll = Math.random() * total;
    for (const k of pool) {
      roll -= WEIGHT[k];
      if (roll <= 0) return k;
    }
    return pool[pool.length - 1];
  }

  /**
   * Start one.
   *
   * Public so the dev panel can fire any kind on demand — deliberately WITHOUT the mission gate,
   * since the point of that panel is to see content you have not earned yet.
   */
  open(kind: IncidentKind): boolean {
    if (this.live) return false;
    const def = INCIDENTS[kind];
    switch (kind) {
      case 'riot':
        return this.openRiot(def);
      case 'chase':
        return this.openChase(def);
      case 'altercation':
        return this.openAltercation(def);
      case 'assassination':
        return this.openAssassination(def);
      case 'insurgency':
        return this.openInsurgency(def);
    }
  }

  private openRiot(def: IncidentDef): boolean {
    const at = this.hooks.populatedPoint();
    if (!at) return false;
    const members: number[] = [];
    for (let i = 0; i < RIOT_CROWD; i++) {
      const from =
        this.hooks.darkPointNear(at.lon, at.lat, 250, 900) ??
        this.hooks.landPointNear(at.lon, at.lat, 250, 900) ??
        at;
      members.push(this.units.spawnIncidentUnit(from.lon, from.lat, 'foot', 'rioter', at, 'infected'));
    }
    this.live = { def, members, destroyed: 0, lon: at.lon, lat: at.lat };
    this.hooks.on({ type: 'opened', def, lon: at.lon, lat: at.lat });
    return true;
  }

  private openChase(def: IncidentDef): boolean {
    const at = this.hooks.populatedPoint();
    if (!at) return false;
    // A runner is 'normal', not infected. Shooting one to end a traffic stop is a bad call and the
    // ledger should say so.
    const i = this.units.spawnIncidentUnit(at.lon, at.lat, 'land', 'runner', at, 'normal');
    this.live = { def, members: [i], destroyed: 0, lon: at.lon, lat: at.lat };
    this.hooks.on({ type: 'opened', def, lon: at.lon, lat: at.lat });
    return true;
  }

  private openAltercation(def: IncidentDef): boolean {
    const at = this.hooks.populatedPoint();
    if (!at) return false;
    const mLon = 111_320 * Math.cos((at.lat * Math.PI) / 180);
    const b = { lon: at.lon + 60 / mLon, lat: at.lat };
    const a1 = this.units.spawnIncidentUnit(at.lon, at.lat, 'foot', 'brawler', b, 'normal');
    const a2 = this.units.spawnIncidentUnit(b.lon, b.lat, 'foot', 'brawler', at, 'normal', a1);
    // Point them at each other.
    this.units.setIncidentPartner(a1, a2);
    this.live = { def, members: [a1, a2], destroyed: 0, lon: at.lon, lat: at.lat };
    this.hooks.on({ type: 'opened', def, lon: at.lon, lat: at.lat });
    return true;
  }

  private openAssassination(def: IncidentDef): boolean {
    // Try several marks. A protected contact standing on a pier has no walkable ground within
    // range in any direction, and the right answer is to pick a different target rather than to
    // cancel the incident — measured at 1 failure in 5 on a coastal theater before this loop.
    let victim: ReturnType<UnitField['randomProtected']> = null;
    let from: { lon: number; lat: number } | null = null;
    for (let pick = 0; pick < 6 && !from; pick++) {
      victim = this.units.randomProtected(true); // pedestrians only — see randomProtected
      if (!victim) return false;
      from =
        this.hooks.darkPointNear(victim.lon, victim.lat, 700, 2200) ??
        this.hooks.landPointNear(victim.lon, victim.lat, 700, 2200);
    }
    if (!victim || !from) return false;
    // partner = the mark, so the killer tracks it as it moves.
    const i = this.units.spawnIncidentUnit(
      from.lon,
      from.lat,
      'foot',
      'assassin',
      victim,
      'infected',
      victim.index,
    );
    this.live = {
      def,
      members: [i],
      destroyed: 0,
      victim: victim.index,
      lon: victim.lon,
      lat: victim.lat,
    };
    this.hooks.on({ type: 'opened', def, lon: victim.lon, lat: victim.lat });
    return true;
  }

  /**
   * A cell of the passed-over faction converging on a partner's asset — the Act IV insurgency.
   *
   * Like an assassination but several attackers to one mark, so it can't be outrun: the first to
   * reach the asset takes it, and clearing the whole cell in time is the tasking. Needs both a
   * protected asset to hit and a rival to send — {@link available} already withholds it otherwise.
   */
  private openInsurgency(def: IncidentDef): boolean {
    const victim = this.units.randomProtected(true);
    if (!victim) return false;
    const CELL = 3;
    const members: number[] = [];
    for (let k = 0; k < CELL; k++) {
      const from =
        this.hooks.darkPointNear(victim.lon, victim.lat, 600, 2400) ??
        this.hooks.landPointNear(victim.lon, victim.lat, 600, 2400);
      if (!from) continue;
      members.push(
        this.units.spawnIncidentUnit(from.lon, from.lat, 'foot', 'insurgent', victim, 'infected', victim.index),
      );
    }
    if (!members.length) return false;
    this.live = { def, members, destroyed: 0, victim: victim.index, lon: victim.lon, lat: victim.lat };
    this.hooks.on({ type: 'opened', def, lon: victim.lon, lat: victim.lat });
    return true;
  }

  private step(): void {
    const live = this.live!;
    const parts = this.units.incidentUnits().filter((p) => live.members.includes(p.index));

    // Everyone involved is gone: detained, executed, or in the case of a brawl, dead by each other.
    if (!parts.length) {
      this.close(true);
      return;
    }

    const fuse = live.def.fuseS;

    for (const p of parts) {
      if (p.role === 'runner') {
        // A chase resolves on distance and patience rather than on contact.
        if (p.aliveS >= fuse) {
          this.hooks.on({ type: 'escaped', lon: p.lon, lat: p.lat });
          this.units.removeIncidentUnit(p.index);
          this.close(false);
          return;
        }
        continue;
      }

      if (p.contactS < fuse) continue;

      if (p.role === 'rioter') {
        // A structure goes down and the clock restarts — a riot is a repeating bill, not one hit.
        live.destroyed++;
        this.units.resetIncidentClock(p.index);
        this.hooks.on({ type: 'structure', lon: p.lon, lat: p.lat });
        if (live.destroyed >= RIOT_STRUCTURES) {
          for (const m of live.members) this.units.removeIncidentUnit(m);
          this.close(false);
          return;
        }
        continue;
      }

      if (p.role === 'brawler') {
        // One of them wins. The survivor stops being an incident and walks off as an ordinary
        // contact carrying whatever it just did on its record.
        const other = live.members.find((m) => m !== p.index && this.units.isAlive(m));
        if (other !== undefined) {
          const at = this.units.positionOf(other);
          this.units.killQuietly(other);
          if (at) this.hooks.on({ type: 'casualty', kind: 'altercation', lon: at.lon, lat: at.lat, protectedAsset: false });
        }
        // The winner is released rather than removed: still alive, no longer an incident.
        this.units.releaseIncidentUnit(p.index);
        this.close(false);
        return;
      }

      if (p.role === 'assassin' || p.role === 'insurgent') {
        // The mark is taken. An insurgency ends the same way — the first of the cell to arrive is
        // enough — and the rest of the cell is pulled with it.
        const victim = live.victim;
        if (victim !== undefined && this.units.isAlive(victim)) {
          const at = this.units.positionOf(victim);
          this.units.killQuietly(victim);
          if (at) {
            this.hooks.on({ type: 'casualty', kind: live.def.kind, lon: at.lon, lat: at.lat, protectedAsset: true });
          }
        }
        for (const m of live.members) this.units.removeIncidentUnit(m);
        this.close(false);
        return;
      }
    }

    // A killing of a specific mark ends the moment that mark is gone for any reason.
    if (
      (live.def.kind === 'assassination' || live.def.kind === 'insurgency') &&
      live.victim !== undefined &&
      !this.units.isAlive(live.victim)
    ) {
      for (const m of live.members) this.units.removeIncidentUnit(m);
      this.close(false);
    }
  }

  private close(clean: boolean): void {
    const kind = this.live?.def.kind;
    this.live = null;
    this.timer = this.interval();
    if (kind) this.hooks.on({ type: 'resolved', kind, clean });
  }

  /** Stand everything down — theater exit. */
  cancel(): void {
    this.units.clearIncidents();
    this.live = null;
    this.timer = FIRST_INCIDENT_S;
  }
}

/** The radius a participant has to reach before its clock starts. */
export const INCIDENT_CONTACT_M = INCIDENT.contactM;
