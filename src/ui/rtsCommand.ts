import { STRUCTURES, BUILDABLE, type StructureType } from '../game/rts/structures';
import { RTS_UNITS, unitsFrom, type RtsUnitId } from '../game/rts/units';
import { researchFrom, type ResearchId } from '../game/rts/research';
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
  /** A tech-tree reason this structure can't be built yet, or null. Locks the chip. */
  buildBlocker(type: StructureType): string | null;
  /** A tech-tree reason this unit can't be built yet, or null. Locks the chip. */
  produceBlocker(unit: RtsUnitId): string | null;
  /** A research project was chosen at the selected building. */
  onResearch(id: ResearchId): void;
  /** A reason a research can't start (done / in progress / cost), or null. */
  researchBlocker(id: ResearchId): string | null;
  /** Research in progress at a structure, for the progress strip. */
  researchProgress(structureId: number): { id: ResearchId; pct: number } | null;
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
      const locked = this.hooks.buildBlocker(type);
      return this.chip({
        cls: `type-${type}${placing === type ? ' active' : ''}${locked ? ' locked' : money >= def.cost ? '' : ' broke'}`,
        hotkey: def.hotkey,
        name: def.name.replace(' FACILITY', ''),
        cost: def.cost,
        locked,
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
    const chips = units.map((u) => {
      const locked = this.hooks.produceBlocker(u.id);
      return this.chip({
        cls: `cat-${u.category}${locked ? ' locked' : money >= u.cost ? '' : ' broke'}`,
        hotkey: u.hotkey,
        name: u.name.replace(' WALKER', ''),
        cost: u.cost,
        locked,
        title: `${u.name} — ${u.buildTimeS}s · ${u.supply} supply`,
        onClick: () => this.hooks.onProduce(u.id),
      });
    });
    // Research chips (the Tech facility): an upgrade the building works on instead of a unit.
    const research = researchFrom(structureType).map((r) => {
      const blocked = this.hooks.researchBlocker(r.id);
      const locked = blocked === 'DONE' ? '✓ DONE' : blocked === 'IN PROGRESS' ? '◷ …' : null;
      return this.chip({
        cls: `cat-research${blocked && blocked !== 'INSUFFICIENT FUNDS' ? ' locked' : money >= r.cost ? '' : ' broke'}`,
        hotkey: r.hotkey,
        name: r.name,
        cost: r.cost,
        locked,
        title: `${r.name} — ${r.blurb}`,
        onClick: () => this.hooks.onResearch(r.id),
      });
    });

    const children: (HTMLElement | Node)[] = [
      this.label(STRUCTURES[structureType].name.replace(' FACILITY', '')),
      ...chips,
      ...research,
    ];
    const queue = this.hooks.queueOf(structureId);
    if (queue.length) children.push(this.queueStrip(queue));
    const rp = this.hooks.researchProgress(structureId);
    if (rp) children.push(this.researchStrip(rp.pct));
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
    locked?: string | null;
    title: string;
    onClick: () => void;
  }): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `grc-chip ${o.cls}`;
    btn.title = o.locked ? `${o.title} — LOCKED: ${o.locked}` : o.title;
    // A locked chip shows the tech-tree requirement in place of its price, so the chain reads off
    // the command bar itself.
    const foot = o.locked ? `<span class="grc-lock">🔒 ${o.locked}</span>` : `<span class="grc-cost">◈ ${o.cost}</span>`;
    btn.innerHTML = `<span class="grc-key">${o.hotkey}</span><span class="grc-name">${o.name}</span>${foot}`;
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

  /** A single progress bar for the research currently running. */
  private researchStrip(pct: number): HTMLElement {
    const box = document.createElement('div');
    box.className = 'grc-queue';
    box.innerHTML = `<div class="grc-qitem"><span class="grc-qname">⚙</span><span class="grc-qbar"><i style="width:${pct}%"></i></span></div>`;
    return box;
  }
}
