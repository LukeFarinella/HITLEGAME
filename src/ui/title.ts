import { SLOT_COUNT, summariseAll, deleteSlot, type SlotSummary } from '../game/saves';
import type { Territory } from '../game/territory';
import { icon } from './icons';
import { sound } from './sound';

/**
 * The title screen and save-slot picker.
 *
 * This is the first thing the game is, so it does two jobs: it sets the tone before any mechanics
 * are visible, and it makes the campaign a THING the player owns rather than an implicit blob of
 * localStorage that the last session happened to leave behind.
 *
 * Three slots, because three is enough to keep a serious campaign, an experiment, and a fresh start
 * without turning the menu into file management. Each card shows enough to recognise a campaign at
 * a glance — where it was founded, how far the chain has gone, what it's worth — and deleting one
 * asks twice, because there is no undo behind it.
 */

const fmt = new Intl.NumberFormat('en-US');

export interface TitleHooks {
  /** A slot was opened. The campaign has been loaded by the time this fires. */
  onPlay(slot: number, summary: SlotSummary): void;
}

let hooks: TitleHooks | null = null;
let territoryRef: Territory | null = null;

/** The scene needs the survey to name a campaign's home state on its card. */
export function setTitleTerritory(t: Territory): void {
  territoryRef = t;
  // A card rendered before the survey landed says "SURVEYING" — refresh it now that it can't.
  if (document.getElementById('g-title-screen')) renderSlots();
}

function homeName(fips: string | null): string {
  if (!fips) return 'NOT YET FOUNDED';
  if (!territoryRef) return 'SURVEYING…';
  return territoryRef.byId.get(fips)?.name.toUpperCase() ?? 'UNKNOWN STATE';
}

/**
 * Show the title screen.
 *
 * Callable at any point — it's how "exit to title" gets back here — so it tears down any menu
 * already up and re-reads every slot from disk rather than trusting a cached summary.
 */
export function showTitle(h: TitleHooks): void {
  hooks = h;
  document.getElementById('g-title-screen')?.remove();

  const back = document.createElement('div');
  back.id = 'g-title-screen';
  back.innerHTML =
    `<div class="gt-vignette"></div>` +
    `<div class="gt-inner">` +
    `<div class="gt-eyebrow">SENTINEL CONTRACT AUTHORITY</div>` +
    `<h1 class="gt-mark">G<b>O</b>RGON</h1>` +
    `<div class="gt-sub">// SENTINEL C2</div>` +
    `<p class="gt-blurb">A private contractor has been retained to identify threats inside the ` +
    `civilian population. You are the operator. Everything you do here is on the record.</p>` +
    `<div class="gt-actions"><button type="button" class="gt-start" id="gt-start">START</button></div>` +
    `<div class="gt-slots" id="gt-slots" hidden></div>` +
    `</div>` +
    `<div class="gt-foot">PROTOTYPE BUILD · NO REAL PERSONS ARE DEPICTED</div>`;
  document.body.append(back);

  document.getElementById('gt-start')?.addEventListener('click', () => {
    sound.play('enter');
    const start = document.getElementById('gt-start');
    const slots = document.getElementById('gt-slots');
    if (!start || !slots) return;
    // The START button becomes the heading for the slot list rather than lingering above it.
    start.remove();
    slots.hidden = false;
    renderSlots();
  });
}

function renderSlots(): void {
  const wrap = document.getElementById('gt-slots');
  if (!wrap) return;
  wrap.innerHTML = `<div class="gt-slots-head">SELECT CAMPAIGN</div>`;

  for (const s of summariseAll()) {
    wrap.append(slotCard(s));
  }
}

function slotCard(s: SlotSummary): HTMLElement {
  const card = document.createElement('div');
  card.className = `gt-slot${s.empty ? ' empty' : ''}`;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'gt-slot-open';
  open.innerHTML = s.empty
    ? `<span class="gt-slot-n">SLOT ${s.slot}</span>` +
      `<span class="gt-slot-title">NEW CAMPAIGN</span>` +
      `<span class="gt-slot-meta">Empty · founding deployment not yet chosen</span>`
    : `<span class="gt-slot-n">SLOT ${s.slot}</span>` +
      `<span class="gt-slot-title">${homeName(s.homeState)}</span>` +
      `<span class="gt-slot-meta">` +
      `${icon('surveil')}${s.missionsComplete}/6 TASKINGS · ` +
      `${fmt.format(s.tokens)} TOKENS · ` +
      `${s.territories} ${s.territories === 1 ? 'TERRITORY' : 'TERRITORIES'}` +
      `</span>`;
  open.addEventListener('click', () => {
    sound.play('purchase');
    document.getElementById('g-title-screen')?.remove();
    hooks?.onPlay(s.slot, s);
  });
  card.append(open);

  if (!s.empty) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'gt-slot-del';
    del.title = `Delete campaign in slot ${s.slot}`;
    del.textContent = 'DELETE';
    // Two-step, in place. A confirm dialog for this would be dismissed on reflex; making the
    // button itself change into the confirmation forces the second click to be aimed.
    let armed = false;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        del.classList.add('armed');
        del.textContent = 'CONFIRM';
        window.setTimeout(() => {
          if (!armed) return;
          armed = false;
          del.classList.remove('armed');
          del.textContent = 'DELETE';
        }, 4000);
        return;
      }
      sound.play('denied');
      deleteSlot(s.slot);
      renderSlots();
    });
    card.append(del);
  }

  return card;
}

export { SLOT_COUNT };
