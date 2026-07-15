// 実装ページ側に注入され、オーバーレイ iframe を生成・制御する。
// ストレージ構造 (v2):
//   foStore = {
//     version: 2,
//     presets: [{ id, name, url, opacity, scale, x, y, width, height, blend }],
//     bindings: { "<key>": { presetId, enabled } },  // key = host or host+path
//     settings: { scope: "host" | "path", lock: bool, moveMode: bool }
//   }
(() => {
  if (window.__frameOverlayInjected) return;
  window.__frameOverlayInjected = true;

  const PRESET_DEFAULTS = {
    name: "プリセット",
    url: "",
    opacity: 0.5,
    scale: 1,
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
    blend: "normal"
  };
  const SETTINGS_DEFAULTS = { scope: "host", lock: true, moveMode: false };

  let store = null;
  let root, iframe, handle, coordLabel;

  // ---- ストア読み込み・マイグレーション ----
  function newId() {
    return "p_" + Math.random().toString(36).slice(2, 9);
  }

  function emptyStore() {
    return { version: 2, presets: [], bindings: {}, settings: { ...SETTINGS_DEFAULTS } };
  }

  function migrate(raw) {
    if (raw && raw.version === 2) {
      raw.settings = { ...SETTINGS_DEFAULTS, ...raw.settings };
      return raw;
    }
    const s = emptyStore();
    if (raw && raw.foState) {
      // v1 単一 state -> プリセット1件へ変換
      const old = raw.foState;
      const p = { id: newId(), ...PRESET_DEFAULTS };
      for (const k of Object.keys(PRESET_DEFAULTS)) if (old[k] != null) p[k] = old[k];
      p.name = "既定";
      s.presets.push(p);
      s.settings.lock = old.lock != null ? old.lock : true;
      if (old.enabled && old.url) {
        s.bindings[keyFor(location, "host")] = { presetId: p.id, enabled: true };
      }
    }
    return s;
  }

  function keyFor(loc, scope) {
    // host はポート込み（localhost:3000 と localhost:4321 を区別する）。
    const host = loc.host || "(local)";
    return scope === "path" ? host + loc.pathname : host;
  }

  function currentKey() {
    return keyFor(location, store.settings.scope);
  }

  function activeBinding() {
    return store.bindings[currentKey()] || null;
  }

  function activePreset() {
    const b = activeBinding();
    if (!b) return null;
    return store.presets.find((p) => p.id === b.presetId) || null;
  }

  function isEnabled() {
    const b = activeBinding();
    return !!(b && b.enabled && activePreset());
  }

  // このページで必ず 1 プリセット＋バインディングが存在する状態にする
  // （enabled は false 始まりなので、これ自体では何も表示しない）。
  function ensureProvisioned() {
    let changed = false;
    if (store.presets.length === 0) {
      store.presets.push({ id: newId(), ...PRESET_DEFAULTS, name: "既定" });
      changed = true;
    }
    const key = currentKey();
    if (!store.bindings[key]) {
      store.bindings[key] = { presetId: store.presets[0].id, enabled: false };
      changed = true;
    } else if (!store.presets.some((p) => p.id === store.bindings[key].presetId)) {
      store.bindings[key].presetId = store.presets[0].id;
      changed = true;
    }
    if (changed) save();
  }

  function save() {
    return chrome.storage.local.set({ foStore: store });
  }

  function load() {
    return chrome.storage.local.get(["foStore", "foState"]).then((r) => {
      if (r.foStore || r.foState) {
        store = migrate(r.foStore || r);
      } else {
        store = emptyStore();
      }
      render();
    });
  }

  // ---- DOM ----
  function buildFigmaEmbed(url) {
    if (/^https?:\/\/embed\.figma\.com\//.test(url)) return url;
    if (/^https?:\/\/(www\.)?figma\.com\/(proto|file|design|board)\//.test(url)) {
      return "https://www.figma.com/embed?embed_host=frame-overlay&url=" + encodeURIComponent(url);
    }
    return url;
  }

  function ensureDom() {
    if (root) return;
    root = document.createElement("div");
    root.id = "fo-overlay-root";

    iframe = document.createElement("iframe");
    iframe.id = "fo-overlay-iframe";
    iframe.allow = "fullscreen";

    handle = document.createElement("div");
    handle.id = "fo-drag-handle";
    coordLabel = document.createElement("span");
    coordLabel.textContent = "移動: ドラッグ / 矢印キー";
    handle.appendChild(coordLabel);

    root.appendChild(iframe);
    root.appendChild(handle);
    document.documentElement.appendChild(root);
    enableDrag();
  }

  function enableDrag() {
    let dragging = false;
    let startX, startY, origX, origY;
    handle.addEventListener("mousedown", (e) => {
      const p = activePreset();
      if (!p) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origX = p.x;
      origY = p.y;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const p = activePreset();
      if (!p) return;
      p.x = origX + (e.clientX - startX);
      p.y = origY + (e.clientY - startY);
      applyTransform();
    });
    window.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        save();
      }
    });
    window.addEventListener("keydown", (e) => {
      if (!isEnabled() || !store.settings.moveMode) return;
      const p = activePreset();
      if (!p) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowLeft") p.x -= step;
      else if (e.key === "ArrowRight") p.x += step;
      else if (e.key === "ArrowUp") p.y -= step;
      else if (e.key === "ArrowDown") p.y += step;
      else return;
      e.preventDefault();
      applyTransform();
      save();
    });
  }

  function applyTransform() {
    const p = activePreset();
    if (!iframe || !p) return;
    iframe.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.scale})`;
    if (coordLabel) coordLabel.textContent = `x:${p.x} y:${p.y} ×${p.scale}`;
  }

  function render() {
    if (!store) return;
    if (!isEnabled()) {
      if (root) root.style.display = "none";
      chrome.runtime.sendMessage({ type: "setHeaderStripping", enabled: false });
      return;
    }
    const p = activePreset();
    ensureDom();
    root.style.display = "block";

    const src = buildFigmaEmbed(p.url || "");
    if (src && iframe.dataset.src !== src) {
      iframe.dataset.src = src;
      iframe.src = src;
    }
    iframe.style.width = p.width + "px";
    iframe.style.height = p.height + "px";
    iframe.style.opacity = String(p.opacity);
    iframe.style.mixBlendMode = p.blend;

    const lock = store.settings.lock;
    iframe.style.pointerEvents = lock ? "none" : "auto";
    root.style.pointerEvents = lock ? "none" : "auto";
    root.classList.toggle("fo-move-mode", !!store.settings.moveMode);
    applyTransform();

    chrome.runtime.sendMessage({ type: "setHeaderStripping", enabled: true });
  }

  // ---- ポップアップからのコマンド ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!store) {
      sendResponse(null);
      return;
    }
    switch (msg?.type) {
      case "getData": {
        ensureProvisioned();
        sendResponse({
          store,
          key: currentKey(),
          binding: activeBinding(),
          activePresetId: activePreset()?.id || null
        });
        return;
      }
      case "setEnabled": {
        const key = currentKey();
        let b = store.bindings[key];
        if (msg.enabled) {
          // 有効化：バインディングが無ければ、指定 or 先頭 or 新規プリセットを割当
          if (!b) {
            let pid = msg.presetId;
            if (!pid) {
              if (store.presets.length === 0) {
                const p = { id: newId(), ...PRESET_DEFAULTS };
                store.presets.push(p);
                pid = p.id;
              } else {
                pid = store.presets[0].id;
              }
            }
            b = store.bindings[key] = { presetId: pid, enabled: true };
          } else {
            b.enabled = true;
          }
        } else if (b) {
          b.enabled = false;
        }
        save().then(render);
        sendResponse({ ok: true });
        return;
      }
      case "selectPreset": {
        const key = currentKey();
        const b = store.bindings[key] || (store.bindings[key] = { presetId: null, enabled: true });
        b.presetId = msg.presetId;
        save().then(render);
        sendResponse({ ok: true });
        return;
      }
      case "updatePreset": {
        const p = store.presets.find((x) => x.id === msg.presetId);
        if (p) Object.assign(p, msg.patch);
        save().then(render);
        sendResponse({ ok: true });
        return;
      }
      case "addPreset": {
        const p = { id: newId(), ...PRESET_DEFAULTS, ...(msg.preset || {}) };
        store.presets.push(p);
        const key = currentKey();
        store.bindings[key] = { presetId: p.id, enabled: true };
        save().then(render);
        sendResponse({ ok: true, id: p.id });
        return;
      }
      case "duplicatePreset": {
        const src = store.presets.find((x) => x.id === msg.presetId);
        if (src) {
          const p = { ...src, id: newId(), name: src.name + " のコピー" };
          store.presets.push(p);
          store.bindings[currentKey()] = { presetId: p.id, enabled: true };
          save().then(render);
          sendResponse({ ok: true, id: p.id });
        } else sendResponse({ ok: false });
        return;
      }
      case "deletePreset": {
        store.presets = store.presets.filter((x) => x.id !== msg.presetId);
        for (const k of Object.keys(store.bindings)) {
          if (store.bindings[k].presetId === msg.presetId) delete store.bindings[k];
        }
        save().then(render);
        sendResponse({ ok: true });
        return;
      }
      case "setSettings": {
        Object.assign(store.settings, msg.patch);
        save().then(render);
        sendResponse({ ok: true });
        return;
      }
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.foStore) {
      store = migrate(changes.foStore.newValue);
      render();
    }
  });

  load();
})();
