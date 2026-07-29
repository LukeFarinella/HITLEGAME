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
    `<div class="gch-legend">` +
    `<span class="gch-key"><i class="k-open"></i>AVAILABLE</span>` +
    `<span class="gch-key"><i class="k-held"></i>HELD</span>` +
    `<span class="gch-key"><i class="k-locked"></i>SEALED</span>` +
    `</div>` +
    `<div class="gch-hint">SELECT A MARKER ON THE GLOBE</div>` +
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
export function showMissionBrief(m: MissionDef): void {
  hideMissionBrief();
  const held = isComplete(m.id);
  const open = tierUnlocked(m.tier);

  const card = document.createElement('div');
  card.id = BRIEF;
  card.className = `gmb${held ? ' held' : ''}${open ? '' : ' locked'}`;
  card.innerHTML =
    `<div class="gmb-top">` +
    `<span class="gmb-sub">${m.sub}</span>` +
    `<span class="gmb-flag">${held ? 'HELD' : open ? 'AVAILABLE' : 'SEALED'}</span>` +
    `</div>` +
    `<div class="gmb-name">${m.name}</div>` +
    `<p class="gmb-blurb">${m.blurb}</p>`;

  const actions = document.createElement('div');
  actions.className = 'gmb-actions';

  if (open) {
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
  } else {
    const why = document.createElement('div');
    why.className = 'gmb-why';
    why.textContent = TIER_NOTE[m.tier];
    actions.append(why);
  }

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
