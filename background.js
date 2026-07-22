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

// Chrome にはテーマ対応アイコンの仕組みが無いため、content script から届く
// prefers-color-scheme に応じて setIcon で黒/白アイコンを切り替える。
// Firefox は manifest の theme_icons が担当しており、setIcon を呼ぶと
// theme_icons を上書きしてしまうため何もしない。
// 注意: Chrome 148+ は `browser` 名前空間を持つため typeof browser では
// 判定できない。Firefox 専用 API の有無で判定する。
const IS_FIREFOX =
  typeof browser !== "undefined" &&
  typeof browser.runtime?.getBrowserInfo === "function";

function updateActionIcon(dark) {
  if (IS_FIREFOX) return;
  const name = dark ? "icon-light" : "icon"; // ダークテーマには白アイコン
  chrome.action
    .setIcon({
      path: {
        16: `icons/${name}-16.png`,
        32: `icons/${name}-32.png`,
        48: `icons/${name}-48.png`,
        128: `icons/${name}-128.png`
      }
    })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "setColorScheme") {
    updateActionIcon(!!msg.dark);
    return;
  }
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
