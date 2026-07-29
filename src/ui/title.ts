import { SLOT_COUNT, summariseAll, deleteSlot, type SlotSummary } from '../game/saves';
import { readCampaignRecord, TIER_NAME } from '../game/rts/campaign';
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
 * a glance — which phase of the ladder it is in and how many of the seventeen theaters it holds —
 * and deleting one asks twice, because there is no undo behind it.
 *
 * ONE button. There were two — a campaign and a separate RTS skirmish — and asking the player to
 * pick a game mode before they had seen either was a decision with nothing behind it. START GAME
 * opens the slot list, a slot opens the operations board, and the board is where the game starts.
 */

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
    // One way in. There used to be two buttons — a campaign and a separate RTS skirmish — which
    // asked the player to choose a game mode before they had seen either. The RTS match IS the game
    // now, so START GAME goes straight to the save slots and the slots go to the operations board.
    `<div class="gt-actions">` +
    `<button type="button" class="gt-start" id="gt-start">START GAME</button>` +
    `</div>` +
    `<div class="gt-slots" id="gt-slots" hidden></div>` +
    `</div>` +
    `<div class="gt-foot">PROTOTYPE BUILD · NO REAL PERSONS ARE DEPICTED</div>`;
  document.body.append(back);

  document.getElementById('gt-start')?.addEventListener('click', () => {
    sound.play('enter');
    const actions = document.querySelector('.gt-actions');
    const slots = document.getElementById('gt-slots');
    if (!actions || !slots) return;
    // The action buttons become the heading for the slot list rather than lingering above it.
    actions.remove();
    slots.hidden = false;
    renderSlots();
  });
}

function renderSlots(): void {
  const wrap = document.getElementById('gt-slots');
  if (!wrap) return;
  wrap.innerHTML = `<div class="gt-slots-head">SELECT CONTRACT</div>`;

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
  // The card is named after the CONTRACT, not the campaign's founding state — the ladder is the
  // progression now, so "how far through the seventeen" is the fact worth surfacing. A legacy save
  // with no ladder record still shows its founding state, which is all it has.
  const rec = readCampaignRecord(s.slot);
  const title = rec.won ? 'CONTRACT COMPLETE' : rec.started ? TIER_NAME[rec.phase] : homeName(s.homeState);
  open.innerHTML = s.empty
    ? `<span class="gt-slot-n">SLOT ${s.slot}</span>` +
      `<span class="gt-slot-title">NEW CONTRACT</span>` +
      `<span class="gt-slot-meta">Empty · no theaters assigned</span>`
    : `<span class="gt-slot-n">SLOT ${s.slot}</span>` +
      `<span class="gt-slot-title">${title}</span>` +
      `<span class="gt-slot-meta">` +
      // Deliberately only the ladder. Funding tokens belong to the pre-ladder campaign and are
      // per-match in a match, so a token count here was a number from a game the player isn't
      // playing.
      `${icon('surveil')}${rec.done}/${rec.total} THEATERS HELD</span>`;
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
