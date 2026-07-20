// ポップアップ UI。content script にコマンドを送って state を編集する。
const $ = (id) => document.getElementById(id);
const els = {
  enabled: $("enabled"),
  scopeKey: $("scopeKey"),
  scopeSeg: $("scopeSeg"),
  presetBar: $("presetBar"),
  presetSelect: $("presetSelect"),
  presetRename: $("presetRename"),
  presetAdd: $("presetAdd"),
  presetDup: $("presetDup"),
  presetDel: $("presetDel"),
  renameBar: $("renameBar"),
  renameInput: $("renameInput"),
  renameOk: $("renameOk"),
  renameCancel: $("renameCancel"),
  tabPin: $("tabPin"),
  emptyState: $("emptyState"),
  fields: $("fields"),
  url: $("url"),
  urlApply: $("urlApply"),
  srcSeg: $("srcSeg"),
  urlRow: $("urlRow"),
  imageRow: $("imageRow"),
  imageDrop: $("imageDrop"),
  imageDropHint: $("imageDropHint"),
  imageThumb: $("imageThumb"),
  imageInfo: $("imageInfo"),
  imageClear: $("imageClear"),
  opacity: $("opacity"),
  opacityNum: $("opacityNum"),
  scale: $("scale"),
  scaleNum: $("scaleNum"),
  width: $("width"),
  height: $("height"),
  x: $("x"),
  y: $("y"),
  targetSeg: $("targetSeg"),
  syncScroll: $("syncScroll"),
  blend: $("blend"),
  blendHint: $("blendHint"),
  fitViewport: $("fitViewport"),
  confirmModal: $("confirmModal"),
  confirmMsg: $("confirmMsg"),
  confirmOk: $("confirmOk"),
  confirmCancel: $("confirmCancel")
};

let tabId = null;
let data = null; // { store, key, binding, activePresetId }

// OS に合わせた貼り付けキー表記（Mac: ⌘V / それ以外: Ctrl+V）
els.imageDropHint.textContent =
  (navigator.platform.includes("Mac") ? "⌘V" : "Ctrl+V") + " で貼り付け / クリックで画像を選択";

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
  const target = store.settings.lock ? "page" : "overlay";
  for (const b of els.targetSeg.querySelectorAll(".seg-btn")) {
    b.classList.toggle("active", b.dataset.target === target);
  }
  els.syncScroll.checked = !!store.settings.syncScroll;

  // プリセット一覧（未割当なら "— 未選択 —" を選択状態に）
  els.presetSelect.innerHTML = "";
  els.presetSelect.classList.toggle("placeholder", !p);
  if (!p) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = store.presets.length ? "未選択" : "プリセットなし";
    els.presetSelect.appendChild(o);
  }
  for (const pr of store.presets) {
    const o = document.createElement("option");
    o.value = pr.id;
    o.textContent = pr.name || "(無名)";
    els.presetSelect.appendChild(o);
  }
  els.presetSelect.value = p ? p.id : "";

  els.presetRename.disabled = !p;
  els.presetDup.disabled = !p;
  els.presetDel.disabled = !p;
  els.tabPin.checked = !!data.tabOverride;

  // 空状態 / フォームの出し分け
  els.fields.style.display = p ? "" : "none";
  els.emptyState.style.display = p ? "none" : "";

  // 参照タイプ（URL / 画像）の出し分け
  const srcType = p ? p.srcType || "url" : "url";
  for (const b of els.srcSeg.querySelectorAll(".seg-btn")) {
    b.classList.toggle("active", b.dataset.src === srcType);
  }
  els.urlRow.hidden = srcType !== "url";
  els.imageRow.hidden = srcType !== "image";
  if (p && srcType === "image") loadThumb(p.id);
  els.fitViewport.textContent =
    srcType === "image" ? "画像の元のサイズに戻す" : "画面に合わせる";

  if (p) {
    els.url.value = p.url;
    els.opacity.value = p.opacity;
    els.opacityNum.value = p.opacity;
    els.scale.value = p.scale;
    els.scaleNum.value = p.scale;
    paintSlider(els.opacity);
    paintSlider(els.scale);
    els.width.value = p.width;
    els.height.value = p.height;
    els.x.value = p.x;
    els.y.value = p.y;
    els.blend.value = p.blend;
    els.blendHint.hidden = p.blend !== "difference";
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

// ---- インライン改名（✏️ でセレクトが入力欄に切り替わる）----
function startRename() {
  const p = activePreset();
  if (!p) return;
  els.presetBar.hidden = true;
  els.renameBar.hidden = false;
  els.renameInput.value = p.name;
  els.renameInput.focus();
  els.renameInput.select();
}
function endRename(commit) {
  if (commit) {
    const name = els.renameInput.value.trim();
    if (name) patchPreset({ name });
  }
  els.renameBar.hidden = true;
  els.presetBar.hidden = false;
}
els.presetRename.addEventListener("click", startRename);
els.renameOk.addEventListener("click", () => endRename(true));
els.renameCancel.addEventListener("click", () => endRename(false));
els.renameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") endRename(true);
  else if (e.key === "Escape") endRename(false);
});
// URL は blur では確定しない（入力途中の意図しない読み込み・保存を防ぐ）。
// Enter か「適用」ボタンでのみ確定する。
const applyUrl = () => patchPreset({ url: els.url.value.trim() });
els.urlApply.addEventListener("click", applyUrl);
els.url.addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyUrl();
});

// ---- スクショ貼付（参照タイプ: 画像）----
async function loadThumb(presetId) {
  const r = await chrome.storage.local.get("dfImages");
  const im = r.dfImages && r.dfImages[presetId];
  if (im) {
    els.imageThumb.src = im.data;
    els.imageThumb.hidden = false;
    els.imageClear.hidden = false;
    els.imageDropHint.hidden = true;
    els.imageInfo.hidden = false;
    els.imageInfo.textContent = `${im.width}×${im.height}px`;
  } else {
    els.imageThumb.removeAttribute("src");
    els.imageThumb.hidden = true;
    els.imageClear.hidden = true;
    els.imageDropHint.hidden = false;
    els.imageInfo.hidden = true;
  }
}

async function setImageFromBlob(blob) {
  const p = activePreset();
  if (!p) return;
  const data = await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(blob);
  });
  const dim = await new Promise((res) => {
    const i = new Image();
    i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight });
    i.src = data;
  });
  const r = await chrome.storage.local.get("dfImages");
  const imgs = r.dfImages || {};
  imgs[p.id] = { data, width: dim.w, height: dim.h };
  await chrome.storage.local.set({ dfImages: imgs });
  // Retina スクショを想定して CSS px に換算した初期サイズを設定
  patchPreset({
    srcType: "image",
    width: Math.round(dim.w / devicePixelRatio),
    height: Math.round(dim.h / devicePixelRatio)
  });
}

for (const b of els.srcSeg.querySelectorAll(".seg-btn")) {
  b.addEventListener("click", () => patchPreset({ srcType: b.dataset.src }));
}
// ファイル選択・D&D はポップアップ内では完結できない（フォーカスが
// 外れると閉じる）ため、ページ上のドロップゾーンに委ねる
els.imageDrop.addEventListener("click", () => {
  const p = activePreset();
  if (!p) return;
  send({ type: "pickImage", presetId: p.id });
  window.close();
});
document.addEventListener("paste", (e) => {
  if (els.imageRow.hidden || !activePreset()) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) {
    e.preventDefault();
    setImageFromBlob(item.getAsFile());
  }
});
els.imageClear.addEventListener("click", async (e) => {
  e.stopPropagation(); // ドロップエリアのクリック（ページ上ピッカー起動）を抑止
  const p = activePreset();
  if (!p) return;
  const r = await chrome.storage.local.get("dfImages");
  const imgs = r.dfImages || {};
  delete imgs[p.id];
  await chrome.storage.local.set({ dfImages: imgs });
  refresh();
});
// スライダー⇄数値入力を双方向に同期
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
// Chrome 用: トラックの進捗塗り位置を CSS 変数で更新
// （Firefox は ::-moz-range-progress がネイティブに塗る）
function paintSlider(el) {
  const min = parseFloat(el.min);
  const max = parseFloat(el.max);
  const pct = ((parseFloat(el.value) - min) / (max - min)) * 100;
  el.style.setProperty("--fill", pct + "%");
}
els.opacity.addEventListener("input", () => {
  els.opacityNum.value = els.opacity.value;
  paintSlider(els.opacity);
  patchPreset({ opacity: parseFloat(els.opacity.value) });
});
els.opacityNum.addEventListener("change", () => {
  const v = clamp(parseFloat(els.opacityNum.value) || 0, 0, 1);
  els.opacity.value = v;
  paintSlider(els.opacity);
  patchPreset({ opacity: v });
});
els.scale.addEventListener("input", () => {
  els.scaleNum.value = els.scale.value;
  paintSlider(els.scale);
  patchPreset({ scale: parseFloat(els.scale.value) });
});
els.scaleNum.addEventListener("change", () => {
  const v = clamp(parseFloat(els.scaleNum.value) || 1, 0.25, 3);
  els.scale.value = v;
  paintSlider(els.scale);
  patchPreset({ scale: v });
});
els.width.addEventListener("change", () => patchPreset({ width: parseInt(els.width.value, 10) || 0 }));
els.height.addEventListener("change", () => patchPreset({ height: parseInt(els.height.value, 10) || 0 }));
els.x.addEventListener("change", () => patchPreset({ x: parseInt(els.x.value, 10) || 0 }));
els.y.addEventListener("change", () => patchPreset({ y: parseInt(els.y.value, 10) || 0 }));
els.blend.addEventListener("change", () => patchPreset({ blend: els.blend.value }));
els.fitViewport.addEventListener("click", async () => {
  const p = activePreset();
  if (!p) return;
  if ((p.srcType || "url") === "image") {
    // 画像モード: 画像の元のサイズ（CSS px 換算）に戻す
    const r = await chrome.storage.local.get("dfImages");
    const im = r.dfImages && r.dfImages[p.id];
    if (im) {
      patchPreset({
        width: Math.round(im.width / devicePixelRatio),
        height: Math.round(im.height / devicePixelRatio)
      });
    }
    return;
  }
  const vp = await send({ type: "getViewport" });
  if (vp) patchPreset({ width: vp.width, height: vp.height, x: 0, y: 0 });
});
for (const b of els.targetSeg.querySelectorAll(".seg-btn")) {
  b.addEventListener("click", () => setSettings({ lock: b.dataset.target === "page" }));
}
els.syncScroll.addEventListener("change", () => setSettings({ syncScroll: els.syncScroll.checked }));

(async () => {
  const tab = await activeTab();
  tabId = tab.id;
  await ensureInjected(tabId);
  await refresh();
})();
