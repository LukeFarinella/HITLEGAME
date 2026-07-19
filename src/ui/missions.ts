import { MISSIONS, missions, type MissionDef } from '../game/missions';
import { icon } from './icons';
import { tolerance, toleranceLabel } from '../game/tolerance';
import { resistance, resistanceLabel } from '../game/resistance';

/**
 * The tasking panel: the mission chain on the right rail of the theater-select screen, mirroring
 * the command store on the left.
 *
 * One mission runs at a time. The active one is pinned at the top with its two counters — valid
 * marks toward the quota, invalid marks toward the ceiling — because those two numbers are the
 * only score the operator is kept to.
 */

const fmt = new Intl.NumberFormat('en-US');

/**
 * The public-tolerance readout: a thin bar sharing the valid/invalid stack, because it belongs to
 * the same question — not "how am I doing" but "what am I allowed to do".
 */
function toleranceBar(): string {
  const pct = Math.round(tolerance.level * 100);
  return (
    `<div class="c2-bar-row tolerance"><span class="c2-bar-k">PUBLIC</span>` +
    `<span class="c2-bar thin"><i class="tol" style="width:${pct}%"></i></span>` +
    `<span class="c2-bar-v">${pct}%</span></div>` +
    `<div class="c2-tol-note">${toleranceLabel(tolerance.level)} · ORDERS NEED ${Math.round(tolerance.threshold * 100)}% CASE</div>` +
    resistanceBar()
  );
}

/**
 * The resistance readout, directly under tolerance because the two are a pair: tolerance is what
 * the public will accept, resistance is what it costs when you go past it. Rising resistance means
 * more attacks on the net and more hiding out in unwatched ground.
 */
function resistanceBar(): string {
  const pct = Math.round(resistance.level * 100);
  const mult = resistance.pressure;
  return (
    `<div class="c2-bar-row tolerance"><span class="c2-bar-k">GROUND</span>` +
    `<span class="c2-bar thin"><i class="res" style="width:${pct}%"></i></span>` +
    `<span class="c2-bar-v">${pct}%</span></div>` +
    `<div class="c2-tol-note">${resistanceLabel(resistance.level)} · ${mult.toFixed(1)}× ATTACKS &amp; CELLS</div>`
  );
}

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
  /** Accordion open state, kept across the re-render that every order triggers. */
  private briefingOpen = false;

  constructor(private hooks: MissionHooks) {
    this.root = document.getElementById('c2-tasking')!;
    this.activeEl = document.getElementById('c2-active')!;
    this.ledgerEl = document.getElementById('c2-ledger-line')!;
    this.listEl = document.getElementById('c2-mission-list')!;

    document.getElementById('c2-tasking-collapse')?.addEventListener('click', () => {
      this.root.classList.toggle('collapsed');
    });

    tolerance.onChange(() => this.render());
    resistance.onChange(() => this.render());

    missions.onChange((e) => {
      if (e.type === 'complete') {
        this.hooks.notify(
          `MISSION COMPLETE · ${e.mission.name} · +${fmt.format(e.mission.reward)} FUNDING TOKENS` +
            (e.mission.grants === 'execute' ? ' · EXECUTION AUTHORIZED' : ''),
        );
      } else if (e.type === 'failed') {
        this.hooks.notify(
          `MISSION FAILED · ${e.mission.name} · CAMPAIGN ROLLED BACK · −${fmt.format(e.mission.penalty)} FUNDING TOKENS`,
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

  /**
   * The active tasking.
   *
   * Three parts, in the order they matter: what this job is called, the OBJECTIVE STEPS with live
   * progress against each, and the narrative behind an accordion. The steps are the operative
   * content — an operator mid-theater needs "8 of 20, two errors left" at a glance, not prose — so
   * the prose folds away and stays folded until it's asked for.
   */
  private renderActive(): void {
    const def = missions.activeDef();
    const run = missions.activeRun();
    this.activeEl.replaceChildren();

    if (!def || !run) {
      // The whole chain is cleared. Tolerance and resistance are campaign state, not tasking
      // state, so they stay up with nothing running.
      this.activeEl.innerHTML =
        `<p class="c2-note">CHAIN CLEARED · NO FURTHER TASKING</p>` +
        `<div class="c2-active c2-idle">${toleranceBar()}</div>`;
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'c2-active';

    const verb = def.mark === 'execute' ? 'EXECUTIONS' : 'INVESTIGATIONS';
    wrap.innerHTML =
      `<div class="c2-active-head">` +
      `<span class="c2-name">${icon(def.mark === 'execute' ? 'lethal' : 'surveil')}${def.name}</span>` +
      `<span class="c2-order order-${def.mark}">${def.mark === 'execute' ? 'LETHAL' : 'SURVEIL'}</span>` +
      `</div>` +
      `<div class="c2-obj-label">OBJECTIVES</div>` +
      this.step(
        `${def.target} valid ${verb.toLowerCase()}`,
        run.valid,
        def.target,
        'ok',
        run.valid >= def.target,
      ) +
      // The failure conditions are counted UP toward their ceiling rather than down from it: a
      // player reading "2 / 3" understands they have one left; "1 remaining" reads as a budget.
      this.step(`Stay under ${def.maxInvalid + 1} invalid`, run.invalid, def.maxInvalid, 'bad', false) +
      this.step(
        `Hold the net · max ${def.maxObelisksLost} sites lost`,
        run.obelisksLost,
        def.maxObelisksLost,
        'bad',
        false,
      ) +
      toleranceBar();

    wrap.append(this.accordion(def));
    this.activeEl.append(wrap);
  }

  /**
   * One objective line: label, progress bar, count.
   *
   * `tone` is which way the bar reads — 'ok' bars fill toward success, 'bad' bars fill toward
   * failing the tasking. Both are shown the same way on purpose, because to the operator they are
   * the same kind of fact: a number moving toward a threshold that ends the job.
   */
  private step(label: string, at: number, of: number, tone: 'ok' | 'bad', done: boolean): string {
    const pct = Math.min(100, of > 0 ? (at / of) * 100 : 0);
    return (
      `<div class="c2-obj${done ? ' done' : ''}">` +
      `<div class="c2-obj-top"><span class="c2-obj-tick">${done ? '◈' : '○'}</span>` +
      `<span class="c2-obj-text">${label}</span>` +
      `<span class="c2-obj-count">${at} / ${of}</span></div>` +
      `<span class="c2-bar"><i class="${tone}" style="width:${pct}%"></i></span>` +
      `</div>`
    );
  }

  /**
   * The narrative, folded away.
   *
   * Open state is remembered across re-renders — this panel redraws on every order, and an
   * accordion that snapped shut mid-sentence each time a contact was flagged would be unreadable.
   */
  private accordion(def: MissionDef): HTMLElement {
    const box = document.createElement('div');
    box.className = 'c2-acc';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'c2-acc-head';
    head.innerHTML = `<span class="c2-acc-caret">▸</span><span>BRIEFING</span>`;

    const body = document.createElement('div');
    body.className = 'c2-acc-body';
    body.innerHTML =
      def.briefing
        .split('\n\n')
        .map((para) => `<p class="c2-modal-p">${para}</p>`)
        .join('') +
      `<div class="c2-modal-objectives">` +
      `<div><span>ON CLEARANCE</span><b>+${fmt.format(def.reward)} tokens · +${Math.round(def.toleranceGain * 100)}% tolerance</b></div>` +
      `<div><span>ON FAILURE</span><b>rollback · −${fmt.format(def.penalty)} tokens</b></div>` +
      (def.grants
        ? `<div><span>GRANTS</span><b>${def.grants === 'execute' ? 'lethal authority' : 'custody authority'}</b></div>`
        : '') +
      `</div>`;

    if (this.briefingOpen) box.classList.add('open');
    head.addEventListener('click', () => {
      this.briefingOpen = !this.briefingOpen;
      box.classList.toggle('open', this.briefingOpen);
    });

    box.append(head, body);
    return box;
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

  /**
   * One link in the chain — a progress readout, not a control.
   *
   * Nothing here is clickable any more. The chain is assigned in order, so a row's only job is to
   * say where the campaign is in it: what's done, what's running, what's still coming and what it
   * will ask for when it arrives.
   */
  private row(m: MissionDef): HTMLElement {
    const status = missions.statusOf(m);
    const row = document.createElement('div');
    row.className = `c2-row mission ${status}`;

    const head = document.createElement('div');
    head.className = 'c2-row-head';
    head.innerHTML =
      `<span class="c2-name">${icon(m.mark === 'execute' ? 'lethal' : 'surveil')}${m.name}</span>` +
      `<span class="c2-tier">${status === 'available' ? 'UPCOMING' : status.toUpperCase()}</span>`;
    row.append(head);

    // A locked mission's brief is withheld: what the company wants next is not the operator's to
    // read ahead on, and it keeps the chain's turns as turns.
    if (status !== 'locked') {
      const brief = document.createElement('p');
      brief.className = 'c2-blurb';
      brief.textContent = m.brief;
      row.append(brief);
    }

    const meta = document.createElement('div');
    meta.className = 'c2-meta';
    const verb = m.mark === 'execute' ? 'EXECUTIONS' : 'INVESTIGATIONS';
    meta.innerHTML = `<span>${m.target} VALID ${verb}</span><span>MAX ${m.maxInvalid} INVALID</span>`;
    row.append(meta);

    const pay = document.createElement('div');
    pay.className = 'c2-meta';
    pay.innerHTML =
      `<span class="ok">+${fmt.format(m.reward)}</span>` +
      `<span class="bad">FAIL −${fmt.format(m.penalty)}</span>`;
    row.append(pay);

    if (m.grants) {
      const grant = document.createElement('div');
      grant.className = 'c2-grant';
      grant.textContent =
        m.grants === 'execute' ? '◈ GRANTS EXECUTION AUTHORIZATION' : '◈ GRANTS CUSTODY AUTHORIZATION';
      row.append(grant);
    }

    return row;
  }
}
