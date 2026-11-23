---
name: kalel-perceptual-design
description: Evaluate graph and UI readability using human perception, contrast, density, and interaction. Use for themes, layout, component layers, labels, or controls.
---

# Perceptual visualization

1. Map each visual channel to one meaning: position and containment for
   grouping, shape or line style for relation type, and colour for status only
   when it adds information. Use proximity and boundaries to show hierarchy
   without suggesting an unobserved dependency or flow.
2. Preserve the user's mental map across refreshes and layout switches:
   selection, search, viewport, and stable relative placement. At high density,
   measure occlusion, edge crossings, and label readability at fitted and
   working zoom. Prefer explicit aggregation or progressive detail to
   microscopic labels; never hide real resources without a visible filter.
3. For Containers, compare the effective canvas (white background can differ
   from the UI theme). Use a faint, neutral, translucent fill toward white on
   dark canvas or black on light canvas, with breathing room between nodes and
   borders. Do not use saturated green for dialogs or informational overlays.
   Keep node labels and selected states readable over every layer.
4. Check text contrast and interactive-state distinction against
   [WCAG contrast guidance](https://www.w3.org/TR/WCAG22/#contrast-minimum)
   and [non-text contrast](https://www.w3.org/TR/WCAG22/#non-text-contrast).
   Test both themes, disabled/hover/focus states, ordinary and narrow sidebar
   widths, and the actual click target rather than trusting a screenshot.
5. Pair targeted frontend regressions with a browser walkthrough and console
   inspection. Describe observed visual evidence and uncertainty; mocked
   Alpine/G6 tests alone do not prove a feature is visible in the preview.
