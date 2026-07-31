import type { UnitKind } from '../../cesium/unitModels';

/**
 * Millstone — the RTS opponent.
 *
 * A rival network with its own Nexus across the map, and a director that throws waves of hardware
 * at yours. Pure match state, like {@link ../rtsGame RtsGame}: it knows WHEN a wave goes out, WHAT
 * is in it, and how much of its Nexus is left — the scene owns spawning the units, marching them,
 * and every pixel. Keeping it a clock plus a health bar is deliberate: the enemy the player
 * experiences is the ARMY, and the army lives in the unit field where combat actually runs.
 *
 * The ramp is the whole difficulty curve, so it's all in one place here — and it is now a ramp
 * through a ROSTER (see {@link ./millstoneUnits}) rather than through a headcount. Each rung
 * introduces a unit that asks the player a question the previous rung didn't:
 *
 *   1  rippers            can you kill a melee line before it arrives?
 *   2  + flensers         can you kill a FAST melee line before it arrives?
 *   3  + motes            are you looking up?
 *   4  + bulwarks         can you still hold a fixed position while it's being shelled?
 *   5  + shrikes, hulks   can you answer standoff fire, and something on the water?
 *   6  + leviathan        do you have an army, or a pile of units?
 *   8  + censers          ...and can it reach something at altitude that outranges all of it?
 *
 * There is no economy behind any of it — Millstone cheats, the way an RTS AI on a timetable always
 * cheats — because a fair economy the player never sees is indistinguishable from a clock, and the
 * clock is honest about what it is.
 */

export const MILLSTONE = {
  /** The enemy Nexus soaks this much. Roughly two waves' worth of your own army standing on it. */
  NEXUS_HP: 2600,
  /** Seconds of peace before the first wave — time to get an economy standing, not an army. */
  FIRST_WAVE_S: 150,
  /** Seconds between waves after that. */
  WAVE_EVERY_S: 85,
  /** Quadrupeds standing guard at the enemy Nexus from the opening. The assault has a cover charge. */
  GARRISON: 3,
  /** How far from the player's Nexus the enemy Nexus is seeded, ideally. Metres. */
  BASE_RANGE_M: 30_000,

  // ---- the base Millstone builds ---------------------------------------------------------------
  //
  // Millstone stopped being one building with a health bar. It now stands up an economy of its own,
  // with the same two questions the player answers with obelisks and data centers:
  //
  //   POWER   where may I build?   -> a generator (or the Nexus) projects it. Build outside every
  //                                   one of them and there is nowhere to put the thing.
  //   SUPPLY  how big may a wave be? -> residence blocks.
  //
  // Which makes the enemy base a thing you can TAKE APART rather than a thing you can only finish.
  // Levelling generators pins its footprint; levelling residences shrinks every wave after. Neither
  // is required to win — razing the Nexus still ends it — but both are now worth a raid, and a
  // player who only ever turtles gets the waves they did not go and prevent.
  /** Seconds between construction attempts. Slower than the wave clock: this is a slow squeeze. */
  BUILD_EVERY_S: 34,
  /** The first build happens this long in, so an opening raid finds a base worth raiding. */
  FIRST_BUILD_S: 45,
  /** How far a generator, or the Nexus, projects the right to build. */
  POWER_M: 2_600,
  /** Keep this much clear between its buildings, so a base is a compound and not a stack. */
  SPACING_M: 260,
  /**
   * Supply the Nexus opens with, and what each residence adds.
   *
   * Tuned so the cap BINDS. At 6 + 3x6 = 24 a fully-housed Millstone can just about field what the
   * ramp asks for by wave 9 (20 machines), which means every block the player levels comes straight
   * off the next wave. The first numbers tried were 8 + 6x6 = 44, and they were worthless: the cap
   * sat so far above the ramp that razing half the housing changed nothing at all, so a raid on the
   * enemy's economy was a raid the player was right to skip.
   */
  NEXUS_SUPPLY: 6,
  RESIDENCE_SUPPLY: 3,
  /** Ceilings, so a long match is a siege rather than a city. */
  MAX_GENERATORS: 5,
  MAX_RESIDENCES: 6,
  MAX_DEFENCES: 6,
};

/** What Millstone builds. Its own economy, plus the same two defences the player gets. */
export type EnemyBuild = 'generator' | 'residence' | 'turret' | 'flak';

/** One standing enemy building. The scene renders and damages these; the director owns the list. */
export interface EnemyStructure {
  id: number;
  type: EnemyBuild;
  lon: number;
  lat: number;
  hp: number;
  maxHp: number;
}

/** Hit points per enemy building — mirrors the player's equivalents closely enough to be fair. */
const ENEMY_HP: Record<EnemyBuild, number> = {
  generator: 620,
  residence: 540,
  turret: 550,
  flak: 500,
};

/** One unit the director wants fielded: what and where. The scene does the spawning. */
export interface WaveSpawn {
  kind: UnitKind;
  lon: number;
  lat: number;
  /** Garrison units stand their ground instead of marching on the player. */
  hold?: boolean;
  /**
   * Needs open water to exist at all. The director has no terrain, so it ASKS for a hull and lets
   * the scene find a sea for it — or quietly drop it, which is the right outcome for a landlocked
   * theater and costs Millstone nothing, since Millstone never paid for it.
   */
  naval?: boolean;
}

const mPerLat = 111_320;

export class MillstoneDirector {
  /** Where the enemy Nexus stands — a surveyed site the scene picked at match start. */
  readonly lon: number;
  readonly lat: number;
  readonly siteIndex: number;

  private _hp = MILLSTONE.NEXUS_HP;
  readonly maxHp = MILLSTONE.NEXUS_HP;

  /** Waves sent so far. Drives the ramp. */
  waveN = 0;
  private timer = MILLSTONE.FIRST_WAVE_S;

  constructor(site: { index: number; lon: number; lat: number }) {
    this.siteIndex = site.index;
    this.lon = site.lon;
    this.lat = site.lat;
  }

  get hp(): number {
    return Math.max(0, Math.ceil(this._hp));
  }

  get destroyed(): boolean {
    return this._hp <= 0;
  }

  /** Take a hit. Returns true on the hit that razes it — fire the victory exactly once. */
  damage(d: number): boolean {
    if (this._hp <= 0) return false;
    this._hp -= d;
    return this._hp <= 0;
  }

  /**
   * Seconds until the next wave leaves, for the HUD's threat clock.
   *
   * `pressure` divides it, so the clock the player reads is the clock they actually get rather than
   * the one they would get on calm ground.
   */
  nextWaveS(pressure = 1): number {
    return Math.max(0, this.timer / Math.max(0.01, pressure));
  }

  /** The standing guard at the enemy Nexus, spawned once when the match opens. */
  garrison(): WaveSpawn[] {
    return this.ring('ripper', MILLSTONE.GARRISON, 500).map((s) => ({ ...s, hold: true }));
  }

  /**
   * Advance the wave clock. Returns the wave to field when one is due, else null. The scene calls
   * this every frame; a wave is a burst, not a stream.
   *
   * `pressure` is how much faster the clock runs than real time — the public's anger at the player's
   * data centers, handed in by the scene (see {@link ./unrest}). Millstone is not simulating the
   * neighbourhood's politics; it is simply finding it easier to move through ground that has stopped
   * cooperating with the company, which is the same thing from the wave's point of view.
   */
  tick(dt: number, pressure = 1): WaveSpawn[] | null {
    if (this._hp <= 0) return null; // a razed base sends nothing
    this.timer -= dt * pressure;
    if (this.timer > 0) return null;
    this.timer = MILLSTONE.WAVE_EVERY_S;
    this.waveN++;

    const n = this.waveN;
    const out: WaveSpawn[] = [];
    // The line: one more ripper each wave, capped where a bigger number is just a longer chore.
    out.push(...this.ring('ripper', Math.min(2 + n, 7), 700));
    // The pursuit element, from wave 2. Flensers outrun anything the player can retreat with, so
    // this is the rung where "fall back and keep shooting" stops being a free answer.
    if (n >= 2) out.push(...this.ring('flenser', Math.min(Math.floor(n / 2), 3), 800));
    // Eyes overhead from wave 3 — cheap, and they die to any answer at all. The point is to find
    // out whether the player HAS an answer before the shrikes arrive.
    if (n >= 3) out.push(...this.ring('mote', Math.min(Math.floor((n - 1) / 2), 3), 900));
    // The artillery, from wave 4. Bulwarks are what stop a dug-in position being the whole game:
    // they shell the ground the player is holding and make holding it cost something.
    if (n >= 4) out.push(...this.ring('bulwark', Math.min(Math.floor((n - 2) / 2), 3), 750));
    // Standoff air, from wave 5 — rockets from outside the range of a short-armed ground line.
    if (n >= 5) out.push(...this.ring('shrike', Math.min(Math.floor((n - 3) / 2), 3), 1000));
    // A gun barge every other wave from the fifth, IF the theater has water. The scene drops it on
    // a landlocked map; a wave that quietly loses one hull is better than a hull stuck on a beach.
    if (n >= 5 && n % 2 === 1) out.push(...this.ring('hulk', 1, 600).map((s) => ({ ...s, naval: true })));
    // The hammer: a leviathan every third wave from the sixth. If the match is still going by then,
    // the player has an army that can answer one — or a base that's about to learn.
    if (n >= 6 && n % 3 === 0) out.push(...this.ring('leviathan', 1, 400));
    // The last rung. A censer outranges everything on the ground and arrives over the top of a line
    // built to face forward; by wave 8 the player either owns air defence or is about to want it.
    if (n >= 8) out.push(...this.ring('censer', 1, 1100));

    // SUPPLY is the cap, and it is what makes a residence block worth crossing the map to level.
    // The ramp above says what Millstone WANTS; this says what it can field. Trimmed from the end,
    // so the wave keeps its opening line and loses its luxuries — a player who has been razing
    // housing meets the same rippers with none of the artillery behind them.
    const cap = this.supplyCap();
    return out.length > cap ? out.slice(0, cap) : out;
  }

  // ---- the base ---------------------------------------------------------------------------------

  /** Everything Millstone has built. The Nexus is not in here — it is the director itself. */
  readonly structures: EnemyStructure[] = [];
  private nextId = 1;
  private buildTimer = MILLSTONE.FIRST_BUILD_S;

  /** Live buildings of a type. */
  private countOf(type: EnemyBuild): number {
    return this.structures.filter((s) => s.type === type && s.hp > 0).length;
  }

  /**
   * Where Millstone is allowed to build: its Nexus, and every generator still standing.
   *
   * This is the rule the player can act on. Every anchor is a building, every building can be
   * destroyed, and destroying the outermost one takes its whole circle of buildable ground with it.
   */
  powerAnchors(): { lon: number; lat: number }[] {
    const out = [{ lon: this.lon, lat: this.lat }];
    for (const s of this.structures) if (s.type === 'generator' && s.hp > 0) out.push({ lon: s.lon, lat: s.lat });
    return out;
  }

  /** Supply, and therefore how many machines a wave may contain. */
  supplyCap(): number {
    return MILLSTONE.NEXUS_SUPPLY + this.countOf('residence') * MILLSTONE.RESIDENCE_SUPPLY;
  }

  /**
   * What Millstone wants to build next, and roughly where — or null if it is not due, or full.
   *
   * The director proposes; the SCENE disposes. It has no terrain, so it cannot know whether the spot
   * is at sea or on a cliff — it offers candidate points around a power anchor and the scene picks
   * the first legal one and calls {@link place}. Same division as the waves, where the director asks
   * for a hull and lets the scene find it a sea.
   *
   * The order of preference is a build order: power first (nothing else can be placed without it),
   * then supply while waves are still small, then defences, then more supply. It reads as an
   * opponent that expands before it fortifies, which is what makes an early raid worth making.
   */
  planBuild(dt: number): { type: EnemyBuild; candidates: { lon: number; lat: number }[] } | null {
    if (this._hp <= 0) return null;
    this.buildTimer -= dt;
    if (this.buildTimer > 0) return null;
    this.buildTimer = MILLSTONE.BUILD_EVERY_S;

    const gens = this.countOf('generator');
    const res = this.countOf('residence');
    const def = this.countOf('turret') + this.countOf('flak');
    let type: EnemyBuild | null = null;
    if (gens < 1) type = 'generator';
    else if (res < 2) type = 'residence';
    else if (def < 2) type = def % 2 === 0 ? 'turret' : 'flak';
    else if (gens < MILLSTONE.MAX_GENERATORS && gens * 2 <= res) type = 'generator';
    else if (res < MILLSTONE.MAX_RESIDENCES) type = 'residence';
    else if (def < MILLSTONE.MAX_DEFENCES) type = def % 2 === 0 ? 'turret' : 'flak';
    if (!type) return null;

    // Candidates ringed around a random anchor. A generator reaches for the EDGE of the powered
    // circle, because its job is to extend it; everything else sits inside, where it is defended.
    const anchors = this.powerAnchors();
    const a = anchors[Math.floor(Math.random() * anchors.length)];
    const near = type === 'generator' ? 0.72 : 0.25;
    const far = type === 'generator' ? 0.95 : 0.7;
    const mLon = mPerLat * Math.cos((a.lat * Math.PI) / 180);
    const candidates: { lon: number; lat: number }[] = [];
    for (let i = 0; i < 14; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = MILLSTONE.POWER_M * (near + Math.random() * (far - near));
      candidates.push({ lon: a.lon + (Math.cos(ang) * r) / mLon, lat: a.lat + (Math.sin(ang) * r) / mPerLat });
    }
    return { type, candidates };
  }

  /** Commit a build the scene found legal ground for. */
  place(type: EnemyBuild, lon: number, lat: number): EnemyStructure {
    const s: EnemyStructure = { id: this.nextId++, type, lon, lat, hp: ENEMY_HP[type], maxHp: ENEMY_HP[type] };
    this.structures.push(s);
    return s;
  }

  /** Whether a point clears everything already standing, including the Nexus. */
  spacedFrom(lon: number, lat: number): boolean {
    const mLon = mPerLat * Math.cos((lat * Math.PI) / 180);
    const far = (blon: number, blat: number, gap: number): boolean =>
      Math.hypot((lon - blon) * mLon, (lat - blat) * mPerLat) >= gap;
    if (!far(this.lon, this.lat, 420)) return false;
    return this.structures.every((s) => s.hp <= 0 || far(s.lon, s.lat, MILLSTONE.SPACING_M));
  }

  /** Damage one of its buildings. Returns true on the hit that levels it. */
  damageStructure(id: number, d: number): boolean {
    const s = this.structures.find((x) => x.id === id);
    if (!s || s.hp <= 0) return false;
    s.hp -= d;
    if (s.hp > 0) return false;
    this.structures.splice(this.structures.indexOf(s), 1);
    return true;
  }

  /** `n` spawn points of a kind, scattered on a ring around the Nexus so a wave walks out as a group. */
  private ring(kind: UnitKind, n: number, radiusM: number): WaveSpawn[] {
    const out: WaveSpawn[] = [];
    const mLon = mPerLat * Math.cos((this.lat * Math.PI) / 180);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radiusM * (0.7 + Math.random() * 0.6);
      out.push({ kind, lon: this.lon + (Math.cos(a) * r) / mLon, lat: this.lat + (Math.sin(a) * r) / mPerLat });
    }
    return out;
  }
}
