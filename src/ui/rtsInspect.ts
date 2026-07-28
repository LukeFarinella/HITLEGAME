import { AUTHORITY_TIERS, type InspectResult, type AuthorityLevel } from '../game/rts/inspect';

/**
 * The inspection card — what the company may know about one member of the public.
 *
 * A floating sheet at the click, not a docked panel: inspecting is a thing you do to a specific
 * person in a specific place, and the card belongs next to them. It closes on any click outside
 * itself, on Escape, and when the contact it is about dies.
 *
 * Presentation only. Every decision about what is legible at what authority lives in
 * {@link ../game/rts/inspect}; this draws whatever it is handed and names what is missing.
 */
export function showInspectCard(x: number, y: number, title: string, res: InspectResult, authority: AuthorityLevel): void {
  closeInspectCard();
  const box = document.createElement('div');
  box.id = 'g-inspect';

  const head = document.createElement('div');
  head.className = 'gi-head';
  head.innerHTML =
    `<span class="gi-title">${title}</span>` +
    `<span class="gi-auth">AUTH ${authority} · ${AUTHORITY_TIERS[authority].name}</span>`;
  box.append(head);

  if (res.refused) {
    const el = document.createElement('div');
    el.className = 'gi-refused';
    el.textContent = res.refused;
    box.append(el);
  }

  for (const sec of res.sections) {
    const s = document.createElement('div');
    s.className = 'gi-sec';
    s.innerHTML = `<div class="gi-sec-head"><span>${sec.title}</span><span class="gi-lvl">AUTH ${sec.level}</span></div>`;
    for (const r of sec.rows) {
      const row = document.createElement('div');
      row.className = 'gi-row';
      row.innerHTML =
        `<span class="gi-k">${r.label}</span>` +
        `<span class="gi-v">${r.value}${r.note ? `<i class="gi-note">${r.note}</i>` : ''}</span>`;
      s.append(row);
    }
    box.append(s);
  }

  // What you are NOT seeing, and what would buy it. The card is an argument about permission, so the
  // locked rungs are part of the card rather than an absence you have to notice.
  if (res.next) {
    const f = document.createElement('div');
    f.className = 'gi-next';
    f.innerHTML = `<span class="gi-lock">🔒 ${res.next.name}</span><span class="gi-grants">${res.next.grants}</span>`;
    box.append(f);
  }

  document.body.append(box);
  // Place it clear of the pointer, and keep it fully on screen.
  const pad = 12;
  box.style.left = `${x + 16}px`;
  box.style.top = `${y + 8}px`;
  const r = box.getBoundingClientRect();
  if (r.right > window.innerWidth - pad) box.style.left = `${Math.max(pad, x - r.width - 16)}px`;
  if (r.bottom > window.innerHeight - pad) box.style.top = `${Math.max(pad, window.innerHeight - pad - r.height)}px`;

  function done(): void {
    closeInspectCard();
    window.removeEventListener('pointerdown', dismiss, true);
  }
  // Ignores pointerdowns inside itself — the same defect that made FINE a dead button, avoided here
  // from the start rather than found later.
  function dismiss(e: PointerEvent): void {
    if (!box.contains(e.target as Node)) done();
  }
  window.setTimeout(() => window.addEventListener('pointerdown', dismiss, true), 0);
}

export function closeInspectCard(): void {
  document.getElementById('g-inspect')?.remove();
}
