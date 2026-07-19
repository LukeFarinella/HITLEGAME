import { MISSIONS, missions, type MissionDef } from '../game/missions';

/**
 * The tasking panel: the mission chain on the right rail of the theater-select screen, mirroring
 * the command store on the left.
 *
 * One mission runs at a time. The active one is pinned at the top with its two counters — valid
 * marks toward the quota, invalid marks toward the ceiling — because those two numbers are the
 * only score the operator is kept to.
 */

const fmt = new Intl.NumberFormat('en-US');

export interface MissionHooks {
  /** A mission started, finished or failed — the scene re-reads authorizations and re-renders. */
  onChange(): void;
  /** Surface a one-line notice on the globe (completion, failure). */
  notify(msg: string): void;
}

export class MissionPanel {
  private root: HTMLElement;
  private activeEl: HTMLElement;
  private ledgerEl: HTMLElement;
  private listEl: HTMLElement;

  constructor(private hooks: MissionHooks) {
    this.root = document.getElementById('c2-tasking')!;
    this.activeEl = document.getElementById('c2-active')!;
    this.ledgerEl = document.getElementById('c2-ledger-line')!;
    this.listEl = document.getElementById('c2-mission-list')!;

    document.getElementById('c2-tasking-collapse')?.addEventListener('click', () => {
      this.root.classList.toggle('collapsed');
    });

    missions.onChange((e) => {
      if (e.type === 'complete') {
        this.hooks.notify(
          `MISSION COMPLETE · ${e.mission.name} · +${fmt.format(e.mission.reward)} OFFICERS` +
            (e.mission.grants === 'execute' ? ' · EXECUTION AUTHORIZED' : ''),
        );
      } else if (e.type === 'failed') {
        this.hooks.notify(
          `MISSION FAILED · ${e.mission.name} · CAMPAIGN ROLLED BACK · −${fmt.format(e.mission.penalty)} OFFICERS`,
        );
      }
      this.render();
      this.hooks.onChange();
    });

    this.render();
  }

  render(): void {
    this.renderActive();
    this.renderLedger();
    this.renderList();
  }

  private renderActive(): void {
    const def = missions.activeDef();
    const run = missions.activeRun();
    if (!def || !run) {
      this.activeEl.innerHTML = `<p class="c2-note">NO ACTIVE TASKING</p>`;
      return;
    }

    const validPct = Math.min(100, (run.valid / def.target) * 100);
    // The invalid bar fills toward the ceiling — the (max+1)th is what actually fails the mission.
    const invalidPct = Math.min(100, (run.invalid / (def.maxInvalid + 1)) * 100);

    this.activeEl.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'c2-active';
    wrap.innerHTML =
      `<div class="c2-active-head"><span class="c2-name">${def.name}</span>` +
      `<span class="c2-order order-${def.mark}">${def.mark === 'execute' ? 'LETHAL' : 'SURVEIL'}</span></div>` +
      `<div class="c2-bar-row"><span class="c2-bar-k">VALID</span>` +
      `<span class="c2-bar"><i class="ok" style="width:${validPct}%"></i></span>` +
      `<span class="c2-bar-v">${run.valid} / ${def.target}</span></div>` +
      `<div class="c2-bar-row"><span class="c2-bar-k">INVALID</span>` +
      `<span class="c2-bar"><i class="bad" style="width:${invalidPct}%"></i></span>` +
      `<span class="c2-bar-v">${run.invalid} / ${def.maxInvalid}</span></div>`;

    const stand = document.createElement('button');
    stand.type = 'button';
    stand.className = 'c2-buy standdown';
    stand.textContent = 'STAND DOWN';
    stand.addEventListener('click', () => missions.abandon());
    wrap.append(stand);
    this.activeEl.append(wrap);
  }

  private renderLedger(): void {
    const l = missions.ledger;
    const total = l.valid + l.invalid;
    const rate = total ? Math.round((l.valid / total) * 100) : 0;
    this.ledgerEl.innerHTML =
      `<span><b>${fmt.format(l.investigations)}</b> INV</span>` +
      `<span><b>${fmt.format(l.executions)}</b> EXEC</span>` +
      `<span class="${rate >= 70 ? 'ok' : 'bad'}"><b>${total ? rate : '—'}%</b> VALID</span>`;
  }

  private renderList(): void {
    this.listEl.replaceChildren();
    for (const m of MISSIONS) this.listEl.append(this.row(m));
  }

  private row(m: MissionDef): HTMLElement {
    const status = missions.statusOf(m);
    const row = document.createElement('div');
    row.className = `c2-row mission ${status}`;

    const head = document.createElement('div');
    head.className = 'c2-row-head';
    head.innerHTML =
      `<span class="c2-name">${m.name}</span>` +
      `<span class="c2-tier">${status.toUpperCase()}</span>`;
    row.append(head);

    if (status !== 'locked') {
      const brief = document.createElement('p');
      brief.className = 'c2-blurb';
      brief.textContent = m.brief;
      row.append(brief);
    }

    const meta = document.createElement('div');
    meta.className = 'c2-meta';
    const verb = m.mark === 'execute' ? 'EXECUTIONS' : 'INVESTIGATIONS';
    meta.innerHTML =
      `<span>${m.target} VALID ${verb}</span><span>MAX ${m.maxInvalid} INVALID</span>`;
    row.append(meta);

    const pay = document.createElement('div');
    pay.className = 'c2-meta';
    pay.innerHTML =
      `<span class="ok">+${fmt.format(m.reward)}</span>` +
      `<span class="bad">FAIL −${fmt.format(m.penalty)}</span>`;
    row.append(pay);

    if (m.grants === 'execute') {
      const grant = document.createElement('div');
      grant.className = 'c2-grant';
      grant.textContent = '◈ GRANTS EXECUTION AUTHORIZATION';
      row.append(grant);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'c2-buy';
    if (status === 'complete') {
      btn.disabled = true;
      btn.classList.add('done');
      btn.textContent = 'COMPLETE';
    } else if (status === 'active') {
      btn.disabled = true;
      btn.textContent = 'IN PROGRESS';
    } else if (status === 'locked') {
      btn.disabled = true;
      const req = MISSIONS.find((x) => x.id === m.requires);
      btn.textContent = `REQUIRES ${req?.name ?? m.requires}`;
    } else if (missions.activeRun()) {
      btn.disabled = true;
      btn.textContent = 'ANOTHER TASKING ACTIVE';
    } else {
      btn.textContent = 'ACCEPT TASKING';
      btn.addEventListener('click', () => missions.accept(m));
    }
    row.append(btn);
    return row;
  }
}
