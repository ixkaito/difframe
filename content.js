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
    let sync = false;
    let syncBase = null; // 同期オン時点のこちらのスクロール位置（相対同期の基準）
    let suppress = false; // 親からの同期適用中は scroll イベントを送り返さない
    window.addEventListener("message", (e) => {
      if (e.source !== window.parent) return;
      const m = e.data && e.data.__frameOverlayMode;
      if (m === "overlay" || m === "page") mode = m;
      const sv = e.data && e.data.__frameOverlaySync;
      if (typeof sv === "boolean") {
        // オフ→オンの瞬間の位置を基準にする（絶対位置に飛ばさない）
        if (sv && !sync) syncBase = { x: window.scrollX, y: window.scrollY };
        sync = sv;
      }
      const s = e.data && e.data.__frameOverlayScrollDelta;
      if (s && sync && syncBase) {
        suppress = true;
        window.scrollTo(syncBase.x + s.dx, syncBase.y + s.dy);
        requestAnimationFrame(() => (suppress = false));
      }
    });
    window.addEventListener(
      "wheel",
      (e) => {
        if (mode === "page") e.preventDefault();
      },
      { passive: false, capture: true }
    );
    // オーバーレイ操作中、こちらのスクロール差分を親ページへ伝える
    window.addEventListener(
      "scroll",
      () => {
        if (!sync || !syncBase || suppress || mode !== "overlay") return;
        window.parent.postMessage(
          {
            __frameOverlayScrollFromFrame: {
              dx: window.scrollX - syncBase.x,
              dy: window.scrollY - syncBase.y
            }
          },
          "*"
        );
      },
      { passive: true }
    );
    // 準備完了を親に伝えて、現在のモードを送ってもらう
    window.parent.postMessage({ __frameOverlayReady: true }, "*");
    return;
  }

  const PRESET_DEFAULTS = {
    name: "プリセット",
    srcType: "url", // "url" | "image"（画像本体は foImages に別置き）
    url: "",
    opacity: 0.5,
    scale: 1,
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
    blend: "normal"
  };
  const SETTINGS_DEFAULTS = { scope: "path", lock: true, syncScroll: true };

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
      for (const p of raw.presets) if (!p.srcType) p.srcType = "url";
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
    return chrome.storage.local.get(["foStore", "foState", "foImages"]).then((r) => {
      if (r.foStore || r.foState) {
        store = migrate(r.foStore || r);
      } else {
        store = emptyStore();
      }
      imagesCache = r.foImages || {};
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

  let shield, overlayImg, forcedBg = false;
  let imagesCache = {}; // foImages: { [presetId]: { data, width, height } }

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

    // スクショ貼付モード用の画像（iframe と排他表示）
    overlayImg = document.createElement("img");
    overlayImg.id = "fo-overlay-img";

    root.appendChild(iframe);
    root.appendChild(overlayImg);
    document.documentElement.appendChild(shield);
    document.documentElement.appendChild(root);
  }

  // ---- ページ上の画像ピッカー ----
  // ポップアップはフォーカスを失うと閉じるため、ファイル選択も D&D も
  // ポップアップ内では完結できない。代わりにページ上へ全画面の
  // ドロップゾーンを出して、そこで受け取る。
  let picker = null;

  function saveImageBlob(presetId, blob) {
    const fr = new FileReader();
    fr.onload = () => {
      const data = fr.result;
      const img = new Image();
      img.onload = () => {
        imagesCache[presetId] = { data, width: img.naturalWidth, height: img.naturalHeight };
        chrome.storage.local.set({ foImages: imagesCache });
        const p = store.presets.find((x) => x.id === presetId);
        if (p) {
          p.srcType = "image";
          // Retina スクショを想定して CSS px に換算した初期サイズ
          p.width = Math.round(img.naturalWidth / devicePixelRatio);
          p.height = Math.round(img.naturalHeight / devicePixelRatio);
        }
        save().then(render);
      };
      img.src = data;
    };
    fr.readAsDataURL(blob);
  }

  function closePicker() {
    if (picker) {
      picker.remove();
      picker = null;
    }
  }

  function openPicker(presetId) {
    closePicker();
    picker = document.createElement("div");
    picker.id = "fo-pick";
    picker.innerHTML =
      '<div id="fo-pick-box">画像をここにドロップ<br>' +
      '<span class="fo-pick-sub">または</span><br>' +
      "クリックで画像を選択<br>" +
      '<span class="fo-pick-sub">(Esc でキャンセル)</span></div>';

    picker.addEventListener("dragover", (e) => {
      e.preventDefault();
      picker.classList.add("fo-pick-over");
    });
    picker.addEventListener("dragleave", () => picker.classList.remove("fo-pick-over"));
    picker.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/"));
      if (f) saveImageBlob(presetId, f);
      closePicker();
    });
    picker.addEventListener("click", () => {
      // ページ上のクリック＝ユーザー操作なのでファイルダイアログを開ける
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.addEventListener("change", () => {
        if (input.files[0]) saveImageBlob(presetId, input.files[0]);
        closePicker();
      });
      input.click();
    });
    window.addEventListener(
      "keydown",
      function esc(e) {
        if (e.key === "Escape") {
          closePicker();
          window.removeEventListener("keydown", esc, true);
        }
      },
      true
    );

    document.documentElement.appendChild(picker);
  }

  // iframe 内の content script に現在の操作対象モードと同期設定を伝える
  function sendModeToFrame() {
    if (!iframe || !iframe.contentWindow) return;
    const mode = isEnabled() && !store.settings.lock ? "overlay" : "page";
    iframe.contentWindow.postMessage(
      { __frameOverlayMode: mode, __frameOverlaySync: !!store.settings.syncScroll },
      "*"
    );
  }

  // ---- スクロール連動（相対同期）----
  // オンにした瞬間の両者の位置を基準に、以後の差分だけを伝え合う。
  // 絶対位置に飛ばさないので、オン/オフのたびにその場から連動し直せる。
  let suppressScroll = false; // 同期適用中の scroll イベントを無視するフラグ
  let syncBase = null; // ページ側の基準スクロール位置

  function rebaseSync() {
    syncBase = { x: window.scrollX, y: window.scrollY };
  }

  function syncScrollToOverlay() {
    const p = activePreset();
    if (!p || !isEnabled() || !store.settings.syncScroll || !syncBase) return;
    if ((p.srcType || "url") === "image") {
      applyTransform(); // 画像は translate にスクロール差分を織り込む
    } else if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage(
        {
          __frameOverlayScrollDelta: {
            dx: window.scrollX - syncBase.x,
            dy: window.scrollY - syncBase.y
          }
        },
        "*"
      );
    }
  }

  window.addEventListener(
    "scroll",
    () => {
      if (suppressScroll) return;
      syncScrollToOverlay();
    },
    { passive: true }
  );

  // iframe 側の準備完了通知・スクロール通知
  window.addEventListener("message", (e) => {
    if (!iframe || e.source !== iframe.contentWindow || !e.data) return;
    if (e.data.__frameOverlayReady) {
      // iframe が読み込み直されたら、その時点を新しい基準にする
      if (store && store.settings.syncScroll) rebaseSync();
      sendModeToFrame();
    }
    const s = e.data.__frameOverlayScrollFromFrame;
    if (s && store && store.settings.syncScroll && syncBase) {
      suppressScroll = true;
      window.scrollTo(syncBase.x + s.dx, syncBase.y + s.dy);
      requestAnimationFrame(() => (suppressScroll = false));
    }
  });

  function applyTransform() {
    const p = activePreset();
    if (!root || !p) return;
    let x = p.x;
    let y = p.y;
    // 画像モードのスクロール連動: 基準からのスクロール差分だけ画像をずらす
    if (store.settings.syncScroll && syncBase && (p.srcType || "url") === "image") {
      x -= window.scrollX - syncBase.x;
      y -= window.scrollY - syncBase.y;
    }
    root.style.transform = `translate(${x}px, ${y}px) scale(${p.scale})`;
  }

  let prevSync = false;

  function render() {
    if (!store) return;
    // 同期がオフ→オンに切り替わった瞬間の位置を新しい基準にする
    const syncNow = !!store.settings.syncScroll;
    if (syncNow && !prevSync) rebaseSync();
    prevSync = syncNow;
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

    const useImage = (p.srcType || "url") === "image";
    iframe.style.display = useImage ? "none" : "block";
    overlayImg.style.display = useImage ? "block" : "none";

    if (useImage) {
      const im = imagesCache[p.id];
      if (im && im.data) {
        if (overlayImg.src !== im.data) overlayImg.src = im.data;
      } else {
        overlayImg.removeAttribute("src");
      }
    } else {
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
    syncScrollToOverlay();

    // 画像モードではヘッダ剥がし不要
    chrome.runtime.sendMessage({ type: "setHeaderStripping", enabled: !useImage });
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
        if (imagesCache[msg.presetId]) {
          delete imagesCache[msg.presetId];
          chrome.storage.local.set({ foImages: imagesCache });
        }
        save().then(render);
        sendResponse({ ok: true });
        return;
      }
      case "pickImage": {
        openPicker(msg.presetId);
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
    if (area !== "local") return;
    if (changes.foStore) {
      store = migrate(changes.foStore.newValue);
      render();
    }
    if (changes.foImages) {
      imagesCache = changes.foImages.newValue || {};
      render();
    }
  });

  loadTabOverride();
  load();
})();
