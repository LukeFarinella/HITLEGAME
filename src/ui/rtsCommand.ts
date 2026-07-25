import { STRUCTURES, BUILDABLE, type StructureType } from '../game/rts/structures';

/**
 * The RTS build command bar — a StarCraft-style row of build chips along the bottom of a match.
 *
 * Deliberately dumb: it renders one chip per buildable structure with its cost and hotkey, greys the
 * ones you can't afford, highlights whichever you're currently placing, and calls back to the scene.
 * All the real work — the placement ghost, the legality tests, spending the money — lives in the
 * scene, which owns the terrain and the money. This is just the menu.
 */

export interface RtsCommandHooks {
  /** Current spendable money, so chips can grey out what you can't afford. */
  money(): number;
  /** A build chip was chosen — the scene enters placement mode for this type. */
  onBuild(type: StructureType): void;
  /** Which type is currently being placed, if any — the chip for it reads as armed. */
  placing(): StructureType | null;
}

export class RtsCommandBar {
  private root: HTMLElement;

  constructor(private hooks: RtsCommandHooks) {
    this.root = document.getElementById('g-rts-cmd')!;
  }

  show(): void {
    this.root.removeAttribute('hidden');
    this.render();
  }

  hide(): void {
    this.root.setAttribute('hidden', '');
    this.root.replaceChildren();
  }

  render(): void {
    const money = this.hooks.money();
    const placing = this.hooks.placing();
    this.root.replaceChildren(
      ...BUILDABLE.map((type) => {
        const def = STRUCTURES[type];
        const afford = money >= def.cost;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `grc-chip type-${type}${placing === type ? ' active' : ''}${afford ? '' : ' broke'}`;
        btn.title = `${def.name} — ${def.blurb}`;
        btn.innerHTML =
          `<span class="grc-key">${def.hotkey}</span>` +
          `<span class="grc-name">${def.name.replace(' FACILITY', '')}</span>` +
          `<span class="grc-cost">◈ ${def.cost}</span>`;
        // A chip is always clickable — trying to build something you can't afford should say so
        // (the scene toasts), not silently do nothing, so the player learns the price.
        btn.addEventListener('click', () => this.hooks.onBuild(type));
        return btn;
      }),
    );
  }
}
