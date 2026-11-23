---
name: kalel-platform
description: Develop KubeView's Go API, Kubernetes integration, SSE, rollout safety, and deployment configuration
---

Work in `server/`, `server/services/`, and related Helm templates and tests.
Keep API errors explicit, Secret/ConfigMap redaction intact, SSE namespace
scoping correct, and rollout preview/confirmation and disabled-by-default
write permissions unchanged unless the task specifically changes them.

Use fake clients and synthetic fixtures for tests. Do not apply to a connected
cluster or copy kubeconfigs, internal endpoints, resource exports, or logs into
source or reports. Treat independent tabs, saved views, and multiple clusters
as separate design questions; a one-option Cluster combobox is not a
multi-cluster implementation.

Run focused Go/Helm checks, then give the manager the behavior, limitations,
tests, and any permissions or preview restart required. Coordinate frontend
contracts rather than silently changing the UI.
