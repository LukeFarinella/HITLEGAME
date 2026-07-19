import * as Cesium from 'cesium';
import { SIEGE, type UnitField } from './units';
import type { SensorField } from './sensors';
import type { PlatformId } from '../game/platforms';

/**
 * The siege director: infected attacks against the obelisk net.
 *
 * The net is not passive infrastructure. A field of obelisks is a provocation, and the more of them
 * a state carries the more often something walks out of the dark to pull one down — so the attack
 * rate scales with site count, and proliferating a state is a real cost as well as a capability.
 *
 * One attacker at a time, deliberately. It makes each attack a legible event with a single answer
 * rather than a swarm to be managed, and it means the reaction window (walk in, then
 * {@link SIEGE.assaultS} in contact) is the whole difficulty dial.
 *
 * An attacker is an ordinary infected foot contact — selectable, markable, and killable through the
 * normal execution path — so "laser the attacker" needed no special case. Detainment is the other
 * answer: a ground platform carrying a detainment rig takes it non-lethally, which works before
 * lethal authority has been granted and never touches the mission ledger.
 */

/**
 * Seconds between attacks, as a function of how many sites the theater carries. A downtown-tier
 * state is left largely alone; a fully proliferated one is under near-constant pressure.
 */
const ATTACK_INTERVAL_SCALE = 6000;
const ATTACK_INTERVAL_MIN = 25;
const ATTACK_INTERVAL_MAX = 400;
/** Grace period after entering a theater before the first attacker walks. */
const FIRST_ATTACK_S = 20;

/**
 * Attackers spawn in an annulus around their TARGET, not anywhere in the theater.
 *
 * Sampling the whole disc looked reasonable and was not: a 160 km-radius theater put the first
 * measured attacker 88 km from its objective, a 33-minute walk that would never have resolved into
 * anything the player saw. Bounding it at both ends is what makes the approach a predictable
 * 70–200 seconds — long enough to react to, short enough to be an event.
 */
const MIN_SPAWN_RANGE_M = 4_000;
const MAX_SPAWN_RANGE_M = 12_000;

export type SiegeEvent =
  | { type: 'inbound'; targetLocal: number }
  | { type: 'lost'; targetLocal: number; targetIndex: number }
  | { type: 'stopped'; how: 'detained' | 'serviced' };

export interface SiegeHooks {
  /** Global obelisk index for a site local to the current theater. */
  globalIndex(local: number): number;
  /** Which platforms carry a detainment rig right now. */
  detainers(): PlatformId[];
  /**
   * A point `minM`–`maxM` from (lon,lat) that no obelisk watches and isn't at sea, or null if the
   * target sits in coverage so dense there's nowhere dark to come from.
   */
  darkPointNear(
    lon: number,
    lat: number,
    minM: number,
    maxM: number,
  ): { lon: number; lat: number } | null;
  on(e: SiegeEvent): void;
}

export class SiegeDirector {
  private timer = FIRST_ATTACK_S;
  /** Marks the wreck of every site pulled down this theater. */
  readonly wrecks = new Cesium.PointPrimitiveCollection();

  constructor(
    private units: UnitField,
    private sensors: SensorField,
    private hooks: SiegeHooks,
  ) {}

  /** How long between attacks, given how much there is to attack. */
  private interval(): number {
    const n = Math.max(1, this.sensors.obeliskCount);
    return Math.min(ATTACK_INTERVAL_MAX, Math.max(ATTACK_INTERVAL_MIN, ATTACK_INTERVAL_SCALE / n));
  }

  /** True between launching an attacker and that attacker leaving the board, however it leaves. */
  private launched = false;

  /** Step the siege. Call once per frame, after the unit field has been ticked and rendered. */
  update(dt: number): void {
    const attacker = this.units.attacker();

    if (!attacker) {
      // An attacker we launched that is no longer on the board was killed by something else —
      // in practice a laser servicing it after the player marked it for execution. That path runs
      // entirely through the normal execution code, so this is where the director finds out.
      if (this.launched) {
        this.launched = false;
        this.units.clearAttacker();
        this.timer = this.interval();
        this.hooks.on({ type: 'stopped', how: 'serviced' });
        return;
      }
      // Nothing inbound: count down to the next one.
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = this.interval();
        this.launch();
      }
      return;
    }

    // A detainment rig takes the attacker the moment it's inside the platform's envelope. Checked
    // before the assault clock so a rig that arrives on the last second still saves the site.
    const detainer = this.units.detainableBy(this.hooks.detainers());
    if (detainer) {
      this.launched = false;
      this.units.clearAttacker();
      this.timer = this.interval();
      this.hooks.on({ type: 'stopped', how: 'detained' });
      return;
    }

    if (attacker.assaultS >= SIEGE.assaultS) {
      const targetIndex = this.hooks.globalIndex(attacker.local);
      this.launched = false;
      this.units.clearAttacker();
      this.timer = this.interval();
      this.hooks.on({ type: 'lost', targetLocal: attacker.local, targetIndex });
    }
  }

  /** Live attacker readout for the HUD. Null when nothing is inbound. */
  inbound() {
    return this.units.attacker();
  }

  private launch(): void {
    // Try a few sites: a target ringed by dense coverage has nowhere dark to be approached from,
    // and picking a different one is better than skipping the attack entirely.
    for (let pick = 0; pick < 6; pick++) {
      const target = this.sensors.randomSite();
      if (!target) return;
      const p = this.hooks.darkPointNear(
        target.lon,
        target.lat,
        MIN_SPAWN_RANGE_M,
        MAX_SPAWN_RANGE_M,
      );
      if (!p) continue;
      this.units.spawnAttacker(p.lon, p.lat, target);
      this.launched = true;
      this.hooks.on({ type: 'inbound', targetLocal: target.local });
      return;
    }
    // Nowhere to come from this cycle — try again on the next interval.
    this.timer = this.interval();
  }

  /** Drop a wreck marker on a site that came down, so the gap in the net is legible on the map. */
  markWreck(apex: Cesium.Cartesian3): void {
    this.wrecks.add({
      position: apex,
      color: Cesium.Color.fromCssColorString('#5E1610'),
      outlineColor: Cesium.Color.fromCssColorString('#E23A2E').withAlpha(0.8),
      outlineWidth: 2,
      pixelSize: 12,
      disableDepthTestDistance: 1e12,
    });
  }

  destroy(): void {
    this.wrecks.destroy();
  }
}
