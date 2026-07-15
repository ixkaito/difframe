// Frame-blocking レスポンスヘッダを剥がして任意サイトを iframe 表示可能にする。
// sub_frame のみ対象なのでトップレベルのナビゲーションには影響しない。
const RULE_ID = 1;

const stripRule = {
  id: RULE_ID,
  priority: 1,
  action: {
    type: "modifyHeaders",
    responseHeaders: [
      { header: "x-frame-options", operation: "remove" },
      { header: "frame-options", operation: "remove" },
      { header: "content-security-policy", operation: "remove" },
      { header: "content-security-policy-report-only", operation: "remove" }
    ]
  },
  condition: {
    resourceTypes: ["sub_frame"]
  }
};

async function setHeaderStripping(enabled) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: enabled ? [stripRule] : []
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "setHeaderStripping") {
    setHeaderStripping(!!msg.enabled)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
});

// 起動時はオフから始める（不要な副作用を避ける）。
chrome.runtime.onStartup.addListener(() => setHeaderStripping(false));
chrome.runtime.onInstalled.addListener(() => setHeaderStripping(false));
