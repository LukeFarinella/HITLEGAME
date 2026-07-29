import * as Cesium from 'cesium';
import { sound } from '../ui/sound';

/**
 * The battle mix — what a fight sounds like from wherever the camera happens to be.
 *
 * The cues themselves live in ui/sound; this decides WHETHER and HOW LOUD, which for combat is most
 * of the work. A theater is a 200-mile disc and a developed match fires dozens of weapons a second,
 * so the two failure modes are opposite and both bad: play everything and it is a screech, play one
 * per frame and a pitched battle sounds like one rifle.
 *
 * Three rules do the whole job:
 *
 *   DISTANCE   Every event is scaled by how far the camera is from it, and silenced past
 *              {@link FAR_M}. This is what "zoomed in enough" means in practice — at the altitude
 *              you arrive at, the far end is 300 km away and the theater is silent; descend toward
 *              a firefight and it comes up under you. Nothing needed a zoom LEVEL check: distance
 *              already is one.
 *   MERGING    Events of a kind are pooled per frame and played as a few voices, not all of them,
 *              with the level raised by the square root of the count. A volley of twenty is
 *              noticeably bigger than one shot and nowhere near twenty times louder — which is
 *              roughly how a real volley behaves, and exactly how a listenable one does.
 *   SPACING    Each kind holds a minimum gap between retriggers. Sustained fire at 60 fps would
 *              otherwise machine-gun a transient into a buzz.
 *
 * Panning comes free once positions are known, and it is worth more than it costs: it is how you
 * hear that the thing being shot is off to your left before you have found it on screen.
 */

export type CombatCue = 'shot' | 'shotHeavy' | 'clash' | 'launch' | 'boom' | 'boomBig' | 'wreck';

/** Inside this, an event is at full level. About a city block's worth of camera distance. */
const NEAR_M = 2_500;
/**
 * Past this, silence.
 *
 * 40 km is chosen against the theater, not out of the air: the disc is ~320 km across and the
 * camera arrives at ~350 km up, so on arrival nothing is audible. Combat fades in over the last
 * part of a descent, which is the point at which the individual machines are things you can see.
 */
const FAR_M = 40_000;

/** How many voices of one kind may sound in a single frame, however many events there were. */
const MAX_VOICES: Record<CombatCue, number> = {
  shot: 3,
  shotHeavy: 2,
  clash: 2,
  launch: 2,
  boom: 2,
  boomBig: 2,
  wreck: 2,
};

/**
 * Minimum seconds between retriggers of a kind.
 *
 * Small arms get the shortest gap because a fast crackle IS what massed light weapons sound like;
 * explosions get the longest because two big booms on top of each other is one muddy boom.
 */
const MIN_GAP_S: Record<CombatCue, number> = {
  shot: 0.055,
  shotHeavy: 0.09,
  clash: 0.07,
  launch: 0.12,
  boom: 0.1,
  boomBig: 0.25,
  wreck: 0.12,
};

/** Ceiling on the summed level of one kind in one frame, so a huge volley cannot dominate. */
const MAX_GAIN: Record<CombatCue, number> = {
  shot: 1.5,
  shotHeavy: 1.6,
  clash: 1.3,
  launch: 1.5,
  boom: 2.0,
  boomBig: 2.4,
  wreck: 1.4,
};

/** Hard stereo is fatiguing and wrong for something you are looking down at. */
const PAN_WIDTH = 0.65;

interface Pending {
  /** Loudest-first, capped at MAX_VOICES entries. */
  best: { gain: number; pan: number }[];
  count: number;
}

export class CombatAudio {
  private readonly scene: Cesium.Scene;
  private pending = new Map<CombatCue, Pending>();
  private lastAt = new Map<CombatCue, number>();
  private clock = 0;
  /** Reused so the per-event projection doesn't allocate — this runs per shot, per frame. */
  private readonly scratch = new Cesium.Cartesian2();

  constructor(scene: Cesium.Scene) {
    this.scene = scene;
  }

  /** Advance the spacing clock. Call once at the top of the frame. */
  begin(dt: number): void {
    this.clock += dt;
  }

  /**
   * Report one combat event at a world position.
   *
   * Cheap enough to call unconditionally from the combat pass: an inaudible event costs one distance
   * compare and returns, which is the common case whenever the camera is not in the fight.
   */
  at(cue: CombatCue, pos: Cesium.Cartesian3): void {
    const d = Cesium.Cartesian3.distance(this.scene.camera.positionWC, pos);
    if (d >= FAR_M) return;

    // Squared falloff between near and far. Linear made the middle of the range too loud — most of a
    // descent sounded the same, so the approach had no shape to it.
    const t = Math.max(0, Math.min(1, (d - NEAR_M) / (FAR_M - NEAR_M)));
    const gain = (1 - t) * (1 - t);
    if (gain < 0.02) return;

    let pan = 0;
    const px = this.scene.cartesianToCanvasCoordinates(pos, this.scratch);
    if (px) {
      const w = this.scene.canvas.clientWidth || 1;
      pan = Math.max(-1, Math.min(1, (px.x / w) * 2 - 1)) * PAN_WIDTH;
    }

    let slot = this.pending.get(cue);
    if (!slot) this.pending.set(cue, (slot = { best: [], count: 0 }));
    slot.count++;
    // Keep only the loudest few. An insertion sort over a 3-element list beats sorting the whole
    // frame's events, and the nearest events are the ones worth hearing anyway.
    const cap = MAX_VOICES[cue];
    if (slot.best.length < cap) {
      slot.best.push({ gain, pan });
      slot.best.sort((a, b) => b.gain - a.gain);
    } else if (gain > slot.best[cap - 1].gain) {
      slot.best[cap - 1] = { gain, pan };
      slot.best.sort((a, b) => b.gain - a.gain);
    }
  }

  /** Play what the frame collected. Call once, after the combat pass. */
  flush(): void {
    for (const [cue, slot] of this.pending) {
      if (!slot.best.length) continue;
      const last = this.lastAt.get(cue) ?? -Infinity;
      if (this.clock - last < MIN_GAP_S[cue]) continue;
      this.lastAt.set(cue, this.clock);

      // sqrt(n) is the crowd law: doubling the number of sources adds about 3 dB, not 6. It is why
      // a volley reads as bigger without the mix falling over.
      const swell = Math.min(MAX_GAIN[cue] / slot.best[0].gain, Math.sqrt(slot.count));
      for (let i = 0; i < slot.best.length; i++) {
        const v = slot.best[i];
        // Voices after the first are the supporting cast — they exist to widen the event, not to
        // double its level.
        const share = i === 0 ? swell : 0.55;
        sound.play(cue, { gain: Math.min(MAX_GAIN[cue], v.gain * share), pan: v.pan });
      }
    }
    this.pending.clear();
  }

  /** Drop everything queued — used when a match ends mid-volley. */
  reset(): void {
    this.pending.clear();
    this.lastAt.clear();
  }
}
