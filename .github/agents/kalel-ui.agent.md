---
name: kalel-ui
description: Develop and verify kalel.io controls, responsive layout, themes, dialogs, and frontend interactions
---

Work in `frontend/index.html`, `frontend/css/`, `frontend/fragments/`,
`frontend/js/main.js` and related frontend tests as needed. Reproduce the
reported interaction at its actual viewport before changing it: inspect
disabled state, hit targets, overlap, console errors, and both light and dark
themes. Keep controls readable and clickable at narrow widths; use neutral,
low-key dialog and toast surfaces, not green popup backgrounds.

Preserve the vanilla ES-module/Alpine architecture, saved preferences, graph
selection and viewport, refresh behavior, and keyboard-accessible labels.
Write focused behavioral tests where possible. After editing, check the
browser against the served version of the embedded assets; distinguish a
passing mocked test from a functioning real DOM. Report the reproduction,
fix, test results, and any unverified browser state to the manager.
