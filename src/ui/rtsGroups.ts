import { RTS_UNITS, type RtsUnitId } from '../game/rts/units';

/**
 * CONTROL GROUPS — the bar across the top of an RTS match.
 *
 * It replaces the per-unit roster chips that used to live here. Those listed every machine you
 * owned, which is the wrong unit of attention entirely: past a dozen units it was a wall of
 * near-identical chips, and nobody commands an army one machine at a time. A control group is what
 * you actually think in — "the line", "the air", "the siege" — and six of them fit where forty chips
 * did not.
 *
 * Ctrl + 1–6 assigns the current selection. 1–6 recalls it. Clicking a card does the same as
 * pressing its number, because a bar you cannot click is a bar that only works if you already knew
 * about it.
 *
 * Presentational only: the scene owns what is selected and what is in each group.
 */

export interface GroupCard {
  /** 1–6. */
  n: number;
  /** How many are still alive in it. Zero means the group emptied out and the card greys. */
  count: number;
  /** Composition, worst-first by count — what the group IS at a glance. */
  makeup: { unit: RtsUnitId; n: number }[];
  /** True when the current selection is exactly this group — the card reads as live. */
  active: boolean;
}

export interface RtsGroupHooks {
  cards(): GroupCard[];
  onPick(n: number): void;
}

/** Category accent, matching the command card and the unit card. */
const CAT_COLOR: Record<string, string> = {
  worker: '#B7BDC5',
  infantry: '#E7A13B',
  aerial: '#3FA0E0',
  naval: '#3F8FA0',
  special: '#8B6FE0',
};

export class RtsGroupBar {
  private root: HTMLElement;
  private signature = '';

  constructor(private hooks: RtsGroupHooks) {
    this.root = document.getElementById('g-rts-groups')!;
  }

  show(): void {
    this.root.removeAttribute('hidden');
    this.render();
  }

  hide(): void {
    this.root.setAttribute('hidden', '');
    this.root.replaceChildren();
    this.signature = '';
  }

  render(): void {
    const cards = this.hooks.cards();
    // Nothing assigned yet: one line telling you the gesture exists, rather than six empty boxes or
    // an unexplained blank strip.
    if (!cards.length) {
      const sig = 'empty';
      if (sig !== this.signature) {
        this.signature = sig;
        const hint = document.createElement('div');
        hint.className = 'grg-hint';
        hint.textContent = 'SELECT UNITS · CTRL + 1–6 TO ASSIGN A CONTROL GROUP';
        this.root.replaceChildren(hint);
      }
      return;
    }
    const sig = cards.map((c) => `${c.n}:${c.count}:${c.active ? 1 : 0}:${c.makeup.map((m) => m.unit + m.n).join('.')}`).join('|');
    if (sig === this.signature) return;
    this.signature = sig;
    this.root.replaceChildren(...cards.map((c) => this.card(c)));
  }

  private card(c: GroupCard): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `grg-card${c.active ? ' active' : ''}${c.count ? '' : ' empty'}`;
    // The accent is the group's DOMINANT category — an air group reads blue at a glance without
    // anybody reading the composition line under it.
    const top = c.makeup[0];
    const cat = top ? RTS_UNITS[top.unit].category : 'worker';
    btn.style.setProperty('--cat', CAT_COLOR[cat] ?? '#B7BDC5');
    btn.title = c.count
      ? `CONTROL GROUP ${c.n} — ${c.makeup.map((m) => `${m.n}× ${RTS_UNITS[m.unit].name}`).join(', ')}. Press ${c.n} to recall.`
      : `CONTROL GROUP ${c.n} — empty. Select units and press CTRL + ${c.n}.`;
    btn.innerHTML =
      `<span class="grg-n">${c.n}</span>` +
      `<span class="grg-body">` +
      `<span class="grg-count">${c.count}</span>` +
      `<span class="grg-makeup">${
        c.count ? c.makeup.map((m) => `${m.n}${RTS_UNITS[m.unit].name.charAt(0)}`).join(' ') : 'EMPTY'
      }</span>` +
      `</span>`;
    btn.addEventListener('click', () => this.hooks.onPick(c.n));
    return btn;
  }
}
