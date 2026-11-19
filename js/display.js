(function () {
  var C = window.Countdown;
  var state = C.recover(C.load() || C.create(), Date.now());
  var bootRevision = state.revision;
  var presenter = C.createPresenter();
  presenter.sync(state);

  var audio = window.CountdownAudio.createEngine();
  audio.setVolume(state.volume);
  audio.setPulse(state.pulse !== false);

  var clockEl = document.getElementById("clock");
  var heroEl = document.getElementById("hero");
  var ecgPath = document.getElementById("ecg-path");
  var captionEl = document.getElementById("caption");
  var coverEl = document.getElementById("cover");
  var coverImgEl = document.getElementById("cover-img");
  var camEl = document.getElementById("cam");
  var camImgEl = document.getElementById("cam-img");
  var liveEl = document.getElementById("live");
  var armBtn = document.getElementById("arm");
  var camWant = false;
  var camSrc = "";
  var lastWhole = null;
  var heardPenalty = state.penaltyUntil > Date.now() ? 0 : (state.penaltyId || 0);
  var heardNotif = state.notifId || 0;
  var heardSfx = state.sfxId || 0;
  var heardHeart = state.heartId || 0;
  var heardHit = state.hitId || 0;
  var heardVoice = 0;
  var voiceUtter = null;
  var heardBg = -1;
  var coverCache = "";
  var lastSfxRetry = 0;
  var lastHeartRetry = 0;
  var lastCueRetry = 0;
  var lastVoiceRetry = 0;
  var heardCue = 0;
  var droppedCue = 0;
  var pendingCue = null;
  var chimed = false;
  var expirySent = false;
  var lastAnnounced = "";
  var bedKey = "";
  var ecgScroll = 0;
  var lastEcgPaint = 0;

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (err) {}
  var TYPE_MS = reduceMotion ? 0 : 42;
  var BACK_MS = reduceMotion ? 0 : 30;
  var captionVisual = "";
  var captionTarget = "";
  var captionSeenId = -1;
  var captionTimer = null;

  var link = C.createLink("display", onMsg);

  function paintCaption() {
    if (!captionEl) return;
    var raw = captionVisual || "";
    var active = raw.replace(/\s+$/, "").length > 0;
    captionEl.classList.toggle("is-active", active);
    if (!active) {
      captionEl.replaceChildren();
      return;
    }
    var lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    while (lines.length && !lines[lines.length - 1].length && lines.length > 1) lines.pop();
    var frag = document.createDocumentFragment();
    lines.forEach(function (line, i) {
      var el = document.createElement(i === 0 ? "strong" : "span");
      el.className = i === 0 ? "caption-title" : "caption-line";
      el.textContent = line.length ? line : "\u00a0";
      frag.appendChild(el);
    });
    captionEl.replaceChildren(frag);
  }

  function stepCaption() {
    captionTimer = null;
    if (captionVisual === captionTarget) {
      paintCaption();
      return;
    }
    if (reduceMotion) {
      captionVisual = captionTarget;
      paintCaption();
      return;
    }
    if (captionTarget.indexOf(captionVisual) === 0) {
      captionVisual = captionTarget.slice(0, captionVisual.length + 1);
      paintCaption();
      if (captionVisual !== captionTarget) {
        captionTimer = setTimeout(stepCaption, TYPE_MS);
      }
      return;
    }
    captionVisual = captionVisual.slice(0, -1);
    paintCaption();
    captionTimer = setTimeout(stepCaption, BACK_MS);
  }

  function kickCaption() {
    if (captionTimer != null) return;
    if (captionVisual === captionTarget) {
      paintCaption();
      return;
    }
    stepCaption();
  }

  function syncCaption() {
    var id = typeof state.captionId === "number" ? state.captionId : 0;
    var next = typeof state.caption === "string" ? state.caption : "";
    if (id === captionSeenId && next === captionTarget) return;
    captionSeenId = id;
    captionTarget = next;
    if (captionTimer != null) {
      clearTimeout(captionTimer);
      captionTimer = null;
    }
    // Soundbar switches: skip backspace wipe, hard-clear, then type forward.
    if (captionTarget.indexOf(captionVisual) !== 0) {
      captionVisual = "";
      paintCaption();
    }
    kickCaption();
  }

  function stopVoiceSpeech() {
    if (voiceUtter) {
      try { voiceUtter.onend = null; voiceUtter.onerror = null; } catch (err) {}
      voiceUtter = null;
    }
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (err) {}
    }
  }

  function pickFaVoice() {
    if (!window.speechSynthesis) return null;
    var voices = window.speechSynthesis.getVoices() || [];
    var best = null;
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      var lang = String(v.lang || "").toLowerCase().replace(/_/g, "-");
      if (lang === "fa-ir" || lang === "fa") return v;
      if (!best && lang.indexOf("fa") === 0) best = v;
    }
    return best;
  }

  function speakVoiceText(raw) {
    if (!window.speechSynthesis) return false;
    var spoken = String(raw || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n+/g, ". ")
      .replace(/\s+/g, " ")
      .trim();
    if (!spoken) return false;
    stopVoiceSpeech();
    audio.stopCue();
    var utter = new SpeechSynthesisUtterance(spoken);
    utter.lang = "fa-IR";
    utter.rate = 0.92;
    utter.pitch = 1;
    var voice = pickFaVoice();
    if (voice) utter.voice = voice;
    voiceUtter = utter;
    utter.onend = function () {
      if (voiceUtter === utter) voiceUtter = null;
    };
    utter.onerror = function () {
      if (voiceUtter === utter) voiceUtter = null;
    };
    window.speechSynthesis.speak(utter);
    return true;
  }

  function noteVoice() {
    var id = state.voiceId || 0;
    if (id === heardVoice) return;
    var file = typeof state.voiceFile === "string" ? state.voiceFile : "";
    var text = typeof state.voiceText === "string" ? state.voiceText : "";
    if (!file && !text) {
      stopVoiceSpeech();
      audio.stopCue();
      heardVoice = id;
      return;
    }
    if (text) {
      if (speakVoiceText(text)) heardVoice = id;
      return;
    }
    stopVoiceSpeech();
    if (audio.playCue(file)) heardVoice = id;
  }

  function tryPlayCue() {
    if (!pendingCue) return;
    if (pendingCue.id <= droppedCue || pendingCue.id === heardCue) {
      pendingCue = null;
      return;
    }
    var blob = pendingCue.blob;
    if (!blob || typeof blob.size !== "number" || !blob.size) {
      pendingCue = null;
      return;
    }
    if (audio.playCue(blob)) {
      heardCue = pendingCue.id;
      pendingCue = null;
    }
  }

  function onMsg(msg) {
    if (msg.type === "cue") {
      if (typeof msg.cueId !== "number" || !msg.blob) return;
      if (msg.cueId === heardCue || msg.cueId <= droppedCue) return;
      pendingCue = { id: msg.cueId, blob: msg.blob };
      tryPlayCue();
      return;
    }
    if (msg.type === "cue-stop") {
      var stopId = typeof msg.cueId === "number" ? msg.cueId : 0;
      if (stopId && heardCue && stopId < heardCue) return;
      if (pendingCue && stopId && pendingCue.id > stopId) return;
      if (stopId) droppedCue = stopId;
      if (!pendingCue || !stopId || pendingCue.id === stopId) pendingCue = null;
      if (!stopId || !heardCue || stopId >= heardCue) {
        audio.stopCue();
        if (stopId) heardCue = stopId;
      }
      return;
    }
    if (msg.type === "cover") {
      if (typeof msg.bgId === "number") state.bgId = msg.bgId;
      if (typeof msg.bgImage === "string") state.bgImage = msg.bgImage;
      syncCover(true);
      return;
    }
    if (msg.type === "speak-play" && msg.url) {
      if (msg.clientId && link && msg.clientId === link.clientId) return;
      audio.playCue(msg.url);
      return;
    }
    if (msg.type === "tick") {
      applyTick(msg);
      return;
    }
    if (msg.type === "state" && msg.state && typeof msg.state.revision === "number") {
      takeState(msg.state, typeof msg.serverNow === "number" ? msg.serverNow : msg.state.serverNow, false);
      return;
    }
  }

  function applyTick(msg) {
    if (!msg || typeof msg.revision !== "number" || msg.revision < state.revision) return;
    if (msg.status === "ended" || msg.revision > state.revision) {
      state.status = msg.status || state.status;
      state.remainingMs = msg.status === "ended" ? 0 : (typeof msg.remainingMs === "number" ? msg.remainingMs : state.remainingMs);
      state.endsAt = msg.status === "ended" ? null : C.toLocalEndsAt(msg.endsAt, msg.serverNow);
      state.revision = msg.revision;
      presenter.sync(state);
      return;
    }
    if (state.status === "running" && msg.revision === state.revision) {
      if (typeof msg.remainingMs === "number") state.remainingMs = msg.remainingMs;
      if (typeof msg.endsAt === "number") state.endsAt = C.toLocalEndsAt(msg.endsAt, msg.serverNow);
    }
  }

  function takeState(incoming, serverNow, force) {
    if (!incoming || typeof incoming.revision !== "number") return;
    if (!force && incoming.revision < state.revision) return;
    if (
      (!incoming.bgImage || !String(incoming.bgImage)) &&
      coverCache &&
      typeof incoming.bgId === "number" &&
      incoming.bgId === heardBg
    ) {
      incoming = Object.assign({}, incoming, { bgImage: coverCache });
    } else {
      incoming = Object.assign({}, incoming);
    }
    if (typeof incoming.endsAt === "number" && typeof serverNow === "number") {
      incoming.endsAt = C.toLocalEndsAt(incoming.endsAt, serverNow);
    }
    delete incoming.serverNow;
    state = incoming;
    presenter.sync(state);
      audio.setVolume(state.volume);
      audio.setPulse(state.pulse !== false);
      audio.setSfxVolume(typeof state.sfxVolume === "number" ? state.sfxVolume : 0.7);
      audio.setHeartVolume(typeof state.heartVolume === "number" ? state.heartVolume : 0.65);
      syncCaption();
      syncCover();
      syncCamera();
      notePenalty();
      noteNotif();
      noteSfx();
      noteHeart();
      noteHit();
      noteVoice();
  }

  function notePenalty() {
    if (!state.penaltyId || state.penaltyId === heardPenalty) return;
    if (!(state.penaltyUntil > Date.now())) {
      heardPenalty = state.penaltyId;
      return;
    }
    if (audio.penalty()) heardPenalty = state.penaltyId;
  }

  function noteNotif() {
    if (!state.notifId || state.notifId === heardNotif) return;
    if (audio.notif()) heardNotif = state.notifId;
  }

  function noteSfx(force) {
    var id = state.sfxId || 0;
    audio.setSfxVolume(typeof state.sfxVolume === "number" ? state.sfxVolume : 0.7);
    if (!(state.sfxPlaying && state.sfxFile)) {
      audio.stopSfx();
      heardSfx = id;
      return;
    }
    if (!force && id === heardSfx && audio.isSfxPlaying()) return;
    if (audio.playSfx(state.sfxFile)) heardSfx = id;
  }

  function noteHeart(force) {
    var id = state.heartId || 0;
    audio.setHeartVolume(typeof state.heartVolume === "number" ? state.heartVolume : 0.65);
    if (!(state.heartPlaying && state.heartFile)) {
      audio.stopHeart();
      heardHeart = id;
      return;
    }
    if (!force && id === heardHeart && audio.isHeartPlaying()) return;
    if (audio.playHeart(state.heartFile)) heardHeart = id;
  }

  function noteHit() {
    var id = state.hitId || 0;
    if (id === heardHit) return;
    if (!state.hitFile) {
      audio.stopHit();
      heardHit = id;
      return;
    }
    if (audio.playHit(state.hitFile)) heardHit = id;
  }

  function applyCover(src) {
    if (!coverEl) return;
    if (!src) {
      if (coverImgEl) {
        coverImgEl.removeAttribute("src");
        coverImgEl.hidden = true;
      }
      coverEl.style.backgroundImage = "";
      document.body.dataset.cover = "0";
      coverCache = "";
      return;
    }
    coverCache = src;
    document.body.dataset.cover = "1";
    if (coverImgEl) {
      coverImgEl.hidden = false;
      if (coverImgEl.getAttribute("src") !== src) coverImgEl.src = src;
      coverEl.style.backgroundImage = "";
      return;
    }
    coverEl.style.backgroundImage = "url(" + JSON.stringify(src) + ")";
  }

  function syncCover(force) {
    var id = typeof state.bgId === "number" ? state.bgId : 0;
    var src = typeof state.bgImage === "string" ? state.bgImage : "";
    if (!force && id === heardBg) {
      if (src && src !== coverCache) applyCover(src);
      return;
    }
    if (!src && id === heardBg && coverCache) return;
    heardBg = id;
    applyCover(src);
  }

  function camUrl() {
    if (location.protocol === "http:" || location.protocol === "https:") {
      return location.origin + "/api/cam.mjpg";
    }
    return "http://127.0.0.1:8765/api/cam.mjpg";
  }

  function syncCamera() {
    var on = !!state.camera;
    document.body.dataset.camera = on ? "1" : "0";
    if (!camEl) return;
    if (!on) {
      camWant = false;
      camEl.hidden = true;
      camEl.setAttribute("aria-hidden", "true");
      if (camImgEl) {
        camImgEl.removeAttribute("src");
        camSrc = "";
      }
      return;
    }
    camWant = true;
    camEl.hidden = false;
    camEl.setAttribute("aria-hidden", "false");
    if (!camImgEl) return;
    var next = camUrl() + "?t=" + (state.voiceId || state.captionId || Date.now());
    if (camSrc && camImgEl.getAttribute("src")) return;
    camSrc = next;
    camImgEl.src = next;
  }

  function ecgWave(t, amp) {
    var phase = ((t % 1) + 1) % 1;
    if (amp < 0.04) return Math.sin(phase * Math.PI * 2) * 0.015;
    if (phase < 0.08) return Math.sin((phase / 0.08) * Math.PI) * 0.08 * amp;
    if (phase < 0.16) return 0;
    if (phase < 0.2) return -(phase - 0.16) / 0.04 * 0.18 * amp;
    if (phase < 0.24) return (-0.18 + (phase - 0.2) / 0.04 * 1.18) * amp;
    if (phase < 0.28) return (1 - (phase - 0.24) / 0.04 * 1.35) * amp;
    if (phase < 0.34) return (-0.35 + (phase - 0.28) / 0.06 * 0.35) * amp;
    if (phase < 0.55) return 0;
    if (phase < 0.72) return Math.sin(((phase - 0.55) / 0.17) * Math.PI) * 0.22 * amp;
    return 0;
  }

  function buildEcgPath(amp) {
    var w = 800;
    var h = 120;
    var mid = h * 0.55;
    var parts = [];
    for (var x = 0; x <= w; x += 4) {
      var t = (x / w) * 3.2 + ecgScroll;
      var y = mid - ecgWave(t, amp) * 52;
      parts.push((x === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1));
    }
    return parts.join(" ");
  }

  function paintEcg(ms, running, flat, pulseOn) {
    if (!ecgPath || !heroEl) return;
    var sec = Math.max(0, ms / 1000);
    var stress = 1 - Math.min(1, Math.max(0, (sec - 5) / 55));
    var amp = flat ? 0.02 : (0.95 - stress * 0.9);
    if (!running && !flat) amp *= 0.35;
    if (!pulseOn) amp *= 0.02;
    var r = Math.round(120 + stress * 135);
    var g = Math.round(210 - stress * 190);
    var b = Math.round(170 - stress * 150);
    var a = flat ? 0.18 : (0.28 + stress * 0.45);
    if (!pulseOn) a *= 0.15;
    heroEl.style.setProperty("--ecg-color", "rgba(" + r + "," + g + "," + b + "," + a + ")");
    heroEl.style.setProperty("--ecg-glow", "rgba(" + r + "," + Math.max(0, g - 40) + "," + b + "," + (0.12 + stress * 0.35) + ")");
    heroEl.style.setProperty("--pulse", String((0.85 + stress * 0.55).toFixed(2)));
    heroEl.dataset.stress = stress > 0.72 ? "critical" : stress > 0.45 ? "hot" : stress > 0.2 ? "warm" : "calm";
    if (flat) heroEl.dataset.stress = "flat";
    ecgPath.setAttribute("d", buildEcgPath(amp));
  }

  function wantBed(whole, running) {
    var live = !!(running && state.pulse !== false);
    var key = (live ? "1:" : "0:") + whole + ":" + (state.pulse !== false ? "1" : "0");
    if (key === bedKey) return;
    bedKey = key;
    audio.setBed(whole, live);
  }

  function greet() {
    link.emit({ type: "hello" });
    link.emit({ type: "request" });
  }

  greet();
  setTimeout(greet, 400);
  setTimeout(greet, 1200);
  setInterval(function () {
    link.emit({ type: "ping", at: Date.now() });
  }, 700);

  function syncCursor() {
    document.body.classList.toggle("hide-cursor", !!(document.fullscreenElement && armBtn.hidden));
  }

  function armFromGesture() {
    audio.arm().then(function () {
      armBtn.hidden = true;
      notePenalty();
      noteNotif();
      noteSfx(true);
      noteHeart(true);
      noteHit();
      noteVoice();
      tryPlayCue();
      syncCursor();
    });
  }

  armBtn.addEventListener("click", armFromGesture);
  document.addEventListener("pointerdown", armFromGesture);
  document.addEventListener("keydown", function (e) {
    if (e.key === "f" || e.key === "F") {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(function () {});
      }
    }
    armFromGesture();
  });
  document.addEventListener("dblclick", function () {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function () {});
    }
  });
  document.addEventListener("fullscreenchange", syncCursor);

  function frame(now) {
    var auth = C.computeRemaining(state, Date.now());
    var expired = state.status === "ended" || (state.status === "running" && auth <= 0);
    var penaltyHot = state.penaltyUntil > Date.now();
    var shown = presenter.value(state, now);
    if (expired) shown = 0;

    var pulseOn = state.pulse !== false;
    var timerOn = state.timerVisible !== false;
    var hasCaption = !!(state.caption && String(state.caption).trim());
    document.body.dataset.status = expired ? "ended" : state.status;
    document.body.dataset.penalty = penaltyHot && !expired ? "1" : "0";
    document.body.dataset.urgency = expired ? "critical" : C.urgency(shown);
    document.body.dataset.pulse = pulseOn ? "1" : "0";
    document.body.dataset.timer = timerOn ? "1" : "0";
    document.body.dataset.message = (!timerOn && hasCaption) ? "1" : "0";
    document.body.dataset.win = state.winMode ? "1" : "0";
    document.body.dataset.camera = state.camera ? "1" : "0";
    if (clockEl) clockEl.hidden = !timerOn;
    if (heroEl) heroEl.hidden = !timerOn;
    C.paintClock(clockEl, shown);

    if (!lastEcgPaint || now - lastEcgPaint > 32) {
      lastEcgPaint = now;
      var scrollRate = state.status === "running" && !expired && pulseOn
        ? 0.0022 + Math.min(0.004, (60 - Math.min(60, shown / 1000)) / 60 * 0.004)
        : 0.0008;
      ecgScroll += scrollRate * 16;
      paintEcg(expired ? 0 : shown, state.status === "running" && !expired, expired, pulseOn);
    }

    var announced = C.formatClock(auth);
    if (announced !== lastAnnounced) {
      lastAnnounced = announced;
      liveEl.textContent = announced;
    }

    if (state.status === "running" && auth > 0) {
      var whole = C.wholeSeconds(auth);
      var suppress = state.penaltyUntil > Date.now() + 2100;
      if (lastWhole == null) {
        lastWhole = whole;
        if (!suppress) audio.tick(whole);
      } else if (whole !== lastWhole) {
        var delta = lastWhole - whole;
        if (!suppress && delta >= 1 && delta <= 2) audio.tick(whole);
        lastWhole = whole;
      }
      wantBed(whole, true);
      expirySent = false;
    } else {
      lastWhole = null;
      wantBed(0, false);
      if (state.status === "running" && auth <= 0 && !expirySent) {
        expirySent = true;
        link.emit({ type: "expired" });
      }
      if (state.status !== "running") expirySent = false;
    }

    if (expired && !chimed && audio.endChime()) chimed = true;
    if (!expired) chimed = false;

    if (state.sfxPlaying && state.sfxFile && !audio.isSfxPlaying() && now - lastSfxRetry > 450) {
      lastSfxRetry = now;
      noteSfx(true);
    }
    if (state.heartPlaying && state.heartFile && !audio.isHeartPlaying() && now - lastHeartRetry > 450) {
      lastHeartRetry = now;
      noteHeart(true);
    }
    if (pendingCue && now - lastCueRetry > 500) {
      lastCueRetry = now;
      tryPlayCue();
    }
    if ((state.voiceFile || state.voiceText) && (state.voiceId || 0) !== heardVoice && now - lastVoiceRetry > 450) {
      lastVoiceRetry = now;
      noteVoice();
    }

    requestAnimationFrame(frame);
  }

  if (window.speechSynthesis) {
    try { window.speechSynthesis.getVoices(); } catch (err) {}
    window.speechSynthesis.addEventListener("voiceschanged", function () {
      if ((state.voiceText || "") && (state.voiceId || 0) !== heardVoice) noteVoice();
    });
  }

  notePenalty();
  noteNotif();
  audio.setSfxVolume(typeof state.sfxVolume === "number" ? state.sfxVolume : 0.7);
  audio.setHeartVolume(typeof state.heartVolume === "number" ? state.heartVolume : 0.65);
  noteSfx();
  noteHeart();
  noteHit();
  noteVoice();
  syncCover();
  syncCamera();
  syncCaption();
  document.body.dataset.pulse = state.pulse !== false ? "1" : "0";
  paintEcg(
    C.computeRemaining(state, Date.now()),
    state.status === "running",
    state.status === "ended",
    state.pulse !== false
  );
  requestAnimationFrame(frame);
  fetch("/api/room/state")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (state.revision !== bootRevision) return;
      if (!data || !data.state) return;
      takeState(data.state, data.serverNow || (data.state && data.state.serverNow), true);
    })
    .catch(function () {});
})();
