import {
  TIERS,
  TIER_NAME,
  TIER_NOTE,
  campaignProgress,
  campaignWon,
  isComplete,
  missionsInTier,
  tierUnlocked,
  type MissionDef,
  type MissionTier,
} from '../game/rts/campaign';
import { sound } from './sound';

/**
 * The operations board — the screen between the save slot and a match.
 *
 * It is a LIST, not a map. A globe with seventeen pins on it would be prettier and would make the
 * one decision the player is here to make (which of these do I take next) harder to read: the
 * interesting information is what is cleared, what is open, and what is still behind a phase, and
 * that is three columns of text.
 *
 * The phase gate is drawn rather than hidden. A locked phase still shows every mission in it, dimmed,
 * with the condition that opens it — you should be able to see the whole campaign from mission one
 * and know exactly how much of it is left.
 */

export interface CampaignHooks {
  /** Deploy to a mission. The board tears itself down first. */
  onDeploy(m: MissionDef): void;
  /** Back to the title screen (and out of the save slot). */
  onExit(): void;
}

const ID = 'g-campaign-board';

let hooks: CampaignHooks | null = null;
let slotNo = 0;

/** Put the board up, replacing any copy already showing. */
export function showCampaignBoard(slot: number, h: CampaignHooks): void {
  hooks = h;
  slotNo = slot;
  document.getElementById(ID)?.remove();

  const back = document.createElement('div');
  back.id = ID;
  back.className = 'gc-back';
  back.innerHTML = `<div class="gt-vignette"></div>`;

  const inner = document.createElement('div');
  inner.className = 'gc-inner';
  back.append(inner);
  document.body.append(back);

  render();
}

export function hideCampaignBoard(): void {
  document.getElementById(ID)?.remove();
  hooks = null;
}

/** Whether the board is currently up — the scene checks this before treating Escape as its own. */
export function campaignBoardOpen(): boolean {
  return !!document.getElementById(ID);
}

function render(): void {
  const inner = document.querySelector(`#${ID} .gc-inner`);
  if (!inner) return;
  inner.innerHTML = '';

  const p = campaignProgress();
  const won = campaignWon();

  const head = document.createElement('div');
  head.className = 'gc-head';
  head.innerHTML =
    `<div class="gc-eyebrow">SENTINEL CONTRACT AUTHORITY · SLOT ${slotNo}</div>` +
    `<h1 class="gc-title">OPERATIONS BOARD</h1>` +
    `<div class="gc-bar"><span style="width:${Math.round((p.done / p.total) * 100)}%"></span></div>` +
    `<div class="gc-count">${p.done} / ${p.total} THEATERS HELD${won ? ' · CONTRACT COMPLETE' : ''}</div>`;
  inner.append(head);

  if (won) inner.append(wonBanner());

  for (const tier of TIERS) inner.append(tierBlock(tier));

  const foot = document.createElement('div');
  foot.className = 'gc-foot';
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.className = 'gc-exit';
  exit.textContent = 'EXIT TO TITLE';
  exit.addEventListener('click', () => {
    sound.play('exit');
    // Read the hook BEFORE tearing down — hideCampaignBoard drops it, so calling it first means the
    // handler fires against null and the button silently does nothing.
    const h = hooks;
    hideCampaignBoard();
    h?.onExit();
  });
  foot.append(exit);
  inner.append(foot);
}

function wonBanner(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'gc-won';
  el.innerHTML =
    `<div class="gc-won-mark">CONTRACT COMPLETE</div>` +
    `<p class="gc-won-p">Every theater on the board is held. There is nothing left anywhere that ` +
    `Millstone still operates, and nothing left anywhere that isn't watched. Cleared theaters can be ` +
    `re-entered at will.</p>`;
  return el;
}

function tierBlock(tier: MissionTier): HTMLElement {
  const open = tierUnlocked(tier);
  const missions = missionsInTier(tier);
  const cleared = missions.filter((m) => isComplete(m.id)).length;

  const wrap = document.createElement('section');
  wrap.className = `gc-tier${open ? '' : ' locked'}`;
  wrap.innerHTML =
    `<div class="gc-tier-head">` +
    `<span class="gc-tier-name">${TIER_NAME[tier]}</span>` +
    `<span class="gc-tier-n">${open ? `${cleared} / ${missions.length}` : 'SEALED'}</span>` +
    `</div>` +
    `<div class="gc-tier-note">${TIER_NOTE[tier]}</div>`;

  const grid = document.createElement('div');
  grid.className = 'gc-grid';
  for (const m of missions) grid.append(missionCard(m, open));
  wrap.append(grid);
  return wrap;
}

function missionCard(m: MissionDef, open: boolean): HTMLElement {
  const done = isComplete(m.id);
  const card = document.createElement('button');
  card.type = 'button';
  card.className = `gc-card${done ? ' done' : ''}${open ? '' : ' locked'}`;
  card.disabled = !open;
  card.innerHTML =
    `<span class="gc-card-top">` +
    `<span class="gc-card-sub">${m.sub}</span>` +
    `<span class="gc-card-flag">${done ? 'HELD' : open ? 'OPEN' : 'SEALED'}</span>` +
    `</span>` +
    `<span class="gc-card-name">${m.name}</span>` +
    `<span class="gc-card-blurb">${m.blurb}</span>`;
  if (!open) return card;

  card.addEventListener('click', () => {
    sound.play('enter');
    // Same ordering trap as the exit button: hideCampaignBoard clears `hooks`, so grab it first.
    const h = hooks;
    hideCampaignBoard();
    h?.onDeploy(m);
  });
  return card;
}

/** Re-read the ladder and redraw, if the board is up. Called after a mission is marked complete. */
export function refreshCampaignBoard(): void {
  if (campaignBoardOpen()) render();
}
