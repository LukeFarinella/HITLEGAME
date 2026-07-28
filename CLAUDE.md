# Working agreements

Standing instructions from Luke. These are not suggestions.

## 1. One link, and stop talking about links.

Hosting is **solved and finished**. The game is at
`https://lukefarinella.github.io/HITLEGAME/` and republishes on every push to `main`
via `.github/workflows/pages.yml`. So the loop is: land the work on main, confirm the
run went green, done.

He does not want to hear about it. **Do not send any other links** — no artifact URLs,
no commit or compare or PR links, no screenshot pages, no preview builds. Do not
re-explain the deploy, the CORS header, the base path, or what a sandbox can't reach.
He asked for a feature; give him the feature.

This rule got rewritten after a session where a single request — "let's continue" —
turned into hours of hosting archaeology, four failed Pages runs, three settings he
had to change himself, and a pile of substitute links, while the actual feature work
sat finished and unmentioned underneath. His words: *"getting pissed that we can't
just iterate and test and work on features."*

If the deploy ever breaks: one sentence on what broke, one sentence on the single
action that fixes it, then **carry on with the feature**. Never let plumbing become
the conversation.

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

## 5. Default to doing the work, not to asking.

Across one session he was asked to choose a chassis approach, a hardpoint depth, a
host, an unblock strategy, and a next feature — and separately told to flip three
GitHub settings. Most of those were answerable from the repo or a sensible default.

Ask only when the answer changes what gets built and cannot be inferred. Otherwise
pick the obvious option, say in one line what was picked, and build. He is the
designer, not the ticket queue.
