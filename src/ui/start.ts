import { MISSIONS } from '../game/missions';
import { progression } from '../game/progression';
import type { StateTerritory, Territory } from '../game/territory';
import { icon } from './icons';

/**
 * The founding window: where this campaign starts.
 *
 * Shown once, before anything else is possible, and it can't be dismissed — the game has no
 * meaningful state until a home has been picked, so there is nothing to dismiss it to. The choice
 * is one of the ten headline economies, and it matters: the state you found in is the one you get
 * for free at downtown tier, and its site count decides how much network you inherit versus how
 * much you have to buy.
 *
 * The opening brief runs alongside the choice rather than after it, so the operator knows what
 * they're being hired to do before they pick where to do it.
 */

const fmt = new Intl.NumberFormat('en-US');

export interface StartHooks {
  /** A home was chosen — the scene re-reads ownership and flies there. */
  onChosen(state: StateTerritory): void;
}

export function showStartWindow(territory: Territory, hooks: StartHooks): void {
  if (document.getElementById('c2-start')) return;

  const trial = MISSIONS[0];
  const back = document.createElement('div');
  back.className = 'c2-modal-back';
  back.id = 'c2-start';

  const box = document.createElement('div');
  box.className = 'c2-modal c2-start';

  box.innerHTML =
    `<div class="c2-modal-head">` +
    `<span class="c2-name">${icon('surveil')}FOUNDING DEPLOYMENT</span>` +
    `<span class="c2-order order-investigate">TRIAL</span>` +
    `</div>` +
    trial.briefing
      .split('\n\n')
      .map((para) => `<p class="c2-modal-p">${para}</p>`)
      .join('') +
    `<p class="c2-modal-p c2-start-ask">Choose the state this contract operates from. It is yours ` +
    `at downtown tier from the start — one site, one scout — and everything else has to be bought.</p>`;

  const grid = document.createElement('div');
  grid.className = 'c2-start-grid';

  let chosen: StateTerritory | null = null;
  const commit = document.createElement('button');

  for (const s of territory.headline) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'c2-start-card';
    card.innerHTML =
      `<span class="c2-start-rank">${s.gdpRank}</span>` +
      `<span class="c2-start-name">${s.name}</span>` +
      `<span class="c2-start-meta">${fmt.format(s.all.length)} sites · ${s.cityReps.length} cities</span>`;
    card.addEventListener('click', () => {
      chosen = s;
      for (const other of grid.querySelectorAll('.c2-start-card')) other.classList.remove('selected');
      card.classList.add('selected');
      commit.disabled = false;
      commit.textContent = `DEPLOY TO ${s.name.toUpperCase()}`;
    });
    grid.append(card);
  }
  box.append(grid);

  const actions = document.createElement('div');
  actions.className = 'c2-modal-actions';
  commit.type = 'button';
  commit.className = 'c2-buy';
  commit.disabled = true;
  commit.textContent = 'SELECT A STATE';
  commit.addEventListener('click', () => {
    if (!chosen || !progression.chooseHome(chosen.id)) return;
    back.remove();
    hooks.onChosen(chosen);
  });
  actions.append(commit);
  box.append(actions);

  back.append(box);
  // Deliberately no click-outside-to-close: there is no game behind this yet.
  document.body.append(back);
}
