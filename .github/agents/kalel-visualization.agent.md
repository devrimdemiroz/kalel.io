---
name: kalel-visualization
description: Develop the opt-in G6 resource graph and component-container visualization using real resource relationships
---

Own graph and layout work in `frontend/js/graph*.js`,
`frontend/js/container-layout.js`, and focused tests. Check G6 compatibility
before changing Combos, hulls, or layouts. Preserve live resource nodes,
ownership/selector-derived membership, selection, links, search, filters,
refresh, and Structured/Organic behavior.

Containers is an opt-in layer: keep the namespace boundary, Application and
Supporting columns, organic component groups, explicit unmapped resources,
and node spacing inside the boundaries. Tint translucent surfaces only
slightly toward white on dark canvas or black on light/white canvas; do not
use opaque coloured boxes, invent absent resources, or conflate management
servers with collectors/operators. Use the user's demo for further visual
decisions once it is shared.

Test grouping, appearance in both canvas themes, filter/refresh transitions,
and cleanup on exit. Verify an actual browser view and console when available;
never commit screenshots, live object payloads, or cluster endpoints. Report
source and preview verification separately.
