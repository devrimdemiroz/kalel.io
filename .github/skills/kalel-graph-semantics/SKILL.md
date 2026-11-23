---
name: kalel-graph-semantics
description: Model Kubernetes resources and observability as a typed network. Use for topology, component grouping, use-case maps, graph analytics, and metrics on nodes or edges.
---

# Graph semantics and network science

1. Start with a use-case map: the question a user needs to answer (ownership,
   impact, exposure, rollout, or observed traffic), the required entities and
   relations, and what evidence exists for each. Distinguish Kubernetes
   configuration relationships from measured communication. An owner edge,
   Service selector, and observed request flow mean different things.
2. Keep node identity stable within a cluster and namespace: group/version/
   resource, namespace, and UID for a specific object. Preserve human-readable
   names separately; a reused name does not make a replacement the same node.
   Give an edge a type, source, target, direction, and provenance. Do not infer
   a traffic edge from an ownership or selector edge.
3. Use actual metadata and links in `frontend/js/graph.js` and
   `frontend/js/container-layout.js`; never invent absent components. Keep
   namespace and release boundaries separate, and show unmapped resources.
   Use degree, connected components, reachability, or centrality only when
   their edge types support the user's question. Explain missing observations
   and avoid treating correlation or visual proximity as causation.
4. For external metrics, associate observations with a node or a well-defined
   relationship, a source, time window, unit, and freshness. A logical edge
   should not display traffic unless telemetry actually identifies that flow.
   Keep source-of-truth topology distinct from temporal overlays.
5. Estimate work in vertices and edges; prefer indexed UID/label lookups and
   incremental updates over rescanning all pairs on every SSE event. Test
   deletion/recreation, many-to-many links, disconnected components, filters,
   and refresh with synthetic fixtures in `frontend/tests/`.

Return the use-case map, chosen semantics and alternatives, scalability risks,
and evidence from a real browser only when it can be inspected safely.
