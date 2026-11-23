// ==========================================================================================
// Unit tests for rollout manifest validation and server-side apply options
// ==========================================================================================

package services

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic/fake"
	clientTesting "k8s.io/client-go/testing"
)

const rolloutManifest = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:stable
`

func TestKubernetes_ValidateDeploymentManifest(t *testing.T) {
	for _, ns := range []string{"", "team"} {
		t.Run("namespace="+ns, func(t *testing.T) {
			manifest := rolloutManifest
			if ns != "" {
				manifest = strings.Replace(manifest, "  name: web", "  name: web\n  namespace: "+ns, 1)
			}

			deployment, err := ValidateDeploymentManifest(manifest, "team")
			if err != nil {
				t.Fatal(err)
			}

			if deployment.GetName() != "web" || deployment.GetNamespace() != "team" {
				t.Fatalf("unexpected metadata: %#v", deployment.Object["metadata"])
			}

			data, err := deployment.MarshalJSON()
			if err != nil {
				t.Fatal(err)
			}

			if _, err := ValidateDeploymentManifest(string(data), "team"); err != nil {
				t.Fatalf("valid JSON Deployment rejected: %v", err)
			}
		})
	}
}

func TestKubernetes_ValidateDeploymentManifestRejectsInvalid(t *testing.T) {
	tests := map[string]string{
		"empty":                "",
		"null":                 "null",
		"array":                "[]",
		"invalid YAML":         "metadata: [",
		"invalid JSON":         `{"apiVersion":"apps/v1"`,
		"two documents":        rolloutManifest + "---\n" + rolloutManifest,
		"trailing JSON":        `{"apiVersion":"apps/v1"} {"kind":"Deployment"}`,
		"missing name":         strings.Replace(rolloutManifest, "  name: web\n", "", 1),
		"invalid name":         strings.Replace(rolloutManifest, "  name: web", "  name: BAD/name", 1),
		"non-string name":      strings.Replace(rolloutManifest, "  name: web", "  name: 123", 1),
		"wrong namespace":      strings.Replace(rolloutManifest, "  name: web", "  name: web\n  namespace: other", 1),
		"non-string namespace": strings.Replace(rolloutManifest, "  name: web", "  name: web\n  namespace: 123", 1),
		"wrong kind":           strings.Replace(rolloutManifest, "kind: Deployment", "kind: StatefulSet", 1),
		"wrong version":        strings.Replace(rolloutManifest, "apps/v1", "apps/v1beta1", 1),
		"duplicate YAML key":   strings.Replace(rolloutManifest, "  name: web", "  name: web\n  name: other", 1),
		"duplicate JSON key":   `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","name":"other"}}`,
		"status":               rolloutManifest + "status: {}\n",
		"null status":          rolloutManifest + "status: null\n",
		"invalid metadata":     "apiVersion: apps/v1\nkind: Deployment\nmetadata: []",
	}

	for _, field := range []string{
		"uid", "resourceVersion", "generation", "creationTimestamp", "deletionTimestamp",
		"deletionGracePeriodSeconds", "managedFields", "selfLink", "generateName",
	} {
		tests["managed "+field] = strings.Replace(
			rolloutManifest, "  name: web", "  name: web\n  "+field+": null", 1)
		tests["managed template "+field] = strings.Replace(
			rolloutManifest, "    metadata:\n", "    metadata:\n      "+field+": null\n", 1)
	}

	for name, manifest := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateDeploymentManifest(manifest, "team"); err == nil {
				t.Fatal("expected invalid manifest to be rejected")
			}
		})
	}

	if _, err := ValidateDeploymentManifest(rolloutManifest, "BAD"); err == nil {
		t.Fatal("expected invalid URL namespace to be rejected")
	}
}

func TestKubernetes_ApplyDeployment(t *testing.T) {
	for _, dryRun := range []bool{true, false} {
		t.Run(map[bool]string{true: "dry-run", false: "apply"}[dryRun], func(t *testing.T) {
			k := mockKubernetes()
			client := k.dynamicClient.(*fake.FakeDynamicClient)

			deployment, err := ValidateDeploymentManifest(rolloutManifest, "team")
			if err != nil {
				t.Fatal(err)
			}

			response := deployment.DeepCopy()
			response.SetUID(types.UID("server-assigned"))
			client.PrependReactor("patch", "deployments", func(action clientTesting.Action) (bool, runtime.Object, error) {
				patch := action.(clientTesting.PatchAction)
				if action.GetNamespace() != "team" || action.GetResource().Group != "apps" ||
					action.GetResource().Version != "v1" || action.GetSubresource() != "" ||
					patch.GetName() != "web" || patch.GetPatchType() != types.ApplyPatchType {
					t.Fatalf("unexpected apply action: %#v", action)
				}

				options := action.(clientTesting.PatchActionImpl).GetPatchOptions()
				if options.FieldManager != "kubeview-rollout" || options.Force == nil || *options.Force ||
					options.FieldValidation != metaV1.FieldValidationStrict {
					t.Fatalf("unsafe apply options: %#v", options)
				}

				wantDryRun := []string(nil)
				if dryRun {
					wantDryRun = []string{metaV1.DryRunAll}
				}

				if !reflect.DeepEqual(options.DryRun, wantDryRun) {
					t.Fatalf("dry run = %v, want %v", options.DryRun, wantDryRun)
				}

				var sent unstructured.Unstructured
				if err := json.Unmarshal(patch.GetPatch(), &sent); err != nil {
					t.Fatal(err)
				}

				if !reflect.DeepEqual(sent.Object, deployment.Object) {
					t.Fatalf("unexpected apply body: %s", patch.GetPatch())
				}

				return true, response, nil
			})

			result, err := k.ApplyDeployment(context.Background(), deployment, dryRun)
			if err != nil {
				t.Fatal(err)
			}

			if result.GetUID() != response.GetUID() || len(client.Actions()) != 1 {
				t.Fatalf("expected the Kubernetes response and exactly one apply, got %#v", result)
			}
		})
	}
}

func TestKubernetes_ApplyDeploymentPropagatesError(t *testing.T) {
	k := mockKubernetes()
	client := k.dynamicClient.(*fake.FakeDynamicClient)
	want := errors.New("apply conflict")
	client.PrependReactor("patch", "deployments", func(_ clientTesting.Action) (bool, runtime.Object, error) {
		return true, nil, want
	})

	deployment, err := ValidateDeploymentManifest(rolloutManifest, "team")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := k.ApplyDeployment(context.Background(), deployment, true); !errors.Is(err, want) {
		t.Fatalf("apply error = %v, want %v", err, want)
	}
}
