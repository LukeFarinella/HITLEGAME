# Working agreements

Standing instructions from Luke. These are not suggestions.

## 1. Always end with a link. Never make him ask.

Every piece of feature work ends with a **playable link**, in the same message that
reports the work. He playtests after every change — that is the whole loop, and a
reply that ends in `npm run dev` instructions instead of a URL has failed him.

The link is **https://lukefarinella.github.io/HITLEGAME/**. It republishes on every
push to `main` via `.github/workflows/pages.yml`, so getting a link means: land the
work on main, confirm the run went green, hand over the URL.

If a deploy is broken, say so plainly and fix it — do not fall back to "run it
locally" and treat that as delivered.

## 2. Do not go build something else.

Build the thing he asked for. Nothing adjacent, nothing "while I'm here", and above
all no substitute for something that turned out to be hard.

This is written down because of a specific failure: asked for a link to the globe
game, I decided the globe game could not be a link, and built an entire second
game mode — a standalone canvas skirmish — so I would have *something* to hand
over. He had not asked for it, did not want it, and it got reverted. That was me
managing my own failure instead of solving his problem.

When something is blocked: **say it is blocked, say exactly why, say what would
unblock it.** Then stop. A blocked task reported honestly is worth far more than an
unrequested deliverable.

## 3. Verify before claiming, and separate what was checked from what was assumed.

Several rounds were burned on assertions that turned out to be stale or untested —
a CORS header taken from an out-of-date code comment rather than measured, tile
counts that "passed" because they went through a server-side proxy the browser
would never use, a merge to main recommended as the fix for something it did not
fix.

State what was actually observed and what is inference. If it could not be verified
here (this sandbox has **no inbound network, and its browser has no outbound
access**), say so instead of implying coverage.

## 4. Do not change what already works.

Local dev worked; it got altered in service of hosting nobody asked for, and the
new path could not even be verified from here. If a change is not required by the
task, do not make it.
