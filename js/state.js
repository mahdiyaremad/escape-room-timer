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

  // file:// gives each document its own origin, so BroadcastChannel and
  // localStorage do not cross the two windows. The launcher relays postMessage.
  function createLink(role, handler) {
    var channel = null;
    try {
      channel = new BroadcastChannel(CHANNEL);
    } catch (err) {}

    function emit(message) {
      var msg = Object.assign({ channel: CHANNEL, from: role }, message);
      if (channel) {
        try { channel.postMessage(msg); } catch (err) {}
      }
      if (window.opener && !window.opener.closed) {
        try { window.opener.postMessage(msg, "*"); } catch (err) {}
      }
    }

    function onMsg(msg) {
      if (!msg || msg.channel !== CHANNEL) return;
      if (msg.from === role) return;
      handler(msg);
    }

    if (channel) channel.onmessage = function (e) { onMsg(e.data); };
    window.addEventListener("message", function (e) { onMsg(e.data); });
    window.addEventListener("storage", function (e) {
      if (e.key !== KEY || !e.newValue) return;
      try {
        handler({ channel: CHANNEL, from: "storage", type: "state", state: JSON.parse(e.newValue) });
      } catch (err) {}
    });

    return { emit: emit };
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
