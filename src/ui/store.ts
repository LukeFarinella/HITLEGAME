import { ASSETS, progression, type Asset } from '../game/progression';
import { GEAR, GEAR_BY_ID, PLATFORMS, gearFits, type PlatformDef, type PlatformId } from '../game/platforms';
import { TIER_LABEL, type Region, type StateTerritory, type Territory } from '../game/territory';
import { icon } from './icons';
import { tolerance, toleranceLabel } from '../game/tolerance';

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

/** A hairline divider with a caption, to separate the two ways territory is sold. */
function sectionLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'c2-section';
  el.textContent = text;
  return el;
}

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
  private tab: Tab = 'platforms';
  /** Which platform's hardpoints are expanded for fitting. */
  private fitting: PlatformId | null = null;
  /** Which territory block has its member states expanded. */
  private expanded: string | null = null;
  private territory?: Territory;

  constructor(private hooks: StoreHooks) {
    this.root = document.getElementById('c2-store')!;
    this.officersEl = document.getElementById('c2-officers')!;
    this.sitesEl = document.getElementById('c2-sites')!;
    this.bodyEl = document.getElementById('c2-body')!;

    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('.c2-tab')) {
      btn.addEventListener('click', () => {
        this.tab = btn.dataset.tab as Tab;
        this.render();
      });
    }
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
    const count = progression.countOf(p.id);
    const owned = count > 0;
    const row = document.createElement('div');
    row.className = `c2-row platform${owned ? ' owned' : ''}`;

    const head = document.createElement('div');
    head.className = 'c2-row-head';
    // A fielded platform shows its strength instead of its price — the price is spent.
    head.innerHTML =
      `<span class="c2-name">${icon(p.id)}${p.name}</span>` +
      (owned
        ? `<span class="c2-count">${count}${p.maxCount > 1 ? ` / ${p.maxCount}` : ''}</span>`
        : `<span class="c2-cost">${fmt.format(p.cost)}</span>`);
    row.append(head);

    const blurb = document.createElement('p');
    blurb.className = 'c2-blurb';
    blurb.textContent = p.blurb;
    row.append(blurb);

    const meta = document.createElement('div');
    meta.className = 'c2-meta';
    meta.innerHTML =
      `<span>${(progression.sensorRangeOf(p.id) / 1000).toFixed(2)} KM SENSOR</span>` +
      `<span>${p.speed} M/S</span>` +
      `<span>${p.hardpoints} HP</span>`;
    row.append(meta);

    if (!owned) {
      const blocker = progression.platformBlocker(p);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'c2-buy';
      if (blocker) {
        btn.disabled = true;
        btn.textContent =
          blocker === 'INSUFFICIENT OFFICERS' ? `INSUFFICIENT · ${fmt.format(p.cost)}` : blocker;
      } else {
        btn.textContent = 'COMMISSION';
        btn.addEventListener('click', () => {
          if (progression.buyPlatform(p)) this.hooks.onPurchase();
        });
      }
      row.append(btn);
      return row;
    }

    // Owned: hardpoints, then the fleet expansion if there is one left to buy.
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
    // Gear is fitted per TYPE, so say so once rather than implying each unit is configured alone.
    if (count > 1) {
      const note = document.createElement('p');
      note.className = 'c2-fleetnote';
      note.textContent = `Loadout applies to all ${count}.`;
      row.append(note);
    }

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

    if (p.expansion && count < p.maxCount) {
      const blocker = progression.expansionBlocker(p);
      const exp = document.createElement('div');
      exp.className = 'c2-expansion';
      exp.innerHTML =
        `<div class="c2-row-head"><span class="c2-name">${p.expansion.name}</span>` +
        `<span class="c2-cost">${fmt.format(p.expansion.cost)}</span></div>` +
        `<p class="c2-blurb">${p.expansion.blurb}</p>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'c2-buy';
      if (blocker) {
        btn.disabled = true;
        btn.textContent =
          blocker === 'INSUFFICIENT OFFICERS'
            ? `INSUFFICIENT · ${fmt.format(p.expansion.cost)}`
            : blocker;
      } else {
        btn.textContent = `COMMISSION +${p.expansion.count}`;
        btn.addEventListener('click', () => {
          if (progression.buyExpansion(p)) this.hooks.onPurchase();
        });
      }
      exp.append(btn);
      row.append(exp);
    }

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
        `<div class="c2-row-head"><span class="c2-name">${icon(gear.id)}${gear.name}</span>` +
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
    // What the network can be used FOR is capped by the climate, so say where it stands here too.
    const note = document.createElement('div');
    note.className = 'c2-section';
    note.textContent = `PUBLIC TOLERANCE ${Math.round(tolerance.level * 100)}% · ${toleranceLabel(tolerance.level)}`;
    frag.append(note);
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
    head.innerHTML =
      `<span class="c2-name">${icon(a.id)}${a.name}</span>` +
      `<span class="c2-cost">${fmt.format(a.cost)}</span>`;
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

    // Owned automation gets its working threshold, since the whole point is that the operator
    // decides how strong a case has to be before the machine acts on it.
    if (owned && (a.id === 'auto-investigate' || a.id === 'auto-execute')) {
      const kind = a.id === 'auto-execute' ? 'execute' : 'investigate';
      const wrap = document.createElement('div');
      wrap.className = 'c2-autorow';
      const label = document.createElement('label');
      const cur = progression.autoThreshold(kind);
      label.innerHTML = `<span>Acts at case</span><b>${Math.round(cur * 100)}%</b>`;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.step = '1';
      slider.value = String(Math.round(cur * 100));
      slider.addEventListener('input', () => {
        label.innerHTML = `<span>Acts at case</span><b>${slider.value}%</b>`;
      });
      slider.addEventListener('change', () => {
        progression.setAutoThreshold(kind, parseInt(slider.value, 10) / 100);
      });
      wrap.append(label, slider);
      row.append(wrap);
    }
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
    // The ten largest economies one at a time, then everything else in blocks.
    frag.append(sectionLabel('HEADLINE TERRITORIES'));
    for (const s of this.territory.headline) frag.append(this.stateRow(s));
    frag.append(sectionLabel('REMAINING BLOCKS'));
    for (const r of this.territory.regions) frag.append(this.regionRow(r));
    frag.append(this.countriesRow());
    return frag;
  }

  /** One individually-bought headline state. */
  private stateRow(s: StateTerritory): HTMLElement {
    const tier = progression.tierOf(s);
    const next = progression.nextTierCost(s);
    const live = tier > 0 ? this.territory!.atTier(s, tier).length : 0;

    const row = document.createElement('div');
    row.className = `c2-row tier-${tier}`;

    const head = document.createElement('div');
    head.className = 'c2-row-head';
    head.innerHTML =
      `<span class="c2-name">${icon('state')}<span class="c2-rank">${s.gdpRank}</span>${s.name}</span>` +
      `<span class="c2-tier">${TIER_LABEL[tier]}</span>`;
    row.append(head);

    const meta = document.createElement('div');
    meta.className = 'c2-meta';
    meta.innerHTML =
      `<span>${fmt.format(live)} / ${fmt.format(s.all.length)} SITES</span>` +
      `<span>${fmt.format(s.cityReps.length)} CITIES</span>`;
    row.append(meta);

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

    // Clicking the row body flies the globe there.
    head.addEventListener('click', () => this.hooks.onFocusState(s));
    meta.addEventListener('click', () => this.hooks.onFocusState(s));
    return row;
  }

  /** One purchasable block, expandable to the states inside it. */
  private regionRow(r: Region): HTMLElement {
    const tier = progression.tierOfRegion(r);
    const next = progression.nextRegionTier(r);
    let live = 0;
    for (const s of r.states) {
      const t = progression.tierOf(s);
      if (t > 0) live += this.territory!.atTier(s, t).length;
    }

    const row = document.createElement('div');
    row.className = `c2-row tier-${tier}`;

    const head = document.createElement('div');
    head.className = 'c2-row-head';
    head.innerHTML =
      `<span class="c2-name">${icon('block')}${r.name}</span>` +
      `<span class="c2-tier">${TIER_LABEL[tier]}</span>`;
    row.append(head);

    const blurb = document.createElement('p');
    blurb.className = 'c2-blurb';
    blurb.textContent = r.blurb;
    row.append(blurb);

    const meta = document.createElement('div');
    meta.className = 'c2-meta';
    meta.innerHTML =
      `<span>${fmt.format(live)} / ${fmt.format(r.obelisks)} SITES</span>` +
      `<span>${r.states.length} STATES</span>` +
      `<span>${fmt.format(r.cities)} CITIES</span>`;
    row.append(meta);

    // Tier pips: how far the block is built out, without reading the label.
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
      // A block containing the campaign's free home state charges for the others only, so say how
      // many are actually being bought when it isn't the whole block.
      const scope = next.states < r.states.length ? ` ×${next.states}` : '';
      btn.textContent = afford
        ? `${verb}${scope} · ${fmt.format(next.cost)}`
        : `INSUFFICIENT · ${fmt.format(next.cost)}`;
      if (afford) {
        btn.addEventListener('click', () => {
          if (progression.buyRegionTier(r)) this.hooks.onPurchase();
        });
      }
    }
    row.append(btn);

    // Expandable member list: the detail is still there when it's wanted, without fifty rows of it.
    const open = this.expanded === r.id;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'c2-expand';
    toggle.textContent = open ? '▾ HIDE STATES' : `▸ ${r.states.length} STATES`;
    toggle.addEventListener('click', () => {
      this.expanded = open ? null : r.id;
      this.render();
    });
    row.append(toggle);

    if (open) {
      const list = document.createElement('div');
      list.className = 'c2-members';
      for (const s of r.states) {
        const t = progression.tierOf(s);
        const line = document.createElement('div');
        line.className = `c2-member tier-${t}`;
        line.innerHTML =
          `<span class="c2-member-n">${s.name}</span>` +
          `<span class="c2-member-t">${TIER_LABEL[t]}</span>` +
          `<span class="c2-member-s">${fmt.format(s.all.length)}</span>`;
        line.addEventListener('click', () => this.hooks.onFocusState(s));
        list.append(line);
      }
      row.append(list);
    }
    return row;
  }

  /**
   * Beyond the states. Gated on holding all of them, and deliberately inert: the obelisk dataset
   * this game runs on is US-only, so there are no sites anywhere else to sell yet.
   */
  private countriesRow(): HTMLElement {
    const ready = this.territory ? progression.allTerritoryHeld(this.territory) : false;
    const row = document.createElement('div');
    row.className = 'c2-row pending';
    row.innerHTML =
      `<div class="c2-row-head"><span class="c2-name">${icon('foreign')}FOREIGN THEATERS</span>` +
      `<span class="c2-tier">${ready ? 'AWAITING SURVEY' : 'LOCKED'}</span></div>` +
      `<p class="c2-blurb">Country-by-country expansion opens once the national network is fully ` +
      `proliferated. No site survey exists outside the United States yet.</p>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'c2-buy';
    btn.disabled = true;
    btn.textContent = ready ? 'NO SURVEY DATA' : 'REQUIRES ALL STATES';
    row.append(btn);
    return row;
  }

}
