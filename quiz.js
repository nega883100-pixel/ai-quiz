(function () {
  "use strict";

  const state = {
    config: null,
    mode: "full",
    questions: [],
    index: 0,
    answers: [],
    draft: null,
    idleTimer: null,
    idleEndsAt: 0,
    tickTimer: null,
    advancing: false,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function audio() {
    return window.QuizAudio || null;
  }

  function show(id) {
    $$(".view").forEach((v) => {
      v.hidden = v.id !== id;
    });
    document.body.setAttribute("data-view", id.replace(/^view-/, ""));
  }

  function fmtTemplate(tpl, vars) {
    return String(tpl || "").replace(/\{(\w+)\}/g, (_, k) =>
      vars[k] != null ? String(vars[k]) : ""
    );
  }

  function formatCount(n) {
    return Number(n).toLocaleString("en-US");
  }

  function formatPercent(n) {
    const x = Number(n);
    return Number.isInteger(x) ? String(x) : x.toFixed(1);
  }

  function formatScore(n) {
    const x = Number(n);
    if (!isFinite(x)) return "—";
    return Math.abs(x - Math.round(x)) < 1e-9 ? String(Math.round(x)) : x.toFixed(1);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function qType(q) {
    return (q && q.type) || "single";
  }

  function scoreByCount(count, bands) {
    const list = bands || [];
    for (let i = 0; i < list.length; i++) {
      if (count <= list[i].max) return list[i].score;
    }
    return list.length ? list[list.length - 1].score : 1;
  }

  function scoreMulti(q, ids) {
    const exclusive = q.exclusiveId || "none";
    const picked = (ids || []).filter((id) => id && id !== exclusive);
    if (!ids || !ids.length) return { score: null, ids: [] };
    if (ids.length === 1 && ids[0] === exclusive) {
      return { score: scoreByCount(0, q.scoreByCount), ids: [exclusive] };
    }
    return { score: scoreByCount(picked.length, q.scoreByCount), ids: picked.slice() };
  }

  function scoreMatrix(q, values) {
    const rows = q.rows || [];
    const vals = values || {};
    const nums = [];
    for (let i = 0; i < rows.length; i++) {
      const v = vals[rows[i].id];
      if (typeof v !== "number") return { score: null, values: Object.assign({}, vals), complete: false };
      nums.push(v);
    }
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    return { score: avg, values: Object.assign({}, vals), complete: true };
  }

  function answerScore(a) {
    if (a == null) return null;
    if (typeof a === "number") return a;
    if (typeof a.score === "number") return a.score;
    return null;
  }

  function hasAnswer(i) {
    return answerScore(state.answers[i]) != null;
  }

  function resolveLevel(avg, levels) {
    const list = levels || [];
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      const min = l.minAvg != null ? l.minAvg : -Infinity;
      const max = l.maxAvg != null ? l.maxAvg : Infinity;
      if (avg >= min && avg < max) return l;
    }
    return list[list.length - 1] || null;
  }

  function dimensionAverages(answers, questions, dimensions) {
    const groups = {};
    (dimensions || []).forEach((d) => {
      groups[d.id] = { id: d.id, name: d.name, scores: [] };
    });
    questions.forEach((q, i) => {
      const sc = answerScore(answers[i]);
      if (sc == null) return;
      const id = q.dimensionId || q.dimension;
      if (!groups[id]) groups[id] = { id: id, name: q.dimension, scores: [] };
      groups[id].name = q.dimension || groups[id].name;
      groups[id].scores.push(sc);
    });
    const result = [];
    Object.keys(groups).forEach((id) => {
      const g = groups[id];
      if (!g.scores.length) return;
      const avg = g.scores.reduce((a, b) => a + b, 0) / g.scores.length;
      result.push({ id: g.id, name: g.name, average: avg, count: g.scores.length });
    });
    return result;
  }

  function overallAverage(answers) {
    const nums = (answers || []).map(answerScore).filter((s) => s != null);
    if (!nums.length) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  function weakestDimensions(answers, questions, dimensions) {
    const dims = dimensionAverages(answers, questions, dimensions);
    if (!dims.length) return { names: [], balanced: true };
    const min = Math.min.apply(null, dims.map((d) => d.average));
    const max = Math.max.apply(null, dims.map((d) => d.average));
    if (Math.abs(max - min) < 1e-9) return { names: [], balanced: true, min: min };
    return {
      names: dims.filter((d) => Math.abs(d.average - min) < 1e-9).map((d) => d.name),
      balanced: false,
      min: min,
    };
  }

  async function loadConfig() {
    try {
      const res = await fetch("questions.json", { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch (err) {
      /* file:// or offline: fall back to the copy embedded in index.html */
    }
    const el = document.getElementById("quiz-config");
    if (el && el.textContent.trim()) return JSON.parse(el.textContent);
    throw new Error("無法載入題目設定");
  }

  function setBackground(kind) {
    const bg = $("#bg");
    bg.style.backgroundImage = "url('assets/img/island.png')";
    bg.classList.toggle("dim", kind !== "start");
  }

  function questionsFor(mode) {
    const cfg = state.config;
    if (mode === "quick") return (cfg.quickQuestions || []).slice();
    return (cfg.questions || []).slice();
  }

  function goStart() {
    clearIdle();
    state.index = 0;
    state.answers = [];
    state.draft = null;
    state.advancing = false;
    state.questions = [];
    state.mode = "full";
    setBackground("start");
    show("view-start");
    if (audio()) audio().startBgm();
    const btn = $("#btn-start-full") || $("#btn-start");
    if (btn) btn.focus();
  }

  function startQuiz(mode) {
    state.mode = mode === "quick" ? "quick" : "full";
    state.questions = questionsFor(state.mode);
    state.index = 0;
    state.answers = [];
    state.draft = null;
    state.advancing = false;
    if (audio()) audio().startBgm();
    renderQuestion();
  }

  function restoreDraft(q, existing) {
    const t = qType(q);
    if (!existing) {
      if (t === "multi") return { type: "multi", ids: [] };
      if (t === "matrix") return { type: "matrix", values: {} };
      return { type: "single", score: null };
    }
    if (t === "multi") return { type: "multi", ids: (existing.ids || []).slice() };
    if (t === "matrix") return { type: "matrix", values: Object.assign({}, existing.values || {}) };
    return { type: "single", score: answerScore(existing), optionIndex: existing.optionIndex };
  }

  function draftValid(q, draft) {
    const t = qType(q);
    if (t === "single") return draft && typeof draft.score === "number";
    if (t === "multi") {
      const r = scoreMulti(q, draft && draft.ids);
      return r.score != null && r.ids.length > 0;
    }
    if (t === "matrix") {
      const r = scoreMatrix(q, draft && draft.values);
      return !!(r && r.complete);
    }
    return false;
  }

  function commitDraft(q, draft) {
    const t = qType(q);
    if (t === "single") {
      return { type: "single", score: draft.score, optionIndex: draft.optionIndex };
    }
    if (t === "multi") {
      const r = scoreMulti(q, draft.ids);
      return { type: "multi", ids: r.ids, score: r.score };
    }
    if (t === "matrix") {
      const r = scoreMatrix(q, draft.values);
      return { type: "matrix", values: r.values, score: r.score };
    }
    return draft;
  }

  function renderQuestion() {
    clearIdle();
    state.advancing = false;
    const cfg = state.config;
    const q = state.questions[state.index];
    const total = state.questions.length;
    const current = state.index + 1;
    const existing = state.answers[state.index];
    state.draft = restoreDraft(q, existing);
    const t = qType(q);

    setBackground("question");
    document.body.setAttribute("data-qtype", t);

    $("#progress-label").textContent = fmtTemplate(cfg.meta.progressTemplate, {
      current: current,
      total: total,
    });
    const modeTag = $("#mode-tag");
    if (modeTag) {
      modeTag.textContent =
        state.mode === "quick" ? cfg.meta.modeQuickTag || "快速闖關" : cfg.meta.modeFullTag || "完整挑戰";
    }
    const segs = $("#progress");
    segs.innerHTML = "";
    segs.setAttribute("aria-hidden", "true");
    for (let i = 0; i < total; i++) {
      const s = document.createElement("span");
      if (hasAnswer(i)) s.classList.add("on");
      if (i === state.index) s.classList.add("now");
      segs.appendChild(s);
    }
    $("#dim-name").textContent = fmtTemplate(cfg.meta.dimensionTemplate || "構面：{name}", {
      name: q.dimension,
    });

    const badge = $("#multi-badge");
    if (badge) {
      if (t === "multi") {
        badge.hidden = false;
        badge.textContent = cfg.meta.multiLabel || "可複選";
      } else if (t === "matrix") {
        badge.hidden = false;
        badge.textContent = cfg.meta.matrixHint || "請逐項點選";
      } else {
        badge.hidden = true;
        badge.textContent = "";
      }
    }
    $("#prompt").textContent = q.prompt;

    const box = $("#options");
    box.innerHTML = "";
    box.className = "options" + (t === "matrix" ? " is-matrix" : t === "multi" ? " is-multi" : "");
    if (t === "matrix") {
      renderMatrix(box, q, state.draft);
    } else if (t === "multi") {
      renderMulti(box, q, state.draft);
    } else {
      renderSingle(box, q, state.draft);
    }

    updateNav();
    show("view-question");
    const sheet = $("#view-question .sheet");
    if (sheet) sheet.scrollTop = 0;
    const optsScroll = box;
    if (optsScroll) optsScroll.scrollTop = 0;
  }

  function renderSingle(box, q, draft) {
    (q.options || []).forEach((opt, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      const letter = String.fromCharCode(65 + i);
      b.setAttribute("data-letter", letter);
      b.setAttribute("data-index", String(i));
      if (draft && draft.score === opt.score && (draft.optionIndex == null || draft.optionIndex === i)) {
        b.classList.add("is-picked");
      }
      b.innerHTML =
        '<span class="num">' +
        letter +
        '</span><span class="txt">' +
        escapeHtml(opt.label) +
        "</span>";
      b.addEventListener("click", function () {
        pickSingle(b, opt.score, i);
      });
      box.appendChild(b);
    });
  }

  function renderMulti(box, q, draft) {
    const ids = (draft && draft.ids) || [];
    (q.options || []).forEach((opt, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt opt-multi";
      const letter = String.fromCharCode(65 + i);
      b.setAttribute("data-letter", letter);
      b.setAttribute("data-id", opt.id);
      b.setAttribute("aria-pressed", ids.indexOf(opt.id) >= 0 ? "true" : "false");
      if (ids.indexOf(opt.id) >= 0) b.classList.add("is-picked");
      if (opt.exclusive) b.classList.add("is-exclusive");
      b.innerHTML =
        '<span class="chk" aria-hidden="true"></span><span class="num">' +
        letter +
        '</span><span class="txt">' +
        escapeHtml(opt.label) +
        "</span>";
      b.addEventListener("click", function () {
        toggleMulti(opt.id);
      });
      box.appendChild(b);
    });
  }

  function renderMatrix(box, q, draft) {
    const values = (draft && draft.values) || {};
    const wrap = document.createElement("div");
    wrap.className = "matrix";
    const head = document.createElement("div");
    head.className = "matrix-head";
    head.innerHTML =
      '<div class="mh-name">系統</div>' +
      (q.columns || [])
        .map(function (c) {
          return (
            '<div class="mh-col"><span class="full">' +
            escapeHtml(c.label) +
            '</span><span class="short">' +
            escapeHtml(c.short || c.label) +
            "</span></div>"
          );
        })
        .join("");
    wrap.appendChild(head);

    (q.rows || []).forEach(function (row) {
      const r = document.createElement("div");
      r.className = "matrix-row";
      if (typeof values[row.id] === "number") r.classList.add("is-done");
      const name = document.createElement("div");
      name.className = "mr-name";
      name.textContent = row.label;
      r.appendChild(name);
      const cells = document.createElement("div");
      cells.className = "mr-cells";
      (q.columns || []).forEach(function (col) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "mr-cell";
        b.setAttribute("aria-label", row.label + "：" + col.label);
        b.setAttribute("aria-pressed", values[row.id] === col.score ? "true" : "false");
        if (values[row.id] === col.score) b.classList.add("is-picked");
        b.innerHTML = '<span class="dot"></span><span class="cl">' + escapeHtml(col.short || col.label) + "</span>";
        b.addEventListener("click", function () {
          pickMatrix(row.id, col.score);
        });
        cells.appendChild(b);
      });
      r.appendChild(cells);
      wrap.appendChild(r);
    });
    box.appendChild(wrap);
  }

  function updateNav() {
    const cfg = state.config;
    const q = state.questions[state.index];
    const t = qType(q);
    const prev = $("#btn-prev");
    const next = $("#btn-next");
    const valid = draftValid(q, state.draft);
    if (prev) {
      prev.disabled = state.index === 0;
      prev.textContent = cfg.meta.prevLabel || "◀ 上一題";
    }
    if (next) {
      next.disabled = !valid;
      if (t === "multi" || t === "matrix") {
        next.textContent = cfg.meta.confirmLabel || "確認 ▶";
        next.classList.add("is-confirm");
      } else {
        next.textContent = cfg.meta.nextLabel || "下一題 ▶";
        next.classList.remove("is-confirm");
      }
    }
  }

  function pickSingle(btn, score, optionIndex) {
    if (state.advancing) return;
    $$(".opt").forEach((el) => el.classList.remove("is-picked"));
    if (btn) btn.classList.add("is-picked");
    state.draft = { type: "single", score: score, optionIndex: optionIndex };
    state.answers[state.index] = commitDraft(state.questions[state.index], state.draft);
    const next = $("#btn-next");
    if (next) next.disabled = false;
    if (audio()) audio().playBeep();
    state.advancing = true;
    window.setTimeout(function () {
      goNext(true);
    }, 160);
  }

  function toggleMulti(id) {
    if (state.advancing) return;
    const q = state.questions[state.index];
    const exclusive = q.exclusiveId || "none";
    const opt = (q.options || []).find((o) => o.id === id);
    let ids = ((state.draft && state.draft.ids) || []).slice();
    const on = ids.indexOf(id) >= 0;
    if (opt && (opt.exclusive || id === exclusive)) {
      ids = on ? [] : [id];
    } else {
      ids = ids.filter((x) => x !== exclusive);
      if (on) ids = ids.filter((x) => x !== id);
      else ids.push(id);
    }
    state.draft = { type: "multi", ids: ids };
    $$(".opt-multi").forEach(function (el) {
      const picked = ids.indexOf(el.getAttribute("data-id")) >= 0;
      el.classList.toggle("is-picked", picked);
      el.setAttribute("aria-pressed", picked ? "true" : "false");
    });
    if (audio()) audio().playBeep();
    updateNav();
  }

  function pickMatrix(rowId, score) {
    if (state.advancing) return;
    const values = Object.assign({}, (state.draft && state.draft.values) || {});
    values[rowId] = score;
    state.draft = { type: "matrix", values: values };
    $$(".matrix-row").forEach(function (rowEl) {
      const name = $(".mr-name", rowEl);
      /* match by rebuilding pressed state from values via buttons' labels is fragile;
         just re-render is safer but would lose scroll. Update cells by row order. */
    });
    /* Update UI in place */
    const q = state.questions[state.index];
    const rows = $$(".matrix-row");
    (q.rows || []).forEach(function (row, ri) {
      const rowEl = rows[ri];
      if (!rowEl) return;
      rowEl.classList.toggle("is-done", typeof values[row.id] === "number");
      const cells = $$(".mr-cell", rowEl);
      (q.columns || []).forEach(function (col, ci) {
        const cell = cells[ci];
        if (!cell) return;
        const on = values[row.id] === col.score;
        cell.classList.toggle("is-picked", on);
        cell.setAttribute("aria-pressed", on ? "true" : "false");
      });
    });
    if (audio()) audio().playBeep();
    updateNav();
  }

  function goPrev() {
    if (state.advancing) return;
    if (state.index <= 0) return;
    state.index -= 1;
    renderQuestion();
  }

  function goNext(fromPick) {
    const q = state.questions[state.index];
    if (!draftValid(q, state.draft) && !hasAnswer(state.index)) {
      state.advancing = false;
      return;
    }
    if (draftValid(q, state.draft)) {
      state.answers[state.index] = commitDraft(q, state.draft);
    }
    if (!hasAnswer(state.index)) {
      state.advancing = false;
      return;
    }
    const last = state.questions.length - 1;
    if (state.index >= last) {
      if (audio() && (fromPick || qType(q) !== "single" || true)) {
        if (audio().playClear) audio().playClear();
      }
      renderResult();
      return;
    }
    state.index += 1;
    renderQuestion();
  }

  function renderQR(url, img) {
    const src = (url || "").trim();
    if (src && typeof qrcode === "function") {
      try {
        const qr = qrcode(0, "M");
        qr.addData(src);
        qr.make();
        img.src = qr.createDataURL(6, 2);
        img.alt = "輔導諮詢 QR 碼";
        return;
      } catch (err) {
        /* fall through to placeholder */
      }
    }
    img.src = "assets/img/qr_placeholder.png";
    img.alt = "輔導諮詢 QR 碼預留位置";
  }

  function computeResult(answers, questions, cfg) {
    const avg = overallAverage(answers);
    const level = resolveLevel(avg, cfg.levels);
    const dims = dimensionAverages(answers, questions, cfg.dimensions);
    const weak = weakestDimensions(answers, questions, cfg.dimensions);
    const total = (answers || []).map(answerScore).reduce((a, b) => a + (b || 0), 0);
    return { average: avg, level: level, dimensions: dims, weak: weak, total: total };
  }

  function renderResult() {
    const cfg = state.config;
    const result = computeResult(state.answers, state.questions, cfg);
    const level = result.level;
    const weak = result.weak;

    if (audio()) {
      audio().stopBgm();
      window.setTimeout(function () {
        if (audio()) audio().playFanfare();
      }, 450);
    }

    setBackground("result");
    const honor = (cfg.meta.resultHeadlinePrefix || "你的稱號：") + (level ? level.title : "—");
    $("#honor").textContent = honor;
    $("#official").textContent = level ? level.officialName : "";
    $("#flavor").textContent = level ? level.flavor : "";
    $("#desc").textContent = level ? level.description : "";

    const percent = level ? formatPercent(level.nationalPercent) : "—";
    const count = level ? formatCount(level.nationalCount) : "";
    $("#national").textContent =
      fmtTemplate(cfg.meta.nationalTemplate, { percent: percent }) +
      fmtTemplate(cfg.meta.nationalCountTemplate, { count: count });

    const portrait = $("#portrait");
    const caption = $("#portrait-caption");
    if (portrait) {
      portrait.src = level && level.portrait ? level.portrait : "assets/img/hero.png";
      portrait.alt = level ? level.title : "";
    }
    if (caption) caption.textContent = level ? level.title : "";

    const bars = $("#bars");
    bars.innerHTML = "";
    const weakSet = new Set(weak.names);
    result.dimensions.forEach((d) => {
      const sc = d.average;
      const row = document.createElement("div");
      row.className = "bar-row";
      const isWeak = weakSet.has(d.name);
      row.innerHTML =
        '<div class="bar-name' +
        (isWeak ? " is-weak" : "") +
        '">' +
        escapeHtml(d.name) +
        '</div><div class="bar-track"><div class="bar-fill' +
        (isWeak ? " weak" : "") +
        '" style="width:0%"></div></div><div class="bar-score">' +
        formatScore(sc) +
        "/5</div>";
      bars.appendChild(row);
      const fill = row.querySelector(".bar-fill");
      window.requestAnimationFrame(function () {
        fill.style.width = (sc / 5) * 100 + "%";
      });
    });

    const weakBox = $("#weak-box");
    if (weak.balanced) {
      weakBox.textContent = cfg.meta.weakBalanced;
    } else {
      weakBox.textContent = cfg.meta.weakLabel + weak.names.join("、");
    }

    $("#recommend-lab").textContent = cfg.meta.recommendLabel;
    $("#recommend-text").textContent = level ? level.recommendation : "";

    $("#qr-label").textContent = cfg.meta.qrLabel;
    const note = $("#qr-note");
    const debug = document.body.classList.contains("debug");
    const sub = cfg.meta.qrSubLabel || "";
    if (sub) {
      note.textContent = sub;
      note.hidden = false;
    } else if (debug && cfg.meta.qrPlaceholderNote) {
      note.textContent = cfg.meta.qrPlaceholderNote;
      note.hidden = false;
    } else {
      note.textContent = "";
      note.hidden = true;
    }
    renderQR(cfg.meta.qrUrl, $("#qr-img"));

    const foot = $("#footnote");
    const showNote = !!cfg.meta.showThresholdsNote || debug;
    if (showNote && cfg.meta.thresholdsNote) {
      foot.hidden = false;
      if (debug) {
        foot.textContent =
          cfg.meta.thresholdsNote +
          "（平均 " +
          formatScore(result.average) +
          "，等級 " +
          (level ? level.title : "—") +
          "）";
      } else {
        foot.textContent = cfg.meta.thresholdsNote;
      }
    } else {
      foot.hidden = true;
    }

    const resultSheet = $("#view-result .sheet");
    if (resultSheet) resultSheet.scrollTop = 0;
    show("view-result");
    armIdle();
  }

  function clearIdle() {
    if (state.idleTimer) {
      window.clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    if (state.tickTimer) {
      window.clearInterval(state.tickTimer);
      state.tickTimer = null;
    }
  }

  function armIdle() {
    clearIdle();
    const ms = Number(state.config.meta.idleResetMs) || 30000;
    state.idleEndsAt = Date.now() + ms;
    updateIdleHint();
    state.tickTimer = window.setInterval(updateIdleHint, 500);
    state.idleTimer = window.setTimeout(goStart, ms);
  }

  function bumpIdle() {
    if ($("#view-result").hidden) return;
    armIdle();
  }

  function updateIdleHint() {
    const el = $("#idle-hint");
    if (!el) return;
    const left = Math.max(0, Math.ceil((state.idleEndsAt - Date.now()) / 1000));
    el.textContent = fmtTemplate(state.config.meta.idleHintTemplate, { sec: left });
  }

  function bind() {
    const full = $("#btn-start-full") || $("#btn-start");
    const quick = $("#btn-start-quick");
    if (full) {
      full.addEventListener("click", function () {
        startQuiz("full");
      });
    }
    if (quick) {
      quick.addEventListener("click", function () {
        startQuiz("quick");
      });
    }
    $("#btn-restart").addEventListener("click", goStart);
    $("#btn-again").addEventListener("click", goStart);
    $("#btn-prev").addEventListener("click", goPrev);
    $("#btn-next").addEventListener("click", function () {
      goNext(false);
    });
    document.addEventListener("pointerdown", bumpIdle, { passive: true });
    document.addEventListener("keydown", function (e) {
      bumpIdle();
      if ($("#view-start").hidden === false && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        startQuiz("full");
        return;
      }
      if ($("#view-question").hidden === false) {
        const letter = (e.key || "").toUpperCase();
        const q = state.questions[state.index];
        const t = qType(q);
        const maxLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const idx = maxLetters.indexOf(letter);
        if (idx >= 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          if (t === "multi") {
            const opt = (q.options || [])[idx];
            if (opt) toggleMulti(opt.id);
          } else if (t === "single") {
            const btn = $$(".opt")[idx];
            if (btn && !btn.disabled) btn.click();
          }
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          goPrev();
        }
        if (e.key === "ArrowRight" || (e.key === "Enter" && (t === "multi" || t === "matrix"))) {
          e.preventDefault();
          goNext(false);
        }
        if (e.key === "Escape") goStart();
      }
      if ($("#view-result").hidden === false && (e.key === "Enter" || e.key === "Escape")) {
        goStart();
      }
    });
    /* Keep context menu available on desktop for debugging; booth still fine. */
    window.addEventListener("resize", function () {
      /* fluid layout: nothing to scale; orientation change reflows via CSS */
    });
    window.addEventListener("orientationchange", function () {
      /* allow CSS to reflow; scroll active view to top of current panel if needed */
    });
  }

  function paintStart(cfg) {
    $("#org-tag").textContent = cfg.meta.org + "　" + (cfg.meta.orgShort || "");
    $("#title").textContent = cfg.meta.title;
    $("#subtitle").textContent = cfg.meta.subtitle;
    const tag = $("#tagline");
    if (tag) {
      tag.textContent = cfg.meta.tagline || "";
      tag.hidden = !cfg.meta.tagline;
    }
    const fullZh = $("#btn-start-full-zh");
    const fullEn = $("#btn-start-full-en");
    const quickZh = $("#btn-start-quick-zh");
    const quickEn = $("#btn-start-quick-en");
    if (fullZh) fullZh.textContent = cfg.meta.fullButton || cfg.meta.startButton;
    if (fullEn) fullEn.textContent = cfg.meta.fullButtonEn || cfg.meta.startButtonEn;
    if (quickZh) quickZh.textContent = cfg.meta.quickButton || "快速闖關 5題・30秒";
    if (quickEn) quickEn.textContent = cfg.meta.quickButtonEn || "QUICK RUN";
    $("#start-hint").textContent = cfg.meta.startHint;
    $("#btn-restart").textContent = cfg.meta.restartLabel;
    $("#btn-again").textContent = cfg.meta.againLabel;
    if ($("#btn-prev")) $("#btn-prev").textContent = cfg.meta.prevLabel || "◀ 上一題";
    if ($("#btn-next")) $("#btn-next").textContent = cfg.meta.nextLabel || "下一題 ▶";
    document.title = cfg.meta.title + (cfg.meta.subtitle ? "：" + cfg.meta.subtitle : "");
  }

  async function main() {
    if (/\bdebug=1\b/.test(location.search)) document.body.classList.add("debug");
    bind();
    if (audio() && audio().init) audio().init();
    state.config = await loadConfig();
    paintStart(state.config);
    goStart();
    window.AIQuiz = {
      getConfig: function () {
        return state.config;
      },
      getState: function () {
        return {
          mode: state.mode,
          index: state.index,
          answers: state.answers.slice(),
          draft: state.draft,
          questionCount: state.questions.length,
        };
      },
      resolveLevel: resolveLevel,
      weakestDimensions: function (answers, questions) {
        return weakestDimensions(answers, questions || state.questions, state.config.dimensions);
      },
      dimensionAverages: dimensionAverages,
      overallAverage: overallAverage,
      scoreMulti: scoreMulti,
      scoreMatrix: scoreMatrix,
      scoreByCount: scoreByCount,
      computeResult: function (answers, questions, mode) {
        const qs = questions || state.questions;
        return computeResult(answers, qs, state.config);
      },
      startQuiz: startQuiz,
      goStart: goStart,
      goPrev: goPrev,
      goNext: function () {
        goNext(false);
      },
      answer: function (score) {
        const q = state.questions[state.index];
        if (qType(q) !== "single") return;
        const opt = (q.options || []).find((o) => o.score === score);
        const idx = (q.options || []).indexOf(opt);
        const btn = $$(".opt")[idx];
        if (btn && !btn.disabled) btn.click();
      },
      answerIndex: function (idx) {
        const btn = $$(".opt")[idx];
        if (btn && !btn.disabled) btn.click();
      },
      toggleMulti: toggleMulti,
      pickMatrix: pickMatrix,
      confirm: function () {
        goNext(false);
      },
      fillAll: function (kind) {
        /* test helper: fill remaining questions with lowest/highest/mixed scores and show result */
        const qs = state.questions;
        for (let i = 0; i < qs.length; i++) {
          if (answerScore(state.answers[i]) != null) continue;
          state.answers[i] = makeFillAnswer(qs[i], kind, i);
        }
        renderResult();
      },
      setAnswersAndShow: function (answers, mode) {
        state.mode = mode || state.mode || "full";
        state.questions = questionsFor(state.mode);
        state.answers = answers;
        renderResult();
      },
      renderResult: renderResult,
      renderQuestion: renderQuestion,
      setIndex: function (i) {
        state.index = i;
        renderQuestion();
      },
      scoreTotal: function (answers) {
        return (answers || state.answers).map(answerScore).reduce((a, b) => a + (b || 0), 0);
      },
    };
  }

  function makeFillAnswer(q, kind, i) {
    const t = qType(q);
    const pickLevel = function () {
      if (kind === "low") return 1;
      if (kind === "high") return 5;
      return [1, 2, 3, 4, 5][i % 5];
    };
    if (t === "single") {
      const want = pickLevel();
      const opt = (q.options || []).find((o) => o.score === want) || q.options[0];
      return { type: "single", score: opt.score };
    }
    if (t === "multi") {
      if (kind === "low") {
        return { type: "multi", ids: [q.exclusiveId || "none"], score: scoreByCount(0, q.scoreByCount) };
      }
      const real = (q.options || []).filter((o) => !o.exclusive && o.id !== (q.exclusiveId || "none"));
      let n;
      if (kind === "high") n = real.length;
      else n = Math.max(1, Math.min(real.length, (i % 5) + 1));
      const ids = real.slice(0, n).map((o) => o.id);
      return { type: "multi", ids: ids, score: scoreByCount(ids.length, q.scoreByCount) };
    }
    if (t === "matrix") {
      const colWant = kind === "low" ? 0 : kind === "high" ? (q.columns.length - 1) : (i % q.columns.length);
      const col = q.columns[colWant];
      const values = {};
      (q.rows || []).forEach(function (row, ri) {
        const c = kind === "mixed" ? q.columns[ri % q.columns.length] : col;
        values[row.id] = c.score;
      });
      const r = scoreMatrix(q, values);
      return { type: "matrix", values: values, score: r.score };
    }
    return { type: "single", score: 1 };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
