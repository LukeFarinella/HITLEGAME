import {
  TIERS,
  TIER_NAME,
  TIER_NOTE,
  campaignProgress,
  campaignWon,
  creditFor,
  isComplete,
  missionsInTier,
  type MissionDef,
} from '../game/rts/campaign';
import { sound } from './sound';

/**
 * The operations HUD — the chrome around the mission markers on the globe.
 *
 * The mission LIST lives on the map now (see cesium/missionMarkers), so this is deliberately thin:
 * a header saying which phase you are in and how much of the contract is held, a legend for what
 * the arrow colours mean, and a brief that slides in when you select one. Everything that used to
 * be a grid of seventeen cards is a globe you can look at.
 *
 * Nothing here knows how to deploy — it raises {@link CampaignHooks.onDeploy} and the scene decides.
 */

export interface CampaignHooks {
  /** Deploy to a mission. */
  onDeploy(m: MissionDef): void;
  /** Back to the title screen (and out of the save slot). */
  onExit(): void;
}

const ID = 'g-campaign-hud';
const BRIEF = 'g-mission-brief';

let hooks: CampaignHooks | null = null;
let slotNo = 0;

/** Put the operations HUD up, replacing any copy already showing. */
export function showCampaignHud(slot: number, h: CampaignHooks): void {
  hooks = h;
  slotNo = slot;
  document.getElementById(ID)?.remove();

  const wrap = document.createElement('div');
  wrap.id = ID;
  document.body.append(wrap);
  render();
}

export function hideCampaignHud(): void {
  document.getElementById(ID)?.remove();
  document.getElementById(BRIEF)?.remove();
  hooks = null;
}

/** Whether the operations HUD is up — the scene checks this before treating a click as its own. */
export function campaignHudOpen(): boolean {
  return !!document.getElementById(ID);
}

/** Re-read the ladder and redraw. Called after a mission is marked complete. */
export function refreshCampaignHud(): void {
  if (campaignHudOpen()) render();
}

function currentPhase(): (typeof TIERS)[number] {
  return TIERS.find((t) => missionsInTier(t).some((m) => !isComplete(m.id))) ?? TIERS[TIERS.length - 1];
}

function render(): void {
  const wrap = document.getElementById(ID);
  if (!wrap) return;
  const p = campaignProgress();
  const won = campaignWon();
  const phase = currentPhase();
  const pct = Math.round((p.done / p.total) * 100);

  wrap.innerHTML =
    `<div class="gch-bar">` +
    `<div class="gch-eyebrow">SENTINEL CONTRACT AUTHORITY · SLOT ${slotNo}</div>` +
    `<div class="gch-phase">${won ? 'CONTRACT COMPLETE' : TIER_NAME[phase]}</div>` +
    `<div class="gch-note">${won ? 'Every theater is held. Cleared ground can be re-entered at will.' : TIER_NOTE[phase]}</div>` +
    `<div class="gch-track"><span style="width:${pct}%"></span></div>` +
    `<div class="gch-count">${p.done} / ${p.total} THEATERS HELD</div>` +
    `</div>` +
    // The legend used to explain arrow colours. There are no arrows: the interaction is the two
    // clicks, so that is what the chrome explains.
    `<div class="gch-legend">` +
    `<span class="gch-key"><i class="k-step"></i>CLICK GROUND TO SELECT IT</span>` +
    `<span class="gch-key"><i class="k-step armed"></i>CLICK THE AMBER AREA AGAIN TO DEPLOY</span>` +
    `</div>` +
    `<div class="gch-hint">LIT GROUND IS HELD · ANY GROUND CAN BE TAKEN</div>` +
    `<button type="button" class="gch-exit" id="gch-exit">EXIT TO TITLE</button>`;

  document.getElementById('gch-exit')?.addEventListener('click', () => {
    sound.play('exit');
    // Read the hook BEFORE tearing down — hideCampaignHud drops it, so calling it first means the
    // handler fires against null and the button silently does nothing.
    const h = hooks;
    hideCampaignHud();
    h?.onExit();
  });
}

/**
 * Show the brief for a selected marker.
 *
 * Bottom-centre, over the globe, so the thing you just clicked stays visible above it — a modal
 * here would hide the map the decision is being made on.
 */
export function showMissionBrief(m: MissionDef, armed = false): void {
  hideMissionBrief();
  // A free contract's own ground has never been fought over, but the rung it fills may already be
  // held — say so, because that changes whether the win is worth anything to the ladder.
  const held = isComplete(creditFor(m));

  const card = document.createElement('div');
  card.id = BRIEF;
  card.className = `gmb${held ? ' held' : ''}${m.free ? ' free' : ''}${armed ? ' armed' : ''}`;
  card.innerHTML =
    `<div class="gmb-top">` +
    `<span class="gmb-sub">${m.sub}</span>` +
    `<span class="gmb-flag">${armed ? 'SELECTED' : m.free ? 'OPEN GROUND' : held ? 'HELD' : 'AVAILABLE'}</span>` +
    `</div>` +
    `<div class="gmb-name">${m.name}</div>` +
    `<p class="gmb-blurb">${m.blurb}</p>` +
    // The second click is the whole interaction, so it is stated on the card rather than left for
    // the operator to discover. The button below does the same job for anyone who would rather press
    // a button than click a map.
    (armed ? `<p class="gmb-confirm">Click the highlighted area again to deploy.</p>` : '');

  const actions = document.createElement('div');
  actions.className = 'gmb-actions';

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'gmb-go';
  go.textContent = held ? 'REDEPLOY' : 'DEPLOY';
  go.addEventListener('click', () => {
    sound.play('enter');
    const h = hooks;
    const mission = m;
    hideMissionBrief();
    h?.onDeploy(mission);
  });
  actions.append(go);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'gmb-close';
  close.textContent = 'DISMISS';
  close.addEventListener('click', () => {
    sound.play('click');
    hideMissionBrief();
  });
  actions.append(close);

  card.append(actions);
  document.body.append(card);
}

export function hideMissionBrief(): void {
  document.getElementById(BRIEF)?.remove();
}

export function missionBriefOpen(): boolean {
  return !!document.getElementById(BRIEF);
}
