/**
 * The console's voice — every cue synthesized at runtime, no audio assets.
 *
 * That matches how the rest of this project works (meshes, buildings, obelisks and icons are all
 * generated), but the real reason is control: "subtle and easy listening" is a property of the
 * envelope and the spectrum, and synthesizing means every cue can be held to the same rules rather
 * than hoping a sample library agrees.
 *
 * The rules, applied to everything below:
 *   - Sines and triangles only. No square or sawtooth anywhere — they buzz.
 *   - Every note gets an attack and an exponential release, so nothing ever clicks on or off.
 *   - Everything runs through one gentle lowpass, so no cue can get bright and sharp.
 *   - Pitches come from a pentatonic set, so cues layered over each other can't sound wrong.
 *   - Quiet by default, and quietest for the cue that fires most (hover).
 */

/** A minor pentatonic — any subset of these sounds consonant together. */
const P = {
  A3: 220,
  C4: 261.63,
  D4: 293.66,
  E4: 329.63,
  G4: 392.0,
  A4: 440,
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  G5: 784.0,
  A5: 880,
};

interface Note {
  freq: number;
  /** Seconds from the start of the cue. */
  at?: number;
  dur?: number;
  gain?: number;
  type?: OscillatorType;
  /** Glide to this frequency over the note — used sparingly, for the laser and the alert. */
  to?: number;
}

type Cue = Note[];

/**
 * The cue book. Kept declarative so the sound design is legible and tunable in one place — every
 * entry is "which notes, when, how loud", and nothing here schedules anything itself.
 */
const CUES: Record<string, Cue> = {
  // --- interface ---------------------------------------------------------------------------
  // Fires on every button the pointer crosses, so it's the quietest and shortest thing here.
  hover: [{ freq: P.A5, dur: 0.045, gain: 0.035, type: 'sine' }],
  // A soft two-tone tick. Close intervals, so it reads as one event rather than a melody.
  click: [
    { freq: P.E5, dur: 0.06, gain: 0.075 },
    { freq: P.A5, at: 0.035, dur: 0.09, gain: 0.05 },
  ],
  // Rising fifth: the sound of gaining something.
  purchase: [
    { freq: P.D4, dur: 0.16, gain: 0.09, type: 'triangle' },
    { freq: P.A4, at: 0.075, dur: 0.24, gain: 0.075, type: 'triangle' },
    { freq: P.E5, at: 0.15, dur: 0.3, gain: 0.045 },
  ],
  // Two flat low notes — a door not opening. Never harsh, just unresonant.
  denied: [
    { freq: P.A3, dur: 0.1, gain: 0.07, type: 'triangle' },
    { freq: P.A3 * 0.94, at: 0.075, dur: 0.16, gain: 0.055, type: 'triangle' },
  ],

  // --- orders ------------------------------------------------------------------------------
  // Investigation: a questioning pair, rising and unresolved.
  order: [
    { freq: P.C5, dur: 0.09, gain: 0.07 },
    { freq: P.D5, at: 0.06, dur: 0.14, gain: 0.055 },
  ],
  // Execution order: same shape, a register lower and darker. Deliberately not a "nicer" sound.
  orderLethal: [
    { freq: P.A3, dur: 0.12, gain: 0.08, type: 'triangle' },
    { freq: P.C4, at: 0.07, dur: 0.2, gain: 0.06, type: 'triangle' },
  ],
  // Taking it back: the order cue in reverse.
  rescind: [
    { freq: P.D5, dur: 0.08, gain: 0.055 },
    { freq: P.G4, at: 0.055, dur: 0.14, gain: 0.045 },
  ],
  // An order committing past its rescind window. Single, settled, low.
  commit: [{ freq: P.G4, dur: 0.22, gain: 0.06, type: 'triangle' }],
  // Directed energy. The one glide in the set, falling and short.
  laser: [
    { freq: P.A5, to: P.A4, dur: 0.18, gain: 0.07 },
    { freq: P.A4, at: 0.02, to: P.A3, dur: 0.22, gain: 0.045, type: 'triangle' },
  ],

  // --- siege -------------------------------------------------------------------------------
  // Something is walking at the net. Two slow low pulses — meant to be noticed, not to startle.
  alert: [
    { freq: P.C4, to: P.A3, dur: 0.3, gain: 0.085, type: 'triangle' },
    { freq: P.C4, at: 0.36, to: P.A3, dur: 0.3, gain: 0.075, type: 'triangle' },
  ],
  // A site coming down: a slow fall through the scale.
  lost: [
    { freq: P.E4, dur: 0.24, gain: 0.09, type: 'triangle' },
    { freq: P.C4, at: 0.16, dur: 0.28, gain: 0.08, type: 'triangle' },
    { freq: P.A3, at: 0.34, dur: 0.5, gain: 0.07, type: 'triangle' },
  ],
  // An attack stopped. Short, resolved, unremarkable — this is the expected outcome.
  stopped: [
    { freq: P.G4, dur: 0.1, gain: 0.06 },
    { freq: P.C5, at: 0.06, dur: 0.18, gain: 0.05 },
  ],

  // --- taskings ----------------------------------------------------------------------------
  success: [
    { freq: P.C4, dur: 0.2, gain: 0.085, type: 'triangle' },
    { freq: P.E4, at: 0.09, dur: 0.24, gain: 0.075, type: 'triangle' },
    { freq: P.G4, at: 0.18, dur: 0.3, gain: 0.07, type: 'triangle' },
    { freq: P.C5, at: 0.27, dur: 0.42, gain: 0.055 },
  ],
  failure: [
    { freq: P.G4, dur: 0.22, gain: 0.085, type: 'triangle' },
    { freq: P.E4, at: 0.14, dur: 0.26, gain: 0.08, type: 'triangle' },
    { freq: P.C4, at: 0.28, dur: 0.34, gain: 0.075, type: 'triangle' },
    { freq: P.A3, at: 0.42, dur: 0.6, gain: 0.065, type: 'triangle' },
  ],

  // --- navigation --------------------------------------------------------------------------
  enter: [
    { freq: P.A3, dur: 0.3, gain: 0.07, type: 'triangle' },
    { freq: P.E4, at: 0.1, dur: 0.34, gain: 0.06, type: 'triangle' },
    { freq: P.A4, at: 0.2, dur: 0.4, gain: 0.045 },
  ],
  exit: [
    { freq: P.A4, dur: 0.24, gain: 0.055 },
    { freq: P.E4, at: 0.1, dur: 0.3, gain: 0.05, type: 'triangle' },
  ],
};

export type CueName = keyof typeof CUES;

const SAVE_KEY = 'gorgon.sound.v1';
/** Master level. Everything above is written relative to this, so one number moves the whole mix. */
const MASTER = 0.5;
/** Hover fires on every pointer crossing; without a floor it can machine-gun. */
const HOVER_THROTTLE_MS = 45;

class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private _enabled = true;
  private lastHover = 0;

  constructor() {
    try {
      const saved = localStorage.getItem(SAVE_KEY);
      if (saved !== null) this._enabled = saved === '1';
    } catch {
      // storage unavailable — default on
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(on: boolean): void {
    this._enabled = on;
    try {
      localStorage.setItem(SAVE_KEY, on ? '1' : '0');
    } catch {
      // not fatal
    }
    if (on) this.play('click');
  }

  /**
   * Browsers refuse to start an AudioContext without a user gesture, so the context is created
   * lazily on the first cue and resumed opportunistically. Calling play() before any interaction
   * is a no-op rather than an error.
   */
  private ensure(): boolean {
    if (!this._enabled) return false;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;
      this.ctx = new Ctor();
      // One shared lowpass: no cue can get brighter than this, whatever it asks for.
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2600;
      filter.Q.value = 0.6;
      this.master = this.ctx.createGain();
      this.master.gain.value = MASTER;
      filter.connect(this.master);
      this.master.connect(this.ctx.destination);
      // Voices connect to the filter, so keep a handle on it rather than the gain.
      this.bus = filter;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx.state !== 'closed';
  }

  private bus: BiquadFilterNode | null = null;

  play(name: CueName): void {
    const cue = CUES[name];
    if (!cue || !this.ensure() || !this.ctx || !this.bus) return;

    if (name === 'hover') {
      const now = performance.now();
      if (now - this.lastHover < HOVER_THROTTLE_MS) return;
      this.lastHover = now;
    }

    const t0 = this.ctx.currentTime + 0.001;
    for (const n of cue) {
      const start = t0 + (n.at ?? 0);
      const dur = n.dur ?? 0.12;
      const peak = n.gain ?? 0.06;

      const osc = this.ctx.createOscillator();
      osc.type = n.type ?? 'sine';
      osc.frequency.setValueAtTime(n.freq, start);
      if (n.to !== undefined) osc.frequency.exponentialRampToValueAtTime(n.to, start + dur);

      // Soft attack, exponential release. The ramp never reaches zero (exponential ramps can't),
      // hence the explicit stop and the tiny floor value.
      const env = this.ctx.createGain();
      const attack = Math.min(0.02, dur * 0.3);
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(peak, start + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, start + dur);

      osc.connect(env);
      env.connect(this.bus);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    }
  }
}

export const sound = new SoundBoard();

/**
 * Wire the interface cues once, by delegation.
 *
 * Every button in this app — store, tasking, dev panel, unit card — gets hover and click for free,
 * and nothing has to remember to opt in. Buttons that are disabled are skipped: a disabled control
 * makes no sound rather than a rejection noise, since it never claimed to be available.
 */
export function bindInterfaceSounds(): void {
  document.addEventListener(
    'pointerover',
    (e) => {
      const t = (e.target as HTMLElement | null)?.closest('button, .c2-member, .c2-tab');
      if (t && !(t as HTMLButtonElement).disabled) sound.play('hover');
    },
    { passive: true },
  );
  document.addEventListener(
    'click',
    (e) => {
      const t = (e.target as HTMLElement | null)?.closest('button, .c2-member');
      if (!t || (t as HTMLButtonElement).disabled) return;
      // Buying makes its own, more satisfying noise; everything else gets the tick.
      if (!t.classList.contains('c2-buy')) sound.play('click');
    },
    { passive: true },
  );
}
