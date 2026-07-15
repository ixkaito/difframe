// 実装ページ側に注入され、オーバーレイ iframe を生成・制御する。
(() => {
  if (window.__frameOverlayInjected) return;
  window.__frameOverlayInjected = true;

  const DEFAULTS = {
    enabled: false,
    url: "",
    opacity: 0.5,
    scale: 1,
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
    lock: true, // true = 下のページを操作 / false = iframe を操作
    blend: "normal", // normal | difference
    moveMode: false
  };

  let state = { ...DEFAULTS };
  let root, iframe, handle, coordLabel;

  function buildFigmaEmbed(url) {
    // Figma の共有 URL を埋め込み URL に変換。既に embed ならそのまま。
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
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origX = state.x;
      origY = state.y;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      state.x = origX + (e.clientX - startX);
      state.y = origY + (e.clientY - startY);
      applyTransform();
    });
    window.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        save();
      }
    });
    // 移動モード中は矢印キーで微調整
    window.addEventListener("keydown", (e) => {
      if (!state.enabled || !state.moveMode) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowLeft") state.x -= step;
      else if (e.key === "ArrowRight") state.x += step;
      else if (e.key === "ArrowUp") state.y -= step;
      else if (e.key === "ArrowDown") state.y += step;
      else return;
      e.preventDefault();
      applyTransform();
      save();
    });
  }

  function applyTransform() {
    if (!iframe) return;
    iframe.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    if (coordLabel) coordLabel.textContent = `x:${state.x} y:${state.y} ×${state.scale}`;
  }

  function render() {
    if (!state.enabled) {
      if (root) root.style.display = "none";
      chrome.runtime.sendMessage({ type: "setHeaderStripping", enabled: false });
      return;
    }
    ensureDom();
    root.style.display = "block";

    const src = buildFigmaEmbed(state.url || "");
    if (src && iframe.dataset.src !== src) {
      iframe.dataset.src = src;
      iframe.src = src;
    }
    iframe.style.width = state.width + "px";
    iframe.style.height = state.height + "px";
    iframe.style.opacity = String(state.opacity);
    iframe.style.mixBlendMode = state.blend;
    iframe.style.pointerEvents = state.lock ? "none" : "auto";
    root.style.pointerEvents = state.lock ? "none" : "auto";
    root.classList.toggle("fo-move-mode", !!state.moveMode);
    applyTransform();

    // ヘッダ剥がしを有効化
    chrome.runtime.sendMessage({ type: "setHeaderStripping", enabled: true });
  }

  function save() {
    chrome.storage.local.set({ foState: state });
  }

  function load() {
    return chrome.storage.local.get("foState").then((r) => {
      if (r.foState) state = { ...DEFAULTS, ...r.foState };
      render();
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "getState") {
      sendResponse(state);
      return;
    }
    if (msg?.type === "updateState") {
      state = { ...state, ...msg.patch };
      save();
      render();
      sendResponse(state);
      return;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.foState) {
      state = { ...DEFAULTS, ...changes.foState.newValue };
      render();
    }
  });

  load();
})();
