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

  const FRAME_NAME = "fo-overlay-frame";

  // ---- オーバーレイ iframe の中で動く分岐（all_frames で注入される）----
  if (window !== window.top) {
    if (window.name !== FRAME_NAME) return; // 無関係な iframe では何もしない

    // スクロールが端に達しても親（実装ページ）へ連鎖させない
    const style = document.createElement("style");
    style.textContent = "html, body { overscroll-behavior: none !important; }";
    (document.head || document.documentElement).appendChild(style);

    // 親から操作対象モードを受け取り、実装ページ操作中は wheel を止めて
    // オーバーレイがスクロールしないようにする
    // （Firefox はスクロールのヒットテストで pointer-events: none を
    //   無視することがあり、親側の対策だけでは漏れるため）。
    // overflow: hidden の付け外しだとスクロールバーの出入りで
    // レイアウト幅が変わってしまうので、イベントで止める。
    let mode = "page";
    window.addEventListener("message", (e) => {
      if (e.source !== window.parent) return;
      const m = e.data && e.data.__frameOverlayMode;
      if (m === "overlay" || m === "page") mode = m;
    });
    window.addEventListener(
      "wheel",
      (e) => {
        if (mode === "page") e.preventDefault();
      },
      { passive: false, capture: true }
    );
    // 準備完了を親に伝えて、現在のモードを送ってもらう
    window.parent.postMessage({ __frameOverlayReady: true }, "*");
    return;
  }

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

  // ---- タブローカルの上書き ----
  // sessionStorage はタブごとに独立し、リロードしても残り、タブを閉じると
  // 消えるので「このタブだけ別プリセット」の置き場所にちょうどいい。
  const TAB_OVERRIDE_KEY = "__frameOverlayTabOverride";
  let tabOverride = null; // { presetId, enabled } | null

  function loadTabOverride() {
    try {
      tabOverride = JSON.parse(sessionStorage.getItem(TAB_OVERRIDE_KEY)) || null;
    } catch {
      tabOverride = null;
    }
  }

  function saveTabOverride() {
    try {
      if (tabOverride) sessionStorage.setItem(TAB_OVERRIDE_KEY, JSON.stringify(tabOverride));
      else sessionStorage.removeItem(TAB_OVERRIDE_KEY);
    } catch {}
  }

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
    // タブローカルの上書きがあれば共有バインディングより優先
    return tabOverride || store.bindings[currentKey()] || null;
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

  let frame, dragLayer;

  function ensureDom() {
    if (root) return;
    root = document.createElement("div");
    root.id = "fo-overlay-root";

    // frame: transform・サイズ・不透明度・ブレンドを担うラッパー
    frame = document.createElement("div");
    frame.id = "fo-frame";

    iframe = document.createElement("iframe");
    iframe.id = "fo-overlay-iframe";
    iframe.name = FRAME_NAME; // iframe 内の content script が自分を識別する印
    iframe.allow = "fullscreen";

    // dragLayer: 移動モード時に iframe 全面を覆ってドラッグを受ける
    dragLayer = document.createElement("div");
    dragLayer.id = "fo-drag-layer";

    handle = document.createElement("div");
    handle.id = "fo-drag-handle";
    coordLabel = document.createElement("span");
    coordLabel.textContent = "ドラッグで移動 / 矢印キーで微調整";
    handle.appendChild(coordLabel);

    frame.appendChild(iframe);
    frame.appendChild(dragLayer);
    frame.appendChild(handle);
    root.appendChild(frame);
    document.documentElement.appendChild(root);
    enableDrag();

    // オーバーレイ操作中、iframe の外（root）に当たった wheel を止める。
    // root は fixed inset:0 だがスクロールコンテナではないため、
    // 放っておくと実装ページへスクロールが流れてしまう。
    root.addEventListener(
      "wheel",
      (e) => {
        const { lock, moveMode } = store.settings;
        if (isEnabled() && !lock && !moveMode) e.preventDefault();
      },
      { passive: false }
    );
  }

  function enableDrag() {
    let dragging = false;
    let startX, startY, origX, origY;
    const begin = (e) => {
      const p = activePreset();
      if (!p) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origX = p.x;
      origY = p.y;
      e.preventDefault();
    };
    // 全面のドラッグレイヤーと、左上の座標バッジ、どちらからでも掴める
    dragLayer.addEventListener("mousedown", begin);
    handle.addEventListener("mousedown", begin);

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

  // iframe 内の content script に現在の操作対象モードを伝える
  function sendModeToFrame() {
    if (!iframe || !iframe.contentWindow) return;
    const { lock, moveMode } = store.settings;
    const mode = isEnabled() && !lock && !moveMode ? "overlay" : "page";
    iframe.contentWindow.postMessage({ __frameOverlayMode: mode }, "*");
  }

  // iframe 側の準備完了通知を受けてモードを送る（初回ロード時の取りこぼし防止）
  window.addEventListener("message", (e) => {
    if (iframe && e.source === iframe.contentWindow && e.data && e.data.__frameOverlayReady) {
      sendModeToFrame();
    }
  });

  function applyTransform() {
    const p = activePreset();
    if (!frame || !p) return;
    frame.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.scale})`;
    if (coordLabel) coordLabel.textContent = `x:${p.x} y:${p.y} ×${p.scale}`;
  }

  function render() {
    if (!store) return;
    if (!isEnabled()) {
      if (root) root.style.display = "none";
      sendModeToFrame();
      chrome.runtime.sendMessage({ type: "setHeaderStripping", enabled: false });
      return;
    }
    const p = activePreset();
    ensureDom();
    root.style.display = "block";

    // ヘッダ剥がしルールの適用完了を待ってから iframe を読み込む
    // （待たないと初回有効化時に XFO/CSP が残ったままリクエストされ得る）
    const src = buildFigmaEmbed(p.url || "");
    if (src && iframe.dataset.src !== src) {
      iframe.dataset.src = src;
      chrome.runtime
        .sendMessage({ type: "setHeaderStripping", enabled: true })
        .then(() => {
          iframe.src = src;
        });
    }
    // サイズは frame に、ブレンド・不透明度も frame（グループ）に適用して確実に効かせる
    frame.style.width = p.width + "px";
    frame.style.height = p.height + "px";
    frame.style.opacity = String(p.opacity);
    frame.style.mixBlendMode = p.blend || "normal";

    const lock = store.settings.lock;
    const move = !!store.settings.moveMode;
    // 移動モード時は iframe を触らずドラッグ。通常はロックに従う。
    iframe.style.pointerEvents = move ? "none" : lock ? "none" : "auto";
    root.style.pointerEvents = move ? "auto" : lock ? "none" : "auto";
    dragLayer.style.display = move ? "block" : "none";
    root.classList.toggle("fo-move-mode", move);
    sendModeToFrame();
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
        sendResponse({
          store,
          key: currentKey(),
          binding: activeBinding(),
          activePresetId: activePreset()?.id || null,
          tabOverride
        });
        return;
      }
      case "getViewport": {
        sendResponse({ width: window.innerWidth, height: window.innerHeight });
        return;
      }
      case "setEnabled": {
        if (tabOverride) {
          // タブローカル上書き中はタブ側だけを切り替える
          if (msg.enabled && !tabOverride.presetId) {
            tabOverride.presetId = store.presets[0]?.id || null;
          }
          tabOverride.enabled = msg.enabled;
          saveTabOverride();
          render();
          sendResponse({ ok: true });
          return;
        }
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
        if (tabOverride) {
          tabOverride.presetId = msg.presetId;
          saveTabOverride();
          render();
          sendResponse({ ok: true });
          return;
        }
        const key = currentKey();
        const b = store.bindings[key] || (store.bindings[key] = { presetId: null, enabled: true });
        b.presetId = msg.presetId;
        save().then(render);
        sendResponse({ ok: true });
        return;
      }
      case "setTabOverride": {
        // 現在の割り当てを引き継いでタブローカル上書きを開始
        const base = store.bindings[currentKey()];
        tabOverride = {
          presetId: base?.presetId || store.presets[0]?.id || null,
          enabled: base ? !!base.enabled : false
        };
        saveTabOverride();
        render();
        sendResponse({ ok: true });
        return;
      }
      case "clearTabOverride": {
        tabOverride = null;
        saveTabOverride();
        render();
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
        if (tabOverride && tabOverride.presetId === msg.presetId) {
          tabOverride.presetId = null;
          saveTabOverride();
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

  loadTabOverride();
  load();
})();
