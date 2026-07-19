/**
 * The loading screen.
 *
 * Two things happen behind this overlay and both of them take real time: surveying 115k obelisk
 * sites into ownable territory, and baking a 200-mile theater out of elevation tiles, road vectors
 * and 24,000 units. Neither is instant, and showing a half-built world while it happens is worse
 * than showing nothing — a map that pops into existence in pieces reads as broken rather than as
 * loading.
 *
 * So the transition is gated: the overlay goes up, the work runs, and the world is only revealed
 * once what the operator can actually interact with is ready.
 *
 * The stage line is real, not decorative. Every string passed to {@link setStage} corresponds to a
 * step that genuinely just finished, which is what makes a fifteen-second wait tolerable — the
 * operator can see it moving, and if it stalls they can see WHERE it stalled.
 */

/**
 * How-to-play lines, shown one at a time along the bottom.
 *
 * These carry most of this game's onboarding. There is no tutorial and the rules are not guessable
 * — that a scan line vanishing means an investigation has gone dark, or that protected contacts are
 * a trap with the worst charge sheets on the board, are things nothing on screen says out loud.
 * A loading screen is the one moment the operator is doing nothing else.
 */
const TIPS: string[] = [
  'Right-click any contact with a platform selected to see what it can do to them. Options you lack the hardware or the authority for are shown with the reason.',
  'You can order against anyone — including contacts the public would never accept as a target. Nothing stops you. Resistance is what it costs.',
  'A scan line runs from whatever is actually watching a flagged contact. If the line vanishes, nobody is watching any more and the investigation has gone dark.',
  'Sensor coverage is where you can act. A contact outside every obelisk and drone envelope cannot be ordered against at all.',
  'Public tolerance sets the bar a case must clear before an order is uncontroversial. It rises as the chain progresses — early on, only an overwhelming case is tolerated.',
  'Protected contacts are company assets. They carry the heaviest charge sheets on the board and they are the most obviously guilty thing you will ever see. Burning one is expensive.',
  'Every contact has a record, and everyone has done something. A sheet full of petty infractions is not evidence of anything.',
  'The assessment is a probability, not a verdict. A 90% reading is wrong one time in ten, and you answer for the shot either way.',
  'Shift-click to queue waypoints. Click a waypoint you already placed to close the route into a patrol loop.',
  'Solid white is the leg being flown now. Dashed is queued. Red means the route carries a lethal order.',
  'Orders have a rescind window. Until the countdown finishes, nothing has happened and nothing is on the ledger.',
  'Obelisks are not passive. The more sites a state carries, the more often something walks out of the dark to pull one down.',
  'A site under attack sends up a distress pulse that reads at any zoom. Click the alert to fly the camera to it.',
  'An attacker can be detained instead of killed. Custody needs a detainment rig on a ground platform — and it never touches the mission ledger.',
  'Your home state garrison defends itself, once you have the authority for it.',
  'Area strikes do not distinguish. Everything inside the ring dies, and everyone in it who was not the target is collateral the public will hear about.',
  'Platforms shoot before the obelisk net does, so a drone you moved somewhere is a drone you will see fire.',
  'Infection concentrates in ground nothing watches. A fully covered theater goes quiet — which is not the same as being clean.',
  'Double-click a platform card to fly the camera to it.',
  'Marquee-select prefers your own platforms: if any friendly unit is inside the box, only friendlies are picked.',
  'Failing a tasking costs funding tokens and rolls the campaign back to where the tasking began.',
  'Losing too many sites in one theater fails the tasking outright. Sites stand back up when you re-enter.',
];

let host: HTMLElement | null = null;
let stageEl: HTMLElement | null = null;
let tipEl: HTMLElement | null = null;
let tipTimer = 0;
let tipOrder: number[] = [];
let tipAt = 0;

/** Fisher-Yates, so a session doesn't show the same three tips every time it loads. */
function shuffled(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextTip(): void {
  if (!tipEl) return;
  if (tipAt >= tipOrder.length) {
    tipOrder = shuffled(TIPS.length);
    tipAt = 0;
  }
  const text = TIPS[tipOrder[tipAt++]];
  // The first tip appears immediately. Fading out an empty line before showing anything meant the
  // loading screen opened with a blank space where the field note goes, for a quarter second.
  if (!tipEl.textContent) {
    tipEl.textContent = text;
    tipEl.classList.add('in');
    return;
  }
  // Thereafter: fade out, swap, fade in — a tip that snaps is read as a glitch.
  tipEl.classList.remove('in');
  window.setTimeout(() => {
    if (tipEl) {
      tipEl.textContent = text;
      tipEl.classList.add('in');
    }
  }, 260);
}

export interface LoadingOptions {
  /** Big line: what is being loaded. */
  title: string;
  /** Small line under it: which one. */
  subtitle?: string;
  /** Seconds each tip stays up. */
  tipSeconds?: number;
}

/** Raise the overlay. Safe to call when one is already up — it just re-labels it. */
export function showLoading(opts: LoadingOptions): void {
  if (!host) {
    host = document.createElement('div');
    host.id = 'g-loading';
    host.innerHTML =
      `<div class="gl-inner">` +
      `<div class="gl-mark">G<b>O</b>RGON</div>` +
      `<div class="gl-title"></div>` +
      `<div class="gl-sub"></div>` +
      `<div class="gl-bar"><span></span></div>` +
      `<div class="gl-stage">STANDING BY</div>` +
      `</div>` +
      `<div class="gl-tipwrap"><span class="gl-tiplabel">FIELD NOTE</span><p class="gl-tip"></p></div>`;
    document.body.append(host);
    stageEl = host.querySelector('.gl-stage');
    tipEl = host.querySelector('.gl-tip');
    tipOrder = shuffled(TIPS.length);
    tipAt = 0;
  }
  host.classList.remove('out');
  const t = host.querySelector('.gl-title');
  const s = host.querySelector('.gl-sub');
  if (t) t.textContent = opts.title;
  if (s) s.textContent = opts.subtitle ?? '';

  nextTip();
  window.clearInterval(tipTimer);
  tipTimer = window.setInterval(nextTip, (opts.tipSeconds ?? 7) * 1000);
}

/** Update the stage line. Called as each real step of the build completes. */
export function setStage(text: string): void {
  if (stageEl) stageEl.textContent = text;
}

/**
 * Drop the overlay.
 *
 * Fades rather than cuts, and the node is left in the DOM — the next load reuses it. A rebuilt
 * overlay would restart the tip rotation from a fresh shuffle every time, which in practice meant
 * seeing the same opening tip on every theater entry.
 */
export function hideLoading(): void {
  window.clearInterval(tipTimer);
  if (!host) return;
  host.classList.add('out');
}

/** Whether the overlay is currently covering the scene. */
export function isLoading(): boolean {
  return !!host && !host.classList.contains('out');
}
