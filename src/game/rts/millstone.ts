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
    return out;
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
