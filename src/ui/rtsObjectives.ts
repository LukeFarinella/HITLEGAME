import { OBJECTIVES, type ObjectiveDef, type ObjectiveId } from '../game/rts/objectives';

/**
 * The RTS objective panel — the chain, on the right, where the campaign's tasking list sits.
 *
 * Same side of the screen as the campaign's taskings on purpose: that is where this game has always
 * put "what you are supposed to be doing", and an RTS match having its own convention would just be
 * two conventions.
 *
 * It shows the NEXT few open objectives rather than all twelve. A wall of twelve is a manual; three
 * is an instruction, and the twelfth means nothing until the eleventh has happened anyway. Completed
 * ones collapse to a single tally so progress is still visible without the list growing forever.
 */
export class RtsObjectivePanel {
  private root: HTMLElement;
  /** How many open objectives to show at once. */
  private static readonly SHOWN = 3;

  constructor() {
    this.root = document.getElementById('g-rts-obj')!;
  }

  show(): void {
    this.root.removeAttribute('hidden');
  }

  hide(): void {
    this.root.setAttribute('hidden', '');
    this.root.replaceChildren();
  }

  /** Repaint from the set of completed ids. Cheap enough to call whenever something completes. */
  render(done: ReadonlySet<ObjectiveId>): void {
    const open = OBJECTIVES.filter((o) => !done.has(o.id));
    const head = document.createElement('div');
    head.className = 'gro-head';
    head.innerHTML =
      `<span class="gro-title">OBJECTIVES</span>` +
      `<span class="gro-count">${done.size} / ${OBJECTIVES.length}</span>`;

    const children: HTMLElement[] = [head];
    if (!open.length) {
      const el = document.createElement('div');
      el.className = 'gro-item gro-all';
      el.innerHTML = `<span class="gro-name">ALL OBJECTIVES CLEARED</span>`;
      children.push(el);
    }
    open.slice(0, RtsObjectivePanel.SHOWN).forEach((o, i) => children.push(this.item(o, i === 0)));
    this.root.replaceChildren(...children);
  }

  /** One row. The first open objective is the LIVE one and carries its instruction; the rest are next. */
  private item(o: ObjectiveDef, live: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = `gro-item${live ? ' live' : ''}`;
    el.title = o.hint;
    const bounty = o.bounty > 0 ? `<span class="gro-bounty">◈ ${o.bounty}</span>` : '';
    el.innerHTML =
      `<div class="gro-row"><span class="gro-name">${o.name}</span>${bounty}</div>` +
      // Only the live one spells out what to do. Showing three instructions at once turns the panel
      // back into a manual, which is the thing it exists to replace.
      (live ? `<div class="gro-hint">${o.hint}</div>` : '');
    return el;
  }
}
