/**
 * The console's voice — every cue synthesized at runtime, no audio assets.
 *
 * That matches how the rest of this project works (meshes, buildings, obelisks and icons are all
 * generated), but the real reason is control: the whole cue book is held to one aesthetic, and that
 * aesthetic lives here rather than in a sample library that might disagree.
 *
 * The palette, to sit under the "Midnight Protocol" score: MYSTERIOUS · DIGITAL · GLITCHY ·
 * MYSTIC-FUTURE. Where the old cues were soft sines through a mellow lowpass, these lean on the
 * synthesis tricks that read as "machine":
 *
 *   - FM  — a modulator bent into a carrier's frequency, for the inharmonic, glassy, bell-metal
 *           timbres that acoustic instruments can't make. This is most of the "future" character.
 *   - RING modulation — two tones multiplied, throwing metallic sum/difference sidebands. Alien,
 *           computerised, faintly wrong in a good way. The laser and the refusals live on it.
 *   - BIT-CRUSH — a quantising waveshaper on a dedicated bus. Amplitude is rounded to a handful of
 *           steps, so anything routed through it gains that lo-fi digital grit and edge.
 *   - NOISE — filtered white noise for data-bursts, air, and impacts. Swept bandpass = "transmission".
 *   - STUTTER — a grain retriggered a few times with a pitch step, the classic glitch artefact.
 *   - SPACE — one procedural reverb (exp-decay noise impulse), sent to sparingly, for the mystique.
 *
 * Everything still obeys two hard rules so nothing ever hurts: soft attacks + exponential releases
 * (nothing clicks on or off), and a master limiter after the buses (no stacked cue can spike).
 */

const SAVE_KEY = 'gorgon.sound.v1';
/** Master level. Everything below is written relative to this, so one number moves the whole mix. */
const MASTER = 0.5;
/** Hover fires on every pointer crossing; without a floor it can machine-gun. */
const HOVER_THROTTLE_MS = 45;

/** Which bus a voice feeds: the clean path, or the bit-crushed digital-grit path. */
type Bus = 'dry' | 'grit';

interface ToneOpts {
  freq: number;
  /** Glide the pitch to here over the note (exponential). Used for zaps and swells. */
  to?: number;
  type?: OscillatorType;
  at?: number;
  dur?: number;
  gain?: number;
  /** Cents of detune — a few cents on a doubled voice gives the shimmering "beating" width. */
  detune?: number;
  /** Slower attack for pads and swells; defaults to a near-instant transient. */
  attack?: number;
  /** FM: a modulator at freq*ratio bent into this carrier's frequency by `index` Hz. */
  fm?: { ratio: number; index: number; type?: OscillatorType };
  /** Ring modulation at this frequency. depth 1 = full (bipolar) ring; <1 blends carrier back in. */
  ring?: { freq: number; depth?: number };
  bus?: Bus;
  /** How much of this voice to send to the reverb, 0..1. */
  space?: number;
}

interface NoiseOpts {
  at?: number;
  dur?: number;
  gain?: number;
  filter?: BiquadFilterType;
  freq?: number;
  /** Sweep the filter to here over the note — a swept bandpass reads as a transmission/data burst. */
  to?: number;
  q?: number;
  bus?: Bus;
  space?: number;
}

interface StutterOpts {
  at?: number;
  times?: number;
  /** Seconds between grains. */
  step?: number;
  freq?: number;
  /** Pitch multiplier applied cumulatively per grain — <1 falls, >1 climbs. */
  drop?: number;
  gain?: number;
  type?: OscillatorType;
  bus?: Bus;
}

/** The toolkit handed to every cue: the buses to feed, plus the voice builders. */
interface Kit {
  tone(o: ToneOpts): void;
  noise(o: NoiseOpts): void;
  stutter(o: StutterOpts): void;
}

/** A cue is now a function that schedules its own voices — flexible enough for FM, ring and glitch. */
type Cue = (k: Kit) => void;

/**
 * The cue book. Each entry keeps the FUNCTION it always had (hover is tiny, denied is negative,
 * orderLethal is dark, success climbs, failure falls) — only the timbre moved to the digital palette.
 */
const CUES: Record<string, Cue> = {
  // --- interface ---------------------------------------------------------------------------
  // Fires on every button the pointer crosses: the quietest, shortest thing here. A single glassy
  // FM tick with a breath of ring shimmer.
  hover: (k) =>
    k.tone({ freq: 1180, dur: 0.05, gain: 0.03, type: 'sine', fm: { ratio: 3.5, index: 220 }, ring: { freq: 60, depth: 0.35 } }),

  // A crisp digital "select": an FM blip snapping down a touch, with a noise transient on the front.
  click: (k) => {
    k.noise({ dur: 0.02, gain: 0.03, filter: 'highpass', freq: 2600 });
    k.tone({ freq: 720, to: 560, dur: 0.09, gain: 0.07, type: 'sine', fm: { ratio: 2.01, index: 300 } });
    k.tone({ freq: 1440, dur: 0.05, gain: 0.025, type: 'triangle', bus: 'grit', at: 0.005 });
  },

  // Gaining something: an ascending trio of FM bells with a reverb bloom and a soft sub underneath.
  purchase: (k) => {
    k.tone({ freq: 55, dur: 0.26, gain: 0.05, type: 'sine' });
    k.tone({ freq: 330, dur: 0.22, gain: 0.06, fm: { ratio: 2, index: 260 }, space: 0.3 });
    k.tone({ freq: 495, at: 0.08, dur: 0.24, gain: 0.05, fm: { ratio: 2, index: 320 }, space: 0.4 });
    k.tone({ freq: 660, at: 0.16, dur: 0.34, gain: 0.045, fm: { ratio: 3, index: 380 }, space: 0.55 });
  },

  // A door not opening: two low detuned tones beating against each other, ring-soured and crushed.
  denied: (k) => {
    k.tone({ freq: 130, dur: 0.16, gain: 0.075, type: 'sawtooth', detune: 0, ring: { freq: 44, depth: 0.6 }, bus: 'grit' });
    k.tone({ freq: 123, at: 0.06, to: 92, dur: 0.22, gain: 0.06, type: 'sawtooth', ring: { freq: 37, depth: 0.6 }, bus: 'grit' });
  },

  // --- orders ------------------------------------------------------------------------------
  // Investigation: a questioning rise with a metallic FM edge and a little data-burst of noise.
  order: (k) => {
    k.tone({ freq: 392, dur: 0.1, gain: 0.07, fm: { ratio: 2.5, index: 240 } });
    k.tone({ freq: 588, at: 0.06, dur: 0.16, gain: 0.055, fm: { ratio: 2.5, index: 300 }, space: 0.28 });
    k.noise({ at: 0.02, dur: 0.09, gain: 0.02, filter: 'bandpass', freq: 1400, to: 3200, q: 6 });
  },

  // Move acknowledged: a unit answering an RMB waypoint. Two quick bright FM chirps climbing a
  // fourth — short, affirmative, unmistakably "moving", and distinct from the questioning INVESTIGATE
  // rise so a reposition never reads as an order against a contact.
  move: (k) => {
    k.tone({ freq: 660, dur: 0.06, gain: 0.06, type: 'sine', fm: { ratio: 2, index: 180 } });
    k.tone({ freq: 880, at: 0.05, dur: 0.09, gain: 0.05, type: 'sine', fm: { ratio: 2, index: 220 }, space: 0.2 });
  },

  // Execution order: same shape a register lower and far darker — a sub, a detuned FM growl, and a
  // reversed-feeling noise swell into the hit. Deliberately not a "nicer" sound.
  orderLethal: (k) => {
    k.tone({ freq: 41, dur: 0.34, gain: 0.07, type: 'sine' });
    k.tone({ freq: 82, dur: 0.26, gain: 0.06, type: 'sawtooth', detune: 8, ring: { freq: 55, depth: 0.5 }, fm: { ratio: 1.5, index: 90 }, bus: 'grit', space: 0.3 });
    k.noise({ dur: 0.3, gain: 0.03, filter: 'lowpass', freq: 240, to: 900, q: 1, space: 0.4 });
  },

  // Taking it back: the order cue in reverse — descending FM blips, quick.
  rescind: (k) => {
    k.tone({ freq: 588, dur: 0.08, gain: 0.055, fm: { ratio: 2.5, index: 260 } });
    k.tone({ freq: 392, at: 0.055, dur: 0.14, gain: 0.045, fm: { ratio: 2.5, index: 200 }, space: 0.25 });
  },

  // An order committing past its rescind window: one low FM bell, settled, with a long reverb tail.
  commit: (k) => {
    k.tone({ freq: 98, dur: 0.14, gain: 0.05, type: 'sine' });
    k.tone({ freq: 196, dur: 0.4, gain: 0.05, fm: { ratio: 2, index: 160 }, space: 0.6 });
  },

  // Directed energy: a fast downward FM glide under full ring modulation — the one true zap — with a
  // crushed noise sizzle riding it.
  laser: (k) => {
    k.tone({ freq: 1320, to: 220, dur: 0.2, gain: 0.075, type: 'sine', fm: { ratio: 1.5, index: 700 }, ring: { freq: 90, depth: 1 } });
    k.noise({ dur: 0.16, gain: 0.03, filter: 'bandpass', freq: 3400, to: 700, q: 3, bus: 'grit' });
  },

  // An obelisk taking a picture of somebody. A shutter, then the capacitor recharging: a hard
  // high-passed snap, a short square click on top of it, and a thin whine sweeping up underneath for
  // half a second. Quiet on purpose — this fires every few seconds in a developed network, so it has
  // to be legible without ever becoming the thing you are listening to.
  camera: (k) => {
    k.noise({ dur: 0.025, gain: 0.055, filter: 'highpass', freq: 4200 });
    k.tone({ freq: 2600, to: 1500, dur: 0.045, gain: 0.045, type: 'square' });
    k.tone({ freq: 140, to: 5400, dur: 0.5, gain: 0.012, type: 'sine', at: 0.04 });
  },

  // --- siege -------------------------------------------------------------------------------
  // Something walking at the net: two slow detuned pulses with a tremolo shimmer and reverb. Eerie,
  // meant to be noticed rather than to startle.
  alert: (k) => {
    for (const at of [0, 0.34]) {
      k.tone({ freq: 233, at, to: 208, dur: 0.3, gain: 0.075, type: 'triangle', detune: 9, attack: 0.05, ring: { freq: 7, depth: 0.4 }, space: 0.4 });
      k.tone({ freq: 466, at: at + 0.01, dur: 0.26, gain: 0.03, fm: { ratio: 2, index: 180 }, attack: 0.05, space: 0.5 });
    }
  },

  // A site coming down: a dark descending cascade, a sub drop, and a glitch stutter as it fails.
  lost: (k) => {
    k.tone({ freq: 330, dur: 0.24, gain: 0.08, type: 'triangle', fm: { ratio: 1.5, index: 200 } });
    k.tone({ freq: 208, at: 0.16, dur: 0.3, gain: 0.07, type: 'triangle', fm: { ratio: 1.5, index: 160 }, space: 0.3 });
    k.tone({ freq: 55, at: 0.3, to: 38, dur: 0.5, gain: 0.075, type: 'sine' });
    k.stutter({ at: 0.34, times: 5, step: 0.045, freq: 220, drop: 0.8, gain: 0.035, bus: 'grit' });
  },

  // An attack stopped: short, resolved, unremarkable — the expected outcome. A clean rising pair.
  stopped: (k) => {
    k.tone({ freq: 392, dur: 0.1, gain: 0.06, fm: { ratio: 2, index: 160 } });
    k.tone({ freq: 523, at: 0.06, dur: 0.18, gain: 0.05, fm: { ratio: 2, index: 200 }, space: 0.3 });
  },

  // --- taskings ----------------------------------------------------------------------------
  // A win: four FM bells climbing, shimmering into the reverb, on a soft sub bed.
  success: (k) => {
    k.tone({ freq: 65, dur: 0.5, gain: 0.045, type: 'sine' });
    const notes = [262, 349, 523, 698];
    notes.forEach((f, i) =>
      k.tone({ freq: f, at: i * 0.09, dur: 0.34 + i * 0.05, gain: 0.06 - i * 0.006, fm: { ratio: 2, index: 240 + i * 40 }, space: 0.3 + i * 0.12 }),
    );
  },

  // A loss: four notes falling, detuned and darker, over a crushed growl.
  failure: (k) => {
    k.tone({ freq: 82, dur: 0.6, gain: 0.05, type: 'sawtooth', ring: { freq: 30, depth: 0.4 }, bus: 'grit' });
    const notes = [392, 311, 247, 196];
    notes.forEach((f, i) =>
      k.tone({ freq: f, at: i * 0.13, dur: 0.34, gain: 0.075 - i * 0.008, type: 'triangle', detune: 7, fm: { ratio: 1.5, index: 140 }, space: 0.25 + i * 0.08 }),
    );
  },

  // --- navigation --------------------------------------------------------------------------
  // Into a theater: a powering-up swell — noise sweeping up, a rising sub, FM shimmer landing on a
  // held fifth. The "boot".
  enter: (k) => {
    k.noise({ dur: 0.42, gain: 0.035, filter: 'bandpass', freq: 300, to: 4200, q: 1.2, space: 0.4 });
    k.tone({ freq: 44, to: 110, dur: 0.4, gain: 0.06, type: 'sine' });
    k.tone({ freq: 220, at: 0.24, dur: 0.34, gain: 0.05, fm: { ratio: 2, index: 220 }, attack: 0.03, space: 0.5 });
    k.tone({ freq: 330, at: 0.3, dur: 0.36, gain: 0.04, fm: { ratio: 3, index: 260 }, attack: 0.03, space: 0.6 });
  },

  // Back out: a powering-down — descending sub and FM, noise sweeping the other way, a short glitch.
  exit: (k) => {
    k.noise({ dur: 0.3, gain: 0.03, filter: 'bandpass', freq: 3600, to: 500, q: 1.2, space: 0.3 });
    k.tone({ freq: 330, to: 165, dur: 0.3, gain: 0.05, fm: { ratio: 2, index: 200 }, space: 0.4 });
    k.tone({ freq: 88, to: 44, dur: 0.34, gain: 0.055, type: 'sine' });
    k.stutter({ at: 0.16, times: 3, step: 0.04, freq: 520, drop: 0.7, gain: 0.025, bus: 'grit' });
  },
};

export type CueName = keyof typeof CUES;

/** Quantising waveshaper: rounds amplitude to a few steps for lo-fi digital grit + a touch of drive. */
function crushCurve(levels = 8, drive = 1.6): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const driven = Math.tanh(x * drive);
    curve[i] = Math.round(driven * levels) / levels;
  }
  return curve;
}

class SoundBoard {
  private ctx: AudioContext | null = null;
  private _enabled = true;
  private lastHover = 0;

  // Buses, built once with the context.
  private dry: GainNode | null = null; // clean path
  private grit: GainNode | null = null; // -> waveshaper -> master (digital crush)
  private space: GainNode | null = null; // reverb send -> convolver -> master
  private noiseBuf: AudioBuffer | null = null;

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
   * Browsers refuse to start an AudioContext without a user gesture, so the context and its graph
   * are built lazily on the first cue and resumed opportunistically. play() before any interaction
   * is a no-op rather than an error.
   */
  private ensure(): boolean {
    if (!this._enabled) return false;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;
      const ac = new Ctor();
      this.ctx = ac;

      // Master: a limiter so no stack of glitchy transients can spike, then a gentle lowpass to keep
      // the bit-crush aliasing from ever getting harsh, then the master gain.
      const master = ac.createGain();
      master.gain.value = MASTER;
      const shelf = ac.createBiquadFilter();
      shelf.type = 'lowpass';
      shelf.frequency.value = 11000;
      shelf.Q.value = 0.5;
      const limiter = ac.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      limiter.connect(shelf);
      shelf.connect(master);
      master.connect(ac.destination);

      // Clean bus.
      this.dry = ac.createGain();
      this.dry.connect(limiter);

      // Digital-grit bus: everything here is amplitude-quantised.
      this.grit = ac.createGain();
      const crusher = ac.createWaveShaper();
      crusher.curve = crushCurve();
      crusher.oversample = 'none'; // keep the aliasing — that's the point
      const gritMakeup = ac.createGain();
      gritMakeup.gain.value = 0.7; // the shaper is hot; pull it back
      this.grit.connect(crusher);
      crusher.connect(gritMakeup);
      gritMakeup.connect(limiter);

      // One procedural reverb for space/mystique, fed by per-voice sends.
      this.space = ac.createGain();
      const verb = ac.createConvolver();
      verb.buffer = this.impulse(ac, 1.5, 3.4);
      const verbLevel = ac.createGain();
      verbLevel.gain.value = 0.9;
      this.space.connect(verb);
      verb.connect(verbLevel);
      verbLevel.connect(limiter);

      // One shared white-noise bed, reused by every noise voice.
      this.noiseBuf = this.whiteNoise(ac, 2);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx.state !== 'closed';
  }

  /** Exponential-decay noise impulse — a cheap, dense, slightly metallic reverb tail. */
  private impulse(ac: AudioContext, seconds: number, decay: number): AudioBuffer {
    const rate = ac.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ac.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  private whiteNoise(ac: AudioContext, seconds: number): AudioBuffer {
    const rate = ac.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ac.createBuffer(1, len, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  play(name: CueName): void {
    const cue = CUES[name];
    if (!cue || !this.ensure() || !this.ctx || !this.dry || !this.grit || !this.space) return;

    if (name === 'hover') {
      const now = performance.now();
      if (now - this.lastHover < HOVER_THROTTLE_MS) return;
      this.lastHover = now;
    }

    const ac = this.ctx;
    const t0 = ac.currentTime + 0.001;
    const busOf = (b: Bus | undefined): GainNode => (b === 'grit' ? this.grit! : this.dry!);

    const kit: Kit = {
      tone: (o) => {
        const start = t0 + (o.at ?? 0);
        const dur = o.dur ?? 0.15;
        const peak = o.gain ?? 0.06;

        const osc = ac.createOscillator();
        osc.type = o.type ?? 'sine';
        osc.frequency.setValueAtTime(o.freq, start);
        if (o.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), start + dur);
        if (o.detune) osc.detune.setValueAtTime(o.detune, start);

        // FM: a modulator bent into the carrier's frequency.
        let mod: OscillatorNode | null = null;
        if (o.fm) {
          mod = ac.createOscillator();
          mod.type = o.fm.type ?? 'sine';
          mod.frequency.setValueAtTime(o.freq * o.fm.ratio, start);
          const modGain = ac.createGain();
          modGain.gain.setValueAtTime(o.fm.index, start);
          mod.connect(modGain);
          modGain.connect(osc.frequency);
        }

        // Amplitude envelope: soft attack, exponential release, never quite to zero.
        const env = ac.createGain();
        const attack = o.attack ?? Math.min(0.012, dur * 0.3);
        env.gain.setValueAtTime(0.0001, start);
        env.gain.exponentialRampToValueAtTime(peak, start + attack);
        env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(env);

        // Ring modulation: multiply the enveloped carrier by a second oscillator (bipolar gain).
        let outNode: AudioNode = env;
        let ringOsc: OscillatorNode | null = null;
        if (o.ring) {
          const depth = o.ring.depth ?? 1;
          const ring = ac.createGain();
          ring.gain.setValueAtTime(1 - depth, start); // base carrier that survives; 0 => full ring
          ringOsc = ac.createOscillator();
          ringOsc.type = 'sine';
          ringOsc.frequency.setValueAtTime(o.ring.freq, start);
          const ringDepth = ac.createGain();
          ringDepth.gain.setValueAtTime(depth, start);
          ringOsc.connect(ringDepth);
          ringDepth.connect(ring.gain);
          env.connect(ring);
          outNode = ring;
        }

        outNode.connect(busOf(o.bus));
        if (o.space && this.space) {
          const send = ac.createGain();
          send.gain.setValueAtTime(o.space, start);
          outNode.connect(send);
          send.connect(this.space);
        }

        const stop = start + dur + 0.05;
        osc.start(start);
        osc.stop(stop);
        mod?.start(start);
        mod?.stop(stop);
        ringOsc?.start(start);
        ringOsc?.stop(stop);
      },

      noise: (o) => {
        if (!this.noiseBuf) return;
        const start = t0 + (o.at ?? 0);
        const dur = o.dur ?? 0.2;
        const peak = o.gain ?? 0.05;

        const src = ac.createBufferSource();
        src.buffer = this.noiseBuf;
        src.loop = true;

        const filter = ac.createBiquadFilter();
        filter.type = o.filter ?? 'bandpass';
        filter.frequency.setValueAtTime(o.freq ?? 1500, start);
        if (o.to !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), start + dur);
        filter.Q.value = o.q ?? 1;

        const env = ac.createGain();
        const attack = Math.min(0.01, dur * 0.3);
        env.gain.setValueAtTime(0.0001, start);
        env.gain.exponentialRampToValueAtTime(peak, start + attack);
        env.gain.exponentialRampToValueAtTime(0.0001, start + dur);

        src.connect(filter);
        filter.connect(env);
        env.connect(busOf(o.bus));
        if (o.space && this.space) {
          const send = ac.createGain();
          send.gain.setValueAtTime(o.space, start);
          env.connect(send);
          send.connect(this.space);
        }

        src.start(start);
        src.stop(start + dur + 0.05);
      },

      stutter: (o) => {
        const times = o.times ?? 4;
        const step = o.step ?? 0.03;
        const drop = o.drop ?? 0.85;
        let freq = o.freq ?? 440;
        for (let i = 0; i < times; i++) {
          kit.tone({
            freq,
            at: (o.at ?? 0) + i * step,
            dur: step * 0.6,
            gain: (o.gain ?? 0.05) * (1 - i / (times + 1)),
            type: o.type ?? 'square',
            bus: o.bus ?? 'grit',
          });
          freq *= drop;
        }
      },
    };

    cue(kit);
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
