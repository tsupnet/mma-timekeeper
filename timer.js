/* =========================================================
   MMA Timekeeper — how it works
   ---------------------------------------------------------
   TIMING METHOD: timestamp-based.
   The clocks never "count". When a clock starts, we note the
   moment from the device's forward-only clock (performance.now).
   Every screen refresh we subtract to get the exact time.
   A late or skipped refresh can't cause drift.
   ========================================================= */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const now = () => performance.now();

  /* ---------------- SETTINGS (saved on this device) ---------------- */
  const DEFAULTS = {
    roundSec: 300,      // 5:00
    rounds: 3,
    restSec: 60,        // 1:00
    warnSec: 10,        // warning time for every clock
    toMaxSec: 300,      // time-out limit 5:00
    toDir: "up",        // "up" or "down"
    soundOn: false,
    keepAwake: true,    // "Keep screen on" switch in Settings
    events: {
      roundWarn: { flash: true,  sound: "beep" },
      roundEnd:  { flash: false, sound: "buzzer" },
      restWarn:  { flash: true,  sound: "beep" },
      restEnd:   { flash: true,  sound: "buzzer" },
      toWarn:    { flash: true,  sound: "beep" },
      toMax:     { flash: true,  sound: "buzzer" }
    }
  };
  const EVENT_NAMES = {
    roundWarn: "Round: warning (last seconds)",
    roundEnd:  "Round: end (0:00)",
    restWarn:  "Break: warning (coaches out)",
    restEnd:   "Break: end (clock resets to 0:00)",
    toWarn:    "Time-out: warning before limit",
    toMax:     "Time-out: limit reached (clock holds)"
  };
  const NO_FLASH = { roundEnd: true, restEnd: true }; // these clocks reset, so nothing to flash

  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function load(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

  let cfg = JSON.parse(JSON.stringify(DEFAULTS));
  (function mergeSaved() {
    const saved = load("mmatk.settings");
    if (!saved) return;
    for (const k of Object.keys(DEFAULTS)) if (k !== "events" && saved[k] !== undefined) cfg[k] = saved[k];
    if (saved.events) for (const e of Object.keys(DEFAULTS.events)) if (saved.events[e]) Object.assign(cfg.events[e], saved.events[e]);
  })();
  const saveCfg = () => store("mmatk.settings", cfg);

  const ms = (s) => s * 1000;
  const roundMs = () => ms(cfg.roundSec);
  const restMs = () => ms(cfg.restSec);
  const toMaxMs = () => ms(cfg.toMaxSec);
  const warnMs = () => ms(cfg.warnSec);

  /* ---------------- CLOCK STATE ---------------- */
  // phase: ready | running | paused | timeout | rest | over
  const S = {
    phase: "ready",
    round: 1,
    mainRemain: roundMs(),  // used when the round clock is NOT running
    mainEndAt: 0,           // when running: the moment it will hit 0:00
    subKind: null,          // null | "timeout" | "rest"
    subStartAt: 0,          // moment the time-out / rest clock started
    fired: {}               // which alerts already went off (so each fires once)
  };

  function mainRemaining(t) {
    return S.phase === "running" ? Math.max(0, S.mainEndAt - t) : S.mainRemain;
  }
  function subElapsed(t) { return S.subKind ? Math.max(0, t - S.subStartAt) : 0; }

  /* Save the clock state so an accidental page reload doesn't lose the time.
     performance.now() restarts on reload, so we save wall-clock equivalents. */
  function saveState() {
    const t = now(), wall = Date.now();
    const toWall = (p) => wall - (t - p);
    store("mmatk.state", {
      phase: S.phase, round: S.round, mainRemain: S.mainRemain,
      mainEndWall: S.phase === "running" ? toWall(S.mainEndAt) : null,
      subKind: S.subKind, subStartWall: S.subKind ? toWall(S.subStartAt) : null,
      fired: S.fired, savedAt: wall
    });
  }
  function restoreState() {
    const st = load("mmatk.state");
    if (!st || Date.now() - st.savedAt > 3 * 3600 * 1000) return; // ignore if older than 3 hours
    const t = now(), wall = Date.now();
    const toPerf = (w) => t - (wall - w);
    S.phase = st.phase; S.round = st.round; S.mainRemain = st.mainRemain;
    if (st.mainEndWall != null) S.mainEndAt = toPerf(st.mainEndWall);
    S.subKind = st.subKind; if (st.subStartWall != null) S.subStartAt = toPerf(st.subStartWall);
    S.fired = st.fired || {};
  }

  /* ---------------- BUTTON ACTIONS ---------------- */
  function startRound() {
    S.subKind = null;
    S.phase = "running";
    S.mainEndAt = now() + S.mainRemain;
    S.fired = {};
  }

  function onMainButton() {
    const t = now();
    switch (S.phase) {
      case "ready": startRound(); break;
      case "running": return; // no pause: while running, this button only shows the round number
      case "paused": S.phase = "running"; S.mainEndAt = t + S.mainRemain; break;
      case "rest": S.mainRemain = roundMs(); startRound(); break; // Start pressed during the break: full round starts
      case "over": newFight(); break;
      default: return; // during time-out the main button is disabled
    }
    changed();
  }

  function onTimeoutButton() {
    const t = now();
    if (S.phase === "running" || S.phase === "paused") {
      // TIME-OUT: pause round clock, start time-out clock
      S.mainRemain = mainRemaining(t);
      S.phase = "timeout";
      S.subKind = "timeout";
      S.subStartAt = t;
      S.fired.toWarn = false; S.fired.toMax = false;
    } else if (S.phase === "timeout") {
      // TIME-IN: reset time-out clock, round clock resumes where it paused
      S.subKind = null;
      S.phase = "running";
      S.mainEndAt = t + S.mainRemain;
    } else return;
    changed();
  }

  // CHANGED Oct 5: << >> inside the round clock work in these phases only (not during the break or after the fight)
  const canAdjustTime = () => S.phase === "ready" || S.phase === "running" || S.phase === "paused" || S.phase === "timeout";
  // CHANGED Oct 5: round number arrows are locked while the round clock is running
  const canAdjustRound = () => S.phase !== "running";

  function adjustMain(deltaSec) {
    if (!canAdjustTime()) return;
    // CHANGED Oct 5: lowest is 0:01 (was 0:00), so rewinding can never end the round by accident
    const t = now(), d = ms(deltaSec), max = roundMs(), min = 1000;
    if (S.phase === "running") {
      const r = Math.min(max, Math.max(min, mainRemaining(t) + d));
      S.mainEndAt = t + r;
      if (r > warnMs()) S.fired.roundWarn = false;
    } else {
      S.mainRemain = Math.min(max, Math.max(min, S.mainRemain + d));
      if (S.mainRemain > warnMs()) S.fired.roundWarn = false;
    }
    changed();
  }

  // CHANGED Oct 5: PAUSE (II) freezes the round clock only. The time-out clock does not start.
  // Tapping again (play triangle) continues from the same time.
  function onPauseButton() {
    const t = now();
    if (S.phase === "running") {
      S.mainRemain = mainRemaining(t);
      S.phase = "paused";
    } else if (S.phase === "paused") {
      S.phase = "running";
      S.mainEndAt = t + S.mainRemain;
    } else return;
    changed();
  }

  function adjustRound(d) {
    if (!canAdjustRound()) return;
    S.round = Math.min(cfg.rounds, Math.max(1, S.round + d));
    if (S.phase === "over") { S.phase = "ready"; S.mainRemain = roundMs(); }
    changed();
  }
  function resetRound() {
    S.phase = "ready"; S.mainRemain = roundMs(); S.subKind = null; S.fired = {};
    changed();
  }
  function newFight() { S.round = 1; resetRound(); }

  /* ---------------- AUTOMATIC EVENTS (checked every refresh) ---------------- */
  function process(t) {
    // Round clock reached 0:00
    if (S.phase === "running" && S.mainEndAt - t <= 0) {
      const endedAt = S.mainEndAt;   // the exact moment it hit zero
      fire("roundEnd");
      if (S.round < cfg.rounds) {
        S.round += 1;
        S.phase = "rest";
        S.mainRemain = 0;            // round clock stays at 0:00 until the break ends
        S.subKind = "rest";
        S.subStartAt = endedAt;      // rest clock starts at that same moment
        S.fired = { roundEnd: true };
      } else {
        S.phase = "over";
        S.mainRemain = 0;
        S.subKind = null;
      }
      changed();
    }
    // Round warning
    if (S.phase === "running") {
      const r = S.mainEndAt - t;
      if (r > 0 && r <= warnMs() && !S.fired.roundWarn) { S.fired.roundWarn = true; fire("roundWarn"); }
    }
    // Break clock (between rounds)
    if (S.subKind === "rest") {
      const el = subElapsed(t);
      if (el >= restMs() - warnMs() && !S.fired.restWarn) { S.fired.restWarn = true; if (el < restMs()) fire("restWarn"); }
      if (el >= restMs() && !S.fired.restEnd) {
        // End of break: break clock resets to 0:00, round clock waits for Start
        S.fired.restEnd = true; fire("restEnd");
        S.subKind = null;
        if (S.phase === "rest") { S.phase = "ready"; S.mainRemain = roundMs(); } // round clock resets now
        changed();
      }
    }
    // Time-out clock
    if (S.subKind === "timeout") {
      const el = subElapsed(t);
      if (el >= toMaxMs() - warnMs() && !S.fired.toWarn) { S.fired.toWarn = true; if (el < toMaxMs()) fire("toWarn"); }
      if (el >= toMaxMs() && !S.fired.toMax) { S.fired.toMax = true; fire("toMax"); }
    }
  }

  /* ---------------- DRAWING THE SCREEN ---------------- */
  const CIRC_MAIN = 2 * Math.PI * 45;
  const CIRC_SUB = 2 * Math.PI * 43;
  const el = {
    mainRing: $("mainRing"), subRing: $("subRing"), mainTime: $("mainTime"), mainLabel: $("mainLabel"),
    subTime: $("subTime"), subLabel: $("subLabel"), subMode: $("subMode"),
    roundText: $("roundText"), roundDots: $("roundDots"),
    btnMain: $("btnMain"), btnTimeout: $("btnTimeout"),
    // CHANGED Oct 5: Adjust panel (adjNow, adjRound) removed; new arrow and pause buttons added
    btnPause: $("btnPause"), btnBack: $("btnBack"), btnFwd: $("btnFwd"),
    btnRoundDown: $("btnRoundDown"), btnRoundUp: $("btnRoundUp")
  };
  el.mainRing.style.strokeDasharray = CIRC_MAIN;
  el.subRing.style.strokeDasharray = CIRC_SUB;

  // Countdown shows 5:00 until a full second has passed, and 0:00 only at the end.
  function fmtDown(msLeft) { const s = Math.max(0, Math.ceil(msLeft / 1000 - 1e-6)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  function fmtUp(msEl) { const s = Math.max(0, Math.floor(msEl / 1000 + 1e-6)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  function fmtSec(sec) { return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); }
  // Break name follows the break length in Settings: 1Min-Break, 2Min-Break, 30Sec-Break, 1:30-Break
  function breakName() {
    const s = cfg.restSec;
    if (s % 60 === 0) return (s / 60) + "Min-Break";
    if (s < 60) return s + "Sec-Break";
    return fmtSec(s) + "-Break";
  }

  // Small text under the time-out / break clock: "Count Down" or "Count Up" (follows Settings)
  function dirText() { return cfg.toDir === "down" ? "Count Down" : "Count Up"; }

  function setText(node, txt) { if (node.textContent !== txt) node.textContent = txt; }
  function setCls(node, cls, on) { node.classList.toggle(cls, !!on); }

  let lastStaticKey = "";
  function drawStatic() {
    // parts that only change when a button is pressed
    const key = [S.phase, S.round, cfg.rounds, cfg.toDir, cfg.toMaxSec, cfg.restSec, S.subKind].join("|");
    if (key === lastStaticKey) return;
    lastStaticKey = key;

    // round counter + dots
    const shownRound = S.round;
    setText(el.roundText, "Round " + shownRound + " of " + cfg.rounds);
    let dots = "";
    if (cfg.rounds <= 15) for (let i = 1; i <= cfg.rounds; i++) {
      const done = i < shownRound || (S.phase === "over");
      dots += '<i class="' + (i === shownRound && S.phase !== "over" ? "now" : done ? "done" : "") + '"></i>';
    }
    el.roundDots.innerHTML = dots;

    // CHANGED Oct 5: round number arrows (locked while running; dimmed at round 1 / last round)
    el.btnRoundDown.disabled = !canAdjustRound() || S.round <= 1;
    el.btnRoundUp.disabled = !canAdjustRound() || S.round >= cfg.rounds;

    // CHANGED Oct 5: << II >> inside the round clock
    el.btnBack.disabled = el.btnFwd.disabled = !canAdjustTime();
    el.btnPause.disabled = !(S.phase === "running" || S.phase === "paused");
    el.btnPause.classList.toggle("paused", S.phase === "paused");
    el.btnPause.setAttribute("aria-label", S.phase === "paused" ? "Continue round clock" : "Pause round clock");

    // main button
    const b = el.btnMain;
    // While the round runs (or during a time-out, or paused) the green button shows the round number
    // CHANGED Oct 5: also while paused (resume with the play triangle inside the clock)
    const showRound = S.phase === "running" || S.phase === "timeout" || S.phase === "paused";
    b.disabled = showRound;
    b.classList.toggle("showround", showRound);
    setText(b, {
      ready: "Start Rd " + S.round, running: "Round " + S.round, paused: "Round " + S.round, // CHANGED Oct 5: was "Resume"
      timeout: "Round " + S.round, rest: "Start Rd " + S.round, over: "New Fight"
    }[S.phase]);

    // time-out button
    const tb = el.btnTimeout;
    tb.disabled = !(S.phase === "running" || S.phase === "paused" || S.phase === "timeout");
    tb.classList.toggle("timein", S.phase === "timeout");
    setText(tb, S.phase === "timeout" ? "Time-In" : "Time-Out");
  }

  function draw() {
    const t = now();
    process(t);
    drawStatic();

    // ----- main clock -----
    const r = mainRemaining(t);
    const inRound = S.phase === "running" || S.phase === "paused" || S.phase === "timeout";
    const mainWarn = inRound && r > 0 && r <= warnMs();
    setText(el.mainTime, fmtDown(r)); // CHANGED Oct 5: Adjust panel time display removed
    const frac = S.phase === "over" ? 0 : Math.min(1, r / roundMs());
    el.mainRing.style.strokeDashoffset = CIRC_MAIN * (1 - frac);
    setCls(el.mainRing, "hide", frac <= 0);
    setCls(el.mainRing, "warn", mainWarn);
    setCls(el.mainTime, "warn", mainWarn);
    const flashMain = mainWarn && S.phase === "running" && cfg.events.roundWarn.flash;
    setCls(el.mainTime, "flash", flashMain);
    setCls(el.mainRing, "flash", flashMain);

    // CHANGED Oct 5: during the red warning, "FIGHT IN PROGRESS" becomes "10-SEC WARNING"
    // (the number follows Warning time in Settings)
    const label = {
      ready: "READY", running: mainWarn ? cfg.warnSec + "-SEC WARNING" : "FIGHT IN PROGRESS", paused: "PAUSED", timeout: "TIME-OUT",
      rest: breakName(), over: "FIGHT OVER"
    }[S.phase];
    setText(el.mainLabel, label);
    el.mainLabel.className = "main-label" + (S.phase === "running" ? " long" : "") +
      (mainWarn ? " warn" : S.phase === "timeout" ? " to" : (S.phase === "ready" || S.phase === "paused" || S.phase === "over" || S.phase === "rest") ? " idle" : "");

    // ----- time-out / break clock -----
    let subTxt, subFrac, subWarn = false, subHold = false, subLbl, modeTxt, flashKey = null;
    if (S.subKind === "rest") {
      const e = Math.min(subElapsed(t), restMs());
      if (cfg.toDir === "down") { subTxt = fmtDown(restMs() - e); subFrac = 1 - e / restMs(); } // counts down to 0:00
      else { subTxt = fmtUp(e); subFrac = e / restMs(); }                                         // counts up
      subWarn = e >= restMs() - warnMs();
      flashKey = subWarn ? "restWarn" : null;
      subLbl = breakName(); modeTxt = dirText();
    } else if (S.subKind === "timeout") {
      const e = Math.min(subElapsed(t), toMaxMs());
      subHold = subElapsed(t) >= toMaxMs();
      subWarn = subHold || e >= toMaxMs() - warnMs();
      flashKey = subHold ? "toMax" : subWarn ? "toWarn" : null;
      if (cfg.toDir === "down") { subTxt = fmtDown(toMaxMs() - e); subFrac = 1 - e / toMaxMs(); }
      else { subTxt = fmtUp(e); subFrac = e / toMaxMs(); }
      subLbl = "TIME-OUT"; modeTxt = dirText();
    } else {
      subTxt = cfg.toDir === "down" ? fmtSec(cfg.toMaxSec) : "0:00";
      subFrac = cfg.toDir === "down" ? 1 : 0;
      subLbl = "TIME-OUT"; modeTxt = dirText();
    }
    const subIdle = !S.subKind;
    setText(el.subTime, subTxt); setText(el.subLabel, subLbl); setText(el.subMode, modeTxt);
    el.subRing.style.strokeDashoffset = CIRC_SUB * (1 - subFrac);
    setCls(el.subRing, "hide", subFrac <= 0 || subIdle && cfg.toDir !== "down");
    setCls(el.subRing, "warn", subWarn);
    setCls(el.subTime, "warn", subWarn); setCls(el.subLabel, "warn", subWarn);
    setCls(el.subLabel, "active", S.subKind === "timeout"); // CHANGED Oct 5: "TIME-OUT" turns white while the time-out clock runs
    setCls(el.subTime, "idle", subIdle);
    const flashSub = !!flashKey && cfg.events[flashKey].flash;
    setCls(el.subTime, "flash", flashSub); setCls(el.subRing, "flash", flashSub);
    el.subRing.style.opacity = subIdle ? ".35" : "";

    requestAnimationFrame(draw);
  }

  // When a button changes things: redraw buttons, save state, keep screen awake
  function changed() { lastStaticKey = ""; saveState(); }

  // Backup timer: browsers pause screen refreshes when hidden. This keeps
  // automatic events (round end, rest start) on time, and saves state.
  setInterval(() => { process(now()); }, 250);
  setInterval(saveState, 2000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { process(now()); keepAwake.refresh(); } else saveState(); });

  /* ---------------- SOUNDS ---------------- */
  let ctx = null;
  const buffers = {}; // custom sound id -> decoded audio
  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      // Ask iPhone/iPad to play even when the ring/silent switch is on (Safari 17+ only).
      try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {}
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }
  function tone(c, freq, start, dur, type, vol) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + 0.01);
    g.gain.setValueAtTime(vol, start + Math.max(0.02, dur - 0.05));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(c.destination);
    o.start(start); o.stop(start + dur + 0.02);
  }
  function bellStrike(c, start) {
    [[880, 0.5], [1320, 0.25], [2200, 0.12]].forEach(([f, v]) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(v, start);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 1.2);
      o.connect(g).connect(c.destination); o.start(start); o.stop(start + 1.25);
    });
  }
  const BUILT_IN = {
    beep:   { name: "Beep (3 short)", play(c) { const t = c.currentTime + 0.02; for (let i = 0; i < 3; i++) tone(c, 1000, t + i * 0.22, 0.14, "square", 0.25); } },
    buzzer: { name: "Buzzer (long)",  play(c) { const t = c.currentTime + 0.02; tone(c, 180, t, 1.3, "sawtooth", 0.35); tone(c, 182, t, 1.3, "square", 0.15); } },
    bell:   { name: "Bell (3 rings)", play(c) { const t = c.currentTime + 0.02; for (let i = 0; i < 3; i++) bellStrike(c, t + i * 0.35); } }
  };
  function playSoundId(id) {
    const c = audio(); if (!c) return;
    if (BUILT_IN[id]) { BUILT_IN[id].play(c); return; }
    const buf = buffers[id];
    if (buf) { const s = c.createBufferSource(); s.buffer = buf; s.connect(c.destination); s.start(); }
  }
  function fire(eventKey) {
    if (!cfg.soundOn) return;
    const snd = cfg.events[eventKey].sound;
    if (!snd || snd === "off") return;
    playSoundId(snd);
  }
  // Sounds can only start after a tap. Unlock audio on the first touch.
  document.addEventListener("pointerdown", () => { if (cfg.soundOn) audio(); }, { passive: true });

  /* ---------------- CUSTOM SOUNDS (saved on this device) ---------------- */
  let customSounds = []; // {id, name}
  function db() {
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error("no storage"));
      const r = indexedDB.open("mma-timekeeper", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("sounds", { keyPath: "id" });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function dbAll() {
    const d = await db();
    return new Promise((res, rej) => { const q = d.transaction("sounds").objectStore("sounds").getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  }
  async function dbPut(item) {
    const d = await db();
    return new Promise((res, rej) => { const tx = d.transaction("sounds", "readwrite"); tx.objectStore("sounds").put(item); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }
  async function dbDel(id) {
    const d = await db();
    return new Promise((res, rej) => { const tx = d.transaction("sounds", "readwrite"); tx.objectStore("sounds").delete(id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }
  async function decode(item) {
    const c = audio(); if (!c) return;
    const data = await item.blob.arrayBuffer();
    buffers[item.id] = await new Promise((res, rej) => c.decodeAudioData(data, res, rej));
  }
  async function loadCustomSounds() {
    try {
      const all = await dbAll();
      customSounds = all.map((s) => ({ id: s.id, name: s.name }));
      renderSoundList(); renderAlerts();
      for (const s of all) decode(s).catch(() => {});
    } catch (e) { customSounds = []; }
  }
  async function addCustomSound(blob, name) {
    const item = { id: "c" + Date.now(), name: name || "My sound", blob };
    try {
      await decode(item); // check it actually plays
    } catch (e) { msg("That file can't be played on this device. Try an MP3 or M4A."); return; }
    try { await dbPut(item); } catch (e) { msg("Couldn't save the sound on this device (storage blocked)."); }
    customSounds.push({ id: item.id, name: item.name });
    renderSoundList(); renderAlerts();
    msg("Saved “" + item.name + "”. Pick it in Alerts above.");
  }
  async function deleteCustomSound(id) {
    try { await dbDel(id); } catch (e) {}
    customSounds = customSounds.filter((s) => s.id !== id);
    delete buffers[id];
    for (const k of Object.keys(cfg.events)) if (cfg.events[k].sound === id) cfg.events[k].sound = "beep";
    saveCfg(); renderSoundList(); renderAlerts();
  }
  function msg(txt) { $("soundMsg").textContent = txt; }

  $("soundUpload").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) addCustomSound(f, f.name.replace(/\.[^.]+$/, "").slice(0, 40));
    e.target.value = "";
  });

  // Recording
  let rec = null, recTimer = null;
  $("btnRecord").addEventListener("click", async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      msg("Recording isn't available here. Upload a sound file instead. Recording works once the timer is on your own web address.");
      return;
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { msg("The microphone was blocked. Allow microphone access for this page, or upload a sound file instead."); return; }
    const chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      clearInterval(recTimer); $("recordBox").hidden = true; $("btnRecord").hidden = false;
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/mp4" });
      addCustomSound(blob, "Recording " + (customSounds.length + 1));
    };
    rec.start();
    const t0 = Date.now();
    $("recordBox").hidden = false; $("btnRecord").hidden = true;
    $("recordStatus").textContent = "Recording… 0s";
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      $("recordStatus").textContent = "Recording… " + s + "s";
      if (s >= 10 && rec.state === "recording") rec.stop(); // 10 second limit
    }, 200);
  });
  $("btnRecordStop").addEventListener("click", () => { if (rec && rec.state === "recording") rec.stop(); });

  function renderSoundList() {
    const box = $("soundList");
    if (!customSounds.length) { box.innerHTML = '<p class="hint">No custom sounds yet.</p>'; return; }
    box.innerHTML = "";
    for (const s of customSounds) {
      const row = document.createElement("div"); row.className = "sound-item";
      const n = document.createElement("span"); n.className = "sname"; n.textContent = s.name;
      const p = document.createElement("button"); p.type = "button"; p.textContent = "Play"; p.onclick = () => playSoundId(s.id);
      const d = document.createElement("button"); d.type = "button"; d.textContent = "Delete";
      d.onclick = () => { if (d.dataset.armed) deleteCustomSound(s.id); else { d.dataset.armed = "1"; d.textContent = "Tap again"; setTimeout(() => { d.textContent = "Delete"; delete d.dataset.armed; }, 3000); } };
      row.append(n, p, d); box.append(row);
    }
  }

  /* ---------------- KEEP THE SCREEN ON ---------------- */
  const keepAwake = (function () {
    let lock = null, video = null, wanted = false, mode = "off";
    function makeVideo() {
      if (video || !window.KEEPAWAKE_MEDIA) return video;
      video = document.createElement("video");
      video.setAttribute("playsinline", ""); video.setAttribute("muted", ""); video.muted = true;
      video.setAttribute("title", "keep awake"); video.loop = true;
      video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0";
      for (const [type, src] of [["webm", KEEPAWAKE_MEDIA.webm], ["mp4", KEEPAWAKE_MEDIA.mp4]]) {
        const s = document.createElement("source"); s.src = src; s.type = "video/" + type; video.appendChild(s);
      }
      video.addEventListener("timeupdate", () => { if (video.duration > 1 && video.currentTime > 0.5) video.currentTime = Math.random() * 0.5; });
      document.body.appendChild(video);
      return video;
    }
    async function tryNative() {
      if (!("wakeLock" in navigator)) return false;
      try {
        lock = await navigator.wakeLock.request("screen");
        lock.addEventListener("release", () => { lock = null; if (mode === "native") mode = "off"; update(); });
        mode = "native"; return true;
      } catch (e) { return false; }
    }
    async function tryVideo() {
      const v = makeVideo(); if (!v) return false;
      try { await v.play(); mode = "video"; return true; } catch (e) { return false; }
    }
    async function enable() {  // call from a tap
      if (!cfg.keepAwake) { update(); return; }   // switch is off in Settings
      wanted = true;
      if (lock || (mode === "video" && video && !video.paused)) { update(); return; }
      if (!(await tryNative())) await tryVideo();
      update();
    }
    function disable() {  // switch turned off: let the phone sleep normally
      wanted = false;
      if (lock) { try { lock.release(); } catch (e) {} lock = null; }
      if (video && !video.paused) video.pause();
      mode = "off"; update();
    }
    function refresh() { if (wanted && !document.hidden) enable(); }
    function update() {
      // Status shown under the "Keep screen on" switch in Settings
      const on = mode === "native" ? !!lock : mode === "video" ? !!(video && !video.paused) : false;
      $("screenStatus").textContent = !cfg.keepAwake
        ? "Off: the phone will sleep normally."
        : on
          ? (mode === "native" ? "On: the screen is being kept on." : "On: the screen is being kept on (backup method).")
          : wanted
            ? "This device isn't confirming the screen will stay on. Set Auto-Lock to Never (iPhone/iPad) or a long Screen timeout (Android)."
            : "Turns on when you tap Start.";
    }
    return { enable, disable, refresh, update, isOn: () => mode !== "off" };
  })();

  /* ---------------- AUTO-LOCK REMINDER (iPhone / iPad) ---------------- */
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const today = new Date().toDateString();
  function showReminder() { $("reminder").hidden = false; }
  if (isIOS && cfg.keepAwake && load("mmatk.remindOff") !== today) showReminder();
  $("remDone").addEventListener("click", () => {
    if ($("remToday").checked) store("mmatk.remindOff", today);
    $("reminder").hidden = true;
    keepAwake.enable();
    if (cfg.soundOn) audio();
  });
  $("btnShowReminder").addEventListener("click", () => { $("settingsSheet").hidden = true; showReminder(); });

  /* ---------------- WIRING BUTTONS ---------------- */
  $("btnMain").addEventListener("click", () => { keepAwake.enable(); onMainButton(); });
  $("btnTimeout").addEventListener("click", () => { keepAwake.enable(); onTimeoutButton(); });
  // CHANGED Oct 5: Adjust button removed. New buttons:
  el.btnPause.addEventListener("click", () => { keepAwake.enable(); onPauseButton(); });
  el.btnRoundDown.addEventListener("click", () => adjustRound(-1));
  el.btnRoundUp.addEventListener("click", () => adjustRound(1));

  // << >> inside the round clock: quick tap = 1 second; press and hold = 10 seconds per step until released
  function holdButton(btn, dir) {
    const HOLD_START = 450, HOLD_REPEAT = 400; // milliseconds
    let startT = null, repeatT = null, held = false, active = false;
    function stop() { clearTimeout(startT); clearInterval(repeatT); startT = repeatT = null; active = false; }
    btn.addEventListener("pointerdown", (e) => {
      if (btn.disabled) return;
      active = true; held = false;
      try { btn.setPointerCapture(e.pointerId); } catch (err) {}
      startT = setTimeout(() => {
        held = true; adjustMain(dir * 10);
        repeatT = setInterval(() => { if (btn.disabled) stop(); else adjustMain(dir * 10); }, HOLD_REPEAT);
      }, HOLD_START);
    });
    btn.addEventListener("pointerup", () => {
      const wasTap = active && !held;
      stop();
      if (wasTap) adjustMain(dir * 1);
    });
    btn.addEventListener("pointercancel", stop);
    btn.addEventListener("lostpointercapture", () => { if (held) stop(); });
    btn.addEventListener("contextmenu", (e) => e.preventDefault()); // no long-press menu
    btn.addEventListener("click", (e) => { if (e.detail === 0) adjustMain(dir * 1); }); // keyboard Enter/Space
  }
  holdButton(el.btnBack, 1);   // CHANGED Oct 5: << adds time (clock number gets larger)
  holdButton(el.btnFwd, -1);   // CHANGED Oct 5: >> takes time off (clock number gets smaller)

  $("openSettings").addEventListener("click", () => { fillSettings(); $("settingsSheet").hidden = false; });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => { $(b.dataset.close).hidden = true; }));
  document.querySelectorAll(".sheet").forEach((sh) => sh.addEventListener("click", (e) => { if (e.target === sh && sh.id !== "reminder") sh.hidden = true; }));

  // Two-tap confirm for resets
  // First tap arms the button (turns red); second tap within 3 seconds does it.
  function armed(btn, action, confirmText, doneText) {
    let t = null;
    btn.addEventListener("click", () => {
      btn.dataset.label = btn.dataset.label || btn.textContent;
      if (btn.classList.contains("armed")) {
        clearTimeout(t); btn.classList.remove("armed"); btn.textContent = btn.dataset.label;
        action(); toast(doneText || "Done"); return; // CHANGED Oct 5: no Adjust panel to close
      }
      btn.classList.add("armed"); btn.textContent = confirmText || "Tap again to confirm";
      clearTimeout(t);
      t = setTimeout(() => { btn.classList.remove("armed"); btn.textContent = btn.dataset.label; }, 3000);
    });
  }
  // CHANGED Oct 5: "Reset this round" and "Reset whole fight" (Adjust panel) removed
  // RESET button: start over, back to Round 1, both clocks cleared
  armed($("btnReset"), newFight, "Sure?", "Reset to Round 1");

  let toastT = null;
  function toast(txt) { const t = $("toast"); t.textContent = txt; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 1600); }

  /* ---------------- SETTINGS SCREEN ---------------- */
  function clampInt(v, lo, hi) { v = parseInt(v, 10); if (isNaN(v)) v = lo; return Math.min(hi, Math.max(lo, v)); }
  function setDurInputs(minId, secId, total) { $(minId).value = Math.floor(total / 60); $(secId).value = total % 60; }
  function readDur(minId, secId, minTotal) { return Math.max(minTotal, clampInt($(minId).value, 0, 59) * 60 + clampInt($(secId).value, 0, 59)); }

  function fillSettings() {
    const preset = cfg.roundSec === 180 || cfg.roundSec === 300;
    document.querySelectorAll("#segRound button").forEach((b) => b.classList.toggle("on", preset ? +b.dataset.roundLen === cfg.roundSec : b.dataset.roundLen === "custom"));
    $("customRoundRow").hidden = preset;
    setDurInputs("roundMin", "roundSec", cfg.roundSec);
    $("rounds").value = cfg.rounds;
    setDurInputs("restMin", "restSec", cfg.restSec);
    $("warnSec").value = cfg.warnSec;
    document.querySelectorAll("#segDir button").forEach((b) => b.classList.toggle("on", b.dataset.dir === cfg.toDir));
    setDurInputs("toMin", "toSec", cfg.toMaxSec);
    $("soundOn").checked = cfg.soundOn;
    $("keepAwakeOn").checked = cfg.keepAwake;
    renderAlerts(); renderSoundList(); keepAwake.update();
  }

  function applyRoundLen(sec) {
    cfg.roundSec = sec; saveCfg();
    if (S.phase === "ready") { S.mainRemain = roundMs(); changed(); }
    else if (S.phase !== "over") toast("New round length starts next round");
  }
  document.querySelectorAll("#segRound button").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.roundLen === "custom") {
      document.querySelectorAll("#segRound button").forEach((x) => x.classList.toggle("on", x === b));
      $("customRoundRow").hidden = false; return;
    }
    applyRoundLen(+b.dataset.roundLen); fillSettings();
  }));
  ["roundMin", "roundSec"].forEach((id) => $(id).addEventListener("change", () => { applyRoundLen(readDur("roundMin", "roundSec", 10)); setDurInputs("roundMin", "roundSec", cfg.roundSec); }));
  ["restMin", "restSec"].forEach((id) => $(id).addEventListener("change", () => { cfg.restSec = readDur("restMin", "restSec", 10); saveCfg(); setDurInputs("restMin", "restSec", cfg.restSec); changed(); }));
  ["toMin", "toSec"].forEach((id) => $(id).addEventListener("change", () => { cfg.toMaxSec = readDur("toMin", "toSec", 10); saveCfg(); setDurInputs("toMin", "toSec", cfg.toMaxSec); changed(); }));
  $("rounds").addEventListener("change", () => { cfg.rounds = clampInt($("rounds").value, 1, 15); $("rounds").value = cfg.rounds; if (S.round > cfg.rounds) S.round = cfg.rounds; saveCfg(); changed(); });
  $("warnSec").addEventListener("change", () => { cfg.warnSec = clampInt($("warnSec").value, 1, 60); $("warnSec").value = cfg.warnSec; saveCfg(); });
  document.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
    const inp = $(b.dataset.step); inp.value = (+inp.value || 0) + (+b.dataset.d); inp.dispatchEvent(new Event("change"));
  }));
  document.querySelectorAll("#segDir button").forEach((b) => b.addEventListener("click", () => {
    cfg.toDir = b.dataset.dir; saveCfg(); fillSettings(); changed();
  }));
  $("soundOn").addEventListener("change", () => { cfg.soundOn = $("soundOn").checked; saveCfg(); if (cfg.soundOn) audio(); });
  $("keepAwakeOn").addEventListener("change", () => {
    cfg.keepAwake = $("keepAwakeOn").checked; saveCfg();
    if (cfg.keepAwake) keepAwake.enable(); else keepAwake.disable();
  });

  function renderAlerts() {
    const box = $("alertTable"); box.innerHTML = "";
    const options = [["off", "No sound"]].concat(Object.keys(BUILT_IN).map((k) => [k, BUILT_IN[k].name]), customSounds.map((s) => [s.id, "★ " + s.name]));
    for (const key of Object.keys(EVENT_NAMES)) {
      const ev = cfg.events[key];
      const row = document.createElement("div"); row.className = "alert-row";
      const name = document.createElement("div"); name.className = "name"; name.textContent = EVENT_NAMES[key];
      const ctrls = document.createElement("div"); ctrls.className = "ctrls";
      if (NO_FLASH[key]) { const na = document.createElement("span"); na.className = "na"; na.textContent = "No flash (clock resets)"; ctrls.append(na); }
      else {
        const lab = document.createElement("label"); lab.className = "check";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = ev.flash; cb.id = "flash-" + key;
        cb.onchange = () => { ev.flash = cb.checked; saveCfg(); };
        lab.append(cb, document.createTextNode(" Flash")); ctrls.append(lab);
      }
      const sel = document.createElement("select"); sel.id = "sound-" + key; sel.setAttribute("aria-label", EVENT_NAMES[key] + " sound");
      for (const [v, n] of options) { const o = document.createElement("option"); o.value = v; o.textContent = n; sel.append(o); }
      sel.value = options.some((o) => o[0] === ev.sound) ? ev.sound : "off";
      sel.onchange = () => { ev.sound = sel.value; saveCfg(); };
      const test = document.createElement("button"); test.type = "button"; test.className = "test"; test.textContent = "Test";
      test.onclick = () => { if (sel.value !== "off") playSoundId(sel.value); };
      ctrls.append(sel, test);
      row.append(name, ctrls); box.append(row);
    }
  }

  /* ---------------- START UP ---------------- */
  restoreState();
  if (S.phase === "ready") S.mainRemain = roundMs();
  keepAwake.update();
  loadCustomSounds();
  requestAnimationFrame(draw);

  // Offline support (only works when hosted on your own web address)
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    try { navigator.serviceWorker.register("sw.js").catch(() => {}); } catch (e) {}
  }
})();
