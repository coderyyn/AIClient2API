package main

import (
	"context"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLocalTLSProtocolsStreamingAndCertificateValidation(t *testing.T) {
	for _, h2 := range []bool{false, true} {
		name := "http1"
		if h2 {
			name = "http2"
		}
		t.Run(name, func(t *testing.T) {
			upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				w.Header().Set("X-Mock-Header", r.Header.Get("X-Mock-Header"))
				io.WriteString(w, "data: first\n\n")
				w.(http.Flusher).Flush()
				io.WriteString(w, "data: [DONE]\n\n")
			}))
			upstream.EnableHTTP2 = h2
			upstream.StartTLS()
			defer upstream.Close()
			ca := filepath.Join(t.TempDir(), "mock-ca.pem")
			if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: upstream.Certificate().Raw}), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("SSL_CERT_FILE", ca)

			rt := newUTLSRoundTripper("")
			defer rt.CloseIdleConnections()
			req, _ := http.NewRequest("GET", upstream.URL, nil)
			req.Header.Set("X-Mock-Header", "synthetic")
			resp, err := rt.RoundTrip(req)
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil || !strings.Contains(string(data), "data: [DONE]") {
				t.Fatalf("stream failed: %v", err)
			}
			if resp.Header.Get("X-Mock-Header") != "synthetic" {
				t.Fatal("request headers were lost")
			}
			want := 1
			if h2 {
				want = 2
			}
			if resp.ProtoMajor != want {
				t.Fatalf("protocol=%d, want=%d", resp.ProtoMajor, want)
			}

			// Same trusted certificate, but a hostname outside its SAN: must fail.
			_, port, _ := net.SplitHostPort(upstream.Listener.Addr().String())
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			conn, err := dialUTLS(ctx, "tcp", net.JoinHostPort("localhost", port), "")
			if conn != nil {
				conn.Close()
			}
			if err == nil {
				t.Fatal("hostname verification was bypassed")
			}
		})
	}
}

func TestMissingTargetIsRejected(t *testing.T) {
	response := httptest.NewRecorder()
	handleProxy(response, httptest.NewRequest("POST", "/", strings.NewReader("synthetic")))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d", response.Code)
	}
}

func TestHTTPConnectProxyTunnel(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		c, e := target.Accept()
		if e == nil {
			defer c.Close()
			io.Copy(c, c)
		}
	}()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" {
			t.Errorf("method=%s", r.Method)
			return
		}
		destination, e := net.DialTimeout("tcp", r.Host, time.Second)
		if e != nil {
			t.Error(e)
			return
		}
		client, _, e := w.(http.Hijacker).Hijack()
		if e != nil {
			t.Error(e)
			destination.Close()
			return
		}
		defer client.Close()
		defer destination.Close()
		io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n")
		go io.Copy(destination, client)
		io.Copy(client, destination)
	}))
	defer proxy.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := dialViaProxy(ctx, "tcp", target.Addr().String(), proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	io.WriteString(conn, "ping")
	data := make([]byte, 4)
	if _, err := io.ReadFull(conn, data); err != nil || string(data) != "ping" {
		t.Fatalf("tunnel: %q %v", data, err)
	}
}
