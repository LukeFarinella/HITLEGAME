import type { PlatformId } from '../platforms';

/**
 * Millstone — the RTS opponent.
 *
 * A rival network with its own Nexus across the map, and a director that throws waves of hardware
 * at yours. Pure match state, like {@link ../rtsGame RtsGame}: it knows WHEN a wave goes out, WHAT
 * is in it, and how much of its Nexus is left — the scene owns spawning the units, marching them,
 * and every pixel. Keeping it a clock plus a health bar is deliberate: the enemy the player
 * experiences is the ARMY, and the army lives in the unit field where combat actually runs.
 *
 * The ramp is the whole difficulty curve, so it's all in one place here: waves grow by one
 * quadruped each time, pick up interceptor escorts from the third wave, and land a giga walker
 * every third wave from the sixth. There is no economy behind it — Millstone cheats, the way an
 * RTS AI on a timetable always cheats — because a fair economy the player never sees is
 * indistinguishable from a clock, and the clock is honest about what it is.
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
  kind: PlatformId;
  lon: number;
  lat: number;
  /** Garrison units stand their ground instead of marching on the player. */
  hold?: boolean;
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

  /** Seconds until the next wave leaves, for the HUD's threat clock. */
  get nextWaveS(): number {
    return Math.max(0, this.timer);
  }

  /** The standing guard at the enemy Nexus, spawned once when the match opens. */
  garrison(): WaveSpawn[] {
    return this.ring('dog', MILLSTONE.GARRISON, 500).map((s) => ({ ...s, hold: true }));
  }

  /**
   * Advance the wave clock. Returns the wave to field when one is due, else null. The scene calls
   * this every frame; a wave is a burst, not a stream.
   */
  tick(dt: number): WaveSpawn[] | null {
    if (this._hp <= 0) return null; // a razed base sends nothing
    this.timer -= dt;
    if (this.timer > 0) return null;
    this.timer = MILLSTONE.WAVE_EVERY_S;
    this.waveN++;

    const out: WaveSpawn[] = [];
    // The line: one more quadruped each wave, capped where a bigger number is just a longer chore.
    out.push(...this.ring('dog', Math.min(2 + this.waveN, 7), 700));
    // The escorts: interceptors join at wave 3 and grow slowly — standoff fire that punishes an
    // army built entirely out of short-armed dogs.
    if (this.waveN >= 3) out.push(...this.ring('interceptor', Math.min(Math.floor((this.waveN - 1) / 2), 4), 900));
    // The hammer: a giga every third wave from the sixth. If the match is still going by then,
    // the player has an army that can answer one — or a base that's about to learn.
    if (this.waveN >= 6 && this.waveN % 3 === 0) out.push(...this.ring('walker', 1, 400));
    return out;
  }

  /** `n` spawn points of a kind, scattered on a ring around the Nexus so a wave walks out as a group. */
  private ring(kind: PlatformId, n: number, radiusM: number): WaveSpawn[] {
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
