(function () {
  var C = window.Countdown;
  var state = C.recover(C.load() || C.create(), Date.now());
  var presenter = C.createPresenter();
  presenter.sync(state);

  var clockEl = document.getElementById("clock");
  var statusEl = document.getElementById("status");
  var linkEl = document.getElementById("link");
  var lampEl = document.getElementById("lamp");
  var ntfyStatusEl = document.getElementById("ntfy-status");
  var ntfyLampEl = document.getElementById("ntfy-lamp");
  var minEl = document.getElementById("minutes");
  var secEl = document.getElementById("seconds");
  var transportEl = document.getElementById("transport");
  var resetEl = document.getElementById("reset");
  var penaltyEl = document.getElementById("penalty");
  var penaltyAmountEl = document.getElementById("penalty-amount");
  var volumeEl = document.getElementById("volume");
  var volumeReadEl = document.getElementById("volume-read");
  var volumeDown = document.getElementById("volume-down");
  var volumeUp = document.getElementById("volume-up");
  var notifEl = document.getElementById("notif");
  var pulseEl = document.getElementById("pulse");
  var rateEl = document.getElementById("rate");
  var rateReadEl = document.getElementById("rate-readout");
  var trimEl = document.getElementById("trim");
  var trimBtn = document.getElementById("trim-apply");
  var captionInput = document.getElementById("caption-input");
  var captionShow = document.getElementById("caption-show");
  var captionSay = document.getElementById("caption-say");
  var captionClear = document.getElementById("caption-clear");
  var camPreview = document.getElementById("cam-preview");
  var camPlaceholder = document.getElementById("cam-placeholder");
  var camLiveBtn = document.getElementById("cam-live");
  var camSnapBtn = document.getElementById("cam-snap");
  var camRecBtn = document.getElementById("cam-rec");
  var camShowBtn = document.getElementById("cam-show");
  var camStatusEl = document.getElementById("cam-status");
  var camShotsEl = document.getElementById("cam-shots");
  var camRecBadge = document.getElementById("cam-rec-badge");
  var camRecTimeEl = document.getElementById("cam-rec-time");
  var timerVisEl = document.getElementById("timer-vis");
  var camLiveOn = false;
  var camRecorder = null;
  var camRecChunks = [];
  var camRecTimer = null;
  var camRecStarted = 0;
  var camDrawTimer = null;
  var camCanvas = null;
  var camCanvasCtx = null;
  var sfxListEl = document.getElementById("sfx-list");
  var sfxVolumeEl = document.getElementById("sfx-volume");
  var sfxVolumeReadEl = document.getElementById("sfx-volume-read");
  var sfxVolumeDown = document.getElementById("sfx-volume-down");
  var sfxVolumeUp = document.getElementById("sfx-volume-up");
  var sfxStopEl = document.getElementById("sfx-stop");
  var heartListEl = document.getElementById("heart-list");
  var heartVolumeEl = document.getElementById("heart-volume");
  var heartVolumeReadEl = document.getElementById("heart-volume-read");
  var heartVolumeDown = document.getElementById("heart-volume-down");
  var heartVolumeUp = document.getElementById("heart-volume-up");
  var heartStopEl = document.getElementById("heart-stop");
  var padListEl = document.getElementById("pad-list");
  var padStopEl = document.getElementById("pad-stop");
  var soundbarListEl = document.getElementById("soundbar-list");
  var coverListEl = document.getElementById("cover-list");
  var coverFileEl = document.getElementById("cover-file");
  var coverClearEl = document.getElementById("cover-clear");
  var coverNameEl = document.getElementById("cover-name");
  var speakEl = document.getElementById("speak");
  var speakPlayEl = document.getElementById("speak-play");
  var speakRecording = false;
  var speakRecorder = null;
  var speakChunks = [];
  var speakBlob = null;
  var speakRemoteUrl = "";
  var sfxHintEl = document.getElementById("sfx-hint");
  var logEl = document.getElementById("log");
  var snrEl = document.getElementById("snr");
  var latEl = document.getElementById("lat");
  var jitterEl = document.getElementById("jitter");
  var presetEls = document.querySelectorAll(".preset");

  var entries = [];
  var lastPing = 0;
  var snr = 42.4;
  var lat = 9;
  var jitter = 0.4;
  var sfxButtons = {};
  var heartButtons = {};
  var padButtons = {};
  var soundbarButtons = {};
  var coverButtons = {};
  var speakAudio = window.CountdownAudio ? window.CountdownAudio.createEngine() : null;
  var speakArmed = false;
  var padFlashTimers = {};
  var activeSoundbarId = "";

  var SOUNDBAR = [
    {
      id: "entrance",
      label: "Enterance",
      voice: "voice-entrance.mp3",
      text: "لابی\nشما به لابی رسیده‌اید. برای نخستین گام، درب گاراژ را باز کنید.",
      speak: "شُما بِه لابی رَسیده‌اید. بَرای نُخُستین گام، دَرْبِ گاراژ را باز کُنید."
    },
    {
      id: "full-access",
      label: "Full Access",
      voice: "voice-full-access.mp3",
      text: "لابی\nشما به تمامی بخش‌های تونل مخفی فرخ‌خان دسترسی یافته‌اید؛ جایی که فرخ‌خان نمی‌خواهد شما ببینید.",
      speak: "شُما بِه تَمامی بَخش‌های تونَلِ مَخفیِ فَرُّخ خان دَسترسی یافته‌اید؛ جایی کِه فَرُّخ خان نمی‌خواهَد شُما بِبِینید."
    },
    {
      id: "rules",
      label: "Rules",
      voice: "voice-rules.mp3",
      text: "قوانین\nتوجه کنید: همواره روی مانیتور یک راهنمایی برای شما قرار داده شده است. اگر مرحله‌ای را نمی‌توانید پشت سر بگذارید، به مانیتور دقت کنید. همچنین با آزاد کردن دوچرخه و رکاب زدن می‌توانید روشنایی تولید کنید. برای شروع، دو نفر معمای گاراژ را حل کنند و دو نفر معمای گلخانه را؛ بقیه می‌توانند به اتاق اسناد بروند و اسناد مهم را کشف کنند. از این لحظه ده دقیقه زمان دارید.",
      speak: "تَوَجُّه کُنید: هَموارِه روی مانیتور یِک راهنمایی بَرای شُما قَرار دادِه شُدِه اَست. اَگَر مَرحَله‌ای را نمی‌تَوانید پُشتِ سَر بُگذارید، بِه مانیتور دِقَّت کُنید. هَمچُنین با آزاد کَردَنِ دوچَرخه و رِکاب زَدَن می‌تَوانید روشَنایی تَولید کُنید. بَرای شُروع، دُو نَفَر مُعَمّای گاراژ را حَل کُنَند و دُو نَفَر مُعَمّای گُلخانه را؛ بَقیّه می‌تَوانَند بِه اُتاقِ اَسناد بِرَوَند و اَسنادِ مُهِم را کَشف کُنَند. اَز این لَحظِه دَه دَقیقه زَمان دارید."
    },
    {
      id: "camera",
      label: "Camera",
      voice: "voice-camera.mp3",
      text: "دوربین\nهمگی به جلوی دوربین بیایید و به مانیتور نگاه کنید.",
      speak: "هَمِگی بِه جِلوی دوربین بیایید و بِه مانیتور نِگاه کُنید."
    },
    {
      id: "win",
      label: "Win",
      voice: "voice-win.mp3",
      text: "شما اسناد مهم را کشف کردید.\nبه کارهای شوم فرخ خان پی بردید\nهمگی به سمت چراغ سبز رنگ درب گاراژ حرکت کنید",
      speak: "شُما اَسنادِ مُهِم را کَشف کَردید. بِه کارهای شومِ فَرُّخ خان پی بُردید. هَمِگی بِه سَمتِ چِراغِ سَبز رَنگِ دَرْبِ گاراژ حَرَکَت کُنید."
    }
  ];

  var link = C.createLink("control", onMsg);
  var authBlocked = false;
  var serverDisplayAlive = false;

  function applyTick(msg) {
    if (!msg || typeof msg.revision !== "number" || msg.revision < state.revision) return;
    if (msg.status === "ended" || msg.revision > state.revision) {
      state.status = msg.status || state.status;
      state.remainingMs = msg.status === "ended" ? 0 : (typeof msg.remainingMs === "number" ? msg.remainingMs : state.remainingMs);
      state.endsAt = msg.status === "ended" ? null : C.toLocalEndsAt(msg.endsAt, msg.serverNow);
      state.revision = msg.revision;
      presenter.sync(state);
      C.save(state);
      paint();
      return;
    }
    if (state.status === "running" && msg.revision === state.revision) {
      if (typeof msg.remainingMs === "number") state.remainingMs = msg.remainingMs;
      if (typeof msg.endsAt === "number") state.endsAt = C.toLocalEndsAt(msg.endsAt, msg.serverNow);
      paint();
    }
  }

  function onMsg(msg) {
    if (!msg) return;
    if (msg.type === "auth" && msg.ok === false) {
      authBlocked = true;
      if (linkEl) linkEl.textContent = "PIN  NEEDED";
      ensureAdminPin(true);
      return;
    }
    if (msg.type === "peers" && msg.peers) {
      serverDisplayAlive = !!msg.peers.displayAlive;
      if (serverDisplayAlive) lastPing = Date.now();
      return;
    }
    if ((msg.from === "display" || msg.from === "server") && (msg.type === "ping" || msg.type === "hello" || msg.type === "heartbeat")) {
      lastPing = Date.now();
    }
    if (msg.type === "expired") trySeal();
    if (msg.type === "tick") {
      applyTick(msg);
      return;
    }
    if (msg.type === "state" && msg.state && typeof msg.state.revision === "number") {
      var stamped = typeof msg.serverNow === "number" || typeof msg.state.serverNow === "number";
      if (msg.clientId && msg.clientId === link.clientId && !stamped) return;
      if (msg.state.revision < state.revision) return;
      var incoming = msg.state;
      if (
        (!incoming.bgImage || !String(incoming.bgImage)) &&
        state.bgImage &&
        typeof incoming.bgId === "number" &&
        incoming.bgId === (state.bgId || 0)
      ) {
        incoming = Object.assign({}, incoming, { bgImage: state.bgImage });
      }
      incoming = Object.assign({}, incoming);
      var serverNow = typeof msg.serverNow === "number" ? msg.serverNow : incoming.serverNow;
      if (typeof incoming.endsAt === "number" && typeof serverNow === "number") {
        incoming.endsAt = C.toLocalEndsAt(incoming.endsAt, serverNow);
      }
      delete incoming.serverNow;
      state = Object.assign(C.create(), incoming);
      presenter.sync(state);
      C.save(state);
      paint();
    }
    if (msg.type === "speak-play" && msg.url) {
      if (!(msg.clientId && msg.clientId === link.clientId)) {
        playSpeakSource(msg.url);
        pushLog("speak play");
      }
      return;
    }
    if (msg.type === "cam-photo" && msg.url) {
      addRemoteShot(msg.url, msg.mediaId || "snap");
      return;
    }
    if (msg.type === "hub-status") return;
    if (msg.type === "cover") {
      if (typeof msg.bgId === "number") state.bgId = msg.bgId;
      if (typeof msg.bgImage === "string") state.bgImage = msg.bgImage;
      C.save(state);
      paint();
    }
  }

  function ensureAdminPin(force) {
    var have = link.getPin && link.getPin();
    if (have && !force) return Promise.resolve(true);
    return fetch("/api/room/info")
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (!info || !info.pinRequired) {
          link.setPin("");
          authBlocked = false;
          return true;
        }
        if (have && !force) {
          return fetch("/api/room/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: have })
          }).then(function (r) {
            if (r.ok) {
              authBlocked = false;
              return true;
            }
            return askPin();
          });
        }
        return askPin();
      })
      .catch(function () { return askPin(); });
  }

  function askPin() {
    var pin = window.prompt("پین ادمین کنترل پنل (room.json → adminPin):", link.getPin() || "");
    if (pin == null) return false;
    link.setPin(String(pin));
    return fetch("/api/room/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: String(pin) })
    }).then(function (r) {
      if (!r.ok) {
        window.alert("پین اشتباه است.");
        authBlocked = true;
        return false;
      }
      authBlocked = false;
      broadcast();
      return true;
    }).catch(function () {
      authBlocked = false;
      return true;
    });
  }

  function slimState(full) {
    var copy = C.clone(full);
    if (copy.bgImage && String(copy.bgImage).indexOf("data:") === 0) copy.bgImage = "";
    return copy;
  }

  function broadcast(opts) {
    var full = !(opts && opts.slim);
    C.save(state);
    link.emit({ type: "state", state: full ? state : slimState(state) });
    if (full && state.bgImage) {
      link.emit({ type: "cover", bgId: state.bgId || 0, bgImage: state.bgImage });
    }
  }

  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, "0"); }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function pushLog(line) {
    entries.push(stamp() + "  " + line);
    if (entries.length > 8) entries.shift();
    logEl.replaceChildren();
    entries.forEach(function (text) {
      var li = document.createElement("li");
      li.textContent = text;
      logEl.appendChild(li);
    });
  }

  function publish(mutator, logLine) {
    var now = Date.now();
    var wasEnded = state.status === "ended";
    var draft = C.clone(state);
    var next = mutator(draft, now);
    if (!next) return false;
    next.revision = state.revision + 1;
    next.updatedAt = now;
    var endedNow = next.status === "ended";
    state = next;
    presenter.sync(state);
    broadcast();
    if (logLine && !(endedNow && wasEnded)) pushLog(logLine);
    if (!wasEnded && endedNow && logLine === "penalty applied") pushLog("sequence sealed");
    paint();
    return true;
  }

  function trySeal() {
    if (state.status !== "running") return;
    if (C.computeRemaining(state, Date.now()) > 80) return;
    publish(function (draft) { return C.seal(draft); }, "sequence sealed");
  }

  function readDuration() {
    var m = parseInt(minEl.value, 10);
    var s = parseInt(secEl.value, 10);
    if (!isFinite(m) || m < 0) m = 0;
    if (!isFinite(s) || s < 0) s = 0;
    m = Math.min(99, m);
    s = Math.min(59, s);
    return (m * 60 + s) * 1000;
  }

  function clockParts(ms) {
    var sec = Math.max(0, Math.round(ms / 1000));
    return {
      m: String(Math.floor(sec / 60)).padStart(2, "0"),
      s: String(sec % 60).padStart(2, "0")
    };
  }

  function paint() {
    var running = state.status === "running";
    var ended = state.status === "ended";
    if (document.activeElement !== minEl && document.activeElement !== secEl) {
      var parts = clockParts(state.durationMs);
      minEl.value = parts.m;
      secEl.value = parts.s;
    }
    if (document.activeElement !== rateEl) {
      rateEl.value = String(state.msPerTick / 1000);
    }
    rateReadEl.textContent = (state.msPerTick / 1000).toFixed(2);
    if (document.activeElement !== volumeEl) {
      volumeEl.value = String(Math.round(state.volume * 100));
    }
    volumeReadEl.textContent = String(Math.round(state.volume * 100)).padStart(2, "0");
    if (sfxVolumeEl && document.activeElement !== sfxVolumeEl) {
      sfxVolumeEl.value = String(Math.round((state.sfxVolume != null ? state.sfxVolume : 0.7) * 100));
    }
    if (sfxVolumeReadEl) {
      sfxVolumeReadEl.textContent = String(Math.round((state.sfxVolume != null ? state.sfxVolume : 0.7) * 100)).padStart(2, "0");
    }
    if (heartVolumeEl && document.activeElement !== heartVolumeEl) {
      heartVolumeEl.value = String(Math.round((state.heartVolume != null ? state.heartVolume : 0.65) * 100));
    }
    if (heartVolumeReadEl) {
      heartVolumeReadEl.textContent = String(Math.round((state.heartVolume != null ? state.heartVolume : 0.65) * 100)).padStart(2, "0");
    }
    Object.keys(sfxButtons).forEach(function (id) {
      var btn = sfxButtons[id];
      var meta = btn._sfx;
      var active = !!(state.sfxPlaying && state.sfxFile && meta && state.sfxFile === sfxPath(meta.file));
      btn.classList.toggle("is-playing", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    Object.keys(heartButtons).forEach(function (id) {
      var btn = heartButtons[id];
      var meta = btn._sfx;
      var active = !!(state.heartPlaying && state.heartFile && meta && state.heartFile === sfxPath(meta.file));
      btn.classList.toggle("is-playing", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    Object.keys(soundbarButtons).forEach(function (id) {
      var btn = soundbarButtons[id];
      var on = activeSoundbarId === id && !!(state.caption && String(state.caption).trim());
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    Object.keys(coverButtons).forEach(function (id) {
      var btn = coverButtons[id];
      var meta = btn._cover;
      var path = coverPath(meta.file);
      var active = !!(state.bgImage && state.bgImage === path);
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    if (coverNameEl) {
      if (!state.bgImage) coverNameEl.textContent = "بدون کاور";
      else if (String(state.bgImage).indexOf("data:") === 0) coverNameEl.textContent = "کاور سفارشی";
      else coverNameEl.textContent = String(state.bgImage).replace(/^images\//, "");
    }
    if (pulseEl) {
      var pulseOn = state.pulse !== false;
      pulseEl.setAttribute("aria-pressed", pulseOn ? "true" : "false");
      pulseEl.classList.toggle("is-on", pulseOn);
      pulseEl.classList.toggle("is-off", !pulseOn);
    }
    if (speakEl && !speakRecording) {
      speakEl.setAttribute("aria-pressed", "false");
      speakEl.classList.remove("is-on");
    }
    if (timerVisEl) {
      var timerOn = state.timerVisible !== false;
      timerVisEl.setAttribute("aria-pressed", timerOn ? "true" : "false");
      timerVisEl.classList.toggle("is-on", timerOn);
      timerVisEl.classList.toggle("is-off", !timerOn);
      timerVisEl.textContent = timerOn ? "TIMER ON" : "TIMER OFF";
    }
    if (camShowBtn) {
      var camOn = !!state.camera;
      camShowBtn.setAttribute("aria-pressed", camOn ? "true" : "false");
      camShowBtn.classList.toggle("is-on", camOn);
    }

    minEl.disabled = running;
    secEl.disabled = running;
    presetEls.forEach(function (btn) { btn.disabled = running; });
    penaltyEl.disabled = ended;
    trimBtn.disabled = ended;
    resetEl.disabled = false;

    if (running) transportEl.textContent = "HOLD";
    else if (state.status === "paused") transportEl.textContent = "RESUME";
    else transportEl.textContent = "START";
  }

  function paintLive() {
    var now = performance.now();
    var auth = C.computeRemaining(state, Date.now());
    var shown = presenter.value(state, now);
    var penaltyHot = state.penaltyUntil > Date.now();
    var expired = state.status === "ended" || (state.status === "running" && auth <= 0);
    var elegant = expired && !penaltyHot;

    C.paintClock(clockEl, shown);
    document.body.classList.toggle("is-penalty", penaltyHot && !elegant);
    document.body.classList.toggle("is-sealed", elegant);
    document.body.dataset.urgency = C.urgency(expired ? 0 : shown);

    if (elegant) statusEl.textContent = "SEALED";
    else if (penaltyHot) statusEl.textContent = "PENALTY";
    else if (state.status === "running") statusEl.textContent = "LIVE";
    else if (state.status === "paused") statusEl.textContent = "HOLD";
    else statusEl.textContent = "ARMED";
  }

  transportEl.addEventListener("click", function () {
    if (state.status === "running") publish(function (draft, now) { return C.pause(draft, now); }, "hold");
    else if (state.status === "paused") publish(function (draft, now) { return C.resume(draft, now); }, "resume");
    else publish(function (draft, now) { return C.start(draft, now); }, "sequence running");
  });

  resetEl.addEventListener("click", function () {
    publish(function (draft) { return C.reset(draft); }, "sequence reset");
  });

  function commitDuration(logIt) {
    var ms = readDuration();
    var label = C.formatClock(ms);
    publish(function (draft) { return C.setDuration(draft, ms); }, logIt ? "sequence armed " + label : null);
  }

  minEl.addEventListener("change", function () { commitDuration(true); });
  secEl.addEventListener("change", function () { commitDuration(true); });

  presetEls.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var total = parseInt(btn.getAttribute("data-sec"), 10) || 0;
      var parts = clockParts(total * 1000);
      minEl.value = parts.m;
      secEl.value = parts.s;
      commitDuration(true);
    });
  });

  penaltyEl.addEventListener("click", function () {
    var sec = parseInt(penaltyAmountEl.value, 10);
    if (!isFinite(sec)) return;
    sec = Math.min(1800, Math.max(1, sec));
    penaltyAmountEl.value = String(sec);
    publish(function (draft, now) { return C.penalty(draft, sec * 1000, now); }, "penalty applied");
  });

  trimBtn.addEventListener("click", function () {
    var sec = parseInt(trimEl.value, 10);
    if (!isFinite(sec) || sec <= 0) return;
    sec = Math.min(1800, sec);
    trimEl.value = String(sec);
    var ok = publish(function (draft, now) { return C.trim(draft, sec * 1000, now); });
    if (!ok) return;
    trimBtn.classList.add("did-commit");
    setTimeout(function () { trimBtn.classList.remove("did-commit"); }, 180);
  });

  rateEl.addEventListener("input", function () {
    var ratio = Number(rateEl.value);
    rateReadEl.textContent = ratio.toFixed(2);
    publish(function (draft, now) { return C.setRate(draft, ratio * 1000, now); });
  });

  function syncSpeakVolume(v) {
    if (speakAudio && speakArmed) speakAudio.setVolume(v);
  }

  function bumpVolume(delta) {
    var next = Math.min(100, Math.max(0, Math.round(state.volume * 100) + delta));
    volumeEl.value = String(next);
    volumeReadEl.textContent = String(next).padStart(2, "0");
    publish(function (draft) { return C.setVolume(draft, next / 100); });
    syncSpeakVolume(next / 100);
  }

  volumeEl.addEventListener("input", function () {
    var v = Number(volumeEl.value) / 100;
    volumeReadEl.textContent = String(Math.round(v * 100)).padStart(2, "0");
    publish(function (draft) { return C.setVolume(draft, v); });
    syncSpeakVolume(v);
  });

  if (volumeDown) volumeDown.addEventListener("click", function () { bumpVolume(-5); });
  if (volumeUp) volumeUp.addEventListener("click", function () { bumpVolume(5); });

  if (notifEl) {
    notifEl.addEventListener("click", function () {
      publish(function (draft) { return C.fireNotif(draft); }, "notif");
    });
  }

  if (pulseEl) {
    pulseEl.addEventListener("click", function () {
      var next = !(state.pulse !== false);
      publish(function (draft) { return C.setPulse(draft, next); }, next ? "pulse on" : "pulse off");
    });
  }

  function bumpSfxVolume(delta) {
    var cur = Math.round((state.sfxVolume != null ? state.sfxVolume : 0.7) * 100);
    var next = Math.min(100, Math.max(0, cur + delta));
    if (sfxVolumeEl) sfxVolumeEl.value = String(next);
    if (sfxVolumeReadEl) sfxVolumeReadEl.textContent = String(next).padStart(2, "0");
    publish(function (draft) { return C.setSfxVolume(draft, next / 100); });
  }

  if (sfxVolumeEl) {
    sfxVolumeEl.addEventListener("input", function () {
      var v = Number(sfxVolumeEl.value) / 100;
      if (sfxVolumeReadEl) sfxVolumeReadEl.textContent = String(Math.round(v * 100)).padStart(2, "0");
      publish(function (draft) { return C.setSfxVolume(draft, v); });
    });
  }
  if (sfxVolumeDown) sfxVolumeDown.addEventListener("click", function () { bumpSfxVolume(-5); });
  if (sfxVolumeUp) sfxVolumeUp.addEventListener("click", function () { bumpSfxVolume(5); });

  if (sfxStopEl) {
    sfxStopEl.addEventListener("click", function () {
      publish(function (draft) { return C.stopSfx(draft); }, "cave stop");
    });
  }

  function bumpHeartVolume(delta) {
    var cur = Math.round((state.heartVolume != null ? state.heartVolume : 0.65) * 100);
    var next = Math.min(100, Math.max(0, cur + delta));
    if (heartVolumeEl) heartVolumeEl.value = String(next);
    if (heartVolumeReadEl) heartVolumeReadEl.textContent = String(next).padStart(2, "0");
    publish(function (draft) { return C.setHeartVolume(draft, next / 100); });
  }

  if (heartVolumeEl) {
    heartVolumeEl.addEventListener("input", function () {
      var v = Number(heartVolumeEl.value) / 100;
      if (heartVolumeReadEl) heartVolumeReadEl.textContent = String(Math.round(v * 100)).padStart(2, "0");
      publish(function (draft) { return C.setHeartVolume(draft, v); });
    });
  }
  if (heartVolumeDown) heartVolumeDown.addEventListener("click", function () { bumpHeartVolume(-5); });
  if (heartVolumeUp) heartVolumeUp.addEventListener("click", function () { bumpHeartVolume(5); });
  if (heartStopEl) {
    heartStopEl.addEventListener("click", function () {
      publish(function (draft) { return C.stopHeart(draft); }, "heart stop");
    });
  }

  if (padStopEl) {
    padStopEl.addEventListener("click", function () {
      Object.keys(padFlashTimers).forEach(function (id) {
        clearTimeout(padFlashTimers[id]);
        delete padFlashTimers[id];
        if (padButtons[id]) padButtons[id].classList.remove("is-playing");
      });
      publish(function (draft) { return C.stopHit(draft); }, "pad stop");
    });
  }

  if (coverClearEl) {
    coverClearEl.addEventListener("click", function () {
      publish(function (draft) { return C.setBgImage(draft, ""); }, "cover cleared");
    });
  }

  function compressCover(file, done) {
    var reader = new FileReader();
    reader.onload = function () {
      var raw = typeof reader.result === "string" ? reader.result : "";
      if (!raw) {
        done("");
        return;
      }
      var img = new Image();
      img.onload = function () {
        try {
          var maxW = 1600;
          var maxH = 1200;
          var scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
          var w = Math.max(1, Math.round(img.naturalWidth * scale));
          var h = Math.max(1, Math.round(img.naturalHeight * scale));
          var canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext("2d");
          if (!ctx) {
            done(raw);
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          done(canvas.toDataURL("image/jpeg", 0.72));
        } catch (err) {
          done(raw);
        }
      };
      img.onerror = function () { done(raw); };
      img.src = raw;
    };
    reader.onerror = function () { done(""); };
    reader.readAsDataURL(file);
  }

  if (coverFileEl) {
    coverFileEl.addEventListener("change", function () {
      var file = coverFileEl.files && coverFileEl.files[0];
      if (!file) return;
      compressCover(file, function (data) {
        if (!data) {
          pushLog("cover failed");
          return;
        }
        publish(function (draft) { return C.setBgImage(draft, data); }, "cover set");
      });
      coverFileEl.value = "";
    });
  }

  function speakMime() {
    var list = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (var i = 0; i < list.length; i++) {
      if (MediaRecorder.isTypeSupported(list[i])) return list[i];
    }
    return "";
  }

  function hubMediaUrl() {
    var hub = link.getHub ? link.getHub() : null;
    if (!hub || !hub.baseUrl) return "";
    return String(hub.baseUrl).replace(/\/$/, "") + "/media?key=" + encodeURIComponent(hub.key || "");
  }

  function playSpeakSource(source) {
    if (!speakAudio || !source) return;
    var run = speakArmed ? Promise.resolve() : speakAudio.arm().then(function () { speakArmed = true; });
    run.then(function () {
      speakAudio.setVolume(state.volume);
      speakAudio.playCue(source);
    });
  }

  function addRemoteShot(url, name) {
    if (!camShotsEl || !url) return;
    var linkElShot = document.createElement("a");
    linkElShot.href = url;
    linkElShot.target = "_blank";
    linkElShot.rel = "noopener";
    var img = document.createElement("img");
    img.src = url;
    img.alt = name || "snap";
    linkElShot.appendChild(img);
    camShotsEl.insertBefore(linkElShot, camShotsEl.firstChild);
    setCamStatus("عکس از هاب: " + (name || "snap"));
  }

  function uploadSpeak(blob) {
    var url = hubMediaUrl();
    if (!url || !blob) return Promise.resolve(null);
    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": (blob.type || "application/octet-stream").split(";")[0],
        "X-Kind": "speak"
      },
      body: blob
    }).then(function (res) {
      if (!res.ok) throw new Error("upload");
      return res.json();
    }).then(function (data) {
      speakRemoteUrl = (data && data.url) || "";
      if (speakRemoteUrl) pushLog("speak saved");
      return data;
    }).catch(function () {
      pushLog("speak upload failed");
      return null;
    });
  }

  function setSpeakRecUi(on) {
    speakRecording = !!on;
    if (!speakEl) return;
    speakEl.setAttribute("aria-pressed", on ? "true" : "false");
    speakEl.classList.toggle("is-on", !!on);
    var label = speakEl.querySelector("span:last-child");
    if (label) label.textContent = on ? "STOP" : "REC";
  }

  function stopSpeakRec() {
    if (!speakRecorder) {
      setSpeakRecUi(false);
      return;
    }
    try { speakRecorder.stop(); } catch (err) { setSpeakRecUi(false); }
  }

  function startSpeakRec() {
    if (speakRecorder) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      pushLog("mic unsupported");
      return;
    }
    var mime = speakMime();
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    }).then(function (stream) {
      speakChunks = [];
      var rec;
      try {
        rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch (err) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        pushLog("mic recorder failed");
        return;
      }
      speakRecorder = rec;
      rec.ondataavailable = function (e) {
        if (e.data && e.data.size) speakChunks.push(e.data);
      };
      rec.onstop = function () {
        stream.getTracks().forEach(function (track) { track.stop(); });
        speakRecorder = null;
        setSpeakRecUi(false);
        var type = (mime || "audio/webm").split(";")[0];
        var blob = new Blob(speakChunks, { type: type });
        speakChunks = [];
        if (!blob.size) {
          pushLog("speak empty");
          return;
        }
        speakBlob = blob;
        speakRemoteUrl = "";
        uploadSpeak(blob);
        pushLog("speak recorded");
      };
      rec.start();
      setSpeakRecUi(true);
      pushLog("speak rec");
    }).catch(function () {
      setSpeakRecUi(false);
      pushLog("mic denied");
    });
  }

  document.addEventListener("pointerdown", function () {
    if (!speakAudio || speakArmed) return;
    speakAudio.arm().then(function () { speakArmed = true; });
  }, { once: true });

  if (speakEl) {
    speakEl.addEventListener("click", function () {
      if (speakRecording || speakRecorder) stopSpeakRec();
      else startSpeakRec();
    });
  }

  if (speakPlayEl) {
    speakPlayEl.addEventListener("click", function () {
      var source = speakBlob || speakRemoteUrl;
      if (!source) {
        pushLog("speak empty");
        return;
      }
      playSpeakSource(source);
      if (speakRemoteUrl) {
        link.emit({ type: "speak-play", url: speakRemoteUrl, mime: (speakBlob && speakBlob.type) || "" });
        pushLog("speak play");
      } else if (speakBlob && hubMediaUrl()) {
        uploadSpeak(speakBlob).then(function () {
          if (!speakRemoteUrl) return;
          link.emit({ type: "speak-play", url: speakRemoteUrl, mime: speakBlob.type || "" });
        });
      }
    });
  }

  function apiBase() {
    if (location.protocol === "http:" || location.protocol === "https:") return location.origin;
    return "http://127.0.0.1:8765";
  }

  function mediaUrl(path) {
    if (!path) return "";
    if (/^(https?:|blob:|data:)/i.test(path)) return path;
    return apiBase().replace(/\/$/, "") + "/" + String(path).replace(/^\//, "");
  }

  function sfxPath(file) {
    // Relative path so LAN + ntfy remote both resolve on the Display origin.
    return "audio/" + String(file || "").replace(/^\/+/, "");
  }

  function coverPath(file) {
    return mediaUrl("images/" + String(file || "").replace(/^\/+/, ""));
  }

  function flashPad(id) {
    var btn = padButtons[id];
    if (!btn) return;
    if (padFlashTimers[id]) clearTimeout(padFlashTimers[id]);
    btn.classList.add("is-playing");
    padFlashTimers[id] = setTimeout(function () {
      btn.classList.remove("is-playing");
      delete padFlashTimers[id];
    }, 900);
  }

  function bindLoopButtons(list, host, store, kind) {
    if (!host) return;
    host.replaceChildren();
    Object.keys(store).forEach(function (k) { delete store[k]; });
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (!item || !item.file) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sfx-btn";
      btn.textContent = item.label || item.id || item.file;
      btn._sfx = item;
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", function () {
        var path = sfxPath(item.file);
        if (kind === "pad") {
          flashPad(item.id || item.file);
          publish(function (draft) { return C.playHit(draft, path); }, "pad " + (item.id || item.file));
          return;
        }
        if (kind === "heart") {
          var sameHeart = state.heartPlaying && state.heartFile === path;
          if (sameHeart) {
            publish(function (draft) { return C.stopHeart(draft); }, "heart stop");
            return;
          }
          publish(function (draft) { return C.playHeart(draft, path); }, "heart " + (item.id || item.file));
          return;
        }
        var same = state.sfxPlaying && state.sfxFile === path;
        if (same) {
          publish(function (draft) { return C.stopSfx(draft); }, "cave stop");
          return;
        }
        publish(function (draft) { return C.playSfx(draft, path); }, "cave " + (item.id || item.file));
      });
      store[item.id || item.file] = btn;
      host.appendChild(btn);
    });
  }

  function renderSounds(list) {
    var all = Array.isArray(list) ? list : [];
    var beds = all.filter(function (item) { return !item.group || item.group === "bed"; });
    var hearts = all.filter(function (item) { return item.group === "heart"; });
    var pads = all.filter(function (item) { return item.group === "pad"; });
    bindLoopButtons(beds, sfxListEl, sfxButtons, "bed");
    bindLoopButtons(hearts, heartListEl, heartButtons, "heart");
    bindLoopButtons(pads, padListEl, padButtons, "pad");
    if (sfxHintEl) {
      sfxHintEl.textContent = beds.length || hearts.length || pads.length
        ? "غار و ضربان همزمان؛ پد برای شلیک خیلی بلند یک‌باره. SPEAK فقط تالک‌بک است."
        : "هیچ فایلی در audio/sounds.js نیست.";
    }
    paint();
  }

  function renderSoundbar() {
    soundbarButtons = {};
    if (!soundbarListEl) return;
    soundbarListEl.replaceChildren();
    SOUNDBAR.forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sfx-btn";
      btn.textContent = item.label;
      btn.title = item.text.replace(/\n/g, " — ");
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", function () {
        activeSoundbarId = item.id;
        if (captionInput) captionInput.value = item.text;
        publish(function (draft) {
          if (item.id === "win") {
            C.setWinMode(draft, true);
            C.setTimerVisible(draft, false);
            C.stopSfx(draft);
            C.stopHeart(draft);
            C.setBgImage(draft, "");
            C.setCamera(draft, false);
          } else if (item.id === "camera") {
            if (draft.winMode) {
              C.setWinMode(draft, false);
              C.setTimerVisible(draft, true);
            }
            C.setCamera(draft, true);
          } else {
            if (draft.winMode) {
              C.setWinMode(draft, false);
              C.setTimerVisible(draft, true);
            }
            C.setCamera(draft, false);
          }
          C.setCaption(draft, item.text);
          return C.speakVoice(draft, sfxPath(item.voice)) || draft;
        }, "soundbar " + item.label);
        paint();
      });
      soundbarButtons[item.id] = btn;
      soundbarListEl.appendChild(btn);
    });
    var clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "chip";
    clearBtn.textContent = "CLEAR";
    clearBtn.addEventListener("click", function () {
      activeSoundbarId = "";
      publish(function (draft) {
        if (draft.winMode) {
          C.setWinMode(draft, false);
          C.setTimerVisible(draft, true);
        }
        C.setCamera(draft, false);
        C.setCaption(draft, "");
        return C.stopVoice(draft) || draft;
      }, "soundbar cleared");
      paint();
    });
    soundbarListEl.appendChild(clearBtn);
  }

  function renderCovers(list) {
    coverButtons = {};
    if (!coverListEl) return;
    coverListEl.replaceChildren();
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (!item || !item.file) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sfx-btn cover-btn";
      btn.textContent = item.label || item.id || item.file;
      btn._cover = item;
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", function () {
        var path = coverPath(item.file);
        if (state.bgImage === path) {
          publish(function (draft) { return C.setBgImage(draft, ""); }, "cover cleared");
          return;
        }
        publish(function (draft) { return C.setBgImage(draft, path); }, "cover set");
      });
      coverButtons[item.id || item.file] = btn;
      coverListEl.appendChild(btn);
    });
    paint();
  }

  function sendCaption(text, logLine) {
    publish(function (draft) { return C.setCaption(draft, text); }, logLine);
  }

  function prepSpeak(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/فرخ[\u200c\s\-]*خان/g, "فَرُّخ خان")
      .replace(/\n+/g, ". ")
      .replace(/\s+/g, " ")
      .trim();
  }

  renderSounds(window.CountdownSounds || []);
  renderSoundbar();
  renderCovers(window.CountdownImages || []);

  captionShow.addEventListener("click", function () {
    var text = (captionInput.value || "").trim();
    if (!text) return;
    activeSoundbarId = "";
    sendCaption(text, "overlay set");
    paint();
  });

  if (captionSay) {
    captionSay.addEventListener("click", function () {
      var text = (captionInput.value || "").trim();
      if (!text) return;
      var spoken = prepSpeak(text);
      if (!spoken) return;
      captionSay.disabled = true;
      fetch(apiBase() + "/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: spoken })
      }).then(function (res) {
        if (!res.ok) throw new Error("tts " + res.status);
        return res.json();
      }).then(function (data) {
        var url = mediaUrl(data && data.url);
        if (!url) throw new Error("no url");
        publish(function (draft) {
          return C.speakVoice(draft, url) || draft;
        }, "say");
        paint();
      }).catch(function () {
        publish(function (draft) {
          return C.speakText(draft, spoken) || draft;
        }, "say fallback");
        paint();
      }).then(function () {
        captionSay.disabled = false;
      });
    });
  }

  captionClear.addEventListener("click", function () {
    activeSoundbarId = "";
    publish(function (draft) {
      C.setCaption(draft, "");
      return C.stopVoice(draft) || draft;
    }, "overlay cleared");
    paint();
  });

  if (timerVisEl) {
    timerVisEl.addEventListener("click", function () {
      var next = !(state.timerVisible !== false);
      publish(function (draft) { return C.setTimerVisible(draft, next); }, next ? "timer shown" : "timer hidden");
    });
  }

  function setCamStatus(text) {
    if (camStatusEl) camStatusEl.textContent = text;
  }

  function stampName(prefix, ext) {
    var d = new Date();
    function p(n) { return String(n).padStart(2, "0"); }
    return prefix + "-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + ext;
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function renderCaptures(items) {
    if (!camShotsEl) return;
    camShotsEl.replaceChildren();
    (Array.isArray(items) ? items : []).forEach(function (item) {
      if (!item || !item.url) return;
      var href = mediaUrl(item.url);
      if (item.kind === "video") {
        var link = document.createElement("a");
        link.className = "cam-shot is-video";
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "VIDEO";
        link.title = item.name || "video";
        camShotsEl.appendChild(link);
        return;
      }
      var img = document.createElement("img");
      img.className = "cam-shot";
      img.src = href;
      img.alt = item.name || "snap";
      img.title = item.name || "snap";
      img.addEventListener("click", function () {
        window.open(href, "_blank", "noopener");
      });
      camShotsEl.appendChild(img);
    });
  }

  function refreshCaptures() {
    fetch(apiBase() + "/api/cam/captures").then(function (res) {
      if (!res.ok) throw new Error("list");
      return res.json();
    }).then(function (data) {
      renderCaptures(data && data.items);
    }).catch(function () {});
  }

  function setCamLive(on) {
    camLiveOn = !!on;
    if (camLiveBtn) {
      camLiveBtn.setAttribute("aria-pressed", camLiveOn ? "true" : "false");
      camLiveBtn.classList.toggle("is-on", camLiveOn);
    }
    if (!camPreview) return;
    if (!camLiveOn) {
      camPreview.hidden = true;
      camPreview.removeAttribute("src");
      if (camPlaceholder) camPlaceholder.hidden = false;
      setCamStatus("LIVE خاموش است.");
      return;
    }
    camPreview.hidden = false;
    if (camPlaceholder) camPlaceholder.hidden = true;
    camPreview.src = apiBase() + "/api/cam.mjpg?t=" + Date.now();
    setCamStatus("LIVE از داهوا.");
  }

  function ensureCamCanvas() {
    if (!camCanvas) {
      camCanvas = document.createElement("canvas");
      camCanvasCtx = camCanvas.getContext("2d", { alpha: false });
    }
    var w = (camPreview && camPreview.naturalWidth) || 704;
    var h = (camPreview && camPreview.naturalHeight) || 576;
    if (camCanvas.width !== w || camCanvas.height !== h) {
      camCanvas.width = w;
      camCanvas.height = h;
    }
    return camCanvas;
  }

  function stopCamDraw() {
    if (camDrawTimer) {
      cancelAnimationFrame(camDrawTimer);
      camDrawTimer = null;
    }
  }

  function drawCamFrame() {
    if (!camRecorder) return;
    try {
      var canvas = ensureCamCanvas();
      if (camPreview && !camPreview.hidden && camPreview.naturalWidth) {
        camCanvasCtx.drawImage(camPreview, 0, 0, canvas.width, canvas.height);
      }
    } catch (err) {}
    camDrawTimer = requestAnimationFrame(drawCamFrame);
  }

  function paintRecClock() {
    if (!camRecTimeEl || !camRecStarted) return;
    var sec = Math.max(0, Math.floor((Date.now() - camRecStarted) / 1000));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    camRecTimeEl.textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  var camServerRec = false;

  function setRecUi(on) {
    if (camRecBadge) camRecBadge.hidden = !on;
    if (camRecBtn) {
      camRecBtn.setAttribute("aria-pressed", on ? "true" : "false");
      camRecBtn.textContent = on ? "STOP" : "REC";
    }
    if (on) {
      camRecStarted = Date.now();
      paintRecClock();
      if (camRecTimer) clearInterval(camRecTimer);
      camRecTimer = setInterval(paintRecClock, 250);
    } else if (camRecTimer) {
      clearInterval(camRecTimer);
      camRecTimer = null;
    }
  }

  function stopCamRec() {
    if (camServerRec) {
      camServerRec = false;
      setCamStatus("در حال توقف REC…");
      fetch(apiBase() + "/api/cam/rec/stop", { method: "POST" }).then(function (res) {
        return res.json();
      }).then(function (data) {
        setRecUi(false);
        if (!data || !data.ok) {
          setCamStatus((data && data.error) || "توقف REC ناموفق");
          return;
        }
        var href = mediaUrl(data.url);
        var a = document.createElement("a");
        a.href = href;
        a.download = data.name || stampName("rec", ".mp4");
        document.body.appendChild(a);
        a.click();
        a.remove();
        setCamStatus("فیلم main ذخیره شد: " + data.name);
        refreshCaptures();
        pushLog("cam rec saved");
      }).catch(function () {
        setRecUi(false);
        setCamStatus("توقف REC ناموفق");
      });
      return;
    }
    if (!camRecorder) return;
    try { camRecorder.stop(); } catch (err) {}
  }

  function startCamRec() {
    if (camRecorder || camServerRec) return;
    // Prefer server-side ffmpeg copy of main 1080p RTSP.
    setCamStatus("شروع REC از main stream…");
    fetch(apiBase() + "/api/cam/rec/start", { method: "POST" }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || "rec");
        return data;
      });
    }).then(function (data) {
      camServerRec = true;
      setRecUi(true);
      setCamStatus("REC main 1080p: " + (data.name || "recording"));
      pushLog("cam rec start main");
      if (!camLiveOn) setCamLive(true);
    }).catch(function () {
      startCamRecFallback();
    });
  }

  function startCamRecFallback() {
    if (camRecorder) return;
    if (!camLiveOn) setCamLive(true);
    var canvas = ensureCamCanvas();
    if (!canvas.captureStream) {
      setCamStatus("REC سرور و canvas در دسترس نیست.");
      return;
    }
    var stream = canvas.captureStream(12);
    var mime = "";
    if (window.MediaRecorder) {
      if (MediaRecorder.isTypeSupported("video/webm;codecs=vp9")) mime = "video/webm;codecs=vp9";
      else if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8")) mime = "video/webm;codecs=vp8";
      else if (MediaRecorder.isTypeSupported("video/webm")) mime = "video/webm";
    }
    if (!window.MediaRecorder || !mime) {
      setCamStatus("MediaRecorder در این مرورگر پشتیبانی نمی‌شود.");
      return;
    }
    camRecChunks = [];
    try {
      camRecorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
    } catch (err) {
      setCamStatus("شروع REC ناموفق بود.");
      camRecorder = null;
      return;
    }
    camRecorder.ondataavailable = function (e) {
      if (e.data && e.data.size) camRecChunks.push(e.data);
    };
    camRecorder.onstop = function () {
      stopCamDraw();
      setRecUi(false);
      var blob = new Blob(camRecChunks, { type: mime.split(";")[0] });
      camRecChunks = [];
      camRecorder = null;
      if (!blob.size) {
        setCamStatus("REC خالی بود.");
        return;
      }
      var filename = stampName("rec", ".webm");
      downloadBlob(blob, filename);
      fetch(apiBase() + "/api/cam/save", {
        method: "POST",
        headers: {
          "Content-Type": "video/webm",
          "X-Filename": filename
        },
        body: blob
      }).then(function (res) {
        if (!res.ok) throw new Error("save");
        return res.json();
      }).then(function () {
        setCamStatus("فیلم ذخیره شد: " + filename);
        refreshCaptures();
        pushLog("cam rec saved");
      }).catch(function () {
        setCamStatus("دانلود شد؛ ذخیره سرور ناموفق: " + filename);
      });
    };
    camRecorder.start(500);
    setRecUi(true);
    stopCamDraw();
    drawCamFrame();
    setCamStatus("REC مرورگر (fallback)…");
    pushLog("cam rec start fallback");
  }

  if (camLiveBtn) {
    camLiveBtn.addEventListener("click", function () {
      setCamLive(!camLiveOn);
    });
  }

  if (camSnapBtn) {
    camSnapBtn.addEventListener("click", function () {
      camSnapBtn.disabled = true;
      setCamStatus("در حال گرفتن عکس…");
      fetch(apiBase() + "/api/cam/snap", { method: "POST" }).then(function (res) {
        if (!res.ok) throw new Error("snap");
        return res.json();
      }).then(function (data) {
        if (!data || !data.url) throw new Error("bad snap");
        var href = mediaUrl(data.url);
        var a = document.createElement("a");
        a.href = href;
        a.download = data.name || stampName("snap", ".jpg");
        document.body.appendChild(a);
        a.click();
        a.remove();
        setCamStatus("عکس ذخیره شد: " + (data.name || "snap"));
        refreshCaptures();
        pushLog("cam snap");
      }).catch(function () {
        setCamStatus("عکس گرفته نشد. سرور/دوربین را چک کنید.");
      }).then(function () {
        camSnapBtn.disabled = false;
      });
    });
  }

  if (camRecBtn) {
    camRecBtn.addEventListener("click", function () {
      if (camRecorder || camServerRec) stopCamRec();
      else startCamRec();
    });
  }

  if (camShowBtn) {
    camShowBtn.addEventListener("click", function () {
      var next = !state.camera;
      publish(function (draft) { return C.setCamera(draft, next) || draft; }, next ? "camera on display" : "camera off display");
      camShowBtn.setAttribute("aria-pressed", next ? "true" : "false");
      paint();
    });
  }

  if (camPreview) {
    camPreview.addEventListener("error", function () {
      if (!camLiveOn) return;
      setCamStatus("استریم قطع شد. دوباره LIVE بزنید.");
      setCamLive(false);
    });
  }

  refreshCaptures();
  fetch(apiBase() + "/api/health").then(function (res) {
    return res.ok ? res.json() : null;
  }).then(function (data) {
    if (data && data.camera) setCamStatus("دوربین آماده: " + data.camera + " — LIVE را بزنید.");
  }).catch(function () {
    setCamStatus("سرور محلی در دسترس نیست. python serve.py");
  });

  captionInput.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    captionShow.click();
  });

  document.addEventListener("keydown", function (e) {
    if (e.target && e.target.matches && e.target.matches("input, textarea")) return;
    if (e.code === "Space") {
      e.preventDefault();
      transportEl.click();
    }
  });

  setInterval(function () {
    var localOk = Date.now() - lastPing < 2500;
    var ok = localOk || serverDisplayAlive || (link.isServerOk && link.isServerOk());
    lampEl.classList.toggle("on", !!(localOk || serverDisplayAlive));
    if (authBlocked) linkEl.textContent = "PIN  NEEDED";
    else if (localOk || serverDisplayAlive) linkEl.textContent = "LINK  OK";
    else if (link.isHubOk && link.isHubOk()) linkEl.textContent = "HUB  OK";
    else if (link.isServerOk && link.isServerOk()) linkEl.textContent = "HUB  OK";
    else linkEl.textContent = "LINK  LOST";
  }, 300);

  setInterval(function () {
    if (document.body.classList.contains("is-sealed")) return;
    snr = Math.min(58, Math.max(28, snr + (Math.random() - 0.5) * 0.7));
    lat = Math.min(24, Math.max(4, lat + (Math.random() - 0.48) * 1.1));
    jitter = Math.min(1.8, Math.max(0.1, jitter + (Math.random() - 0.5) * 0.12));
    snrEl.textContent = snr.toFixed(1);
    latEl.textContent = String(Math.round(lat)).padStart(2, "0");
    jitterEl.textContent = jitter.toFixed(1);
  }, 900);

  setInterval(function () {
    if (state.status === "running" && C.computeRemaining(state, Date.now()) <= 0) {
      trySeal();
      return;
    }
    link.emit({ type: "heartbeat", revision: state.revision, at: Date.now() });
  }, 900);

  var hadStore = !!C.load();
  var bootRevision = state.revision;

  function paintNtfy(status) {
    if (!ntfyStatusEl || !ntfyLampEl) return;
    var ok = !!(status && status.ok);
    var pending = !status || (!ok && !status.lastError && !status.lastOkAt);
    ntfyLampEl.classList.toggle("on", ok);
    if (pending) ntfyStatusEl.textContent = "HUB در حال اتصال";
    else if (ok) ntfyStatusEl.textContent = "HUB متصل";
    else ntfyStatusEl.textContent = "HUB ناموفق";
    ntfyStatusEl.title = (status && (status.lastError || status.activeBase)) || "";
  }

  function pollNtfy() {
    fetch("/api/room/info")
      .then(function (r) { return r.json(); })
      .then(function (info) {
        paintNtfy(info && info.hub && info.hub.status);
      })
      .catch(function () {
        paintNtfy({ ok: false, lastError: "سرور محلی در دسترس نیست", lastOkAt: 1 });
      });
  }

  function reconcileWithServer() {
    return fetch("/api/room/state")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (state.revision !== bootRevision) return;
        if (!data || !data.state || typeof data.state.revision !== "number") {
          broadcast();
          return;
        }
        if (data.state.revision > state.revision) {
          onMsg({
            channel: C.CHANNEL,
            from: "server",
            clientId: "server",
            type: "state",
            serverNow: data.serverNow || data.state.serverNow,
            state: data.state
          });
          pushLog("synced from server");
          return;
        }
        if (data.state.revision < state.revision) {
          broadcast();
          pushLog("server caught up");
          return;
        }
        onMsg({
          channel: C.CHANNEL,
          from: "server",
          clientId: "server",
          type: "state",
          serverNow: data.serverNow || data.state.serverNow,
          state: data.state
        });
      })
      .catch(function () { broadcast(); });
  }

  ensureAdminPin(false).then(function () {
    return reconcileWithServer();
  }).then(function () {
    if (!hadStore) pushLog("room hub open");
    else if (state.status === "ended") pushLog("sequence sealed");
    else pushLog("channel restored");
  });
  pollNtfy();
  setInterval(pollNtfy, 2000);
  paint();

  function frame() {
    paintLive();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
