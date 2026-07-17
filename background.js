// Frame-blocking レスポンスヘッダを剥がして任意サイトを iframe 表示可能にする。
// セッションルール + tabIds 条件で「オーバーレイが有効なタブ」だけに適用し、
// 他タブの閲覧（CSP 等の保護）には一切影響しないようにする。
// sub_frame のみ対象なのでトップレベルのナビゲーションには影響しない。

// タブ ID は 0 の可能性があるが、ルール ID は 1 以上が必要なので +1 する。
function ruleIdFor(tabId) {
  return tabId + 1;
}

function stripRuleForTab(tabId) {
  return {
    id: ruleIdFor(tabId),
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
      resourceTypes: ["sub_frame"],
      tabIds: [tabId]
    }
  };
}

async function setHeaderStripping(tabId, enabled) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleIdFor(tabId)],
    addRules: enabled ? [stripRuleForTab(tabId)] : []
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "setHeaderStripping") {
    const tabId = sender.tab?.id;
    if (tabId == null || tabId < 0) {
      sendResponse({ ok: false, error: "no tab" });
      return;
    }
    setHeaderStripping(tabId, !!msg.enabled)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
});

// タブを閉じたらそのタブのルールも削除（セッションルールは
// ブラウザ再起動でも自動的に消えるので、残留の心配はない）。
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [ruleIdFor(tabId)] })
    .catch(() => {});
});

// 旧バージョンが残した「全体適用」のダイナミックルールを掃除する。
async function cleanupLegacyDynamicRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id)
    });
  }
}
chrome.runtime.onInstalled.addListener(cleanupLegacyDynamicRules);
chrome.runtime.onStartup.addListener(cleanupLegacyDynamicRules);
