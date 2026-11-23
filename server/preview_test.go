// ==========================================================================================
// Development preview configuration and uncached embedded asset delivery
// ==========================================================================================

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/benc-uk/go-rest-api/pkg/api"
	"github.com/go-chi/chi/v5"

	"github.com/benc-uk/kubeview/server/services"
)

func TestPreviewConfig(t *testing.T) {
	for _, value := range []string{"", "false", "true", "1", "invalid"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("DEV_MODE", value)

			if got := getConfig().DevMode; got != (value == "true" || value == "1") {
				t.Fatalf("DEV_MODE=%q resulted in %v", value, got)
			}
		})
	}
}

func TestPreviewAssets(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		s := &KubeviewAPI{config: Config{DevMode: enabled}}
		router := chi.NewRouter()
		s.AddRoutes(router)

		for _, path := range []string{"/", "/public/js/main.js", "/public/fragments/about-dialog.html"} {
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))

			if recorder.Code != http.StatusOK {
				t.Fatalf("%s: status = %d", path, recorder.Code)
			}

			want := ""
			if enabled {
				want = "no-store"
			}

			if got := recorder.Header().Get("Cache-Control"); got != want {
				t.Fatalf("%s: dev=%v cache control = %q, want %q", path, enabled, got, want)
			}
		}
	}
}

func TestPreviewCapability(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		s := &KubeviewAPI{
			Base:        api.NewBase("kubeview", "test", "test", true),
			kubeService: &services.Kubernetes{},
			config:      Config{SingleNamespace: "team", DevMode: enabled},
		}
		recorder := httptest.NewRecorder()
		s.handleNamespaceList(recorder, httptest.NewRequest(http.MethodGet, "/api/namespaces", nil))

		var result struct {
			DevMode *bool `json:"devMode"`
		}

		if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}

		if recorder.Code != http.StatusOK || result.DevMode == nil || *result.DevMode != enabled {
			t.Fatalf("unexpected preview capability: %s", recorder.Body.String())
		}
	}
}
