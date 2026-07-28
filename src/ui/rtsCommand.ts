import { STRUCTURES, BUILDABLE, abilitiesFrom, type AbilityId, type StructureType } from '../game/rts/structures';
import { RTS_UNITS, unitsFrom, type RtsUnitId } from '../game/rts/units';
import { researchFrom, type ResearchId } from '../game/rts/research';
import { mountsFor, MOUNT_BY_ID, type RtsLoadout, type WeaponId } from '../game/rts/weapons';
import { BASIC_ATTACK } from '../game/rts/weapons';
import type { QueueItem } from '../game/rts/rtsGame';
import type { UnitKind } from '../cesium/unitModels';

/**
 * The RTS command card — a StarCraft-style bottom bar whose contents depend on what's selected.
 *
 *   worker selected      → BUILD chips (place a structure)
 *   producing building   → PRODUCE chips + the live build queue for that building
 *   building w/ abilities → ABILITY chips, showing their cooldown in place of a price
 *   armed unit selected  → LOADOUT: its hardpoints, and the weapons that fit them
 *   anything else        → empty
 *
 * It stays deliberately presentational: it reads a CONTEXT the scene hands it and calls back. The
 * scene owns selection, money, the ghost and the queues; this just draws the menu and the progress.
 */

export type CommandContext =
  | { kind: 'none' }
  | { kind: 'build' }
  | { kind: 'produce'; structureId: number; structureType: StructureType }
  | {
      kind: 'loadout';
      /** The unit field index of the single selected unit. */
      unitIndex: number;
      unitId: RtsUnitId;
      meshKind: UnitKind;
      loadout: RtsLoadout;
    };

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
  /** A mount was chosen for a hardpoint on the selected unit. */
  onFit(unitIndex: number, slot: number, mount: WeaponId): void;
  /** A reason this mount can't go in this slot (cost, fit, already there), or null. */
  fitBlocker(unitIndex: number, slot: number, mount: WeaponId): string | null;
  /** A structure ability was chosen — the scene takes over (an aimed one opens a targeting cursor). */
  onAbility(id: AbilityId): void;
  /** A reason this ability can't fire (charging, cost), or null. */
  abilityBlocker(structureId: number, id: AbilityId): string | null;
  /** The ability currently being AIMED, if any — its chip reads as armed, like a build ghost. */
  aiming(): AbilityId | null;
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
    if (ctx.kind === 'loadout') {
      this.renderLoadout(ctx);
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

    // Ability chips (the Skyhook): a thing the building DOES, on a cooldown rather than a queue.
    // Charging shows the seconds left in place of the price, so the chip is the cooldown readout too.
    const aiming = this.hooks.aiming();
    const abilities = abilitiesFrom(structureType).map((a) => {
      const blocked = this.hooks.abilityBlocker(structureId, a.id);
      const locked = blocked && blocked !== 'INSUFFICIENT FUNDS' ? blocked : null;
      return this.chip({
        cls: `cat-ability${aiming === a.id ? ' active' : ''}${locked ? ' locked' : money >= a.cost ? '' : ' broke'}`,
        hotkey: a.hotkey,
        name: a.name,
        cost: a.cost,
        locked,
        title: `${a.name} — ${a.blurb} · ${a.cooldownS}s cooldown`,
        onClick: () => this.hooks.onAbility(a.id),
      });
    });

    const children: (HTMLElement | Node)[] = [
      this.label(STRUCTURES[structureType].name.replace(' FACILITY', '')),
      ...chips,
      ...research,
      ...abilities,
    ];
    const queue = this.hooks.queueOf(structureId);
    if (queue.length) children.push(this.queueStrip(queue));
    const rp = this.hooks.researchProgress(structureId);
    if (rp) children.push(this.researchStrip(rp.pct));
    this.root.replaceChildren(...children);
  }

  /**
   * Which hardpoint the next chosen mount goes into. Reset whenever the selection changes, so
   * clicking a different unit never quietly fits a weapon to the slot you armed on the last one.
   */
  private armedSlot = 0;
  private armedFor = -1;

  /**
   * Unit context: the chassis' own attack, its hardpoints, and what will fit in them.
   *
   * Reads as a sentence — "this is what it already does, these are its slots, these are the things
   * that go in a slot" — because a loadout screen that opens on a wall of weapons makes the player
   * work out what the unit ALREADY has before they can judge what to add.
   */
  private renderLoadout(ctx: Extract<CommandContext, { kind: 'loadout' }>): void {
    if (this.armedFor !== ctx.unitIndex) {
      this.armedFor = ctx.unitIndex;
      // Open on the first empty slot: the overwhelmingly common intent is "add a weapon", not
      // "replace one I already paid for".
      const empty = ctx.loadout.indexOf(null);
      this.armedSlot = empty >= 0 ? empty : 0;
    }
    if (this.armedSlot >= ctx.loadout.length) this.armedSlot = 0;

    const money = this.hooks.money();
    const basic = BASIC_ATTACK[ctx.meshKind];
    const children: (HTMLElement | Node)[] = [this.label(RTS_UNITS[ctx.unitId].name)];

    // The chassis' own weapon, shown but not offered — it can't be changed, and hiding it would
    // make an unfitted unit look unarmed.
    children.push(
      this.readout(
        basic.name,
        `${basic.kind.toUpperCase()} · ${basic.rangeM} m · ${basic.dmg} dmg / ${basic.periodS}s`,
      ),
    );

    if (!ctx.loadout.length) {
      children.push(this.readout('NO HARDPOINTS', 'This chassis carries what it was built with.'));
      this.root.replaceChildren(...children);
      return;
    }

    // The slots themselves. Clicking one arms it; the mount chips below fill whichever is armed.
    for (let i = 0; i < ctx.loadout.length; i++) {
      const fitted = ctx.loadout[i];
      const def = fitted ? MOUNT_BY_ID.get(fitted) : undefined;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `grc-chip cat-slot${i === this.armedSlot ? ' active' : ''}`;
      btn.title = def ? `HARDPOINT ${i + 1} — ${def.name}. Choosing another replaces it at full price.` : `HARDPOINT ${i + 1} — empty.`;
      btn.innerHTML =
        `<span class="grc-key">${i + 1}</span>` +
        `<span class="grc-name">${def ? def.name : 'EMPTY'}</span>` +
        `<span class="grc-cost">HARDPOINT</span>`;
      btn.addEventListener('click', () => {
        this.armedSlot = i;
        this.render();
      });
      children.push(btn);
    }

    const mounts = mountsFor(ctx.meshKind);
    if (!mounts.length) {
      children.push(this.readout('NOTHING FITS', 'No mount in the catalog fits this chassis.'));
      this.root.replaceChildren(...children);
      return;
    }
    for (const m of mounts) {
      const blocked = this.hooks.fitBlocker(ctx.unitIndex, this.armedSlot, m.id);
      // "Already fitted" and "doesn't fit" are locks; being broke just greys the price.
      const locked = blocked && blocked !== 'INSUFFICIENT FUNDS' ? blocked : null;
      children.push(
        this.chip({
          cls: `cat-mount${locked ? ' locked' : money >= m.cost ? '' : ' broke'}`,
          hotkey: m.hotkey,
          name: m.name,
          cost: m.cost,
          locked,
          title:
            `${m.name} — ${m.blurb} · ${m.weapon.kind.toUpperCase()} · ${m.weapon.rangeM} m · ` +
            `${m.weapon.dmg} dmg / ${m.weapon.periodS}s`,
          onClick: () => this.hooks.onFit(ctx.unitIndex, this.armedSlot, m.id),
        }),
      );
    }
    this.root.replaceChildren(...children);
  }

  /** A non-interactive chip — something the player is being told, not offered. */
  private readout(name: string, detail: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'grc-chip grc-readout';
    el.title = detail;
    el.innerHTML = `<span class="grc-name">${name}</span><span class="grc-cost">${detail}</span>`;
    return el;
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
