// ==========================================================================================
// Unit tests for rollout configuration, request guards and capability discovery
// ==========================================================================================

package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benc-uk/go-rest-api/pkg/api"
	"github.com/go-chi/chi/v5"
	apiErrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/benc-uk/kubeview/server/services"
)

func TestRolloutConfig(t *testing.T) {
	for _, value := range []string{"", "false", "true", "invalid"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("ENABLE_ROLLOUTS", value)

			if got := getConfig().EnableRollouts; got != (value == "true") {
				t.Fatalf("ENABLE_ROLLOUTS=%q resulted in %v", value, got)
			}
		})
	}
}

func TestRolloutRequestGuards(t *testing.T) {
	tests := []struct {
		name        string
		config      Config
		path        string
		body        string
		header      string
		headerValue string
		want        int
	}{
		{name: "disabled", path: "/api/rollout/team?dryRun=true", body: `{}`, want: 403},
		{name: "namespace restricted", config: Config{EnableRollouts: true, SingleNamespace: "team"},
			path: "/api/rollout/other?dryRun=true", body: `{}`, want: 403},
		{name: "invalid namespace", path: "/api/rollout/BAD?dryRun=true", body: `{}`, want: 400},
		{name: "dry run required", path: "/api/rollout/team", body: `{}`, want: 400},
		{name: "invalid dry run", path: "/api/rollout/team?dryRun=1", body: `{}`, want: 400},
		{name: "repeated dry run", path: "/api/rollout/team?dryRun=true&dryRun=false", body: `{}`, want: 400},
		{name: "missing manifest", body: `{}`, want: 400},
		{name: "null manifest", body: `{"manifest":null}`, want: 400},
		{name: "non-string manifest", body: `{"manifest":{}}`, want: 400},
		{name: "unknown request field", body: `{"manifest":"test","force":true}`, want: 400},
		{name: "multiple bodies", body: `{"manifest":"test"} {}`, want: 400},
		{name: "malformed body", body: `{"manifest":`, want: 400},
		{name: "invalid manifest", body: `{"manifest":"kind: Pod"}`, want: 400},
		{name: "oversized body", body: `{"manifest":"` + strings.Repeat("x", maxRolloutBodyBytes) + `"}`, want: 413},
		{name: "cross-origin", body: `{}`, header: "Origin", headerValue: "https://evil.example", want: 403},
		{name: "null origin", body: `{}`, header: "Origin", headerValue: "null", want: 403},
		{name: "cross-site", body: `{}`, header: "Sec-Fetch-Site", headerValue: "cross-site", want: 403},
		{name: "same-origin", body: `{}`, header: "Origin", headerValue: "http://example.com", want: 400},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			config := tt.config
			if tt.name != "disabled" {
				config.EnableRollouts = true
			}

			s := &KubeviewAPI{config: config}
			router := chi.NewRouter()
			s.AddRoutes(router)

			path := tt.path
			if path == "" {
				path = "/api/rollout/team?dryRun=true"
			}

			req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(tt.body))
			if tt.header != "" {
				req.Header.Set(tt.header, tt.headerValue)
			}

			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, req)

			if recorder.Code != tt.want {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, tt.want, recorder.Body.String())
			}
		})
	}
}

func TestRolloutNamespaceCapability(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		s := &KubeviewAPI{
			Base:        api.NewBase("kubeview", "test", "test", true),
			kubeService: &services.Kubernetes{},
			config:      Config{SingleNamespace: "team", EnableRollouts: enabled},
		}

		recorder := httptest.NewRecorder()
		s.handleNamespaceList(recorder, httptest.NewRequest(http.MethodGet, "/api/namespaces", nil))

		var response struct {
			RolloutsEnabled *bool `json:"rolloutsEnabled"`
		}

		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}

		if recorder.Code != 200 || response.RolloutsEnabled == nil || *response.RolloutsEnabled != enabled {
			t.Fatalf("unexpected capability response: %s", recorder.Body.String())
		}
	}
}

func TestRolloutErrorStatus(t *testing.T) {
	resource := schema.GroupResource{Group: "apps", Resource: "deployments"}
	for _, tt := range []struct {
		err  error
		want int
	}{
		{apiErrors.NewConflict(resource, "web", errors.New("owned by another manager")), 409},
		{apiErrors.NewForbidden(resource, "web", errors.New("RBAC denied")), 403},
		{errors.New("transport failure"), 500},
	} {
		if got := rolloutErrorStatus(tt.err); got != tt.want {
			t.Fatalf("error status = %d, want %d", got, tt.want)
		}
	}
}
