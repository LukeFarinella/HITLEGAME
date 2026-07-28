import { RTS_UNITS, type RtsUnitId } from '../game/rts/units';
import { platformIcon } from '../cesium/unitModels';
import type { PlatformId } from '../game/platforms';

/**
 * The RTS unit card — what a selected machine of YOURS reads as.
 *
 * The campaign's contact card is a dossier on a person: assessment, charge sheet, a sanction ladder.
 * None of that means anything pointed at your own hardware, so an RTS match shows this instead: a
 * portrait, the three bars an RTS runs on (health / shield / energy), what the unit is for, and what
 * it is doing right now.
 *
 * Presentational only. The scene assembles the selection and hands it over; this draws it.
 */

export interface RtsCardUnit {
  index: number;
  unit: RtsUnitId;
  callsign: string;
  /** Live combat health, read off the unit field — the same number the fight is shooting at. */
  hp: number;
  maxHp: number;
  shield: number;
  energy: number;
  /** What it's doing this second — MOVING, HOLDING, BUILDING ROBOTICS FACILITY … */
  action: string;
  speedMs: number;
  sensorKm: number;
}

/**
 * The company's standing, shown on the NEXUS card and nowhere else.
 *
 * The Nexus is the company's seat, so it is where the company's own state belongs — how far its
 * authority reaches, and whether it is still operating with the public's consent. See
 * {@link ../game/rts/mandate}.
 */
export interface RtsCardMandate {
  authority: number;
  authorityName: string;
  nextName: string | null;
  tolerance: number;
  threshold: number;
  margin: number;
  override: boolean;
  label: string;
}

/** The selected structure, when one is selected instead of units. */
export interface RtsCardStructure {
  name: string;
  blurb: string;
  hp: number;
  maxHp: number;
  /** PRODUCING WORKER · 6s, RESEARCHING AUTO-FINE · 22s, IDLE … */
  action: string;
  /** Glyph for the portrait plate. */
  glyph: string;
  accent: string;
  /** True for the Nexus, which carries the match on its back. */
  critical: boolean;
  /** Present on the Nexus only — the company's authority and mandate. */
  mandate?: RtsCardMandate;
}

export interface RtsUnitCardHooks {
  /** The current selection, in roster order. Empty (and no structure) hides the card. */
  units(): RtsCardUnit[];
  /** The selected structure, if one is selected. Takes precedence over units. */
  structure(): RtsCardStructure | null;
  /** A portrait in the multi-select grid was clicked — select just that one. */
  onPick(index: number): void;
}

/** Category accent colours, matching the command card's chips. */
const CAT_COLOR: Record<string, string> = {
  worker: '#B7BDC5',
  infantry: '#E7A13B',
  aerial: '#3FA0E0',
  special: '#8B6FE0',
};

/** The unit silhouette as a data URL, cached per kind. Reuses the map-icon art as a portrait. */
const portraitCache = new Map<string, string>();
function portrait(meshKind: PlatformId): string {
  const hit = portraitCache.get(meshKind);
  if (hit) return hit;
  const canvas = platformIcon(meshKind);
  // toDataURL rather than reusing the node: the same canvas backs the map billboards, and moving it
  // into the DOM would pull it out from under them.
  const url = canvas ? canvas.toDataURL() : '';
  portraitCache.set(meshKind, url);
  return url;
}

export class RtsUnitCard {
  private root: HTMLElement;
  /** What the DOM was last built for, so a per-frame render only rewrites the numbers. */
  private signature = '';

  constructor(private hooks: RtsUnitCardHooks) {
    this.root = document.getElementById('rts-unit')!;
  }

  hide(): void {
    this.root.setAttribute('hidden', '');
    this.root.replaceChildren();
    this.signature = '';
  }

  render(): void {
    // A selected building takes the card: its health is the thing you need while it's being shot at.
    const struct = this.hooks.structure();
    if (struct) {
      this.root.removeAttribute('hidden');
      const sig = `struct:${struct.name}`;
      if (sig !== this.signature) {
        this.signature = sig;
        this.root.replaceChildren(this.buildStructure(struct));
      }
      this.updateStructure(struct);
      return;
    }

    const units = this.hooks.units();
    if (!units.length) return this.hide();
    this.root.removeAttribute('hidden');

    // Rebuild the structure only when WHICH units are selected changes; otherwise just move the bars.
    const sig = units.map((u) => `${u.index}:${u.unit}`).join(',');
    if (sig !== this.signature) {
      this.signature = sig;
      this.root.replaceChildren(units.length === 1 ? this.buildSingle(units[0]) : this.buildGrid(units));
    }
    if (units.length === 1) this.updateSingle(units[0]);
    else this.updateGrid(units);
  }

  // ---- structure -------------------------------------------------------------------------------

  private buildStructure(s: RtsCardStructure): HTMLElement {
    const box = document.createElement('div');
    box.className = 'ruc-single ruc-struct';
    box.style.setProperty('--cat', s.accent);
    box.innerHTML =
      `<div class="ruc-top">` +
      `<div class="ruc-portrait ruc-glyph">${s.glyph}</div>` +
      `<div class="ruc-ident">` +
      `<div class="ruc-name">${s.name}</div>` +
      `<div class="ruc-class">${s.critical ? 'MAIN BASE · LOSING IT ENDS THE MATCH' : 'STRUCTURE'}</div>` +
      this.bar('hp', 'HP') +
      `</div></div>` +
      `<p class="ruc-blurb">${s.blurb}</p>` +
      (s.mandate ? this.mandateBlock() : '') +
      `<div class="ruc-stats">` +
      `<div class="ruc-stat"><span class="k">ACTION</span><span class="v act">—</span></div>` +
      `</div>`;
    return box;
  }

  /**
   * The mandate block: the authority rung, and a bar of public tolerance with the override threshold
   * marked on it.
   *
   * One bar with a line on it rather than two numbers, because the only thing worth reading here is
   * the RELATION between them — how much room is left before the company is operating on something
   * other than agreement.
   */
  private mandateBlock(): string {
    return (
      `<div class="ruc-mandate">` +
      `<div class="ruc-mrow"><span class="k">AUTHORITY</span><span class="v mauth">—</span></div>` +
      `<div class="ruc-mrow"><span class="k">MANDATE</span><span class="v mstate">—</span></div>` +
      `<div class="ruc-mbar"><i class="mfill"></i><b class="mthresh"></b></div>` +
      `<div class="ruc-mfoot"><span class="mtol">—</span><span class="mnext">—</span></div>` +
      `</div>`
    );
  }

  private updateStructure(s: RtsCardStructure): void {
    const bar = this.root.querySelector('.ruc-bar.hp');
    const fill = bar?.querySelector('i') as HTMLElement | null;
    const v = bar?.querySelector('.ruc-bv');
    const frac = s.maxHp > 0 ? s.hp / s.maxHp : 0;
    if (fill) {
      fill.style.width = `${Math.max(0, Math.min(100, frac * 100))}%`;
      fill.style.background = frac > 0.6 ? 'var(--ok)' : frac > 0.3 ? 'var(--warn)' : 'var(--red)';
    }
    if (v) v.textContent = `${Math.ceil(s.hp)} / ${s.maxHp}`;
    const act = this.root.querySelector('.ruc-stat .act');
    if (act) act.textContent = s.action;
    if (s.mandate) this.updateMandate(s.mandate);
  }

  private updateMandate(m: RtsCardMandate): void {
    const q = (sel: string) => this.root.querySelector(sel) as HTMLElement | null;
    const auth = q('.mauth');
    if (auth) {
      auth.textContent = m.authority > 0 ? `${m.authority} · ${m.authorityName}` : 'NONE';
      auth.style.color = m.authority > 0 ? '#6FA8C7' : 'var(--steel)';
    }
    const state = q('.mstate');
    if (state) {
      state.textContent = m.label;
      state.style.color = m.override ? 'var(--red)' : m.label === 'NARROW' ? 'var(--warn)' : 'var(--ok)';
    }
    const fill = q('.mfill');
    if (fill) {
      fill.style.width = `${Math.round(m.tolerance * 100)}%`;
      fill.style.background = m.override ? 'var(--red)' : m.label === 'NARROW' ? 'var(--warn)' : 'var(--ok)';
    }
    // The threshold is a line ON the track, not a second fill: it is a place, not a quantity.
    const th = q('.mthresh');
    if (th) th.style.left = `${Math.round(m.threshold * 100)}%`;
    const tol = q('.mtol');
    if (tol) {
      tol.textContent = `TOLERANCE ${Math.round(m.tolerance * 100)}% · THRESHOLD ${Math.round(m.threshold * 100)}%`;
    }
    const next = q('.mnext');
    if (next) {
      next.textContent = m.nextName ? `${m.nextName} LOWERS IT` : 'MAXIMUM AUTHORITY';
    }
  }

  // ---- single ----------------------------------------------------------------------------------

  private buildSingle(u: RtsCardUnit): HTMLElement {
    const def = RTS_UNITS[u.unit];
    const box = document.createElement('div');
    box.className = `ruc-single cat-${def.category}`;
    box.style.setProperty('--cat', CAT_COLOR[def.category] ?? '#B7BDC5');
    box.innerHTML =
      `<div class="ruc-top">` +
      `<div class="ruc-portrait"><img src="${portrait(def.meshKind)}" alt=""></div>` +
      `<div class="ruc-ident">` +
      `<div class="ruc-name">${u.callsign}</div>` +
      // The category is the useful half; only repeat the type name when it says something different
      // (a QUADRUPED is infantry, but a WORKER is just a worker).
      `<div class="ruc-class">${
        def.name === def.category.toUpperCase() ? def.name : `${def.name} · ${def.category.toUpperCase()}`
      }</div>` +
      this.bar('hp', 'HP') +
      (def.maxShield > 0 ? this.bar('sh', 'SHLD') : '') +
      (def.maxEnergy > 0 ? this.bar('en', 'NRG') : '') +
      `</div></div>` +
      `<p class="ruc-blurb">${def.blurb}</p>` +
      `<div class="ruc-stats">` +
      `<div class="ruc-stat"><span class="k">ACTION</span><span class="v act">—</span></div>` +
      `<div class="ruc-stat"><span class="k">SPEED</span><span class="v spd">—</span></div>` +
      `<div class="ruc-stat"><span class="k">SENSOR</span><span class="v sen">—</span></div>` +
      `</div>`;
    return box;
  }

  private bar(cls: string, label: string): string {
    return (
      `<div class="ruc-bar ${cls}">` +
      `<span class="ruc-bk">${label}</span>` +
      `<span class="ruc-btrack"><i></i></span>` +
      `<span class="ruc-bv">—</span>` +
      `</div>`
    );
  }

  private updateSingle(u: RtsCardUnit): void {
    const def = RTS_UNITS[u.unit];
    const set = (cls: string, val: number, max: number) => {
      const bar = this.root.querySelector(`.ruc-bar.${cls}`);
      if (!bar || max <= 0) return;
      const fill = bar.querySelector('i') as HTMLElement | null;
      const v = bar.querySelector('.ruc-bv');
      if (fill) fill.style.width = `${Math.max(0, Math.min(100, (val / max) * 100))}%`;
      if (v) v.textContent = `${Math.ceil(val)} / ${max}`;
    };
    set('hp', u.hp, u.maxHp);
    set('sh', u.shield, def.maxShield);
    set('en', u.energy, def.maxEnergy);
    const t = (sel: string, text: string) => {
      const e = this.root.querySelector(sel);
      if (e) e.textContent = text;
    };
    t('.ruc-stat .act', u.action);
    t('.ruc-stat .spd', `${u.speedMs} M/S`);
    t('.ruc-stat .sen', `${u.sensorKm.toFixed(1)} KM`);
    // HP colour reads as a warning as it falls — the one number worth panicking about.
    const hpFill = this.root.querySelector('.ruc-bar.hp i') as HTMLElement | null;
    if (hpFill) {
      const frac = u.hp / u.maxHp;
      hpFill.style.background = frac > 0.6 ? 'var(--ok)' : frac > 0.3 ? 'var(--warn)' : 'var(--red)';
    }
  }

  // ---- multi -----------------------------------------------------------------------------------

  private buildGrid(units: RtsCardUnit[]): HTMLElement {
    const box = document.createElement('div');
    box.className = 'ruc-grid';
    const head = document.createElement('div');
    head.className = 'ruc-grid-head';
    head.textContent = `${units.length} UNITS SELECTED`;
    box.append(head);
    const cells = document.createElement('div');
    cells.className = 'ruc-cells';
    for (const u of units) {
      const def = RTS_UNITS[u.unit];
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `ruc-cell cat-${def.category}`;
      cell.dataset.index = String(u.index);
      cell.title = `${u.callsign} — ${def.name}`;
      cell.style.setProperty('--cat', CAT_COLOR[def.category] ?? '#B7BDC5');
      cell.innerHTML =
        `<img src="${portrait(def.meshKind)}" alt="">` + `<span class="ruc-cell-hp"><i></i></span>`;
      cell.addEventListener('click', () => this.hooks.onPick(u.index));
      cells.append(cell);
    }
    box.append(cells);
    return box;
  }

  private updateGrid(units: RtsCardUnit[]): void {
    for (const u of units) {
      const cell = this.root.querySelector(`.ruc-cell[data-index="${u.index}"] .ruc-cell-hp i`) as HTMLElement | null;
      if (!cell) continue;
      const frac = u.maxHp > 0 ? u.hp / u.maxHp : 0;
      cell.style.width = `${Math.max(0, Math.min(100, frac * 100))}%`;
      cell.style.background = frac > 0.6 ? 'var(--ok)' : frac > 0.3 ? 'var(--warn)' : 'var(--red)';
    }
  }
}
