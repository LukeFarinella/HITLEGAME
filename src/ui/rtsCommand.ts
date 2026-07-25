import { STRUCTURES, BUILDABLE, type StructureType } from '../game/rts/structures';
import { RTS_UNITS, unitsFrom, type RtsUnitId } from '../game/rts/units';
import type { QueueItem } from '../game/rts/rtsGame';

/**
 * The RTS command card — a StarCraft-style bottom bar whose contents depend on what's selected.
 *
 *   worker selected      → BUILD chips (place a structure)
 *   producing building   → PRODUCE chips + the live build queue for that building
 *   anything else        → empty
 *
 * It stays deliberately presentational: it reads a CONTEXT the scene hands it and calls back. The
 * scene owns selection, money, the ghost and the queues; this just draws the menu and the progress.
 */

export type CommandContext =
  | { kind: 'none' }
  | { kind: 'build' }
  | { kind: 'produce'; structureId: number; structureType: StructureType };

export interface RtsCommandHooks {
  money(): number;
  /** Which menu to show right now, from the current selection. */
  context(): CommandContext;
  /** Structure type currently being placed, if any — its BUILD chip reads as armed. */
  placing(): StructureType | null;
  /** A BUILD chip was chosen (worker context). */
  onBuild(type: StructureType): void;
  /** A PRODUCE chip was chosen (building context). */
  onProduce(unit: RtsUnitId): void;
  /** The live queue at a producing structure, for the progress strip. */
  queueOf(structureId: number): QueueItem[];
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
    const ctx = this.hooks.context();
    if (ctx.kind === 'none') {
      this.root.replaceChildren();
      return;
    }
    if (ctx.kind === 'build') {
      this.renderBuild();
      return;
    }
    this.renderProduce(ctx.structureId, ctx.structureType);
  }

  /** Worker context: chips that place a structure. */
  private renderBuild(): void {
    const money = this.hooks.money();
    const placing = this.hooks.placing();
    const chips = BUILDABLE.map((type) => {
      const def = STRUCTURES[type];
      return this.chip({
        cls: `type-${type}${placing === type ? ' active' : ''}${money >= def.cost ? '' : ' broke'}`,
        hotkey: def.hotkey,
        name: def.name.replace(' FACILITY', ''),
        cost: def.cost,
        title: `${def.name} — ${def.blurb}`,
        onClick: () => this.hooks.onBuild(type),
      });
    });
    this.root.replaceChildren(this.label('BUILD'), ...chips);
  }

  /** Building context: chips that queue units, plus the live queue strip. */
  private renderProduce(structureId: number, structureType: StructureType): void {
    const money = this.hooks.money();
    const units = unitsFrom(structureType);
    const chips = units.map((u) =>
      this.chip({
        cls: `cat-${u.category}${money >= u.cost ? '' : ' broke'}`,
        hotkey: u.hotkey,
        name: u.name.replace(' DRONE', '').replace(' WALKER', ''),
        cost: u.cost,
        title: `${u.name} — ${u.buildTimeS}s · ${u.supply} supply`,
        onClick: () => this.hooks.onProduce(u.id),
      }),
    );
    const children: (HTMLElement | Node)[] = [this.label(STRUCTURES[structureType].name.replace(' FACILITY', '')), ...chips];
    const queue = this.hooks.queueOf(structureId);
    if (queue.length) children.push(this.queueStrip(queue));
    this.root.replaceChildren(...children);
  }

  private label(text: string): HTMLElement {
    const el = document.createElement('span');
    el.className = 'grc-label';
    el.textContent = text;
    return el;
  }

  private chip(o: {
    cls: string;
    hotkey: string;
    name: string;
    cost: number;
    title: string;
    onClick: () => void;
  }): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `grc-chip ${o.cls}`;
    btn.title = o.title;
    btn.innerHTML =
      `<span class="grc-key">${o.hotkey}</span>` +
      `<span class="grc-name">${o.name}</span>` +
      `<span class="grc-cost">◈ ${o.cost}</span>`;
    btn.addEventListener('click', o.onClick);
    return btn;
  }

  /** A compact strip of the queued units with a progress bar on the one currently building. */
  private queueStrip(queue: QueueItem[]): HTMLElement {
    const box = document.createElement('div');
    box.className = 'grc-queue';
    queue.forEach((item, i) => {
      const cell = document.createElement('div');
      cell.className = 'grc-qitem';
      const pct = i === 0 ? Math.round((1 - item.remainingS / item.totalS) * 100) : 0;
      cell.innerHTML =
        `<span class="grc-qname">${RTS_UNITS[item.unit].name.charAt(0)}</span>` +
        `<span class="grc-qbar"><i style="width:${pct}%"></i></span>`;
      box.append(cell);
    });
    return box;
  }
}
