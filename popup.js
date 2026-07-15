// ポップアップ UI。content script の state を読み書きする。
const els = {
  enabled: document.getElementById("enabled"),
  url: document.getElementById("url"),
  load: document.getElementById("load"),
  opacity: document.getElementById("opacity"),
  opacityVal: document.getElementById("opacityVal"),
  scale: document.getElementById("scale"),
  scaleVal: document.getElementById("scaleVal"),
  width: document.getElementById("width"),
  height: document.getElementById("height"),
  x: document.getElementById("x"),
  y: document.getElementById("y"),
  lock: document.getElementById("lock"),
  moveMode: document.getElementById("moveMode"),
  blend: document.getElementById("blend")
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureInjected(tabId) {
  // content script が未注入のページ用フォールバック（reload 直後など）
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  } catch (_) {}
}

async function getState() {
  const tab = await activeTab();
  await ensureInjected(tab.id);
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "getState" }, (res) => {
      if (chrome.runtime.lastError || !res) resolve(null);
      else resolve(res);
    });
  });
}

async function patch(p) {
  const tab = await activeTab();
  chrome.tabs.sendMessage(tab.id, { type: "updateState", patch: p });
}

function fill(state) {
  if (!state) return;
  els.enabled.checked = state.enabled;
  els.url.value = state.url;
  els.opacity.value = state.opacity;
  els.opacityVal.textContent = state.opacity;
  els.scale.value = state.scale;
  els.scaleVal.textContent = "×" + state.scale;
  els.width.value = state.width;
  els.height.value = state.height;
  els.x.value = state.x;
  els.y.value = state.y;
  els.lock.checked = state.lock;
  els.moveMode.checked = state.moveMode;
  els.blend.value = state.blend;
}

els.enabled.addEventListener("change", () => patch({ enabled: els.enabled.checked }));
els.load.addEventListener("click", () => patch({ url: els.url.value.trim(), enabled: true }));
els.url.addEventListener("keydown", (e) => {
  if (e.key === "Enter") patch({ url: els.url.value.trim(), enabled: true });
});
els.opacity.addEventListener("input", () => {
  els.opacityVal.textContent = els.opacity.value;
  patch({ opacity: parseFloat(els.opacity.value) });
});
els.scale.addEventListener("input", () => {
  els.scaleVal.textContent = "×" + els.scale.value;
  patch({ scale: parseFloat(els.scale.value) });
});
els.width.addEventListener("change", () => patch({ width: parseInt(els.width.value, 10) || 0 }));
els.height.addEventListener("change", () => patch({ height: parseInt(els.height.value, 10) || 0 }));
els.x.addEventListener("change", () => patch({ x: parseInt(els.x.value, 10) || 0 }));
els.y.addEventListener("change", () => patch({ y: parseInt(els.y.value, 10) || 0 }));
els.lock.addEventListener("change", () => patch({ lock: els.lock.checked }));
els.moveMode.addEventListener("change", () => patch({ moveMode: els.moveMode.checked }));
els.blend.addEventListener("change", () => patch({ blend: els.blend.value }));

getState().then(fill);
