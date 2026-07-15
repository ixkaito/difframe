// ポップアップ UI。content script にコマンドを送って state を編集する。
const $ = (id) => document.getElementById(id);
const els = {
  enabled: $("enabled"),
  scopeKey: $("scopeKey"),
  presetSelect: $("presetSelect"),
  presetAdd: $("presetAdd"),
  presetDup: $("presetDup"),
  presetDel: $("presetDel"),
  presetFields: $("presetFields"),
  name: $("name"),
  url: $("url"),
  opacity: $("opacity"),
  opacityVal: $("opacityVal"),
  scale: $("scale"),
  scaleVal: $("scaleVal"),
  width: $("width"),
  height: $("height"),
  x: $("x"),
  y: $("y"),
  lock: $("lock"),
  moveMode: $("moveMode"),
  blend: $("blend")
};

let tabId = null;
let data = null; // { store, key, binding, activePresetId }

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureInjected(id) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId: id }, files: ["content.css"] });
  } catch (_) {}
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

async function refresh() {
  data = await send({ type: "getData" });
  fill();
}

function activePreset() {
  if (!data) return null;
  return data.store.presets.find((p) => p.id === data.activePresetId) || null;
}

function fill() {
  if (!data) return;
  const { store, key } = data;
  els.enabled.checked = !!(data.binding && data.binding.enabled);
  els.scopeKey.textContent = key;

  for (const r of document.querySelectorAll('input[name="scope"]')) {
    r.checked = r.value === store.settings.scope;
  }
  els.lock.checked = store.settings.lock;
  els.moveMode.checked = store.settings.moveMode;

  // プリセット一覧
  els.presetSelect.innerHTML = "";
  if (store.presets.length === 0) {
    const o = document.createElement("option");
    o.textContent = "(プリセットなし — 表示ONで自動作成)";
    o.value = "";
    els.presetSelect.appendChild(o);
  }
  for (const p of store.presets) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name || "(無名)";
    els.presetSelect.appendChild(o);
  }
  const p = activePreset();
  if (p) els.presetSelect.value = p.id;

  const disabled = !p;
  els.presetFields.disabled = disabled;
  els.presetDup.disabled = disabled;
  els.presetDel.disabled = disabled;
  if (p) {
    els.name.value = p.name;
    els.url.value = p.url;
    els.opacity.value = p.opacity;
    els.opacityVal.textContent = p.opacity;
    els.scale.value = p.scale;
    els.scaleVal.textContent = "×" + p.scale;
    els.width.value = p.width;
    els.height.value = p.height;
    els.x.value = p.x;
    els.y.value = p.y;
    els.blend.value = p.blend;
  }
}

function patchPreset(patch) {
  const p = activePreset();
  if (!p) return;
  send({ type: "updatePreset", presetId: p.id, patch }).then(refresh);
}

function setSettings(patch) {
  send({ type: "setSettings", patch }).then(refresh);
}

// ---- イベント ----
els.enabled.addEventListener("change", () =>
  send({ type: "setEnabled", enabled: els.enabled.checked }).then(refresh)
);

for (const r of document.querySelectorAll('input[name="scope"]')) {
  r.addEventListener("change", () => {
    if (r.checked) setSettings({ scope: r.value });
  });
}

els.presetSelect.addEventListener("change", () => {
  if (els.presetSelect.value) send({ type: "selectPreset", presetId: els.presetSelect.value }).then(refresh);
});
els.presetAdd.addEventListener("click", () =>
  send({ type: "addPreset", preset: { name: "新規プリセット" } }).then(refresh)
);
els.presetDup.addEventListener("click", () => {
  const p = activePreset();
  if (p) send({ type: "duplicatePreset", presetId: p.id }).then(refresh);
});
els.presetDel.addEventListener("click", () => {
  const p = activePreset();
  if (p && confirm(`プリセット「${p.name}」を削除しますか？`))
    send({ type: "deletePreset", presetId: p.id }).then(refresh);
});

els.name.addEventListener("change", () => patchPreset({ name: els.name.value }));
els.url.addEventListener("change", () => patchPreset({ url: els.url.value.trim() }));
els.url.addEventListener("keydown", (e) => {
  if (e.key === "Enter") patchPreset({ url: els.url.value.trim() });
});
els.opacity.addEventListener("input", () => {
  els.opacityVal.textContent = els.opacity.value;
  patchPreset({ opacity: parseFloat(els.opacity.value) });
});
els.scale.addEventListener("input", () => {
  els.scaleVal.textContent = "×" + els.scale.value;
  patchPreset({ scale: parseFloat(els.scale.value) });
});
els.width.addEventListener("change", () => patchPreset({ width: parseInt(els.width.value, 10) || 0 }));
els.height.addEventListener("change", () => patchPreset({ height: parseInt(els.height.value, 10) || 0 }));
els.x.addEventListener("change", () => patchPreset({ x: parseInt(els.x.value, 10) || 0 }));
els.y.addEventListener("change", () => patchPreset({ y: parseInt(els.y.value, 10) || 0 }));
els.blend.addEventListener("change", () => patchPreset({ blend: els.blend.value }));
els.lock.addEventListener("change", () => setSettings({ lock: els.lock.checked }));
els.moveMode.addEventListener("change", () => setSettings({ moveMode: els.moveMode.checked }));

(async () => {
  const tab = await activeTab();
  tabId = tab.id;
  await ensureInjected(tabId);
  await refresh();
})();
