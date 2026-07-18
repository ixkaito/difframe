// ポップアップ UI。content script にコマンドを送って state を編集する。
const $ = (id) => document.getElementById(id);
const els = {
  enabled: $("enabled"),
  scopeKey: $("scopeKey"),
  scopeSeg: $("scopeSeg"),
  presetSelect: $("presetSelect"),
  presetAdd: $("presetAdd"),
  presetDup: $("presetDup"),
  presetDel: $("presetDel"),
  tabPin: $("tabPin"),
  emptyState: $("emptyState"),
  fields: $("fields"),
  name: $("name"),
  url: $("url"),
  opacity: $("opacity"),
  opacityNum: $("opacityNum"),
  scale: $("scale"),
  scaleNum: $("scaleNum"),
  width: $("width"),
  height: $("height"),
  x: $("x"),
  y: $("y"),
  targetSeg: $("targetSeg"),
  targetHint: $("targetHint"),
  blend: $("blend"),
  fitViewport: $("fitViewport"),
  confirmModal: $("confirmModal"),
  confirmMsg: $("confirmMsg"),
  confirmOk: $("confirmOk"),
  confirmCancel: $("confirmCancel")
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
  if (!data || !data.activePresetId) return null;
  return data.store.presets.find((p) => p.id === data.activePresetId) || null;
}

function fill() {
  if (!data) return;
  const { store, key, binding } = data;
  const p = activePreset();

  els.enabled.checked = !!(binding && binding.enabled && p);
  els.scopeKey.textContent = key;

  for (const b of els.scopeSeg.querySelectorAll(".seg-btn")) {
    b.classList.toggle("active", b.dataset.scope === store.settings.scope);
  }
  // 操作対象: moveMode > lock の優先順で実質3モード
  const target = store.settings.moveMode ? "move" : store.settings.lock ? "page" : "overlay";
  for (const b of els.targetSeg.querySelectorAll(".seg-btn")) {
    b.classList.toggle("active", b.dataset.target === target);
  }
  els.targetHint.textContent = {
    page: "オーバーレイは素通し。下の実装ページを普段どおり操作できます。",
    overlay: "オーバーレイ（iframe 内）を操作できます。実装ページには届きません。",
    move: "ドラッグ・矢印キー（Shift で ×10）でオーバーレイの位置を調整。"
  }[target];

  // プリセット一覧（未割当なら "— 未選択 —" を選択状態に）
  els.presetSelect.innerHTML = "";
  if (!p) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = store.presets.length ? "— 未選択 —" : "— プリセットなし —";
    els.presetSelect.appendChild(o);
  }
  for (const pr of store.presets) {
    const o = document.createElement("option");
    o.value = pr.id;
    o.textContent = pr.name || "(無名)";
    els.presetSelect.appendChild(o);
  }
  els.presetSelect.value = p ? p.id : "";

  els.presetDup.disabled = !p;
  els.presetDel.disabled = !p;
  els.tabPin.checked = !!data.tabOverride;

  // 空状態 / フォームの出し分け
  els.fields.style.display = p ? "" : "none";
  els.emptyState.style.display = p ? "none" : "";

  if (p) {
    els.name.value = p.name;
    els.url.value = p.url;
    els.opacity.value = p.opacity;
    els.opacityNum.value = p.opacity;
    els.scale.value = p.scale;
    els.scaleNum.value = p.scale;
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

function confirmDialog(message) {
  return new Promise((resolve) => {
    els.confirmMsg.textContent = message;
    els.confirmModal.hidden = false;
    const done = (v) => {
      els.confirmModal.hidden = true;
      els.confirmOk.removeEventListener("click", ok);
      els.confirmCancel.removeEventListener("click", cancel);
      resolve(v);
    };
    const ok = () => done(true);
    const cancel = () => done(false);
    els.confirmOk.addEventListener("click", ok);
    els.confirmCancel.addEventListener("click", cancel);
  });
}

// ---- イベント ----
els.enabled.addEventListener("change", () =>
  send({ type: "setEnabled", enabled: els.enabled.checked }).then(refresh)
);

for (const b of els.scopeSeg.querySelectorAll(".seg-btn")) {
  b.addEventListener("click", () => setSettings({ scope: b.dataset.scope }));
}

els.tabPin.addEventListener("change", () =>
  send({ type: els.tabPin.checked ? "setTabOverride" : "clearTabOverride" }).then(refresh)
);

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
els.presetDel.addEventListener("click", async () => {
  const p = activePreset();
  if (!p) return;
  if (await confirmDialog(`プリセット「${p.name}」を削除しますか？`))
    send({ type: "deletePreset", presetId: p.id }).then(refresh);
});

els.name.addEventListener("change", () => patchPreset({ name: els.name.value }));
els.url.addEventListener("change", () => patchPreset({ url: els.url.value.trim() }));
els.url.addEventListener("keydown", (e) => {
  if (e.key === "Enter") patchPreset({ url: els.url.value.trim() });
});
// スライダー⇄数値入力を双方向に同期
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
els.opacity.addEventListener("input", () => {
  els.opacityNum.value = els.opacity.value;
  patchPreset({ opacity: parseFloat(els.opacity.value) });
});
els.opacityNum.addEventListener("change", () => {
  const v = clamp(parseFloat(els.opacityNum.value) || 0, 0, 1);
  els.opacity.value = v;
  patchPreset({ opacity: v });
});
els.scale.addEventListener("input", () => {
  els.scaleNum.value = els.scale.value;
  patchPreset({ scale: parseFloat(els.scale.value) });
});
els.scaleNum.addEventListener("change", () => {
  const v = clamp(parseFloat(els.scaleNum.value) || 1, 0.25, 3);
  els.scale.value = v;
  patchPreset({ scale: v });
});
els.width.addEventListener("change", () => patchPreset({ width: parseInt(els.width.value, 10) || 0 }));
els.height.addEventListener("change", () => patchPreset({ height: parseInt(els.height.value, 10) || 0 }));
els.x.addEventListener("change", () => patchPreset({ x: parseInt(els.x.value, 10) || 0 }));
els.y.addEventListener("change", () => patchPreset({ y: parseInt(els.y.value, 10) || 0 }));
els.blend.addEventListener("change", () => patchPreset({ blend: els.blend.value }));
els.fitViewport.addEventListener("click", async () => {
  const vp = await send({ type: "getViewport" });
  if (vp) patchPreset({ width: vp.width, height: vp.height, x: 0, y: 0 });
});
for (const b of els.targetSeg.querySelectorAll(".seg-btn")) {
  b.addEventListener("click", () => {
    const patch = {
      page: { lock: true, moveMode: false },
      overlay: { lock: false, moveMode: false },
      move: { moveMode: true }
    }[b.dataset.target];
    setSettings(patch);
  });
}

(async () => {
  const tab = await activeTab();
  tabId = tab.id;
  await ensureInjected(tabId);
  await refresh();
})();
