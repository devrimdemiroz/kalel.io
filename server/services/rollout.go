// ==========================================================================================
// Validation and declarative server-side apply for Deployment rollouts
// ==========================================================================================

package services

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	kubeYAML "k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/yaml"
)

// ValidateDeploymentManifest accepts one declarative apps/v1 Deployment.
// Kubernetes validates the Deployment spec during apply, including dry runs.
func ValidateDeploymentManifest(manifest, ns string) (*unstructured.Unstructured, error) {
	if problems := validation.IsDNS1123Label(ns); len(problems) != 0 {
		return nil, errors.New("a valid namespace is required")
	}

	reader := kubeYAML.NewYAMLReader(bufio.NewReader(strings.NewReader(manifest)))

	document, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}

	if _, err := reader.Read(); !errors.Is(err, io.EOF) {
		return nil, errors.New("manifest must contain exactly one document")
	}

	data, err := yaml.YAMLToJSONStrict(document)
	if err != nil {
		return nil, fmt.Errorf("invalid manifest: %w", err)
	}

	deployment := &unstructured.Unstructured{}
	if err := deployment.UnmarshalJSON(data); err != nil {
		return nil, fmt.Errorf("invalid Deployment: %w", err)
	}

	if deployment.GetAPIVersion() != "apps/v1" || deployment.GetKind() != "Deployment" {
		return nil, errors.New("only apps/v1 Deployment manifests are supported")
	}

	if err := validateDeploymentMetadata(deployment, ns); err != nil {
		return nil, err
	}

	if _, found := deployment.Object["status"]; found {
		return nil, errors.New("status is server-managed and must be omitted")
	}

	if err := rejectManagedMetadata(deployment.Object, "metadata"); err != nil {
		return nil, err
	}

	if err := rejectManagedMetadata(deployment.Object, "spec", "template", "metadata"); err != nil {
		return nil, err
	}

	deployment.SetNamespace(ns)

	return deployment, nil
}

func validateDeploymentMetadata(deployment *unstructured.Unstructured, ns string) error {
	name, _, err := unstructured.NestedString(deployment.Object, "metadata", "name")
	if err != nil || len(validation.IsDNS1123Subdomain(name)) != 0 {
		return errors.New("metadata.name must be a valid Deployment name")
	}

	manifestNS, _, err := unstructured.NestedString(deployment.Object, "metadata", "namespace")
	if err != nil || (manifestNS != "" && manifestNS != ns) {
		return errors.New("metadata.namespace must match the URL namespace")
	}

	return nil
}

func rejectManagedMetadata(object map[string]interface{}, path ...string) error {
	metadata, _, err := unstructured.NestedMap(object, path...)
	if err != nil {
		return err
	}

	for _, field := range []string{
		"uid", "resourceVersion", "generation", "creationTimestamp", "deletionTimestamp",
		"deletionGracePeriodSeconds", "managedFields", "selfLink", "generateName",
	} {
		if _, found := metadata[field]; found {
			return fmt.Errorf("%s.%s must be omitted from declarative manifests", strings.Join(path, "."), field)
		}
	}

	return nil
}

// ApplyDeployment uses the caller's context and never takes ownership forcibly.
func (k *Kubernetes) ApplyDeployment(
	ctx context.Context, deployment *unstructured.Unstructured, dryRun bool,
) (*unstructured.Unstructured, error) {
	data, err := deployment.MarshalJSON()
	if err != nil {
		return nil, err
	}

	force := false
	options := metaV1.PatchOptions{
		FieldManager:    "kubeview-rollout",
		Force:           &force,
		FieldValidation: metaV1.FieldValidationStrict,
	}
	if dryRun {
		options.DryRun = []string{metaV1.DryRunAll}
	}

	gvr := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}

	return k.dynamicClient.Resource(gvr).Namespace(deployment.GetNamespace()).
		Patch(ctx, deployment.GetName(), types.ApplyPatchType, data, options)
}
