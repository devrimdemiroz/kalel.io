---
name: kalel-edge-routing
description: Design and validate G6 edge paths, ports, waypoints, and octilinear routing. Use for network diagrams, obstacle avoidance, edge labels, crossings, or path-style changes.
---

# Edge routing and waypoints

1. Identify the edge's meaning and direction before choosing a shape. Record
   endpoint anchors, visible port labels, optional waypoints, obstacles
   (nodes, labels, and container boundaries), and behavior under filtering.
   Keep port numbers on the Service that exposes them, not every connection.
2. Compare the bundled G6 5.1.1 straight, polyline, quadratic, and cubic
   styles before proposing a custom edge. Its built-in polyline supports
   orthogonal routing; do not describe an octilinear router as built-in.
   Check the installed G6 API and [edge documentation]
   (https://g6.antv.antgroup.com/en/manual/element/edge/overview) before
   customizing `frontend/js/graph.js` or `frontend/js/main.js`.
3. For an octilinear proposal, constrain every segment to horizontal,
   vertical, or 45-degree diagonal directions (allow numerical tolerance).
   Preserve requested waypoints in order; avoid obstacles and minimize
   crossings, bends, detours, and label collisions without moving real nodes.
   Specify what happens when no unobstructed route exists, rather than
   silently drawing a misleading path.
4. Keep routing stable after zoom, layout changes, node movement, filtering,
   and live updates. Benchmark dense graphs and prefer bounded incremental
   work over recomputing every path on each event.
5. Use synthetic fixtures to check segment angles, waypoint order, parallel
   edges, occluded labels, hidden endpoints, and dark/light legibility. Verify
   graph state and the actual browser; do not add a new routing mode until
   its user-facing need and acceptance behavior are defined.
