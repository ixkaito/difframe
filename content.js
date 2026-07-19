// 実装ページ側に注入され、オーバーレイ iframe を生成・制御する。
// ストレージ構造 (v2):
//   foStore = {
//     version: 2,
//     presets: [{ id, name, url, opacity, scale, x, y, width, height, blend }],
//     bindings: { "<key>": { presetId, enabled } },  // key = host or host+path
//     settings: { scope: "host" | "path", lock: bool }
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
  const SETTINGS_DEFAULTS = { scope: "path", lock: true };

  let store = null;
  let root, iframe;

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

  // プリセットを現在の割り当て先（ピン中はタブ上書き、通常は共有）に紐付ける
  function assignPreset(presetId) {
    if (tabOverride) {
      tabOverride.presetId = presetId;
      tabOverride.enabled = true;
      saveTabOverride();
    } else {
      store.bindings[currentKey()] = { presetId, enabled: true };
    }
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

  let shield, forcedBg = false;

  function hasExplicitBackground() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== "transparent" && c !== "rgba(0, 0, 0, 0)") return true;
    }
    return false;
  }

  // 背景が一切ないページはキャンバスが「ブラウザのデフォルト白」で
  // 塗られ、これは CSS の描画物ではないので mix-blend-mode の合成対象に
  // ならない。差分モード中だけ html に白背景を明示して合成対象にする。
  function ensureCanvasBackground(diff) {
    if (diff && !forcedBg && !hasExplicitBackground()) {
      document.documentElement.style.backgroundColor = "#fff";
      forcedBg = true;
    } else if (!diff && forcedBg) {
      document.documentElement.style.backgroundColor = "";
      forcedBg = false;
    }
  }

  function ensureDom() {
    if (root) return;

    // shield: オーバーレイ操作モード中、iframe の外に当たった wheel を
    // 止めるための全画面透明レイヤー（スクロールがページへ流れないように）
    shield = document.createElement("div");
    shield.id = "fo-shield";
    shield.addEventListener(
      "wheel",
      (e) => {
        if (isEnabled() && !store.settings.lock) e.preventDefault();
      },
      { passive: false }
    );

    // root: サイズ・transform・不透明度・ブレンド・背景をすべて持つ
    // 単一のオーバーレイ枠。ページと mix-blend-mode で合成するには
    // html 直下（ルートのスタッキングコンテキスト直属）である必要が
    // あるため、全画面ラッパーの入れ子にはしない。
    root = document.createElement("div");
    root.id = "fo-overlay-root";

    iframe = document.createElement("iframe");
    iframe.id = "fo-overlay-iframe";
    iframe.name = FRAME_NAME; // iframe 内の content script が自分を識別する印
    iframe.allow = "fullscreen";

    root.appendChild(iframe);
    document.documentElement.appendChild(shield);
    document.documentElement.appendChild(root);
  }

  // iframe 内の content script に現在の操作対象モードを伝える
  function sendModeToFrame() {
    if (!iframe || !iframe.contentWindow) return;
    const mode = isEnabled() && !store.settings.lock ? "overlay" : "page";
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
    if (!root || !p) return;
    root.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.scale})`;
  }

  function render() {
    if (!store) return;
    if (!isEnabled()) {
      if (root) root.style.display = "none";
      if (shield) shield.style.display = "none";
      ensureCanvasBackground(false);
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
    } else if (!src && iframe.dataset.src) {
      // URL が空のプリセットに切り替わったら、前のページを残さず空にする
      iframe.dataset.src = "";
      iframe.src = "about:blank";
    }
    root.style.width = p.width + "px";
    root.style.height = p.height + "px";
    // 差分 = mix-blend-mode: difference。root は html 直下なので
    // ページの描画結果と合成される。不透明度 1.0 のとき一致部分は
    // |C-C| = 0 → 真っ黒。実装ページ側に背景が無い場合はキャンバスが
    // 合成対象にならないため、ensureCanvasBackground で白を明示する。
    const diff = p.blend === "difference";
    root.style.mixBlendMode = diff ? "difference" : "";
    root.style.opacity = String(p.opacity);
    ensureCanvasBackground(diff);

    const lock = store.settings.lock;
    iframe.style.pointerEvents = lock ? "none" : "auto";
    root.style.pointerEvents = lock ? "none" : "auto";
    // シールドはオーバーレイ操作モード中だけ有効
    shield.style.display = lock ? "none" : "block";
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
          // （プリセットが無ければ、ピンなし時と同様に自動作成する）
          if (msg.enabled && !tabOverride.presetId) {
            if (store.presets.length === 0) {
              store.presets.push({ id: newId(), ...PRESET_DEFAULTS });
            }
            tabOverride.presetId = store.presets[0].id;
          }
          tabOverride.enabled = msg.enabled;
          saveTabOverride();
          save().then(render);
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
      // 新規プリセットの割り当て先：ピン中はタブ上書き、通常は共有バインディング
      case "addPreset": {
        const p = { id: newId(), ...PRESET_DEFAULTS, ...(msg.preset || {}) };
        store.presets.push(p);
        assignPreset(p.id);
        save().then(render);
        sendResponse({ ok: true, id: p.id });
        return;
      }
      case "duplicatePreset": {
        const src = store.presets.find((x) => x.id === msg.presetId);
        if (src) {
          const p = { ...src, id: newId(), name: src.name + " のコピー" };
          store.presets.push(p);
          assignPreset(p.id);
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
