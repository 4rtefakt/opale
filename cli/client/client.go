package client

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	BaseURL string
	Token   string
	http    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: baseURL,
		Token:   token,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) do(method, path string, body any) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, r)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	return c.http.Do(req)
}

func (c *Client) Get(path string, out any) error {
	resp, err := c.do("GET", path, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return decode(resp, out)
}

func (c *Client) Post(path string, body, out any) error {
	resp, err := c.do("POST", path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return decode(resp, out)
}

// Patch sends a PATCH request and decodes the JSON response into out (may be nil).
func (c *Client) Patch(path string, body, out any) error {
	resp, err := c.do("PATCH", path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return decode(resp, out)
}

// PostStream sends a POST and calls onEvent for each SSE "data:" line.
// Return false from onEvent to stop early.
func (c *Client) PostStream(path string, body any, onEvent func([]byte) bool) error {
	resp, err := c.do("POST", path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return apiErr(resp)
	}
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := []byte(strings.TrimPrefix(line, "data: "))
		if !onEvent(data) {
			return nil
		}
	}
	return sc.Err()
}

func (c *Client) Delete(path string) error {
	resp, err := c.do("DELETE", path, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return apiErr(resp)
	}
	return nil
}

func decode(resp *http.Response, out any) error {
	if resp.StatusCode >= 300 {
		return apiErr(resp)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("erreur API %d: %s", e.Status, e.Message)
}

func apiErr(resp *http.Response) error {
	var body struct {
		Error string `json:"error"`
	}
	data, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(data, &body)
	msg := body.Error
	if msg == "" {
		msg = string(data)
	}
	return &APIError{Status: resp.StatusCode, Message: msg}
}
