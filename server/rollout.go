// ==========================================================================================
// Opt-in HTTP endpoint for declarative Deployment rollouts
// ==========================================================================================

package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/benc-uk/go-rest-api/pkg/problem"
	"github.com/go-chi/chi/v5"
	apiErrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/benc-uk/kubeview/server/services"
)

const maxRolloutBodyBytes = 1 << 20 // 1 MiB, including the JSON envelope.

func (s *KubeviewAPI) handleRollout(w http.ResponseWriter, r *http.Request) {
	if !s.config.EnableRollouts {
		problem.Wrap(403, r.RequestURI, "rollouts disabled", errors.New("ENABLE_ROLLOUTS is not enabled")).Send(w)
		return
	}

	// The application permits CORS for reads; writes must not inherit that trust.
	if err := http.NewCrossOriginProtection().Check(r); err != nil {
		problem.Wrap(403, r.RequestURI, "cross-origin rollout denied", err).Send(w)
		return
	}

	ns := chi.URLParam(r, "namespace")
	if s.config.SingleNamespace != "" && ns != s.config.SingleNamespace {
		problem.Wrap(403, r.RequestURI, "single namespace mode",
			errors.New("only namespace permitted is:"+s.config.SingleNamespace)).Send(w)
		return
	}

	if len(validation.IsDNS1123Label(ns)) != 0 {
		problem.Wrap(400, r.RequestURI, "invalid namespace", errors.New("a valid namespace is required")).Send(w)
		return
	}

	dryRun, err := rolloutDryRun(r)
	if err != nil {
		problem.Wrap(400, r.RequestURI, "invalid dryRun", err).Send(w)
		return
	}

	manifest, err := readRolloutManifest(w, r)
	if err != nil {
		status := http.StatusBadRequest

		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			status = http.StatusRequestEntityTooLarge
		}

		problem.Wrap(status, r.RequestURI, "invalid rollout request", err).Send(w)

		return
	}

	deployment, err := services.ValidateDeploymentManifest(manifest, ns)
	if err != nil {
		problem.Wrap(400, r.RequestURI, "invalid Deployment manifest", err).Send(w)
		return
	}

	result, err := s.kubeService.ApplyDeployment(r.Context(), deployment, dryRun)
	if err != nil {
		problem.Wrap(rolloutErrorStatus(err), r.RequestURI, "Deployment apply failed", err).Send(w)
		return
	}

	s.ReturnJSON(w, result)
}

func rolloutErrorStatus(err error) int {
	var apiStatus apiErrors.APIStatus
	if errors.As(err, &apiStatus) && apiStatus.Status().Code >= 400 && apiStatus.Status().Code <= 599 {
		return int(apiStatus.Status().Code)
	}

	return http.StatusInternalServerError
}

func rolloutDryRun(r *http.Request) (bool, error) {
	values := r.URL.Query()["dryRun"]
	if len(values) != 1 || (values[0] != "true" && values[0] != "false") {
		return false, errors.New("dryRun must be explicitly set to true or false")
	}

	return values[0] == "true", nil
}

func readRolloutManifest(w http.ResponseWriter, r *http.Request) (string, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRolloutBodyBytes)

	var body struct {
		Manifest string `json:"manifest"`
	}

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(&body); err != nil {
		return "", err
	}

	if err := decoder.Decode(new(interface{})); !errors.Is(err, io.EOF) {
		if err != nil {
			return "", err
		}

		return "", errors.New("request must contain exactly one JSON object")
	}

	if body.Manifest == "" {
		return "", errors.New("manifest is required")
	}

	return body.Manifest, nil
}
