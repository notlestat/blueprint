# Design audit and direction options

11 November 2026. Status: a fourth direction, D, was chosen and built. The three concepts below were set aside.

## Audit

- **Who and what.** One designer, on a laptop, reviewing UI that an agent wrote. The surface is a working tool, so reading and acting come before expression. The designs on the artboards are the content. The tool's own look has to stay out of their way.
- **Constraints.** Plain HTML, CSS and JavaScript with no framework, as the spec sets out. Artboards are sandboxed iframes. Keyboard access to every comment and reduced motion support are acceptance criteria.
- **What exists.** Nothing. The repository has a spec and no interface.
- **What to avoid.** The sidebar, toolbar and properties panel shell that Paper and Figma share, and a blue cyanotype grid, which is the first idea the name suggests.
- **Taste evidence.** The designer's recorded interests are Swiss design, experimental typography, construction diagrams, print layering and photography-led work, with a tension between precision and disruption. That reading comes from written notes. The reference boards behind the notes were not opened, and no new references were supplied for Blueprint.

## Skills read and how they were used

| Skill | Role here |
| --- | --- |
| design-engineering | The workflow: audit, three concepts, depth and motion planned up front. |
| impeccable | Set the mode to "Operate": a tool where scanning and consistency outrank expression. Its setup script was not run because this step is planning only. |
| ui-skills-root | Read. Its CLI was not run. No UI Skills context was loaded. |
| Lavish playbooks: comparison, input | Shaped the review page and its choice form. |

Huashu's six thumbnails then three drafts process was not run in full. Three drafts were built directly. The review skills (`plan-design-review`, `better-interface`) have not run yet.

## The three concepts

Files are in `.lavish/direction/`. Each shows the same board at 1440 by 900.

| | A · Drawing sheet | B · Light table | C · Proof |
| --- | --- | --- | --- |
| Idea | A technical drawing | A photographer's light table | A printer's page proofs |
| Controls | One title block in the corner | A filmstrip along the bottom | One line of type across the top |
| A note | Red triangle, leader line, text in the margin | Yellow wax ring round the area, text beside the lit frame | Dot on the sheet, text in that sheet's margin |
| Ground | Warm paper with a fine grid | Near black | Off white |
| Type | IBM Plex Mono, Archivo condensed | Instrument Serif, JetBrains Mono | Inter Tight |
| Depth | Sheets lift off the grid | Light and dark | Mostly flat |
| Motion | Leader lines draw in | Light moves to the chosen frame | Hairline reaches from note to pin |
| Main cost | Small capitals are slower to read; many notes tangle | Dimmed frames are hard to compare | Margins use canvas space |

## Recommendation

A, the drawing sheet. It keeps every note readable without a click, puts all the interface in one place, and suits the recorded interest in construction diagrams. Two ideas from the others are worth carrying over if A is chosen: the blue colour for agent replies from C, and the ring that marks an area from B.

This was a proposal. The designer chose a different direction, D, described below.

## Not checked

Safari and Firefox, screen readers, real pan and zoom, and how each concept holds up with 20 artboards or 15 notes on one artboard.

## Direction D, chosen 11 November 2026

After seeing A, B and C, the brief changed: base the look on Apple's design system and Emil Kowalski's design engineering guidance, and keep it as clean as Grok's chat page.

Skills read for D:

| Skill | What it contributed |
| --- | --- |
| apple-design | Translucent floating material for all chrome, system font with size-specific tracking, 1:1 pointer tracking, cards that grow from the thing that opened them, and the three accessibility media queries. |
| emil-design-eng | The strong ease-out curve, durations under 200 ms, press feedback at 0.97 scale, no animation for keyboard actions, and never animating from scale 0. |
| gestures | Tracking with direct `transform` and style writes, a 4px threshold before a drag counts, and a 44px hit area on pins. |

Reference: one screenshot of grok.com's home page, taken 11 November 2026. Observed: a near-black ground, one centred rounded input, pill buttons, one typeface and almost no other elements. Blueprint takes the restraint and the pill-shaped input. It does not copy Grok's layout, logo or colours.

The mockup is `.lavish/direction/d-quiet.html`. The built page is `public/`.

Not done for D: Huashu's thumbnail round, and the `frontend-design`, `animate` and `animation-performance` skills were not read. No momentum after a pan, and no spring physics: pan and zoom follow the pointer directly and stop when it stops.
