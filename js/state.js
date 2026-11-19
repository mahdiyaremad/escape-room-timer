(function () {
  var CHANNEL = "countdown-link";
  var KEY = "countdown-state-v1";

  function create() {
    return {
      remainingMs: 120000,
      durationMs: 120000,
      status: "idle",
      msPerTick: 1000,
      endsAt: null,
      penaltyUntil: 0,
      penaltyId: 0,
      presentation: null,
      revision: 0,
      volume: 0.85,
      pulse: true,
      caption: "",
      captionId: 0,
      voiceFile: "",
      voiceText: "",
      voiceId: 0,
      timerVisible: true,
      notifId: 0,
      sfxFile: "",
      sfxId: 0,
      sfxPlaying: false,
      sfxVolume: 0.7,
      heartFile: "",
      heartId: 0,
      heartPlaying: false,
      heartVolume: 0.65,
      hitFile: "",
      hitId: 0,
      bgImage: "",
      bgId: 0,
      winMode: false,
      camera: false,
      speak: false,
      speakId: 0,
      updatedAt: 0
    };
  }

  function clone(state) {
    return JSON.parse(JSON.stringify(state));
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || typeof data.revision !== "number") return null;
      return Object.assign(create(), data);
    } catch (err) {
      return null;
    }
  }

  function save(state) {
    try {
      var copy = clone(state);
      // Keep live data-URL backgrounds out of storage (quota / reload noise).
      if (copy.bgImage && String(copy.bgImage).indexOf("data:") === 0) copy.bgImage = "";
      localStorage.setItem(KEY, JSON.stringify(copy));
    } catch (err) {}
  }

  // Displayed time is real time stretched by msPerTick (1000 = one real second).
  function computeRemaining(state, now) {
    if (!state) return 0;
    if (state.status === "running" && typeof state.endsAt === "number") {
      var per = state.msPerTick > 0 ? state.msPerTick : 1000;
      return Math.max(0, ((state.endsAt - now) / per) * 1000);
    }
    return Math.max(0, state.remainingMs || 0);
  }

  // endsAt from the server is on the server clock. Shift it onto this device.
  function toLocalEndsAt(endsAt, serverNow) {
    if (typeof endsAt !== "number" || typeof serverNow !== "number") return endsAt;
    return endsAt - (serverNow - Date.now());
  }

  function wholeSeconds(ms) {
    if (!(ms > 0)) return 0;
    return Math.ceil(ms / 1000 - 1e-9);
  }

  function formatClock(ms) {
    var sec = wholeSeconds(ms);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    var mm = m < 100 ? String(m).padStart(2, "0") : String(m);
    return mm + ":" + String(s).padStart(2, "0");
  }

  function urgency(ms) {
    var s = ms / 1000;
    if (s <= 10) return "critical";
    if (s <= 30) return "hot";
    if (s <= 60) return "warm";
    return "calm";
  }

  function paintClock(el, ms) {
    if (!el) return;
    var text = formatClock(ms);
    if (el.getAttribute("data-clock") === text) return;
    var prev = el.getAttribute("data-clock");
    el.setAttribute("data-clock", text);
    if (!prev || el.childElementCount !== text.length) {
      var frag = document.createDocumentFragment();
      for (var i = 0; i < text.length; i++) {
        frag.appendChild(clockCell(text.charAt(i)));
      }
      el.replaceChildren(frag);
      return;
    }
    for (var n = 0; n < text.length; n++) {
      var ch = text.charAt(n);
      var cell = el.children[n];
      if (cell.textContent === ch) continue;
      cell.replaceWith(clockCell(ch));
    }
  }

  function clockCell(ch) {
    var span = document.createElement("span");
    span.className = ch === ":" ? "colon" : "digit";
    span.textContent = ch;
    return span;
  }

  function createPresenter() {
    var anim = null;
    var seen = new Set();

    function sync(state) {
      var p = state && state.presentation;
      if (!p || typeof p.id !== "number") {
        anim = null;
        return;
      }
      if (seen.has(p.id)) return;
      seen.add(p.id);
      var dur = p.dur || 520;
      if (typeof p.at === "number" && Date.now() - p.at > dur + 150) return;
      anim = {
        id: p.id,
        from: p.fromMs,
        kind: p.kind,
        dur: dur,
        start: performance.now()
      };
    }

    function value(state, perfNow) {
      var live = computeRemaining(state, Date.now());
      if (!anim) return live;
      var t = Math.min(1, (perfNow - anim.start) / anim.dur);
      var e = anim.kind === "penalty" ? 1 - Math.pow(1 - t, 3) : t * t * (3 - 2 * t);
      var visual = anim.from + (live - anim.from) * e;
      if (t >= 1) anim = null;
      return Math.max(0, visual);
    }

    return { sync: sync, value: value };
  }

  // Local WebSocket on the LAN server. Internet sync is the IP hub (not ntfy).
  function createLink(role, handler) {
    var channel = null;
    var clientId = "";
    var adminPin = "";
    var serverOk = false;
    var hubOk = false;
    var ws = null;
    var hubWs = null;
    var reconnectTimer = null;
    var hubReconnectTimer = null;
    var es = null;
    var useSseFallback = false;
    var seenIds = {};
    var seenOrder = [];
    var hub = {
      enabled: true,
      baseUrl: "http://5.57.39.218:6985",
      key: "brhub-7k3m9qx2-6985"
    };

    try {
      clientId = sessionStorage.getItem("countdown-client-id") || "";
      if (!clientId) {
        clientId = role + "-" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
        sessionStorage.setItem("countdown-client-id", clientId);
      }
      adminPin = sessionStorage.getItem("countdown-admin-pin") || "";
    } catch (err) {
      clientId = role + "-" + String(Date.now());
    }

    try {
      channel = new BroadcastChannel(CHANNEL);
    } catch (err) {}

    function rememberId(id) {
      if (!id) return false;
      if (seenIds[id]) return true;
      seenIds[id] = 1;
      seenOrder.push(id);
      if (seenOrder.length > 500) {
        seenOrder.splice(0, 200).forEach(function (key) { delete seenIds[key]; });
      }
      return false;
    }

    function onMsg(msg) {
      if (!msg || msg.channel !== CHANNEL) return;
      if (msg.id && rememberId(msg.id)) return;
      if (msg.clientId && msg.clientId === clientId) return;
      if (!msg.clientId && msg.from === role) return;
      handler(msg);
    }

    function emitLocal(msg) {
      if (channel) {
        try { channel.postMessage(msg); } catch (err) {}
      }
      if (window.opener && !window.opener.closed) {
        try { window.opener.postMessage(msg, "*"); } catch (err) {}
      }
    }

    function wsUrl() {
      var proto = location.protocol === "https:" ? "wss:" : "ws:";
      var path = "/ws?role=" + encodeURIComponent(role) + "&clientId=" + encodeURIComponent(clientId);
      if (adminPin) path += "&pin=" + encodeURIComponent(adminPin);
      return proto + "//" + location.host + path;
    }

    function makeId() {
      return clientId + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    }

    function reportHub(ok, base, error) {
      hubOk = !!ok;
      handler({
        channel: CHANNEL,
        from: "server",
        clientId: "server",
        type: "hub-status",
        ok: !!ok,
        base: base || hub.baseUrl,
        error: error || ""
      });
    }

    function hubWsUrl() {
      var base = String(hub.baseUrl || "").replace(/\/$/, "");
      if (!base) return "";
      var wsBase = base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
      var url = wsBase + "/ws?role=" + encodeURIComponent(role) + "&clientId=" + encodeURIComponent(clientId);
      if (hub.key) url += "&key=" + encodeURIComponent(hub.key);
      return url;
    }

    function emitHub(msg) {
      if (!hub.enabled || !hub.baseUrl) return;
      if (msg.via === "hub") return;
      var t = msg.type || "";
      if (t === "ping" || t === "heartbeat" || t === "peers" || t === "ready" || t === "auth" || t === "hub-status") return;
      if (!hubWs || hubWs.readyState !== 1) return;
      try { hubWs.send(JSON.stringify(msg)); } catch (err) {}
    }

    function emitHttp(msg) {
      if (typeof fetch !== "function") return;
      var headers = { "Content-Type": "application/json" };
      if (adminPin) headers["X-Admin-Pin"] = adminPin;
      fetch("/api/room/publish", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(msg),
        keepalive: true
      }).then(function (res) {
        if (!ws || ws.readyState !== 1) serverOk = res.ok || res.status === 401;
        return res.json().catch(function () { return null; }).then(function (data) {
          if (res.status === 401 && handler) {
            handler({ channel: CHANNEL, from: "server", type: "auth", ok: false, error: (data && data.error) || "pin" });
          }
          if (data && data.peers) {
            handler({ channel: CHANNEL, from: "server", clientId: "server", type: "peers", peers: data.peers });
          }
        });
      }).catch(function () {
        if (!ws || ws.readyState !== 1) serverOk = false;
      });
    }

    function emit(message) {
      var msg = Object.assign({
        channel: CHANNEL,
        from: role,
        clientId: clientId,
        clientNow: Date.now(),
        id: makeId()
      }, message);
      if (adminPin && (msg.type === "state" || msg.type === "cover" || msg.type === "hello" || msg.type === "speak-play")) {
        msg.pin = adminPin;
      }
      emitLocal(msg);
      var localUp = ws && ws.readyState === 1;
      if (localUp) {
        try { ws.send(JSON.stringify(msg)); } catch (err) { emitHttp(msg); emitHub(msg); }
      } else {
        emitHttp(msg);
        emitHub(msg);
      }
    }

    function connectSse() {
      if (typeof EventSource === "undefined") return;
      if (es) {
        try { es.close(); } catch (err) {}
        es = null;
      }
      var url = "/api/room/events?role=" + encodeURIComponent(role) + "&clientId=" + encodeURIComponent(clientId);
      try {
        es = new EventSource(url);
      } catch (err) {
        return;
      }
      es.onopen = function () { serverOk = true; };
      es.onmessage = function (e) {
        serverOk = true;
        try { onMsg(JSON.parse(e.data)); } catch (err) {}
      };
      es.onerror = function () {
        if (!ws || ws.readyState !== 1) serverOk = false;
      };
    }

    function connectWs() {
      if (typeof WebSocket === "undefined") {
        useSseFallback = true;
        connectSse();
        return;
      }
      if (ws) {
        try { ws.close(); } catch (err) {}
        ws = null;
      }
      try {
        ws = new WebSocket(wsUrl());
      } catch (err) {
        useSseFallback = true;
        connectSse();
        scheduleReconnect();
        return;
      }
      ws.onopen = function () {
        serverOk = true;
        useSseFallback = false;
        if (es) {
          try { es.close(); } catch (err) {}
          es = null;
        }
        try {
          ws.send(JSON.stringify({
            channel: CHANNEL,
            from: role,
            clientId: clientId,
            type: "hello",
            pin: adminPin || undefined
          }));
        } catch (err) {}
      };
      ws.onmessage = function (e) {
        serverOk = true;
        try { onMsg(JSON.parse(e.data)); } catch (err) {}
      };
      ws.onerror = function () {
        serverOk = false;
      };
      ws.onclose = function () {
        serverOk = false;
        ws = null;
        if (!useSseFallback) {
          useSseFallback = true;
          connectSse();
        }
        scheduleReconnect();
      };
    }

    function connectHub() {
      if (hubWs) {
        try { hubWs.onclose = null; hubWs.close(); } catch (err) {}
        hubWs = null;
      }
      if (!hub.enabled || !hub.baseUrl || typeof WebSocket === "undefined") {
        reportHub(false, hub.baseUrl, "هاب خاموش است");
        return;
      }
      var url = hubWsUrl();
      var sock;
      try {
        sock = new WebSocket(url);
      } catch (err) {
        reportHub(false, hub.baseUrl, "خطای اتصال");
        scheduleHubReconnect();
        return;
      }
      hubWs = sock;
      sock.onopen = function () {
        reportHub(true, String(hub.baseUrl).replace(/^https?:\/\//, ""), "");
        try {
          sock.send(JSON.stringify({
            channel: CHANNEL,
            from: role,
            clientId: clientId,
            id: makeId(),
            type: "hello"
          }));
        } catch (err) {}
      };
      sock.onmessage = function (e) {
        hubOk = true;
        if (ws && ws.readyState === 1) return;
        var msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (!msg || msg.channel !== CHANNEL) return;
        msg.via = "hub";
        onMsg(msg);
      };
      sock.onerror = function () {
        reportHub(false, hub.baseUrl, "خطای اتصال");
      };
      sock.onclose = function () {
        if (hubWs !== sock) return;
        hubWs = null;
        reportHub(false, hub.baseUrl, "قطع شد");
        scheduleHubReconnect();
      };
    }

    function scheduleReconnect() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWs, 1400);
    }

    function scheduleHubReconnect() {
      if (hubReconnectTimer) clearTimeout(hubReconnectTimer);
      hubReconnectTimer = setTimeout(connectHub, 1500);
    }

    function applyHubConfig(cfg) {
      if (!cfg || typeof cfg !== "object") return;
      var prev = hub.baseUrl + "|" + hub.key + "|" + (hub.enabled ? "1" : "0");
      if (typeof cfg.enabled === "boolean") hub.enabled = cfg.enabled;
      if (cfg.baseUrl) hub.baseUrl = String(cfg.baseUrl).replace(/\/$/, "");
      if (typeof cfg.key === "string" && cfg.key) hub.key = cfg.key;
      var next = hub.baseUrl + "|" + hub.key + "|" + (hub.enabled ? "1" : "0");
      if (next !== prev) connectHub();
    }

    if (channel) channel.onmessage = function (e) { onMsg(e.data); };
    window.addEventListener("message", function (e) { onMsg(e.data); });
    window.addEventListener("storage", function (e) {
      if (e.key !== KEY || !e.newValue) return;
      try {
        handler({ channel: CHANNEL, from: "storage", type: "state", state: JSON.parse(e.newValue) });
      } catch (err) {}
    });

    connectWs();
    connectHub();

    if (typeof fetch === "function") {
      fetch("/api/room/info")
        .then(function (r) { return r.json(); })
        .then(function (info) {
          if (info && info.hub) applyHubConfig(info.hub);
        })
        .catch(function () {});
    }

    return {
      emit: emit,
      clientId: clientId,
      setPin: function (pin) {
        adminPin = typeof pin === "string" ? pin : "";
        try { sessionStorage.setItem("countdown-admin-pin", adminPin); } catch (err) {}
        if (ws && ws.readyState === 1) {
          try { ws.close(); } catch (err) {}
        } else {
          connectWs();
        }
      },
      getPin: function () { return adminPin; },
      isServerOk: function () { return serverOk || hubOk; },
      isHubOk: function () { return hubOk; },
      isNtfyOk: function () { return hubOk; },
      getHub: function () {
        return { baseUrl: hub.baseUrl, key: hub.key, ok: hubOk };
      }
    };
  }

  function recover(state, now) {
    if (state.status === "running" && computeRemaining(state, now) <= 0) {
      state.status = "ended";
      state.remainingMs = 0;
      state.endsAt = null;
      state.revision += 1;
      state.updatedAt = now;
    }
    return state;
  }

  function start(state, now) {
    if (state.status === "running") return null;
    if (state.status !== "paused") state.remainingMs = state.durationMs;
    if (!(state.remainingMs > 0)) return null;
    state.status = "running";
    state.endsAt = now + (state.remainingMs / 1000) * state.msPerTick;
    state.presentation = null;
    state.penaltyUntil = 0;
    return state;
  }

  function pause(state, now) {
    if (state.status !== "running") return null;
    state.remainingMs = computeRemaining(state, now);
    state.endsAt = null;
    state.status = "paused";
    state.presentation = null;
    return state;
  }

  function resume(state, now) {
    if (state.status !== "paused") return null;
    if (!(state.remainingMs > 0)) return null;
    state.status = "running";
    state.endsAt = now + (state.remainingMs / 1000) * state.msPerTick;
    state.presentation = null;
    return state;
  }

  function reset(state) {
    state.remainingMs = state.durationMs;
    state.endsAt = null;
    state.status = "idle";
    state.penaltyUntil = 0;
    state.penaltyId = 0;
    state.presentation = null;
    return state;
  }

  function setDuration(state, ms) {
    if (state.status === "running") return null;
    if (!(ms > 0)) return null;
    state.durationMs = ms;
    if (state.status === "ended") return state;
    state.remainingMs = ms;
    state.status = "idle";
    state.endsAt = null;
    state.presentation = null;
    state.penaltyUntil = 0;
    return state;
  }

  function penalty(state, subtractMs, now) {
    if (state.status === "ended") return null;
    if (!(subtractMs > 0)) return null;
    var current = computeRemaining(state, now);
    if (!(current > 0)) return null;
    var nextMs = Math.max(0, current - subtractMs);
    var id = state.revision + 1;
    state.presentation = {
      id: id,
      kind: "penalty",
      fromMs: current,
      toMs: nextMs,
      dur: 680,
      at: now
    };
    state.penaltyUntil = now + 3000;
    state.penaltyId = id;
    state.remainingMs = nextMs;
    if (state.status === "idle") state.durationMs = Math.max(nextMs, 0);
    if (nextMs <= 0) {
      state.status = "ended";
      state.remainingMs = 0;
      state.endsAt = null;
      if (state.durationMs <= 0) state.durationMs = current;
      return state;
    }
    if (state.status === "running") {
      state.endsAt = now + (nextMs / 1000) * state.msPerTick;
    }
    return state;
  }

  function trim(state, addMs, now) {
    if (state.status === "ended") return null;
    if (!(addMs > 0)) return null;
    var current = computeRemaining(state, now);
    var nextMs = current + addMs;
    var id = state.revision + 1;
    state.presentation = {
      id: id,
      kind: "grace",
      fromMs: current,
      toMs: nextMs,
      dur: 520,
      at: now
    };
    state.remainingMs = nextMs;
    if (state.status === "running") {
      state.endsAt = now + (nextMs / 1000) * state.msPerTick;
    }
    if (state.status === "idle") state.durationMs = nextMs;
    return state;
  }

  function setRate(state, msPerTick, now) {
    var next = clamp(msPerTick, 1000, 2000);
    if (Math.abs(next - state.msPerTick) < 0.5) return null;
    var current = computeRemaining(state, now);
    state.msPerTick = next;
    if (state.status === "running") {
      state.remainingMs = current;
      state.endsAt = now + (current / 1000) * next;
    }
    return state;
  }

  function setVolume(state, volume) {
    var v = clamp(volume, 0, 1);
    if (Math.abs(v - state.volume) < 0.0005) return null;
    state.volume = v;
    return state;
  }

  function setPulse(state, on) {
    var next = !!on;
    if (state.pulse === next) return null;
    state.pulse = next;
    return state;
  }

  function seal(state) {
    if (state.status === "ended") return null;
    state.status = "ended";
    state.remainingMs = 0;
    state.endsAt = null;
    state.presentation = null;
    return state;
  }

  function setCaption(state, text) {
    state.caption = typeof text === "string" ? text : "";
    state.captionId = (state.captionId || 0) + 1;
    return state;
  }

  function speakVoice(state, file) {
    if (typeof file !== "string" || !file) return null;
    state.voiceFile = file;
    state.voiceText = "";
    state.voiceId = (state.voiceId || 0) + 1;
    return state;
  }

  function speakText(state, text) {
    var next = typeof text === "string" ? text.trim() : "";
    if (!next) return null;
    state.voiceText = next;
    state.voiceFile = "";
    state.voiceId = (state.voiceId || 0) + 1;
    return state;
  }

  function stopVoice(state) {
    if (!state.voiceFile && !state.voiceText && !(state.voiceId > 0)) return null;
    state.voiceFile = "";
    state.voiceText = "";
    state.voiceId = (state.voiceId || 0) + 1;
    return state;
  }

  function setTimerVisible(state, on) {
    var next = !!on;
    if (state.timerVisible === next) return null;
    state.timerVisible = next;
    return state;
  }

  function fireNotif(state) {
    state.notifId = (state.notifId || 0) + 1;
    return state;
  }

  function playSfx(state, file) {
    if (typeof file !== "string" || !file) return null;
    state.sfxFile = file;
    state.sfxPlaying = true;
    state.sfxId = (state.sfxId || 0) + 1;
    return state;
  }

  function stopSfx(state) {
    if (!state.sfxPlaying && !state.sfxFile) return null;
    state.sfxPlaying = false;
    state.sfxFile = "";
    state.sfxId = (state.sfxId || 0) + 1;
    return state;
  }

  function setSfxVolume(state, volume) {
    var v = clamp(volume, 0, 1);
    if (Math.abs(v - (state.sfxVolume || 0)) < 0.0005) return null;
    state.sfxVolume = v;
    return state;
  }

  function setSpeak(state, on) {
    var next = !!on;
    if (state.speak === next) return null;
    state.speak = next;
    state.speakId = (state.speakId || 0) + 1;
    return state;
  }

  function playHeart(state, file) {
    if (typeof file !== "string" || !file) return null;
    state.heartFile = file;
    state.heartPlaying = true;
    state.heartId = (state.heartId || 0) + 1;
    return state;
  }

  function stopHeart(state) {
    if (!state.heartPlaying && !state.heartFile) return null;
    state.heartPlaying = false;
    state.heartFile = "";
    state.heartId = (state.heartId || 0) + 1;
    return state;
  }

  function setHeartVolume(state, volume) {
    var v = clamp(volume, 0, 1);
    if (Math.abs(v - (state.heartVolume || 0)) < 0.0005) return null;
    state.heartVolume = v;
    return state;
  }

  function playHit(state, file) {
    if (typeof file !== "string" || !file) return null;
    state.hitFile = file;
    state.hitId = (state.hitId || 0) + 1;
    return state;
  }

  function stopHit(state) {
    if (!state.hitFile && !(state.hitId > 0)) return null;
    state.hitFile = "";
    state.hitId = (state.hitId || 0) + 1;
    return state;
  }

  function setBgImage(state, src) {
    var next = typeof src === "string" ? src : "";
    if (state.bgImage === next) return null;
    state.bgImage = next;
    state.bgId = (state.bgId || 0) + 1;
    return state;
  }

  function setWinMode(state, on) {
    var next = !!on;
    if (!!state.winMode === next) return null;
    state.winMode = next;
    return state;
  }

  function setCamera(state, on) {
    var next = !!on;
    if (!!state.camera === next) return null;
    state.camera = next;
    return state;
  }

  window.Countdown = {
    CHANNEL: CHANNEL,
    KEY: KEY,
    create: create,
    clone: clone,
    load: load,
    save: save,
    recover: recover,
    computeRemaining: computeRemaining,
    toLocalEndsAt: toLocalEndsAt,
    wholeSeconds: wholeSeconds,
    formatClock: formatClock,
    urgency: urgency,
    paintClock: paintClock,
    createPresenter: createPresenter,
    createLink: createLink,
    start: start,
    pause: pause,
    resume: resume,
    reset: reset,
    setDuration: setDuration,
    penalty: penalty,
    trim: trim,
    setRate: setRate,
    setVolume: setVolume,
    setPulse: setPulse,
    seal: seal,
    setCaption: setCaption,
    speakVoice: speakVoice,
    speakText: speakText,
    stopVoice: stopVoice,
    setTimerVisible: setTimerVisible,
    fireNotif: fireNotif,
    playSfx: playSfx,
    stopSfx: stopSfx,
    setSfxVolume: setSfxVolume,
    playHeart: playHeart,
    stopHeart: stopHeart,
    setHeartVolume: setHeartVolume,
    playHit: playHit,
    stopHit: stopHit,
    setBgImage: setBgImage,
    setWinMode: setWinMode,
    setCamera: setCamera,
    setSpeak: setSpeak
  };
})();
