(function () {
  function createEngine() {
    var ctx = null;
    var master = null;
    var armed = false;
    var volume = 0.85;
    var pulseOn = true;
    var bedGain = null;
    var bedWant = { whole: 99, running: false };
    var speakGain = null;
    var speakStream = null;
    var speakNode = null;
    var speaking = false;
    var FADE_MS = 900;

    function context() {
      if (ctx) return ctx;
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      return ctx;
    }

    function createLoopLayer() {
      var el = null;
      var url = "";
      var layerVol = 0.7;
      var fadeToken = 0;
      var desired = false;
      var busy = false;

      function peak() {
        return Math.min(1, Math.max(0, volume * layerVol));
      }

      function hardStop() {
        busy = false;
        if (!el) return;
        try { el.pause(); } catch (err) {}
        try {
          el.removeAttribute("src");
          el.load();
        } catch (err) {}
        el = null;
        url = "";
      }

      function fadeTo(target, ms, done) {
        if (!el) {
          busy = false;
          if (done) done();
          return;
        }
        busy = true;
        var token = ++fadeToken;
        var from = el.volume;
        var start = performance.now();
        var dur = Math.max(40, ms || FADE_MS);
        function step(now) {
          if (token !== fadeToken || !el) return;
          var t = Math.min(1, (now - start) / dur);
          var next = from + (target - from) * t;
          try { el.volume = Math.min(1, Math.max(0, next)); } catch (err) {}
          if (t < 1) {
            requestAnimationFrame(step);
            return;
          }
          busy = false;
          if (done) done();
        }
        requestAnimationFrame(step);
      }

      function kick() {
        if (!el) return;
        if (!busy) {
          try { el.volume = peak(); } catch (err) {}
        }
        var start = el.play();
        if (start && typeof start.then === "function") start.catch(function () {});
      }

      function startUrl(nextUrl, fadeIn) {
        hardStop();
        url = nextUrl;
        el = new Audio();
        el.loop = true;
        el.preload = "auto";
        el.src = nextUrl;
        try { el.volume = fadeIn ? 0.0001 : peak(); } catch (err) {}
        var start = el.play();
        if (start && typeof start.then === "function") start.catch(function () {});
        if (fadeIn) fadeTo(peak(), FADE_MS, null);
        else busy = false;
      }

      return {
        setVolume: function (v) {
          layerVol = Math.min(1, Math.max(0, v));
          if (el && desired && !busy) {
            try { el.volume = peak(); } catch (err) {}
          }
        },
        syncMaster: function () {
          if (el && desired && !busy) {
            try { el.volume = peak(); } catch (err) {}
          }
        },
        isPlaying: function () {
          return !!(desired && el && !el.paused && !el.ended);
        },
        wants: function () {
          return desired;
        },
        currentUrl: function () {
          return url;
        },
        play: function (nextUrl) {
          if (!armed || !nextUrl) return false;
          desired = true;
          if (url === nextUrl && el) {
            if (el.paused || el.ended) kick();
            else if (!busy) {
              try { el.volume = peak(); } catch (err) {}
            }
            return true;
          }
          if (el) {
            var pending = nextUrl;
            fadeTo(0, FADE_MS, function () {
              if (!desired) {
                hardStop();
                return;
              }
              startUrl(pending, true);
            });
            return true;
          }
          startUrl(nextUrl, true);
          return true;
        },
        stop: function (immediate) {
          desired = false;
          if (!el) {
            url = "";
            return;
          }
          if (immediate) {
            fadeToken += 1;
            hardStop();
            return;
          }
          fadeTo(0, FADE_MS, function () {
            if (desired) return;
            hardStop();
          });
        },
        ensure: function () {
          if (!desired || !url) return false;
          if (busy) return true;
          if (!el) {
            startUrl(url, true);
            return true;
          }
          if (el.paused || el.ended) kick();
          return true;
        }
      };
    }

    var bedLayer = createLoopLayer();
    var heartLayer = createLoopLayer();
    var cueEl = null;
    var cueUrl = "";
    var hitEl = null;

    function stopCue() {
      var el = cueEl;
      cueEl = null;
      if (el) {
        try { el.pause(); } catch (err) {}
        try {
          el.removeAttribute("src");
          el.load();
        } catch (err) {}
      }
      if (cueUrl) {
        var url = cueUrl;
        cueUrl = "";
        try { URL.revokeObjectURL(url); } catch (err) {}
      }
    }

    function playCue(source) {
      if (!armed || !source) return false;
      if (typeof source !== "string" && typeof source.size !== "number") return false;
      stopCue();
      var url = "";
      if (typeof source === "string") url = source;
      else {
        try { url = URL.createObjectURL(source); } catch (err) { return false; }
        cueUrl = url;
      }
      if (!url) return false;
      cueEl = new Audio();
      cueEl.preload = "auto";
      cueEl.src = url;
      try { cueEl.volume = Math.min(1, Math.max(0, volume)); } catch (err) {}
      var start = cueEl.play();
      if (start && typeof start.then === "function") start.catch(function () {});
      return true;
    }

    function isCuePlaying() {
      return !!(cueEl && !cueEl.paused && !cueEl.ended);
    }

    function stopHit() {
      if (!hitEl) return;
      try { hitEl.pause(); } catch (err) {}
      try {
        hitEl.removeAttribute("src");
        hitEl.load();
      } catch (err) {}
      hitEl = null;
    }

    function playHit(url) {
      if (!armed || !url) return false;
      stopHit();
      hitEl = new Audio();
      hitEl.preload = "auto";
      hitEl.src = url;
      // Scare pads stay pinned loud regardless of bed/master trim.
      try { hitEl.volume = 1; } catch (err) {}
      var start = hitEl.play();
      if (start && typeof start.then === "function") start.catch(function () {});
      return true;
    }

    function isHitPlaying() {
      return !!(hitEl && !hitEl.paused && !hitEl.ended);
    }

    function setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      if (master && ctx) {
        var t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), t);
        master.gain.linearRampToValueAtTime(Math.max(0.0001, volume), t + 0.05);
      }
      bedLayer.syncMaster();
      heartLayer.syncMaster();
      if (cueEl) {
        try { cueEl.volume = Math.min(1, Math.max(0, volume)); } catch (err) {}
      }
    }

    function setSfxVolume(v) { bedLayer.setVolume(v); }
    function setHeartVolume(v) { heartLayer.setVolume(v); }
    function playSfx(url) { return bedLayer.play(url); }
    function stopSfx(immediate) { bedLayer.stop(!!immediate); }
    function isSfxPlaying() { return bedLayer.isPlaying(); }
    function playHeart(url) { return heartLayer.play(url); }
    function stopHeart(immediate) { heartLayer.stop(!!immediate); }
    function isHeartPlaying() { return heartLayer.isPlaying(); }
    function ensureLoops() {
      bedLayer.ensure();
      heartLayer.ensure();
    }

    function ensureSpeakBus() {
      context();
      if (speakGain) return speakGain;
      speakGain = ctx.createGain();
      speakGain.gain.value = 1;
      speakGain.connect(master);
      return speakGain;
    }

    function stopSpeak() {
      speaking = false;
      if (speakNode) {
        try { speakNode.disconnect(); } catch (err) {}
        speakNode = null;
      }
      if (speakStream) {
        try {
          speakStream.getTracks().forEach(function (track) { track.stop(); });
        } catch (err) {}
        speakStream = null;
      }
    }

    function startSpeak() {
      if (!armed) return Promise.resolve(false);
      if (speaking) return Promise.resolve(true);
      context();
      ensureSpeakBus();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return Promise.resolve(false);
      }
      return navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      }).then(function (stream) {
        if (!armed) {
          stream.getTracks().forEach(function (track) { track.stop(); });
          return false;
        }
        stopSpeak();
        speakStream = stream;
        speakNode = ctx.createMediaStreamSource(stream);
        speakNode.connect(speakGain);
        speaking = true;
        return true;
      }).catch(function () {
        speaking = false;
        return false;
      });
    }

    function setSpeak(on) {
      if (on) return startSpeak();
      stopSpeak();
      return Promise.resolve(true);
    }

    function isSpeaking() {
      return speaking;
    }

    function env(peak, attack, decay) {
      var t = ctx.currentTime;
      var g = ctx.createGain();
      g.connect(master);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
      return { gain: g, t: t };
    }

    function tone(freq, peak, attack, decay, type) {
      var node = env(peak, attack, decay);
      var o = ctx.createOscillator();
      o.type = type || "sine";
      o.frequency.setValueAtTime(freq, node.t);
      o.connect(node.gain);
      o.start(node.t);
      o.stop(node.t + attack + decay + 0.04);
      return node;
    }

    function noise(peak, dur, fromHz, toHz) {
      var t = ctx.currentTime;
      var n = Math.max(1, Math.floor(ctx.sampleRate * dur));
      var buf = ctx.createBuffer(1, n, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < n; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 1.4);
      }
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(fromHz, t);
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, toHz), t + dur);
      var g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0002, peak), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(filter);
      filter.connect(g);
      g.connect(master);
      src.start(t);
      src.stop(t + dur + 0.02);
    }

    function click(peak, dur, hpHz) {
      var t = ctx.currentTime;
      var n = Math.max(1, Math.floor(ctx.sampleRate * dur));
      var buf = ctx.createBuffer(1, n, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 0.45);
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = hpHz || 1400;
      var g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0002, peak), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.008, dur));
      src.connect(hp);
      hp.connect(g);
      g.connect(master);
      src.start(t);
      src.stop(t + dur + 0.02);
    }

    function sweep(startFreq, endFreq, peak, attack, decay, type, rise) {
      var t = ctx.currentTime;
      var atk = Math.max(0.0015, attack);
      var g = ctx.createGain();
      g.connect(master);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + atk);
      g.gain.exponentialRampToValueAtTime(0.0001, t + atk + decay);
      var o = ctx.createOscillator();
      o.type = type || "sine";
      o.frequency.setValueAtTime(Math.max(30, startFreq), t);
      o.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), t + Math.max(0.012, rise));
      o.connect(g);
      o.start(t);
      o.stop(t + atk + decay + 0.05);
    }

    function pulse(freq, peak, decay, delay) {
      var t = ctx.currentTime + (delay || 0);
      var g = ctx.createGain();
      g.connect(master);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.008 + decay);
      var o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(Math.max(40, freq * 1.7), t);
      o.frequency.exponentialRampToValueAtTime(Math.max(28, freq), t + 0.045);
      o.connect(g);
      o.start(t);
      o.stop(t + decay + 0.06);
    }

    function ensureBed() {
      if (bedGain || !ctx) return;
      bedGain = ctx.createGain();
      bedGain.gain.value = 0.0001;
      bedGain.connect(master);
      [
        { f: 33, g: 0.38 },
        { f: 46, g: 0.62 },
        { f: 49.4, g: 0.22 }
      ].forEach(function (layer) {
        var o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = layer.f;
        var g = ctx.createGain();
        g.gain.value = layer.g;
        o.connect(g);
        g.connect(bedGain);
        o.start();
      });
    }

    function applyBed() {
      if (!armed || !ctx) return;
      ensureBed();
      var whole = bedWant.whole;
      var want = pulseOn && bedWant.running && whole > 0 && whole <= 30;
      var target = want ? 0.014 + ((30 - whole) / 30) * 0.05 : 0.0001;
      var t = ctx.currentTime;
      var current = Math.max(0.0001, bedGain.gain.value || 0.0001);
      bedGain.gain.cancelScheduledValues(t);
      bedGain.gain.setValueAtTime(current, t);
      bedGain.gain.exponentialRampToValueAtTime(target, t + (pulseOn ? 0.35 : 0.7));
    }

    function setPulse(on) {
      pulseOn = !!on;
      applyBed();
    }

    function arm() {
      var c = context();
      var ready = c.state === "suspended" ? c.resume() : Promise.resolve();
      return ready.then(function () {
        armed = true;
        applyBed();
      });
    }

    function tickIntensity(whole) {
      if (whole >= 60) {
        var span = (120 - Math.min(whole, 120)) / 60;
        if (span < 0) span = 0;
        if (span > 1) span = 1;
        return span * 0.2;
      }
      var near = (60 - whole) / 49;
      if (near < 0) near = 0;
      if (near > 1) near = 1;
      return 0.2 + near * 0.8;
    }

    function heartbeat(whole) {
      var close = (30 - whole) / 19;
      if (close < 0) close = 0;
      if (close > 1) close = 1;
      var lub = 48 + close * 16;
      var peak = 0.075 + close * 0.06;
      pulse(lub, peak, 0.12 - close * 0.035, 0);
      pulse(lub * 1.42, peak * 0.4, 0.05, 0.145 - close * 0.055);
      noise(0.028 + close * 0.032, 0.055, 170, 55);
    }

    function stakes(whole) {
      var n = 11 - whole;
      var accent = n / 10;
      var ladder = [494, 554, 622, 698, 784, 880, 988, 1109, 1175, 1319];
      var freq = ladder[n - 1];
      var rise = 0.04 + accent * 0.045;
      click(0.062 + accent * 0.065, 0.022 - accent * 0.01, 1700 + accent * 1800);
      sweep(freq * 0.8, freq, 0.09 + accent * 0.07, 0.002, 0.068 + accent * 0.05, "sine", rise);
      sweep(freq * 1.18, freq * 1.5, 0.014 + accent * 0.02, 0.002, 0.04 + accent * 0.02, "sine", rise * 0.75);
      pulse(64 + accent * 24, 0.06 + accent * 0.045, 0.06, 0);
    }

    function tick(whole) {
      if (!armed || !(whole > 0)) return;
      context();
      if (whole <= 10) {
        stakes(whole);
        return;
      }
      var snap = tickIntensity(whole);
      var freq = 148 + snap * 320;
      var decay = 0.155 - snap * 0.12;
      var peak = 0.026 + snap * 0.064;
      click(0.015 + snap * 0.072, 0.028 - snap * 0.016, 850 + snap * 1700);
      sweep(freq * (1.05 + snap * 0.55), freq, peak, 0.0045 - snap * 0.003, decay, "sine", 0.012 + (1 - snap) * 0.035);
      var partial = peak * snap * 0.4;
      if (partial > 0.008) tone(freq * 2.5, partial, 0.0015, 0.016, "sine");
      if (pulseOn && whole <= 30) heartbeat(whole);
    }

    function setBed(whole, running) {
      bedWant = { whole: whole, running: !!running };
      applyBed();
    }

    function penalty() {
      if (!armed) return false;
      context();
      pulse(44, 0.12, 0.16, 0);
      click(0.05, 0.04, 300);
      noise(0.16, 1.55, 680, 46);
      [
        { freq: 55, peak: 0.095, dur: 1.65 },
        { freq: 58.6, peak: 0.08, dur: 1.55 },
        { freq: 77.8, peak: 0.04, dur: 1.1 }
      ].forEach(function (part) {
        var node = env(part.peak, 0.01, part.dur);
        var o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.setValueAtTime(part.freq * 2.4, node.t);
        o.frequency.exponentialRampToValueAtTime(part.freq, node.t + 0.38);
        var lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.setValueAtTime(820, node.t);
        lp.frequency.exponentialRampToValueAtTime(130, node.t + 0.5);
        o.connect(lp);
        lp.connect(node.gain);
        o.start(node.t);
        o.stop(node.t + part.dur + 0.08);
      });
      tone(90, 0.065, 0.008, 0.7, "triangle");
      return true;
    }

    function scheduledNoise(start, peak, dur, fromHz, toHz, q, attack) {
      var atk = Math.max(0.004, Math.min(attack || 0.05, dur * 0.45));
      var n = Math.max(1, Math.floor(ctx.sampleRate * dur));
      var buf = ctx.createBuffer(1, n, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = q;
      bp.frequency.setValueAtTime(fromHz, start);
      bp.frequency.exponentialRampToValueAtTime(Math.max(40, toHz), start + dur);
      var g = ctx.createGain();
      g.connect(master);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + atk);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      src.connect(bp);
      bp.connect(g);
      src.start(start);
      src.stop(start + dur + 0.03);
    }

    function metallic(start, freq, ratio, index, peak, dur) {
      var g = ctx.createGain();
      g.connect(master);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      var carrier = ctx.createOscillator();
      carrier.type = "sine";
      carrier.frequency.setValueAtTime(freq, start);
      carrier.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.4), start + dur);
      var mod = ctx.createOscillator();
      mod.type = "sine";
      mod.frequency.setValueAtTime(freq * ratio, start);
      mod.frequency.exponentialRampToValueAtTime(Math.max(30, freq * ratio * 0.46), start + dur);
      var depth = ctx.createGain();
      depth.gain.setValueAtTime(index, start);
      depth.gain.exponentialRampToValueAtTime(Math.max(2, index * 0.12), start + dur * 0.8);
      mod.connect(depth);
      depth.connect(carrier.frequency);
      var hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = Math.max(90, freq * 0.35);
      carrier.connect(hp);
      hp.connect(g);
      carrier.start(start);
      mod.start(start);
      carrier.stop(start + dur + 0.05);
      mod.stop(start + dur + 0.05);
    }

    function collapse(start, from, to, peak, dur, wobble, type) {
      var g = ctx.createGain();
      g.connect(master);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + 0.06);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.45), start + dur * 0.55);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      var o = ctx.createOscillator();
      o.type = type || "triangle";
      o.frequency.setValueAtTime(from, start);
      o.frequency.exponentialRampToValueAtTime(Math.max(28, to), start + dur);
      if (wobble > 0) {
        var lfo = ctx.createOscillator();
        var lg = ctx.createGain();
        lfo.frequency.value = wobble;
        lg.gain.value = from * 0.028;
        lfo.connect(lg);
        lg.connect(o.frequency);
        lfo.start(start);
        lfo.stop(start + dur + 0.05);
      }
      var lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 1.3;
      lp.frequency.setValueAtTime(type === "sawtooth" ? 1100 : 640, start);
      lp.frequency.exponentialRampToValueAtTime(78, start + dur);
      o.connect(lp);
      lp.connect(g);
      o.start(start);
      o.stop(start + dur + 0.05);
    }

    function eerie(start, freq, dur) {
      var g = ctx.createGain();
      g.connect(master);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.03, start + 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      var o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(freq, start);
      o.frequency.exponentialRampToValueAtTime(freq * 0.52, start + dur);
      var lfo = ctx.createOscillator();
      var lg = ctx.createGain();
      lfo.frequency.setValueAtTime(5.2, start);
      lfo.frequency.exponentialRampToValueAtTime(0.55, start + dur);
      lg.gain.setValueAtTime(freq * 0.01, start);
      lg.gain.linearRampToValueAtTime(freq * 0.045, start + dur);
      lfo.connect(lg);
      lg.connect(o.frequency);
      o.connect(g);
      var g2 = ctx.createGain();
      g2.connect(master);
      g2.gain.setValueAtTime(0.0001, start);
      g2.gain.setValueAtTime(0.0001, start + 0.08);
      g2.gain.exponentialRampToValueAtTime(0.022, start + 0.55);
      g2.gain.exponentialRampToValueAtTime(0.0001, start + dur * 0.94);
      var o2 = ctx.createOscillator();
      o2.type = "sine";
      o2.frequency.setValueAtTime(freq * 1.063, start);
      o2.frequency.exponentialRampToValueAtTime(freq * 0.41, start + dur);
      o2.connect(g2);
      o.start(start);
      o2.start(start);
      lfo.start(start);
      o.stop(start + dur + 0.05);
      o2.stop(start + dur + 0.05);
      lfo.stop(start + dur + 0.05);
    }

    function notif() {
      if (!armed) return false;
      context();
      var t = ctx.currentTime + 0.01;
      var bus = ctx.createGain();
      bus.gain.value = 1;
      bus.connect(ctx.destination);

      function blast(start, freq, peak, attack, hold, release) {
        var g = ctx.createGain();
        g.connect(bus);
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack);
        g.gain.setValueAtTime(Math.max(0.0002, peak * 0.92), start + attack + hold);
        g.gain.exponentialRampToValueAtTime(0.0001, start + attack + hold + release);
        var o = ctx.createOscillator();
        o.type = "square";
        o.frequency.setValueAtTime(freq, start);
        var o2 = ctx.createOscillator();
        o2.type = "sawtooth";
        o2.frequency.setValueAtTime(freq * 1.01, start);
        var lp = ctx.createBiquadFilter();
        lp.type = "bandpass";
        lp.frequency.setValueAtTime(freq * 1.4, start);
        lp.Q.value = 2.2;
        o.connect(lp);
        o2.connect(lp);
        lp.connect(g);
        o.start(start);
        o2.start(start);
        o.stop(start + attack + hold + release + 0.05);
        o2.stop(start + attack + hold + release + 0.05);
      }

      [880, 1174, 880].forEach(function (freq, i) {
        var start = t + i * 0.42;
        blast(start, freq, 0.42, 0.012, 0.18, 0.22);
        blast(start, freq * 2, 0.18, 0.01, 0.14, 0.16);
        scheduledNoise(start, 0.22, 0.28, 4200, 900, 0.9, 0.02);
      });
      return true;
    }

    function endChime() {
      if (!armed) return false;
      context();
      setBed(99, false);
      if (bedGain) {
        var now = ctx.currentTime;
        var current = Math.max(0.0001, bedGain.gain.value || 0.0001);
        bedGain.gain.cancelScheduledValues(now);
        bedGain.gain.setValueAtTime(current, now);
        bedGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      }
      var t = ctx.currentTime + 0.02;
      scheduledNoise(t, 0.07, 0.36, 2200, 140, 1.15, 0.006);
      metallic(t, 246, 1.618, 96, 0.074, 2.5);
      metallic(t + 0.07, 369, 1.414, 72, 0.044, 1.85);
      metallic(t + 0.48, 173, 2.37, 58, 0.05, 2.4);
      collapse(t, 92, 37, 0.08, 4.15, 0.16, "triangle");
      collapse(t + 0.02, 95.6, 63, 0.056, 4.05, 0.22, "triangle");
      collapse(t + 0.06, 130, 46, 0.046, 3.15, 0.45, "sawtooth");
      collapse(t + 0.14, 188, 70, 0.03, 2.45, 0.7, "triangle");
      scheduledNoise(t + 0.06, 0.055, 3.9, 1380, 62, 3.2, 0.18);
      eerie(t + 0.18, 622, 3.4);
      return true;
    }

    return {
      arm: arm,
      setVolume: setVolume,
      setPulse: setPulse,
      tick: tick,
      setBed: setBed,
      penalty: penalty,
      notif: notif,
      endChime: endChime,
      playSfx: playSfx,
      stopSfx: stopSfx,
      setSfxVolume: setSfxVolume,
      isSfxPlaying: isSfxPlaying,
      playHeart: playHeart,
      stopHeart: stopHeart,
      setHeartVolume: setHeartVolume,
      isHeartPlaying: isHeartPlaying,
      ensureLoops: ensureLoops,
      setSpeak: setSpeak,
      isSpeaking: isSpeaking,
      playCue: playCue,
      stopCue: stopCue,
      isCuePlaying: isCuePlaying,
      playHit: playHit,
      stopHit: stopHit,
      isHitPlaying: isHitPlaying
    };
  }

  window.CountdownAudio = { createEngine: createEngine };
})();
