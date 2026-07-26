/**
 * The background score — one authored, looping track for the menus and the world map.
 *
 * Unlike the interface cues (ui/sound.ts), which are synthesized note-by-note, this is a single MP3.
 * It runs on a plain HTMLAudioElement rather than through the WebAudio graph: it needs nothing the
 * graph offers here (no filtering, no per-note scheduling), and an `<audio loop>` is the least code
 * that loops seamlessly and fades cleanly.
 *
 * Two behaviours the rest of the app leans on:
 *   - VOLUME is the player's, saved across sessions (see the AUDIO panel). Fades are cosmetic and
 *     always ramp toward that stored level, never past it.
 *   - AUTOPLAY is gated by the browser: no sound before a user gesture. fadeIn() tries to play, and
 *     if it's blocked, arms a one-shot gesture listener so the score starts on the first click or
 *     keypress — which, at the title screen, is the START button.
 */

/**
 * Built off Vite's `base`, not a root-absolute path — a project-site host serves the app from a
 * subpath, where a leading slash would reach past the deployment and 404. Same reason
 * `obelisks.ts` resolves its binary this way.
 */
const SRC = `${import.meta.env.BASE_URL}music/midnight-protocol.mp3`;
/** Player's target volume, 0..1. */
const VOL_KEY = 'gorgon.music.vol.v1';
const DEFAULT_VOL = 0.55;
const FADE_MS = 1400;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

class Music {
  private el: HTMLAudioElement | null = null;
  private _vol = DEFAULT_VOL; // target level when audible, 0..1
  private want = false; // whether the score is meant to be audible right now
  private raf = 0; // active fade, if any
  private gesture: (() => void) | null = null; // pending autoplay-unblock listener

  constructor() {
    try {
      const s = localStorage.getItem(VOL_KEY);
      if (s !== null) this._vol = clamp01(parseFloat(s));
    } catch {
      // storage unavailable — default volume
    }
  }

  /** The player's target volume, 0..1. */
  get volume(): number {
    return this._vol;
  }

  /**
   * Set the player's target volume and persist it. Applied live: if the score is currently up, it
   * follows the slider immediately (the slider itself is the fade), and a level of 0 leaves the
   * element playing silently so nudging it back up resumes instantly without another gesture.
   */
  setVolume(v: number): void {
    this._vol = clamp01(v);
    try {
      localStorage.setItem(VOL_KEY, String(this._vol));
    } catch {
      // not fatal
    }
    if (this.want) {
      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
      const a = this.ensureEl();
      a.volume = this._vol;
      this.ensurePlaying();
    }
  }

  /** Bring the score up to the player's volume and keep it looping. Idempotent. */
  fadeIn(ms = FADE_MS): void {
    this.want = true;
    this.ensurePlaying();
    this.ramp(this._vol, ms);
  }

  /** Take the score down to silence, then pause it. Idempotent. */
  fadeOut(ms = FADE_MS): void {
    this.want = false;
    if (!this.el) return;
    this.ramp(0, ms, () => this.el?.pause());
  }

  private ensureEl(): HTMLAudioElement {
    if (!this.el) {
      const a = new Audio(SRC);
      a.loop = true;
      a.preload = 'auto';
      a.volume = 0;
      this.el = a;
    }
    return this.el;
  }

  private ensurePlaying(): void {
    const a = this.ensureEl();
    if (!a.paused) return;
    void a.play().then(
      () => this.disarm(),
      () => this.arm(), // blocked by autoplay policy — wait for a gesture
    );
  }

  private arm(): void {
    if (this.gesture) return;
    const go = () => {
      this.disarm();
      if (this.want) this.ensurePlaying();
    };
    this.gesture = go;
    window.addEventListener('pointerdown', go, { once: true, capture: true });
    window.addEventListener('keydown', go, { once: true, capture: true });
  }

  private disarm(): void {
    if (!this.gesture) return;
    window.removeEventListener('pointerdown', this.gesture, { capture: true });
    window.removeEventListener('keydown', this.gesture, { capture: true });
    this.gesture = null;
  }

  private ramp(target: number, ms: number, done?: () => void): void {
    const a = this.ensureEl();
    if (this.raf) cancelAnimationFrame(this.raf);
    const from = a.volume;
    const start = performance.now();
    const step = (now: number) => {
      const p = ms <= 0 ? 1 : Math.min(1, (now - start) / ms);
      a.volume = clamp01(from + (target - from) * p);
      if (p >= 1) {
        this.raf = 0;
        done?.();
        return;
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
}

export const music = new Music();
