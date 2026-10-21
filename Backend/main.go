package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Config struct {
	ClientID     string
	ClientSecret string
	Port         string
	OnlyRead     bool
	CertFile     string
	KeyFile      string
	WS_URL		 string
}

type TokenFile struct {
	RefreshToken     string    `json:"refresh_token"`
	RefreshExpiresAt time.Time `json:"refresh_expires_at"`
}

type StreamerInfo struct {
	StreamerSocketURL      string `json:"streamerSocketUrl"`
	SchwabClientCustomerID string `json:"schwabClientCustomerId"`
	SchwabClientCorrelID   string `json:"schwabClientCorrelId"`
	SchwabClientChannelID  string `json:"schwabClientChannelId"`
	SchwabClientFunctionID string `json:"schwabClientFunctionId"`
}

type TokenManager struct {
	mu               sync.RWMutex
	AccessToken      string    // Valid for 30 mins, held in memory
	AccessExpiresAt  time.Time // Expiration time for Access Token
	RefreshToken     string    
	RefreshExpiresAt time.Time 
	ClientID         string
	ClientSecret     string
	filePath         string

	cachedStreamerInfo *StreamerInfo

	refreshing  bool
	refreshChan chan error
}

type WSCommandPayload struct {
	Service    string                 `json:"service"`
	Command    string                 `json:"command"`
	Parameters map[string]interface{} `json:"parameters,omitempty"`
}

type SchwabWSManager struct {
	mu                     sync.Mutex
	conn                   *websocket.Conn
	clientCount            int
	subs                   map[string]WSCommandPayload
	sendChan               chan []byte
	broadcastChan          chan []byte
	isConnecting           bool
	isAuthenticated        bool
	schwabClientCustomerId string
	schwabClientCorrelId   string
	requestCounter         int64

	disconnectTimer *time.Timer
}

var (
	cfg        Config
	tokenMgr   *TokenManager
	wsMgr      *SchwabWSManager
	httpClient = &http.Client{Timeout: 15 * time.Second}
)

func main() {
	cfg.ClientID = os.Getenv("SCHWAB_CLIENT_ID")
	cfg.ClientSecret = os.Getenv("SCHWAB_CLIENT_SECRET")
	cfg.Port = os.Getenv("PORT")
	cfg.CertFile = os.Getenv("CERT_FILE")
	cfg.KeyFile = os.Getenv("KEY_FILE")
	cfg.WS_URL = os.Getenv("WS_URL")
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		log.Fatal("Error: SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET environment variables must be provided")
	}
	if cfg.Port == "" {
		cfg.Port = "2333"
	}

	if os.Getenv("ONLY_READ") == "false" || os.Getenv("ONLY_READ") == "0" {
		cfg.OnlyRead = false
		log.Println("Security Warning: ONLY_READ is false, /trader/ endpoint allows write/trade operations!")
	} else {
		cfg.OnlyRead = true
		log.Println("Security Mode: ONLY_READ is true, /trader/ endpoint allows GET requests only.")
	}

	tokenMgr = &TokenManager{
		ClientID:     cfg.ClientID,
		ClientSecret: cfg.ClientSecret,
		filePath:     "token.json",
	}
	tokenMgr.LoadFromFile()

	wsMgr = &SchwabWSManager{
		subs:          make(map[string]WSCommandPayload),
		sendChan:      make(chan []byte, 100),
		broadcastChan: make(chan []byte, 500),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", handleRouter)

	addr := ":" + cfg.Port
	log.Printf("Schwab Gate server starting, listening on port %s\n", cfg.Port)

	var err error
	if cfg.CertFile != "" && cfg.KeyFile != "" {
		log.Println("Enabling HTTPS transport mode")
		err = http.ListenAndServeTLS(addr, cfg.CertFile, cfg.KeyFile, mux)
	} else {
		log.Println("Warning: No certificates configured, using HTTP mode")
		err = http.ListenAndServe(addr, mux)
	}
	if err != nil {
		log.Fatalf("Server exited unexpectedly: %v", err)
	}
}

func handleRouter(w http.ResponseWriter, r *http.Request) {

	if r.Method == http.MethodOptions {
		return
	}

	path := r.URL.Path

	switch {
	case path == "/login":
		handleLogin(w, r)
	case path == "/":
		handleRootAndOAuth(w, r)
	case path == "/stream":
		handleSSEStream(w, r)
	case path == "/command":
		handleWSCommand(w, r)
	case strings.HasPrefix(path, "/marketdata/") || strings.HasPrefix(path, "/trader/"):
		handleProxy(w, r)
	default:
		http.Error(w, `{"error":"Not Found"}`, http.StatusNotFound)
	}
}

func getRedirectURI(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}

	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}

	uri := fmt.Sprintf("%s://%s", scheme, host)
	return strings.TrimSuffix(uri, "/")
}

func (tm *TokenManager) LoadFromFile() {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	file, err := os.Open(tm.filePath)
	if err != nil {
		log.Println("Notice: Local token.json not found, please visit /login for authorization.")
		return
	}
	defer file.Close()

	var tf TokenFile
	if err := json.NewDecoder(file).Decode(&tf); err != nil {
		log.Println("Warning: Failed to parse token.json:", err)
		return
	}

	tm.RefreshToken = tf.RefreshToken
	tm.RefreshExpiresAt = tf.RefreshExpiresAt

	if tm.RefreshToken == "" {
		log.Println("Notice: No Refresh Token found in token.json.")
		return
	}

	if time.Now().After(tm.RefreshExpiresAt) {
		log.Printf("Warning: Local Refresh Token has expired (expired at %s), please re-authorize via /login.\n", tm.RefreshExpiresAt.Format(time.RFC3339))
	} else {
		log.Printf("Successfully loaded Refresh Token from disk, valid until: %s\n", tm.RefreshExpiresAt.Format(time.RFC3339))
	}
}

func (tm *TokenManager) SaveToFile() {
	tf := TokenFile{
		RefreshToken:     tm.RefreshToken,
		RefreshExpiresAt: tm.RefreshExpiresAt,
	}

	data, err := json.MarshalIndent(tf, "", "  ")
	if err != nil {
		log.Println("Error: Failed to serialize token:", err)
		return
	}

	_ = os.WriteFile(tm.filePath, data, 0600)
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	callbackURI := getRedirectURI(r)

	authURL := fmt.Sprintf(
		"https://api.schwabapi.com/v1/oauth/authorize?client_id=%s&redirect_uri=%s",
		url.QueryEscape(cfg.ClientID),
		url.QueryEscape(callbackURI),
	)

	http.Redirect(w, r, authURL, http.StatusFound)
}

func handleRootAndOAuth(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if query.Has("code") {
		code := query.Get("code")
		if code == "" {
			http.Error(w, "Missing auth code", http.StatusBadRequest)
			return
		}

		redirectURI := getRedirectURI(r)
		err := tokenMgr.ExchangeCode(code, redirectURI)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"OAuth Error: %v"}`, err), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"success","message":"OAuth successful, refresh_token saved to disk."}`))
		return
	}

	tokenMgr.mu.RLock()
	hasToken := tokenMgr.RefreshToken != ""
	refreshExpires := tokenMgr.RefreshExpiresAt
	tokenMgr.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if hasToken {
		fmt.Fprintf(w, `{"status":"running","gateway":"Schwab-trading-terminal","authenticated":true,"refresh_token_expires_at":"%s"}`, refreshExpires.Format(time.RFC3339))
	} else {
		w.Write([]byte(`{"status":"running","gateway":"Schwab-trading-terminal","authenticated":false,"message":"Please visit /login to start Schwab OAuth."}`))
	}
}

func (tm *TokenManager) ExchangeCode(code, redirectURI string) error {
	data := url.Values{}
	data.Set("grant_type", "authorization_code")
	data.Set("code", code)
	data.Set("redirect_uri", redirectURI)

	return tm.requestToken(data, true)
}

func (tm *TokenManager) Refresh() error {
	tm.mu.RLock()
	refreshToken := tm.RefreshToken
	refreshExpiresAt := tm.RefreshExpiresAt
	tm.mu.RUnlock()

	if refreshToken == "" {
		return fmt.Errorf("no refresh token available")
	}

	if time.Now().After(refreshExpiresAt) {
		return fmt.Errorf("refresh token has expired (>7 days from initial authorization), re-authentication required")
	}

	data := url.Values{}
	data.Set("grant_type", "refresh_token")
	data.Set("refresh_token", refreshToken)

	return tm.requestToken(data, false)
}

func (tm *TokenManager) requestToken(data url.Values, isNewAuthorization bool) error {
	req, err := http.NewRequest(http.MethodPost, "https://api.schwabapi.com/v1/oauth/token", strings.NewReader(data.Encode()))
	if err != nil {
		return err
	}

	authStr := base64.StdEncoding.EncodeToString([]byte(tm.ClientID + ":" + tm.ClientSecret))
	req.Header.Set("Authorization", "Basic "+authStr)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("schwab token endpoint error (%d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}

	if err := json.Unmarshal(body, &result); err != nil {
		return err
	}

	tm.mu.Lock()
	tm.AccessToken = result.AccessToken
	tm.AccessExpiresAt = time.Now().Add(time.Duration(result.ExpiresIn-120) * time.Second)

	if result.RefreshToken != "" {
		tm.RefreshToken = result.RefreshToken
		if isNewAuthorization {
			tm.RefreshExpiresAt = time.Now().Add(7 * 24 * time.Hour)
		}
		tm.SaveToFile()
	}
	tm.mu.Unlock()

	log.Println("Access Token updated in memory, expires at:", tm.AccessExpiresAt)
	log.Printf("Refresh Token absolute expiration remains at: %s\n", tm.RefreshExpiresAt.Format(time.RFC3339))

	go tm.FetchAndCacheStreamerInfo()

	return nil
}

func (tm *TokenManager) FetchAndCacheStreamerInfo() {
	resp, err := DoSchwabHTTPRequest(http.MethodGet, "https://api.schwabapi.com/trader/v1/userPreference", nil)
	if err != nil {
		log.Println("Failed to pre-fetch userPreference:", err)
		return
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != http.StatusOK {
		log.Printf("Failed to read userPreference (status %d): %v\n", resp.StatusCode, err)
		return
	}

	var prefData struct {
		StreamerInfo []StreamerInfo `json:"streamerInfo"`
	}

	if err := json.Unmarshal(respBody, &prefData); err == nil && len(prefData.StreamerInfo) > 0 {
		tm.mu.Lock()
		tm.cachedStreamerInfo = &prefData.StreamerInfo[0]
		tm.mu.Unlock()
		log.Printf("Successfully pre-fetched and cached WebSocket configuration (URL: %s)\n", prefData.StreamerInfo[0].StreamerSocketURL)
	}
}

func (tm *TokenManager) GetValidToken() (string, error) {
	tm.mu.RLock()
	hasToken := tm.RefreshToken != ""
	refreshExpired := time.Now().After(tm.RefreshExpiresAt)
	hasAccess := tm.AccessToken != ""
	accessExpired := time.Now().After(tm.AccessExpiresAt)
	tm.mu.RUnlock()

	if !hasToken {
		return "", fmt.Errorf("unauthorized: please visit /login to complete oauth flow first")
	}

	if refreshExpired {
		return "", fmt.Errorf("refresh token expired (>7 days from initial auth): please visit /login to re-authenticate")
	}

	if hasAccess && !accessExpired {
		tm.mu.RLock()
		defer tm.mu.RUnlock()
		return tm.AccessToken, nil
	}

	tm.mu.Lock()

	hasAccess = tm.AccessToken != ""
	accessExpired = time.Now().After(tm.AccessExpiresAt)
	if hasAccess && !accessExpired {
		token := tm.AccessToken
		tm.mu.Unlock()
		return token, nil
	}

	if tm.refreshing {
		ch := tm.refreshChan
		tm.mu.Unlock()

		log.Println("Token is being refreshed by another request, waiting...")
		<-ch

		tm.mu.RLock()
		defer tm.mu.RUnlock()
		if tm.AccessToken == "" {
			return "", fmt.Errorf("token refresh failed while waiting")
		}
		return tm.AccessToken, nil
	}

	tm.refreshing = true
	tm.refreshChan = make(chan error)
	ch := tm.refreshChan
	tm.mu.Unlock()

	log.Println("Access Token expired or missing, refreshing synchronously...")
	err := tm.Refresh()

	tm.mu.Lock()
	tm.refreshing = false
	close(ch)
	tm.mu.Unlock()

	if err != nil {
		return "", fmt.Errorf("token refresh failed: %v", err)
	}

	tm.mu.RLock()
	defer tm.mu.RUnlock()
	return tm.AccessToken, nil
}

func DoSchwabHTTPRequest(method, targetURL string, body io.Reader, contentType ...string) (*http.Response, error) {
	token, err := tokenMgr.GetValidToken()
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(method, targetURL, body)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	var ct string
	if len(contentType) > 0 {
		ct = contentType[0]
	}

	if ct != "" {
		req.Header.Set("Content-Type", ct)
	} else if method == http.MethodPost || method == http.MethodPut {
		req.Header.Set("Content-Type", "application/json")
	}

	return httpClient.Do(req)
}

func handleProxy(w http.ResponseWriter, r *http.Request) {
	log.Println("[API] " + r.URL.Path)
	isTrader := strings.HasPrefix(r.URL.Path, "/trader/")

	if isTrader && cfg.OnlyRead && r.Method != http.MethodGet {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"error":"Forbidden: ONLY_READ mode is active, non-GET methods on /trader/ are blocked."}`))
		return
	}

	targetURL := "https://api.schwabapi.com" + r.URL.Path
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	var bodyBytes []byte
	if r.Body != nil {
		bodyBytes, _ = io.ReadAll(r.Body)
	}

	clientContentType := r.Header.Get("Content-Type")

	resp, err := DoSchwabHTTPRequest(r.Method, targetURL, bytes.NewReader(bodyBytes), clientContentType)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%v"}`, err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func handleSSEStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	wsMgr.mu.Lock()
	wsMgr.clientCount++
	currentClients := wsMgr.clientCount
	wsMgr.mu.Unlock()

	wsMgr.CancelCloseConnection()

	if currentClients == 1 {
		go wsMgr.StartBackgroundConnection()
	}

	clientChan := make(chan []byte, 50)
	done := make(chan struct{})
	defer close(done)

	go func() {
		for {
			select {
			case <-done:
				return
			case msg := <-wsMgr.broadcastChan:
				select {
				case clientChan <- msg:
				default:
				}
			}
		}
	}()

	fmt.Fprintf(w, "data: %s\n\n", `{"status":"sse_connected"}`)
	flusher.Flush()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			wsMgr.mu.Lock()
			wsMgr.clientCount--
			remaining := wsMgr.clientCount
			wsMgr.mu.Unlock()

			log.Printf("SSE client disconnected, remaining clients: %d\n", remaining)

			if remaining <= 0 {
				wsMgr.ScheduleCloseConnection()
			}
			return
		case msg := <-clientChan:
			fmt.Fprintf(w, "data: %s\n\n", string(msg))
			flusher.Flush()
		}
	}
}

func normalizeKeys(rawKeys string) string {
	parts := strings.Split(rawKeys, ",")
	seen := make(map[string]bool)
	var clean []string

	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed != "" && !seen[trimmed] {
			seen[trimmed] = true
			clean = append(clean, trimmed)
		}
	}

	sort.Strings(clean)
	return strings.Join(clean, ",")
}

func handleWSCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}

	var rawPayload map[string]interface{}
	if err := json.Unmarshal(body, &rawPayload); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	service, _ := rawPayload["service"].(string)
	command, _ := rawPayload["command"].(string)

	if strings.TrimSpace(service) == "" || strings.TrimSpace(command) == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"Mandatory fields 'service' and 'command' cannot be empty"}`))
		return
	}

	wsMgr.mu.Lock()
	if !wsMgr.isAuthenticated {
		wsMgr.mu.Unlock()
		log.Printf("[Blocked] Received command [%s:%s], but Schwab WS is not logged in yet (503)\n", service, command)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"error":"Schwab WebSocket is not logged in yet, please wait"}`))
		return
	}

	rawPayload["SchwabClientCustomerId"] = wsMgr.schwabClientCustomerId
	rawPayload["SchwabClientCorrelId"] = wsMgr.schwabClientCorrelId

	if val, ok := rawPayload["requestid"]; !ok || val == nil || fmt.Sprintf("%v", val) == "" {
		wsMgr.requestCounter++
		rawPayload["requestid"] = fmt.Sprintf("%d", wsMgr.requestCounter)
	}

	params, _ := rawPayload["parameters"].(map[string]interface{})
	var normalizedKeys string
	if params != nil {
		if k, ok := params["keys"].(string); ok {
			normalizedKeys = normalizeKeys(k)
		}
	}

	subKey := fmt.Sprintf("%s:%s", service, normalizedKeys)
	cmdUpper := strings.ToUpper(command)

	if strings.Contains(cmdUpper, "SUBS") && !strings.Contains(cmdUpper, "UNSUBS") {
		savedParams := make(map[string]interface{})
		for k, v := range params {
			savedParams[k] = v
		}

		wsMgr.subs[subKey] = WSCommandPayload{
			Service:    service,
			Command:    command,
			Parameters: savedParams,
		}
	} else if strings.Contains(cmdUpper, "UNSUBS") {
		delete(wsMgr.subs, subKey)
	}
	wsMgr.mu.Unlock()

	schwabEnvelope := map[string]interface{}{
		"requests": []interface{}{rawPayload},
	}
	envelopeBytes, _ := json.Marshal(schwabEnvelope)

	select {
	case wsMgr.sendChan <- envelopeBytes:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"command_sent"}`))
	default:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"error":"WebSocket send queue is full or disconnected"}`))
	}
}

func (wm *SchwabWSManager) StartBackgroundConnection() {
	wm.mu.Lock()
	if wm.isConnecting || wm.conn != nil {
		wm.mu.Unlock()
		return
	}
	wm.isConnecting = true
	wm.mu.Unlock()

	defer func() {
		wm.mu.Lock()
		wm.isConnecting = false
		wm.isAuthenticated = false
		wm.mu.Unlock()
	}()

	retryCount := 0
	for {
		wm.mu.Lock()
		if wm.clientCount <= 0 && wm.disconnectTimer == nil {
			wm.mu.Unlock()
			log.Println("All SSE clients offline and debounce timer expired. Stopping Schwab WebSocket connection.")
			return
		}
		wm.mu.Unlock()

		tokenMgr.mu.RLock()
		cachedInfo := tokenMgr.cachedStreamerInfo
		tokenMgr.mu.RUnlock()

		var info StreamerInfo
		if cachedInfo != nil {
			info = *cachedInfo
			log.Println("Using pre-cached Schwab WebSocket configuration.")
		} else {
			log.Println("No cached Streamer info found, fetching userPreference from Schwab API...")
			resp, err := DoSchwabHTTPRequest(http.MethodGet, "https://api.schwabapi.com/trader/v1/userPreference", nil)
			if err != nil {
				retryCount++
				backoff := time.Duration(min(retryCount*3, 30)) * time.Second
				log.Printf("Failed to fetch userPreference, retrying in %v: %v\n", backoff, err)
				time.Sleep(backoff)
				continue
			}

			respBody, _ := io.ReadAll(resp.Body)
			resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				retryCount++
				backoff := time.Duration(min(retryCount*3, 30)) * time.Second
				log.Printf("userPreference returned error status (%d): %s, retrying in %v\n", resp.StatusCode, string(respBody), backoff)
				time.Sleep(backoff)
				continue
			}

			var prefData struct {
				StreamerInfo []StreamerInfo `json:"streamerInfo"`
			}

			if err := json.Unmarshal(respBody, &prefData); err != nil || len(prefData.StreamerInfo) == 0 {
				log.Println("Failed to parse streamerInfo, retrying in 5s:", err)
				time.Sleep(5 * time.Second)
				continue
			}

			info = prefData.StreamerInfo[0]
			tokenMgr.mu.Lock()
			tokenMgr.cachedStreamerInfo = &info
			tokenMgr.mu.Unlock()
		}

		wm.mu.Lock()
		wm.schwabClientCustomerId = info.SchwabClientCustomerID
		wm.schwabClientCorrelId = info.SchwabClientCorrelID
		wm.mu.Unlock()

		wsURL := info.StreamerSocketURL
		if cfg.WS_URL != "" {
			wsURL = cfg.WS_URL
		}
		log.Println("Dialing Schwab WebSocket URL:", wsURL)

		conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			tokenMgr.mu.Lock()
			tokenMgr.cachedStreamerInfo = nil
			tokenMgr.mu.Unlock()

			retryCount++
			backoff := time.Duration(min(retryCount*3, 30)) * time.Second
			log.Printf("Schwab WebSocket dial failed, retrying in %v: %v\n", backoff, err)
			time.Sleep(backoff)
			continue
		}

		wm.mu.Lock()
		wm.conn = conn
		wm.mu.Unlock()

		token, err := tokenMgr.GetValidToken()
		if err != nil {
			log.Println("Failed to get Access Token for WS login:", err)
			conn.Close()
			wm.mu.Lock()
			wm.conn = nil
			wm.isAuthenticated = false
			wm.mu.Unlock()
			time.Sleep(5 * time.Second)
			continue
		}

		channelId := info.SchwabClientChannelID
		if channelId == "" {
			channelId = "N9"
		}
		functionId := info.SchwabClientFunctionID
		if functionId == "" {
			functionId = "APIAPP"
		}

		loginPayload := map[string]interface{}{
			"requests": []map[string]interface{}{
				{
					"service":                "ADMIN",
					"command":                "LOGIN",
					"requestid":              "0",
					"SchwabClientCustomerId": info.SchwabClientCustomerID,
					"SchwabClientCorrelId":   info.SchwabClientCorrelID,
					"parameters": map[string]interface{}{
						"Authorization":          token,
						"SchwabClientChannel":    channelId,
						"SchwabClientFunctionId": functionId,
					},
				},
			},
		}

		loginBytes, _ := json.Marshal(loginPayload)
		if err := conn.WriteMessage(websocket.TextMessage, loginBytes); err != nil {
			log.Println("Failed to send Schwab WS login payload:", err)
			conn.Close()
			wm.mu.Lock()
			wm.conn = nil
			wm.isAuthenticated = false
			wm.mu.Unlock()
			time.Sleep(3 * time.Second)
			continue
		}

		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, loginRespBytes, readErr := conn.ReadMessage()
		_ = conn.SetReadDeadline(time.Time{})

		if readErr != nil {
			log.Println("Timeout or connection closed waiting for login response:", readErr)
			conn.Close()
			wm.mu.Lock()
			wm.conn = nil
			wm.isAuthenticated = false
			wm.mu.Unlock()

			retryCount++
			backoff := time.Duration(min(retryCount*3, 30)) * time.Second
			time.Sleep(backoff)
			continue
		}

		respStr := string(loginRespBytes)
		log.Printf("Received Schwab login response: %s\n", respStr)
		if strings.Contains(respStr, "LOGIN_DENIED") || strings.Contains(respStr, "error") {
			log.Println("Schwab denied login. Clearing cached config and retrying in 10s...")
			tokenMgr.mu.Lock()
			tokenMgr.cachedStreamerInfo = nil
			tokenMgr.mu.Unlock()

			conn.Close()
			wm.mu.Lock()
			wm.conn = nil
			wm.isAuthenticated = false
			wm.mu.Unlock()
			time.Sleep(10 * time.Second)
			continue
		}

		retryCount = 0

		wm.mu.Lock()
		wm.isAuthenticated = true
		wm.mu.Unlock()

		wm.broadcastChan <- []byte(`{"status":"schwab_ws_connected_and_logged_in"}`)
		log.Println("Schwab WebSocket authentication succeeded!")

		go func(c *websocket.Conn) {
			time.Sleep(300 * time.Millisecond)

			wm.mu.Lock()
			defer wm.mu.Unlock()

			defaultSubKey := "ACCT_ACTIVITY:Account Activity"
			if _, exists := wm.subs[defaultSubKey]; !exists {
				wm.subs[defaultSubKey] = WSCommandPayload{
					Service: "ACCT_ACTIVITY",
					Command: "SUBS",
					Parameters: map[string]interface{}{
						"keys":   "Account Activity",
						"fields": "0,1,2,3",
					},
				}
			}

			for _, sub := range wm.subs {
				wm.requestCounter++
				payload := map[string]interface{}{
					"service":                sub.Service,
					"command":                sub.Command,
					"requestid":              fmt.Sprintf("%d", wm.requestCounter),
					"SchwabClientCustomerId": wm.schwabClientCustomerId,
					"SchwabClientCorrelId":   wm.schwabClientCorrelId,
					"parameters":             sub.Parameters,
				}

				env := map[string]interface{}{"requests": []interface{}{payload}}
				if b, err := json.Marshal(env); err == nil {
					_ = c.WriteMessage(websocket.TextMessage, b)
					log.Printf("Auto-subscribed to service [%s:%s]\n", sub.Service, sub.Parameters["keys"])
				}
			}
		}(conn)

		stopWrite := make(chan struct{})
		go func() {
			for {
				select {
				case <-stopWrite:
					return
				case msg := <-wm.sendChan:
					wm.mu.Lock()
					if wm.conn != nil {
						_ = wm.conn.WriteMessage(websocket.TextMessage, msg)
					}
					wm.mu.Unlock()
				}
			}
		}()

		for {
			wm.mu.Lock()
			if wm.clientCount <= 0 && wm.disconnectTimer == nil {
				wm.mu.Unlock()
				log.Println("All clients offline and debounce timer expired. Closing WS gracefully.")
				close(stopWrite)
				conn.Close()
				return
			}
			wm.mu.Unlock()

			_, message, err := conn.ReadMessage()
			if err != nil {
				log.Println("Schwab WS read error or connection lost:", err)
				close(stopWrite)

				wm.mu.Lock()
				wm.isAuthenticated = false
				wm.mu.Unlock()

				wm.broadcastChan <- []byte(`{"status":"schwab_ws_disconnected"}`)
				break
			}
			wm.broadcastChan <- message
		}

		wm.mu.Lock()
		wm.isAuthenticated = false
		if wm.conn != nil {
			wm.conn.Close()
			wm.conn = nil
		}
		wm.mu.Unlock()

		wm.mu.Lock()
		if wm.clientCount <= 0 && wm.disconnectTimer == nil {
			wm.mu.Unlock()
			return
		}
		wm.mu.Unlock()

		log.Println("Schwab WS disconnected, attempting reconnect in 3s...")
		time.Sleep(3 * time.Second)
	}
}

func (wm *SchwabWSManager) ScheduleCloseConnection() {
	wm.mu.Lock()
	defer wm.mu.Unlock()

}

func (wm *SchwabWSManager) CancelCloseConnection() {
	wm.mu.Lock()
	defer wm.mu.Unlock()

	if wm.disconnectTimer != nil {
		wm.disconnectTimer.Stop()
		wm.disconnectTimer = nil
		log.Println("Active SSE client reconnected. Debounce timer canceled.")
	}
}