// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package im

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/larksuite/cli/shortcuts/common"
	"github.com/spf13/cobra"
)

func TestImMessagesSearchSupportsUserAndBotIdentity(t *testing.T) {
	if !stringSliceContains(ImMessagesSearch.AuthTypes, "user") {
		t.Fatalf("ImMessagesSearch.AuthTypes = %v, want user support", ImMessagesSearch.AuthTypes)
	}
	if !stringSliceContains(ImMessagesSearch.AuthTypes, "bot") {
		t.Fatalf("ImMessagesSearch.AuthTypes = %v, want bot support for tenant access token", ImMessagesSearch.AuthTypes)
	}
}

func newMessagesSearchRuntime(t *testing.T, stringFlags map[string]string, boolFlags map[string]bool, rt http.RoundTripper) *common.RuntimeContext {
	t.Helper()

	runtime := newBotShortcutRuntime(t, rt)
	cmd := &cobra.Command{Use: "test"}

	stringFlagNames := []string{"query", "page-token", "at-chatter-ids", "start", "end"}
	for _, name := range stringFlagNames {
		cmd.Flags().String(name, "", "")
	}
	cmd.Flags().Int("page-size", 20, "")
	cmd.Flags().Int("page-limit", 20, "")
	boolFlagNames := []string{"page-all", "no-reactions"}
	for _, name := range boolFlagNames {
		cmd.Flags().Bool(name, false, "")
	}
	if err := cmd.ParseFlags(nil); err != nil {
		t.Fatalf("ParseFlags() error = %v", err)
	}
	for name, value := range stringFlags {
		if err := cmd.Flags().Set(name, value); err != nil {
			t.Fatalf("Flags().Set(%q) error = %v", name, err)
		}
	}
	for name, value := range boolFlags {
		if err := cmd.Flags().Set(name, map[bool]string{true: "true", false: "false"}[value]); err != nil {
			t.Fatalf("Flags().Set(%q) error = %v", name, err)
		}
	}
	runtime.Cmd = cmd
	runtime.Format = "pretty"
	return runtime
}

func TestImMessagesSearchNormalizesLooseTimeFlags(t *testing.T) {
	// 日报技能会把消息展示用的 create_time（"2026-11-10 11:18"）直接塞进
	// --start。飞书搜索 API 对这种格式返回 99992402，模型得白跑一轮才猜到
	// 改成 ISO 8601。请求体必须由本地解析结果规范化，不能原样透传。
	runtime := newMessagesSearchRuntime(t, map[string]string{
		"query": "",
		"start": "2026-11-10 10:31",
		"end":   "2026-11-10 14:20:01",
	}, nil, nil)

	req, err := buildMessagesSearchRequest(runtime)
	if err != nil {
		t.Fatalf("buildMessagesSearchRequest() error = %v", err)
	}
	filter, ok := req.body["filter"].(map[string]interface{})
	if !ok {
		t.Fatalf("body has no filter: %#v", req.body)
	}
	timeRange, ok := filter["time_range"].(map[string]interface{})
	if !ok {
		t.Fatalf("filter has no time_range: %#v", filter)
	}

	for flag, tc := range map[string]struct {
		input  string
		layout string
	}{
		"start_time": {"2026-11-10 10:31", "2006-01-02 15:04"},
		"end_time":   {"2026-11-10 14:20:01", "2006-01-02 15:04:05"},
	} {
		parsed, err := time.ParseInLocation(tc.layout, tc.input, time.Local)
		if err != nil {
			t.Fatalf("ParseInLocation(%q) error = %v", tc.input, err)
		}
		want := parsed.Format(time.RFC3339)
		if got, _ := timeRange[flag].(string); got != want {
			t.Errorf("%s = %q, want RFC3339 %q", flag, got, want)
		}
	}

	// 已经是 RFC3339 的输入必须保持原样，不能改变既有正确调用。
	runtime = newMessagesSearchRuntime(t, map[string]string{
		"start": "2026-11-10T11:18:00+08:00",
	}, nil, nil)
	req, err = buildMessagesSearchRequest(runtime)
	if err != nil {
		t.Fatalf("buildMessagesSearchRequest() error = %v", err)
	}
	timeRange = req.body["filter"].(map[string]interface{})["time_range"].(map[string]interface{})
	if got, _ := timeRange["start_time"].(string); !strings.HasPrefix(got, "2026-11-10T11:18:00") {
		t.Errorf("RFC3339 input was rewritten to %q", got)
	}
}

func TestImMessagesSearchSourceLabelStaysWithItsOwnMessage(t *testing.T) {
	// 日报里出现过「天策研发群钟瑾@你」：群名取到了同一批结果里另一条消息
	// 的 chat_name。source_label 必须由每条消息自己的 chat_id / sender 拼出。
	runtime := newMessagesSearchRuntime(t, map[string]string{"query": ""},
		map[string]bool{"no-reactions": true},
		shortcutRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			switch {
			case strings.Contains(req.URL.Path, "/open-apis/im/v1/messages/search"):
				return shortcutJSONResponse(200, map[string]interface{}{
					"code": 0,
					"data": map[string]interface{}{
						"items": []interface{}{
							map[string]interface{}{"meta_data": map[string]interface{}{"message_id": "om_a"}},
							map[string]interface{}{"meta_data": map[string]interface{}{"message_id": "om_b"}},
						},
						"has_more": false,
					},
				}), nil
			case strings.Contains(req.URL.Path, "/open-apis/im/v1/messages/mget"):
				items := make([]interface{}, 0, 2)
				for _, id := range req.URL.Query()["message_ids"] {
					chatID, name := "oc_a", "钟瑾"
					if id == "om_b" {
						chatID, name = "oc_b", "卿红斌"
					}
					items = append(items, map[string]interface{}{
						"message_id":  id,
						"msg_type":    "text",
						"create_time": "1710000000",
						"chat_id":     chatID,
						"sender": map[string]interface{}{
							"id": "ou_" + name, "name": name, "sender_type": "user",
						},
						"body": map[string]interface{}{"content": `{"text":"ping"}`},
					})
				}
				return shortcutJSONResponse(200, map[string]interface{}{
					"code": 0,
					"data":  map[string]interface{}{"items": items},
				}), nil
			case strings.Contains(req.URL.Path, "/open-apis/im/v1/chats/batch_query"):
				return shortcutJSONResponse(200, map[string]interface{}{
					"code": 0,
					"data": map[string]interface{}{
						"items": []interface{}{
							map[string]interface{}{"chat_id": "oc_a", "chat_mode": "group", "name": "屯数看数能力移植到汤圆"},
							map[string]interface{}{"chat_id": "oc_b", "chat_mode": "group", "name": "天策研发群(2025)"},
						},
					},
				}), nil
			default:
				return nil, fmt.Errorf("unexpected request: %s", req.URL.String())
			}
		}))
	runtime.Format = "json"

	if err := ImMessagesSearch.Execute(context.Background(), runtime); err != nil {
		t.Fatalf("ImMessagesSearch.Execute() error = %v", err)
	}

	outBuf, _ := runtime.Factory.IOStreams.Out.(*bytes.Buffer)
	if outBuf == nil {
		t.Fatal("stdout buffer missing")
	}
	var envelope map[string]interface{}
	if err := json.Unmarshal(outBuf.Bytes(), &envelope); err != nil {
		t.Fatalf("output is not JSON (%v): %s", err, outBuf.String())
	}
	data, _ := envelope["data"].(map[string]interface{})
	if data == nil {
		data = envelope
	}
	messages, _ := data["messages"].([]interface{})
	if len(messages) != 2 {
		t.Fatalf("messages = %d, want 2; output=%s", len(messages), outBuf.String())
	}
	want := map[string]string{
		"om_a": "屯数看数能力移植到汤圆 · 钟瑾",
		"om_b": "天策研发群(2025) · 卿红斌",
	}
	for _, raw := range messages {
		m, _ := raw.(map[string]interface{})
		id, _ := m["message_id"].(string)
		if got, _ := m["source_label"].(string); got != want[id] {
			t.Errorf("message %s source_label = %q, want %q", id, got, want[id])
		}
	}
}

func TestMessageSourceLabelHandlesP2PAndMissingNames(t *testing.T) {
	cases := []struct {
		name string
		msg  map[string]interface{}
		want string
	}{
		{"group", map[string]interface{}{
			"chat_name": "技术中台域&AI创新实验室",
			"sender":    map[string]interface{}{"name": "贺世博"},
		}, "技术中台域&AI创新实验室 · 贺世博"},
		{"p2p", map[string]interface{}{
			"chat_type": "p2p",
			"sender":    map[string]interface{}{"name": "赵言"},
		}, "私聊 · 赵言"},
		{"no chat name", map[string]interface{}{
			"sender": map[string]interface{}{"name": "钟瑾"},
		}, "钟瑾"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := messageSourceLabel(tc.msg); got != tc.want {
				t.Errorf("source_label = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestImMessagesSearchExecuteAutoPaginationBatches(t *testing.T) {
	var (
		searchPageTokens []string
		mgetBatchSizes   []int
		chatBatchSizes   []int
	)

	runtime := newMessagesSearchRuntime(t, map[string]string{
		"query":      "incident",
		"page-limit": "2",
	}, map[string]bool{
		"page-all": true,
	}, shortcutRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch {
		case strings.Contains(req.URL.Path, "/open-apis/im/v1/messages/search"):
			pageToken := req.URL.Query().Get("page_token")
			searchPageTokens = append(searchPageTokens, pageToken)
			switch pageToken {
			case "":
				return shortcutJSONResponse(200, map[string]interface{}{
					"code": 0,
					"data": map[string]interface{}{
						"items":      buildSearchResultItems(1, 50),
						"has_more":   true,
						"page_token": "tok_p2",
					},
				}), nil
			case "tok_p2":
				return shortcutJSONResponse(200, map[string]interface{}{
					"code": 0,
					"data": map[string]interface{}{
						"items":      buildSearchResultItems(51, 55),
						"has_more":   true,
						"page_token": "tok_p3",
					},
				}), nil
			default:
				return nil, fmt.Errorf("unexpected search page_token: %q", pageToken)
			}
		case strings.Contains(req.URL.Path, "/open-apis/im/v1/messages/mget"):
			ids := req.URL.Query()["message_ids"]
			mgetBatchSizes = append(mgetBatchSizes, len(ids))
			return shortcutJSONResponse(200, map[string]interface{}{
				"code": 0,
				"data": map[string]interface{}{
					"items": buildMessageDetails(ids),
				},
			}), nil
		case strings.Contains(req.URL.Path, "/open-apis/im/v1/chats/batch_query"):
			var body struct {
				ChatIDs []string `json:"chat_ids"`
			}
			rawBody, err := io.ReadAll(req.Body)
			if err != nil {
				t.Fatalf("ReadAll() error = %v", err)
			}
			if err := json.Unmarshal(rawBody, &body); err != nil {
				t.Fatalf("json.Unmarshal() error = %v", err)
			}
			chatBatchSizes = append(chatBatchSizes, len(body.ChatIDs))
			return shortcutJSONResponse(200, map[string]interface{}{
				"code": 0,
				"data": map[string]interface{}{
					"items": buildChatContexts(body.ChatIDs),
				},
			}), nil
		default:
			return nil, fmt.Errorf("unexpected request: %s", req.URL.String())
		}
	}))

	if err := ImMessagesSearch.Execute(context.Background(), runtime); err != nil {
		t.Fatalf("ImMessagesSearch.Execute() error = %v", err)
	}

	if !reflect.DeepEqual(searchPageTokens, []string{"", "tok_p2"}) {
		t.Fatalf("search page tokens = %#v, want %#v", searchPageTokens, []string{"", "tok_p2"})
	}
	if !reflect.DeepEqual(mgetBatchSizes, []int{50, 5}) {
		t.Fatalf("mget batch sizes = %#v, want %#v", mgetBatchSizes, []int{50, 5})
	}
	if !reflect.DeepEqual(chatBatchSizes, []int{50, 5}) {
		t.Fatalf("chat batch sizes = %#v, want %#v", chatBatchSizes, []int{50, 5})
	}

	outBuf, _ := runtime.Factory.IOStreams.Out.(*bytes.Buffer)
	if outBuf == nil {
		t.Fatal("stdout buffer missing")
	}
	output := outBuf.String()
	if !strings.Contains(output, "55 search result(s)") {
		t.Fatalf("stdout = %q, want search results summary", output)
	}
	if !strings.Contains(output, "warning: stopped after fetching 2 page(s)") {
		t.Fatalf("stdout = %q, want page limit warning", output)
	}
}

func TestImMessagesSearchExecuteExplicitPageLimitWithoutPageAll(t *testing.T) {
	var searchCalls int

	runtime := newMessagesSearchRuntime(t, map[string]string{
		"query":      "incident",
		"page-limit": "2",
	}, nil, shortcutRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch {
		case strings.Contains(req.URL.Path, "/open-apis/im/v1/messages/search"):
			searchCalls++
			pageToken := req.URL.Query().Get("page_token")
			if searchCalls == 1 {
				if pageToken != "" {
					return nil, fmt.Errorf("unexpected first page token: %q", pageToken)
				}
				return shortcutJSONResponse(200, map[string]interface{}{
					"code": 0,
					"data": map[string]interface{}{
						"items":      buildSearchResultItems(1, 1),
						"has_more":   true,
						"page_token": "tok_p2",
					},
				}), nil
			}
			if pageToken != "tok_p2" {
				return nil, fmt.Errorf("unexpected second page token: %q", pageToken)
			}
			return shortcutJSONResponse(200, map[string]interface{}{
				"code": 0,
				"data": map[string]interface{}{
					"items":      buildSearchResultItems(2, 2),
					"has_more":   false,
					"page_token": "",
				},
			}), nil
		case strings.Contains(req.URL.Path, "/open-apis/im/v1/messages/mget"):
			ids := req.URL.Query()["message_ids"]
			return shortcutJSONResponse(200, map[string]interface{}{
				"code": 0,
				"data": map[string]interface{}{
					"items": buildMessageDetails(ids),
				},
			}), nil
		case strings.Contains(req.URL.Path, "/open-apis/im/v1/chats/batch_query"):
			var body struct {
				ChatIDs []string `json:"chat_ids"`
			}
			rawBody, err := io.ReadAll(req.Body)
			if err != nil {
				t.Fatalf("ReadAll() error = %v", err)
			}
			if err := json.Unmarshal(rawBody, &body); err != nil {
				t.Fatalf("json.Unmarshal() error = %v", err)
			}
			return shortcutJSONResponse(200, map[string]interface{}{
				"code": 0,
				"data": map[string]interface{}{
					"items": buildChatContexts(body.ChatIDs),
				},
			}), nil
		default:
			return nil, fmt.Errorf("unexpected request: %s", req.URL.String())
		}
	}))

	if err := ImMessagesSearch.Execute(context.Background(), runtime); err != nil {
		t.Fatalf("ImMessagesSearch.Execute() error = %v", err)
	}
	if searchCalls != 2 {
		t.Fatalf("searchCalls = %d, want 2", searchCalls)
	}
}

func buildSearchResultItems(start, end int) []interface{} {
	items := make([]interface{}, 0, end-start+1)
	for i := start; i <= end; i++ {
		items = append(items, map[string]interface{}{
			"meta_data": map[string]interface{}{
				"message_id": fmt.Sprintf("om_%03d", i),
			},
		})
	}
	return items
}

func buildMessageDetails(ids []string) []interface{} {
	items := make([]interface{}, 0, len(ids))
	for _, id := range ids {
		suffix := strings.TrimPrefix(id, "om_")
		items = append(items, map[string]interface{}{
			"message_id":  id,
			"msg_type":    "text",
			"create_time": "1710000000",
			"chat_id":     "oc_" + suffix,
			"sender": map[string]interface{}{
				"id":          "cli_bot",
				"name":        "Bot",
				"sender_type": "bot",
			},
			"body": map[string]interface{}{
				"content": fmt.Sprintf(`{"text":"message %s"}`, suffix),
			},
		})
	}
	return items
}

func buildChatContexts(chatIDs []string) []interface{} {
	items := make([]interface{}, 0, len(chatIDs))
	for _, chatID := range chatIDs {
		items = append(items, map[string]interface{}{
			"chat_id":   chatID,
			"chat_mode": "group",
			"name":      "Chat " + strings.TrimPrefix(chatID, "oc_"),
		})
	}
	return items
}

func stringSliceContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
