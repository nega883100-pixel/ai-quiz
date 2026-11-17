/* Original 8-bit music and SFX for 經濟部產業競爭力輔導團「企業 AI 能力大冒險」.
   Synthesized with the Web Audio API. No sampled audio, no third-party tunes.
   Melody is an original C-major pentatonic island bounce and is not based on
   any commercial game soundtrack. */
(function () {
  "use strict";

  var MUTE_KEY = "aiquiz-muted";
  var BPM = 132;
  var STEP = 60 / BPM / 4; /* sixteenth */

  var ctx = null;
  var master = null;
  var bgmGain = null;
  var sfxGain = null;
  var muted = false;
  var unlocked = false;
  var bgmOn = false;
  var bgmWanted = false;
  var timer = null;
  var nextTime = 0;
  var stepIndex = 0;

  /* MIDI-ish note numbers; 0 = rest. Lead (C5=72) */
  var LEAD = [
    72, 0, 76, 79, 81, 79, 76, 72,
    74, 76, 79, 76, 74, 72, 72, 0,
    76, 79, 81, 84, 81, 79, 76, 74,
    72, 76, 79, 76, 74, 74, 72, 0,
    79, 81, 84, 81, 79, 76, 74, 76,
    77, 76, 74, 72, 74, 76, 72, 0,
    76, 79, 81, 84, 86, 84, 81, 79,
    76, 79, 76, 74, 72, 67, 72, 0
  ];
  /* Bass (C3=48) — two sixteenths per written note, held */
  var BASS = [
    48, 48, 48, 48, 43, 43, 43, 43,
    45, 45, 45, 45, 40, 40, 40, 40,
    41, 41, 41, 41, 48, 48, 48, 48,
    43, 43, 43, 43, 43, 43, 48, 48,
    48, 48, 48, 48, 43, 43, 43, 43,
    41, 41, 41, 41, 48, 48, 48, 48,
    43, 43, 43, 43, 50, 50, 50, 50,
    48, 48, 43, 43, 48, 48, 48, 0
  ];
  /* Off-beat harmony */
  var HARM = [
    0, 0, 64, 0, 0, 0, 67, 0,
    0, 0, 64, 0, 0, 0, 62, 0,
    0, 0, 67, 0, 0, 0, 64, 0,
    0, 0, 62, 0, 0, 0, 60, 0,
    0, 0, 69, 0, 0, 0, 67, 0,
    0, 0, 64, 0, 0, 0, 62, 0,
    0, 0, 67, 0, 0, 0, 69, 0,
    0, 0, 64, 0, 0, 0, 60, 0
  ];

  function midi(n) {
    return 440 * Math.pow(2, (n - 69) / 12);
  }

  function loadMute() {
    try {
      muted = localStorage.getItem(MUTE_KEY) === "1";
    } catch (e) {
      muted = false;
    }
  }

  function saveMute() {
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch (e) {}
  }

  function ensure() {
    if (ctx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.2; /* unchanged so SFX loudness stays put */
    bgmGain = ctx.createGain();
    /* was 0.55; 1.5 is ~2.73x so BGM sits near SFX without overtaking clicks */
    bgmGain.gain.value = 1.5;
    var bgmComp = ctx.createDynamicsCompressor();
    bgmComp.threshold.value = -10;
    bgmComp.knee.value = 6;
    bgmComp.ratio.value = 8;
    bgmComp.attack.value = 0.005;
    bgmComp.release.value = 0.15;
    bgmGain.connect(bgmComp);
    bgmComp.connect(master);
    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.7; /* unchanged; short SFX bypass the BGM compressor */
    sfxGain.connect(master);
    var limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    return true;
  }

  function beepOsc(type, freq, t0, dur, gain, dest, attack, drop) {
    if (!ctx) return;
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (drop) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * drop), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + (attack || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  function noiseBurst(t0, dur, gain) {
    if (!ctx) return;
    var n = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var bp = ctx.createBiquadFilter();
    bp.type = "highpass";
    bp.frequency.value = 4000;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(sfxGain);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  function scheduleStep(t0, idx) {
    var i = idx % LEAD.length;
    if (LEAD[i]) beepOsc("square", midi(LEAD[i]), t0, STEP * 1.05, 0.11, bgmGain, 0.005, 0);
    if (BASS[i] && (i % 2 === 0)) {
      beepOsc("triangle", midi(BASS[i]), t0, STEP * 2.1, 0.16, bgmGain, 0.008, 0);
    }
    if (HARM[i]) beepOsc("square", midi(HARM[i]), t0, STEP * 0.9, 0.05, bgmGain, 0.004, 0);
    /* light hats on off-beats */
    if (i % 2 === 1) {
      /* route a quieter hat into bgm so mute-with-bgm works */
      if (!ctx) return;
      var n = Math.floor(ctx.sampleRate * 0.03);
      var buf = ctx.createBuffer(1, n, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var k = 0; k < n; k++) data[k] = Math.random() * 2 - 1;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var bp = ctx.createBiquadFilter();
      bp.type = "highpass";
      bp.frequency.value = 6000;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.04, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.03);
      src.connect(bp);
      bp.connect(g);
      g.connect(bgmGain);
      src.start(t0);
      src.stop(t0 + 0.04);
    }
  }

  function scheduler() {
    if (!ctx || !bgmOn || muted) return;
    var ahead = 0.12;
    while (nextTime < ctx.currentTime + ahead) {
      scheduleStep(nextTime, stepIndex);
      nextTime += STEP;
      stepIndex += 1;
    }
    timer = window.setTimeout(scheduler, 40);
  }

  function startBgm() {
    bgmWanted = true;
    if (!unlocked || muted || !ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    if (bgmOn) return;
    bgmOn = true;
    nextTime = ctx.currentTime + 0.05;
    stepIndex = 0;
    scheduler();
  }

  function stopBgm() {
    bgmWanted = false;
    bgmOn = false;
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  function playBeep() {
    if (!unlocked || muted || !ctx) return;
    var t = ctx.currentTime;
    beepOsc("square", 784, t, 0.06, 0.18, sfxGain, 0.004, 0);
    beepOsc("square", 1046, t + 0.05, 0.05, 0.14, sfxGain, 0.003, 0);
  }

  function playClear() {
    if (!unlocked || muted || !ctx) return;
    var t = ctx.currentTime;
    var notes = [72, 76, 79, 84];
    for (var i = 0; i < notes.length; i++) {
      beepOsc("square", midi(notes[i]), t + i * 0.11, 0.14, 0.18, sfxGain, 0.006, 0);
    }
  }

  function playFanfare() {
    if (!unlocked || muted || !ctx) return;
    var t = ctx.currentTime;
    var line = [72, 76, 79, 84, 79, 84, 88, 96];
    for (var i = 0; i < line.length; i++) {
      var dur = i === line.length - 1 ? 0.55 : 0.13;
      beepOsc("square", midi(line[i]), t + i * 0.12, dur, 0.2, sfxGain, 0.006, 0);
    }
    /* bass hits */
    var bass = [48, 48, 55, 60];
    for (var j = 0; j < bass.length; j++) {
      beepOsc("triangle", midi(bass[j]), t + 0.12 * (j * 2), 0.28, 0.22, sfxGain, 0.01, 0);
    }
    /* final chord */
    var end = t + 0.12 * 7;
    beepOsc("square", midi(72), end, 0.7, 0.1, sfxGain, 0.01, 0);
    beepOsc("square", midi(76), end, 0.7, 0.1, sfxGain, 0.01, 0);
    beepOsc("square", midi(79), end, 0.7, 0.1, sfxGain, 0.01, 0);
    beepOsc("triangle", midi(48), end, 0.7, 0.18, sfxGain, 0.01, 0);
  }

  function updateButton() {
    var btn = document.getElementById("btn-mute");
    var icon = document.getElementById("mute-icon");
    if (!btn) return;
    btn.setAttribute("aria-pressed", muted ? "true" : "false");
    btn.setAttribute("aria-label", muted ? "開啟音效" : "關閉音效");
    btn.title = muted ? "開啟音效" : "關閉音效";
    if (icon) {
      icon.src = muted ? "assets/img/icon_speaker_off.png" : "assets/img/icon_speaker.png";
      icon.alt = muted ? "音效已關" : "音效已開";
    }
    btn.classList.toggle("is-muted", muted);
  }

  function setMuted(v) {
    muted = !!v;
    saveMute();
    if (muted) {
      bgmOn = false;
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
    } else if (bgmWanted) {
      startBgm();
    }
    updateButton();
  }

  function unlock() {
    if (!ensure()) return;
    unlocked = true;
    if (ctx.state === "suspended") {
      ctx.resume().catch(function () {});
    }
    if (!muted && bgmWanted) startBgm();
  }

  function onFirstGesture() {
    unlock();
    if (!muted) {
      /* If we are on start or quiz, begin the loop. */
      var start = document.getElementById("view-start");
      var quiz = document.getElementById("view-question");
      var onPlayScreen =
        (start && !start.hidden) || (quiz && !quiz.hidden) || (!start && !quiz);
      if (onPlayScreen) startBgm();
    }
  }

  function init() {
    loadMute();
    updateButton();
    var btn = document.getElementById("btn-mute");
    if (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        unlock();
        setMuted(!muted);
      });
    }
    document.addEventListener("pointerdown", onFirstGesture, { capture: true, passive: true, once: true });
    document.addEventListener("keydown", onFirstGesture, { capture: true, once: true });
  }

  window.QuizAudio = {
    init: init,
    unlock: unlock,
    startBgm: startBgm,
    stopBgm: stopBgm,
    playBeep: playBeep,
    playClear: playClear,
    playFanfare: playFanfare,
    isMuted: function () {
      return muted;
    },
    setMuted: setMuted,
    updateButton: updateButton,
  };
})();
