// =================================================================================================
// Render the chart without a cluster and check namespace-scoped, opt-in rollout permissions.
// =================================================================================================

package kubeview

import (
	"bytes"
	"encoding/json"
	"io"
	"os/exec"
	"reflect"
	"slices"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/yaml"
)

type chartDocument struct {
	Kind     string              `json:"kind"`
	Metadata metav1.ObjectMeta   `json:"metadata"`
	Rules    []rbacv1.PolicyRule `json:"rules"`
	RoleRef  rbacv1.RoleRef      `json:"roleRef"`
	Subjects []rbacv1.Subject    `json:"subjects"`
	Spec     json.RawMessage     `json:"spec"`
}

func renderChart(t *testing.T, values ...string) []chartDocument {
	t.Helper()

	args := append([]string{"template", "chart-check", ".", "--namespace", "viewer"}, values...)
	output, err := exec.Command("helm", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("helm template failed: %v\n%s", err, output)
	}

	documents := make([]chartDocument, 0, 8)
	decoder := yaml.NewYAMLOrJSONDecoder(bytes.NewReader(output), 4096)

	for {
		document := chartDocument{}
		err := decoder.Decode(&document)
		if err == io.EOF {
			break
		}

		if err != nil {
			t.Fatalf("decode Helm manifest: %v", err)
		}

		if document.Kind != "" {
			documents = append(documents, document)
		}
	}

	return documents
}

func TestChartRolloutPermissions(t *testing.T) {
	modes := []struct {
		name      string
		args      []string
		namespace string
		scoped    bool
	}{
		{name: "default", namespace: "viewer"},
		{name: "all", args: []string{"--set", "singleNamespace=false"}, namespace: "viewer"},
		{name: "release", args: []string{"--set", "singleNamespace=true"}, namespace: "viewer", scoped: true},
		{name: "named", args: []string{"--set", "singleNamespace=workloads"}, namespace: "workloads", scoped: true},
		{name: "numeric", args: []string{"--set-string", "singleNamespace=123"}, namespace: "123", scoped: true},
	}

	for _, mode := range modes {
		for _, enabled := range []bool{false, true} {
			name := mode.name + "/default-read-only"
			values := append([]string{}, mode.args...)

			if enabled {
				name = mode.name + "/rollouts"
				values = append(values, "--set", "enableRollouts=true")
			}

			t.Run(name, func(t *testing.T) {
				documents := renderChart(t, values...)
				roleCount, bindingCount, deploymentCount := 0, 0, 0

				for _, document := range documents {
					switch document.Kind {
					case "Role", "ClusterRole":
						roleCount++
						checkChartRole(t, document, mode.namespace, mode.scoped, enabled)
					case "RoleBinding", "ClusterRoleBinding":
						bindingCount++
						checkChartBinding(t, document, mode.namespace, mode.scoped, enabled)
					case "Deployment":
						deploymentCount++
						checkChartEnvironment(t, document, mode.namespace, mode.scoped, enabled)
					}
				}

				expected := 1
				if enabled {
					expected++
				}

				if roleCount != expected || bindingCount != expected || deploymentCount != 1 {
					t.Fatalf("got %d roles, %d bindings, %d Deployments; want %d, %d, 1",
						roleCount, bindingCount, deploymentCount, expected, expected)
				}
			})
		}
	}
}

func checkChartRole(t *testing.T, document chartDocument, namespace string, scoped, enabled bool) {
	t.Helper()

	if strings.HasSuffix(document.Metadata.Name, "-rollout") {
		expected := []rbacv1.PolicyRule{{
			APIGroups: []string{"apps"},
			Resources: []string{"deployments"},
			Verbs:     []string{"create", "patch"},
		}}
		if !enabled || document.Kind != "Role" || document.Metadata.Namespace != namespace {
			t.Fatalf("rollout role is enabled unexpectedly or not namespace-scoped: %+v", document)
		}

		if !reflect.DeepEqual(document.Rules, expected) {
			t.Fatalf("rollout role grants unexpected permissions: %+v", document.Rules)
		}

		return
	}

	expectedKind, expectedNamespace := "ClusterRole", ""
	if scoped {
		expectedKind, expectedNamespace = "Role", namespace
	}

	if document.Kind != expectedKind || document.Metadata.Namespace != expectedNamespace || len(document.Rules) == 0 {
		t.Fatalf("unexpected read role scope or empty policy: %+v", document)
	}

	for _, rule := range document.Rules {
		if slices.Contains(rule.Resources, "secrets") || slices.Contains(rule.Resources, "*") {
			t.Fatalf("read role must not grant Secret access: %+v", rule)
		}

		for _, verb := range rule.Verbs {
			if !slices.Contains([]string{"get", "list", "watch"}, verb) {
				t.Fatalf("read role grants write permissions: %+v", rule)
			}
		}
	}
}

func checkChartBinding(t *testing.T, document chartDocument, namespace string, scoped, enabled bool) {
	t.Helper()

	expectedKind, expectedRoleKind, expectedNamespace := "ClusterRoleBinding", "ClusterRole", ""
	if scoped || strings.HasSuffix(document.Metadata.Name, "-rollout") {
		expectedKind, expectedRoleKind, expectedNamespace = "RoleBinding", "Role", namespace
	}

	if strings.HasSuffix(document.Metadata.Name, "-rollout") && !enabled {
		t.Fatal("rollout binding exists with rollouts disabled")
	}

	if document.Kind != expectedKind || document.Metadata.Namespace != expectedNamespace {
		t.Fatalf("unexpected binding scope: %+v", document)
	}

	expectedRef := rbacv1.RoleRef{
		APIGroup: "rbac.authorization.k8s.io",
		Kind:     expectedRoleKind,
		Name:     document.Metadata.Name,
	}
	expectedSubjects := []rbacv1.Subject{{
		Kind:      "ServiceAccount",
		Name:      "chart-check-kubeview",
		Namespace: "viewer",
	}}
	if document.RoleRef != expectedRef || !reflect.DeepEqual(document.Subjects, expectedSubjects) {
		t.Fatalf("binding must reference its matching role and the release service account: %+v", document)
	}
}

func checkChartEnvironment(t *testing.T, document chartDocument, namespace string, scoped, enabled bool) {
	t.Helper()

	spec := appsv1.DeploymentSpec{}
	if err := json.Unmarshal(document.Spec, &spec); err != nil {
		t.Fatalf("decode Deployment spec: %v", err)
	}

	env := make(map[string]string)
	for _, variable := range spec.Template.Spec.Containers[0].Env {
		env[variable.Name] = variable.Value
	}

	if (env["ENABLE_ROLLOUTS"] == "true") != enabled {
		t.Fatalf("ENABLE_ROLLOUTS does not match opt-in: %v", env)
	}

	if scoped && env["SINGLE_NAMESPACE"] != namespace {
		t.Fatalf("SINGLE_NAMESPACE must match the RBAC namespace: %v", env)
	}

	if !scoped && env["SINGLE_NAMESPACE"] != "" {
		t.Fatalf("all-namespace mode must not set SINGLE_NAMESPACE: %v", env)
	}
}

func TestChartSecretReferencesRemainSupported(t *testing.T) {
	documents := renderChart(t,
		"--set-string", "imagePullSecrets[0].name=pull-credentials",
		"--set", "ingress.enabled=true",
		"--set-string", "ingress.host=example.invalid",
		"--set-string", "ingress.tlsSecretName=ingress-tls",
	)
	foundPullSecret, foundTLSSecret := false, false

	for _, document := range documents {
		switch document.Kind {
		case "Deployment":
			spec := appsv1.DeploymentSpec{}
			if err := json.Unmarshal(document.Spec, &spec); err != nil {
				t.Fatal(err)
			}

			foundPullSecret = len(spec.Template.Spec.ImagePullSecrets) == 1 &&
				spec.Template.Spec.ImagePullSecrets[0].Name == "pull-credentials"
		case "Ingress":
			spec := networkingv1.IngressSpec{}
			if err := json.Unmarshal(document.Spec, &spec); err != nil {
				t.Fatal(err)
			}

			foundTLSSecret = len(spec.TLS) == 1 && spec.TLS[0].SecretName == "ingress-tls"
		}
	}

	if !foundPullSecret || !foundTLSSecret {
		t.Fatalf("Secret references were lost: image pull=%t, TLS=%t", foundPullSecret, foundTLSSecret)
	}
}
