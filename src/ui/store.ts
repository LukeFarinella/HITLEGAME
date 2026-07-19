import { ASSETS, progression, type Asset } from '../game/progression';
import { GEAR, GEAR_BY_ID, PLATFORMS, gearFits, type PlatformDef, type PlatformId } from '../game/platforms';
import { TIER_LABEL, type StateTerritory, type Territory } from '../game/territory';

/**
 * The command store: two tabbed floating panels on the theater-select screen.
 *
 *   ASSETS    — commission hardware and capabilities (the disc observer, sensor uprates).
 *   TERRITORY — take states, then build each one out through its three obelisk tiers.
 *
 * Rows are rendered from data rather than markup because both lists are generated: the asset
 * catalog lives in progression.ts and the territory list falls out of the survey, which isn't even
 * loaded when the page boots. index.html carries only the shell.
 */

const fmt = new Intl.NumberFormat('en-US');

type Tab = 'platforms' | 'assets' | 'territory';

export interface StoreHooks {
  /** Anything derived from ownership (obelisk masks, sensor ranges) rebuilds here. */
  onPurchase(): void;
  /** Fly the globe to a state the player picked in the list. */
  onFocusState(s: StateTerritory): void;
}

export class Store {
  private root: HTMLElement;
  private officersEl: HTMLElement;
  private sitesEl: HTMLElement;
  private bodyEl: HTMLElement;
  private filterEl: HTMLInputElement;
  private tab: Tab = 'platforms';
  /** Which platform's hardpoints are expanded for fitting. */
  private fitting: PlatformId | null = null;
  private territory?: Territory;
  private filter = '';

  constructor(private hooks: StoreHooks) {
    this.root = document.getElementById('c2-store')!;
    this.officersEl = document.getElementById('c2-officers')!;
    this.sitesEl = document.getElementById('c2-sites')!;
    this.bodyEl = document.getElementById('c2-body')!;
    this.filterEl = document.getElementById('c2-filter') as HTMLInputElement;

    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('.c2-tab')) {
      btn.addEventListener('click', () => {
        this.tab = btn.dataset.tab as Tab;
        this.render();
      });
    }
    this.filterEl.addEventListener('input', () => {
      this.filter = this.filterEl.value.trim().toLowerCase();
      this.render();
    });
    document.getElementById('c2-collapse')?.addEventListener('click', () => {
      this.root.classList.toggle('collapsed');
    });

    progression.onChange(() => this.render());
    this.render();
  }

  /** The survey landed — the territory tab can stop saying "surveying". */
  setTerritory(t: Territory): void {
    this.territory = t;
    this.render();
  }

  // ---- rendering -------------------------------------------------------------------------------

  private render(): void {
    this.officersEl.textContent = fmt.format(progression.officers);
    this.sitesEl.textContent = this.territory
      ? `${fmt.format(progression.activeObelisks(this.territory))} / ${fmt.format(this.territory.totalObelisks)}`
      : '—';

    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('.c2-tab')) {
      btn.classList.toggle('active', btn.dataset.tab === this.tab);
    }
    // The filter only earns its space on the 50-row territory list.
    this.filterEl.parentElement!.hidden = this.tab !== 'territory';

    this.bodyEl.replaceChildren(
      this.tab === 'platforms'
        ? this.renderPlatforms()
        : this.tab === 'assets'
          ? this.renderAssets()
          : this.renderTerritory(),
    );
  }

  // ---- platforms + hardpoints ------------------------------------------------------------------

  private renderPlatforms(): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (const p of PLATFORMS) frag.append(this.platformRow(p));
    return frag;
  }

  private platformRow(p: PlatformDef): HTMLElement {
    const owned = progression.hasPlatform(p.id);
    const row = document.createElement('div');
    row.className = `c2-row platform${owned ? ' owned' : ''}`;

    const head = document.createElement('div');
    head.className = 'c2-row-head';
    head.innerHTML = `<span class="c2-name">${p.name}</span><span class="c2-cost">${fmt.format(p.cost)}</span>`;
    row.append(head);

    const blurb = document.createElement('p');
    blurb.className = 'c2-blurb';
    blurb.textContent = p.blurb;
    row.append(blurb);

    const meta = document.createElement('div');
    meta.className = 'c2-meta';
    const range = owned ? progression.sensorRangeOf(p.id) : p.sensorM;
    meta.innerHTML =
      `<span>${(range / 1000).toFixed(1)} KM SENSOR</span>` +
      `<span>${p.speed} M/S</span>` +
      `<span>${p.hardpoints} HP</span>`;
    row.append(meta);

    if (!owned) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'c2-buy';
      const afford = progression.officers >= p.cost;
      btn.disabled = !afford;
      btn.textContent = afford ? 'COMMISSION' : `INSUFFICIENT · ${fmt.format(p.cost)}`;
      if (afford) btn.addEventListener('click', () => {
        if (progression.buyPlatform(p)) this.hooks.onPurchase();
      });
      row.append(btn);
      return row;
    }

    // Owned: show the hardpoints, each either fitted (with a strip control) or an open slot.
    const loadout = progression.loadoutOf(p.id);
    const hp = document.createElement('div');
    hp.className = 'c2-hardpoints';
    loadout.forEach((gearId, slot) => {
      const gear = gearId ? GEAR_BY_ID.get(gearId) : undefined;
      const line = document.createElement('div');
      line.className = `c2-hp ${gear ? 'fitted' : 'empty'}`;
      line.innerHTML = `<span class="c2-hp-k">HP${slot + 1}</span><span class="c2-hp-v">${gear ? gear.name : 'OPEN'}</span>`;
      if (gear) {
        const strip = document.createElement('button');
        strip.type = 'button';
        strip.className = 'c2-strip';
        strip.title = `Strip — refunds ${fmt.format(Math.floor(gear.cost / 2))}`;
        strip.textContent = '✕';
        strip.addEventListener('click', () => {
          if (progression.stripHardpoint(p.id, slot)) this.hooks.onPurchase();
        });
        line.append(strip);
      }
      hp.append(line);
    });
    row.append(hp);

    const fit = document.createElement('button');
    fit.type = 'button';
    fit.className = 'c2-buy';
    const open = this.fitting === p.id;
    const hasFree = loadout.includes(null);
    fit.disabled = !hasFree && !open;
    fit.textContent = !hasFree && !open ? 'ALL HARDPOINTS FITTED' : open ? 'CLOSE ARMOURY' : 'FIT GEAR';
    fit.addEventListener('click', () => {
      this.fitting = open ? null : p.id;
      this.render();
    });
    row.append(fit);

    if (open) row.append(this.armoury(p));
    return row;
  }

  /** The gear list for one platform, filtered to what actually fits it. */
  private armoury(p: PlatformDef): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'c2-armoury';
    for (const gear of GEAR) {
      if (!gearFits(gear, p.id)) continue;
      const blocker = progression.gearBlocker(gear, p.id);
      const item = document.createElement('div');
      item.className = 'c2-gear';
      item.innerHTML =
        `<div class="c2-row-head"><span class="c2-name">${gear.name}</span>` +
        `<span class="c2-cost">${fmt.format(gear.cost)}</span></div>` +
        `<p class="c2-blurb">${gear.blurb}</p>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'c2-buy';
      if (blocker) {
        btn.disabled = true;
        btn.textContent = blocker;
        if (blocker === 'FITTED') btn.classList.add('done');
      } else {
        btn.textContent = 'INSTALL';
        btn.addEventListener('click', () => {
          if (progression.fitGear(gear, p.id)) {
            if (!progression.loadoutOf(p.id).includes(null)) this.fitting = null;
            this.hooks.onPurchase();
            this.render();
          }
        });
      }
      item.append(btn);
      wrap.append(item);
    }
    return wrap;
  }

  private renderAssets(): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (const a of ASSETS) frag.append(this.assetRow(a));
    return frag;
  }

  private assetRow(a: Asset): HTMLElement {
    const owned = progression.has(a.id);
    const blocker = progression.assetBlocker(a);

    const row = document.createElement('div');
    row.className = 'c2-row';
    if (owned) row.classList.add('owned');
    if (a.pending) row.classList.add('pending');

    const head = document.createElement('div');
    head.className = 'c2-row-head';
    head.innerHTML = `<span class="c2-name">${a.name}</span><span class="c2-cost">${fmt.format(a.cost)}</span>`;
    row.append(head);

    const blurb = document.createElement('p');
    blurb.className = 'c2-blurb';
    blurb.textContent = a.blurb;
    row.append(blurb);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'c2-buy';
    if (blocker) {
      btn.disabled = true;
      btn.textContent = blocker;
      if (owned) btn.classList.add('done');
    } else {
      btn.textContent = 'COMMISSION';
      btn.addEventListener('click', () => {
        if (progression.buyAsset(a)) this.hooks.onPurchase();
      });
    }
    row.append(btn);
    return row;
  }

  private renderTerritory(): DocumentFragment {
    const frag = document.createDocumentFragment();
    if (!this.territory) {
      const note = document.createElement('p');
      note.className = 'c2-note';
      note.textContent = 'SURVEYING TERRITORY…';
      frag.append(note);
      return frag;
    }

    // Held ground floats to the top, most-developed first; the rest stays alphabetical so a
    // specific state is easy to find by eye as well as by the filter.
    const list = this.territory.states
      .filter((s) => !this.filter || s.name.toLowerCase().includes(this.filter))
      .sort((a, b) => {
        const ta = progression.tierOf(a);
        const tb = progression.tierOf(b);
        if (ta !== tb) return tb - ta;
        return a.name.localeCompare(b.name);
      });

    if (!list.length) {
      const note = document.createElement('p');
      note.className = 'c2-note';
      note.textContent = 'NO MATCHING TERRITORY';
      frag.append(note);
      return frag;
    }
    for (const s of list) frag.append(this.stateRow(s));
    return frag;
  }

  private stateRow(s: StateTerritory): HTMLElement {
    const tier = progression.tierOf(s);
    const next = progression.nextTierCost(s);
    const live = tier > 0 ? this.territory!.atTier(s, tier).length : 0;

    const row = document.createElement('div');
    row.className = `c2-row tier-${tier}`;

    const head = document.createElement('div');
    head.className = 'c2-row-head';
    head.innerHTML =
      `<span class="c2-name">${s.name}</span>` +
      `<span class="c2-tier">${TIER_LABEL[tier]}</span>`;
    row.append(head);

    const meta = document.createElement('div');
    meta.className = 'c2-meta';
    meta.innerHTML =
      `<span>${fmt.format(live)} / ${fmt.format(s.all.length)} SITES</span>` +
      `<span>${fmt.format(s.cityReps.length)} CITIES</span>`;
    row.append(meta);

    // Tier pips: a glance at how far a state is built out, without reading the label.
    const pips = document.createElement('div');
    pips.className = 'c2-pips';
    for (let t = 1; t <= 3; t++) {
      const pip = document.createElement('i');
      if (tier >= t) pip.className = 'on';
      pips.append(pip);
    }
    row.append(pips);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'c2-buy';
    if (!next) {
      btn.disabled = true;
      btn.classList.add('done');
      btn.textContent = 'FULLY PROLIFERATED';
    } else {
      const afford = progression.officers >= next.cost;
      btn.disabled = !afford;
      const verb = next.tier === 1 ? 'UNLOCK' : next.tier === 2 ? 'CITY NET' : 'PROLIFERATE';
      btn.textContent = afford
        ? `${verb} · ${fmt.format(next.cost)}`
        : `INSUFFICIENT · ${fmt.format(next.cost)}`;
      if (afford) {
        btn.addEventListener('click', () => {
          if (progression.buyNextTier(s)) this.hooks.onPurchase();
        });
      }
    }
    row.append(btn);

    // The row itself is a "show me" — clicking anywhere but the buy button flies the globe there.
    head.addEventListener('click', () => this.hooks.onFocusState(s));
    meta.addEventListener('click', () => this.hooks.onFocusState(s));
    return row;
  }
}
