/* 透明图层叠序校准台 —— 前端逻辑（原生 JS） */
"use strict";

const MIN_LAYERS = 2, MAX_LAYERS = 7;
const MIN_SAMPLES = 1, MAX_SAMPLES = 4;
const MAX_RELATIONS = 12;
const MIN_CANDIDATES = 2, MAX_CANDIDATES = 12;

const state = {
  layers: [
    { id: "R", color: "#ff0000", opacity: 0.5 },
    { id: "B", color: "#0000ff", opacity: 0.5 },
  ],
  samples: [
    { background: "#ffffff", target: "#e189bc" },
    { background: "#000000", target: "#bc0089" },
  ],
  relations: [], // {lower, upper}
};

let solveTimer = null;
let lastErrorKey = "";
let inflightToken = 0;
let lastSolveResult = null; // 最近一次成功的求解结果（供过渡面板重置/默认上限）
// lastSolveResult 对应的求解输入纪元：只有它 === solveInputEpoch 时，该顺序才是
// 「当前校准输入对应的有效求解顺序」。输入变化后新求解尚未返回 / 求解失败 / 输入非法
// 期间该值与当前纪元不一致，合成预览一律禁用，直接调用 runComposite 也不会发请求。
let lastSolveEpoch = 0;

// 原求解与成环解除流程共用的输入纪元：图层、样本或关系每变化一次就 +1（只增不减）。
// 三类请求（原求解 / 解除方案 / 确认解除）发出时记录当前纪元；响应落地前纪元若已变，
// 说明请求在途期间（含响应体读取期间）输入发生过变化——该请求立即作废，
// 即使之后改回原值也不会恢复（纪元不会回到旧值）。
let solveInputEpoch = 0;

function noteSolveInputChanged() {
  solveInputEpoch += 1;
  // 校准输入（图层 / 样本 / 关系）变化同样属于合成相关输入变化：合成纪元同步 +1
  // （只增不减，改回原值也不回落），markCompositeStaleness 会立即撤销旧预览下载
  // 资格与在途合成资格，无需等待任何在途求解 / 合成完成。
  compositeState.epoch += 1;
  markCompositeStaleness(); // 图层 / 样本 / 关系变化也立即撤销旧合成预览的下载资格
}

const $ = (sel) => document.querySelector(sel);
const elLayers = $("#layers");
const elSamples = $("#samples");
const elRelations = $("#relations");
const elErrorBanner = $("#errorBanner");
const elErrorList = $("#errorList");
const elResultBody = $("#resultBody");
const elStatus = $("#status");

// ------------------------------------------------------------ 工具函数 --

function normalizeHex(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  if (s[0] !== "#") s = "#" + s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = "#" + s[1].repeat(2) + s[2].repeat(2) + s[3].repeat(2);
  }
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function scheduleSolve(delay = 200) {
  noteSolveInputChanged();
  clearTimeout(solveTimer);
  solveTimer = setTimeout(runSolve, delay);
  markInferStaleness();
  markSuggestStaleness();
  markReviewStaleness();
  markTransitionStaleness();
  markCycleStaleness();
  markExtractStaleness();
}

// ------------------------------------------------------------ 渲染输入 --

function render() {
  renderLayers();
  renderSamples();
  renderRelations();
  $("#addLayerBtn").disabled = state.layers.length >= MAX_LAYERS;
  $("#addSampleBtn").disabled = state.samples.length >= MAX_SAMPLES;
  $("#addRelationBtn").disabled = state.relations.length >= MAX_RELATIONS;
}

function renderLayers() {
  elLayers.innerHTML = "";
  const idCounts = {};
  state.layers.forEach((l) => {
    const k = l.id.trim();
    if (k) idCounts[k] = (idCounts[k] || 0) + 1;
  });
  const duplicateIds = new Set(
    Object.entries(idCounts).filter(([, n]) => n > 1).map(([k]) => k)
  );
  state.layers.forEach((layer, i) => {
    const validHex = normalizeHex(layer.color);
    const opNum = typeof layer.opacity === "number" ? layer.opacity : NaN;
    const opValid = Number.isFinite(opNum) && opNum >= 0 && opNum <= 1;
    const opValue = opValid ? opNum : "";
    const row = document.createElement("div");
    row.className = "layer-row";
    row.innerHTML = `
      <span class="row-index">${i + 1}</span>
      <input class="id-input ${layer.id && duplicateIds.has(layer.id) ? "invalid" : ""}"
             data-act="layer-id" data-i="${i}" type="text"
             value="${escapeHtml(layer.id)}" placeholder="ID" />
      <input type="color" data-act="layer-picker" data-i="${i}"
             value="${validHex || "#000000"}" title="选色" />
      <input class="hex-input ${validHex ? "" : "invalid"}" data-act="layer-hex" data-i="${i}"
             type="text" value="${escapeHtml(layer.color)}" placeholder="#RRGGBB" />
      <input class="opacity-range" data-act="layer-opacity-range" data-i="${i}"
             type="range" min="0" max="1" step="0.01" value="${opValid ? opNum : 1}" />
      <input class="opacity-input ${opValid ? "" : "invalid"}" data-act="layer-opacity"
             data-i="${i}" type="number" min="0" max="1" step="0.01"
             value="${opValue}" />
      <span class="opacity-val">${opValid ? Math.round(opNum * 100) + "%" : "—"}</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-layer" data-i="${i}"
              type="button" ${state.layers.length <= MIN_LAYERS ? "disabled" : ""}>删除</button>
    `;
    elLayers.appendChild(row);
  });
}

function renderSamples() {
  elSamples.innerHTML = "";
  state.samples.forEach((smp, i) => {
    const bg = normalizeHex(smp.background);
    const tg = normalizeHex(smp.target);
    const row = document.createElement("div");
    row.className = "sample-row";
    row.innerHTML = `
      <span class="row-index">${i + 1}</span>
      <span class="field-label">背景
        <input type="color" data-act="sample-bg-picker" data-i="${i}"
               value="${bg || "#000000"}" />
        <input class="hex-input" data-act="sample-bg" data-i="${i}" type="text"
               value="${escapeHtml(smp.background)}" placeholder="#RRGGBB" />
      </span>
      <span class="field-label">目标
        <input type="color" data-act="sample-target-picker" data-i="${i}"
               value="${tg || "#000000"}" />
        <input class="hex-input" data-act="sample-target" data-i="${i}" type="text"
               value="${escapeHtml(smp.target)}" placeholder="#RRGGBB" />
      </span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-sample" data-i="${i}"
              type="button" ${state.samples.length <= MIN_SAMPLES ? "disabled" : ""}>删除</button>
    `;
    elSamples.appendChild(row);
  });
}

function renderRelations() {
  elRelations.innerHTML = "";
  if (state.relations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "result-empty";
    empty.textContent = "暂无约束（任意图层顺序均可参与择优）。";
    elRelations.appendChild(empty);
    return;
  }
  const options = state.layers
    .map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.id)}</option>`)
    .join("");
  state.relations.forEach((rel, i) => {
    const row = document.createElement("div");
    row.className = "relation-row";
    row.innerHTML = `
      <select data-act="rel-lower" data-i="${i}">
        ${optionWith(options, rel.lower)}
      </select>
      <span class="relation-arrow">在更下方 ▲ 叠在</span>
      <select data-act="rel-upper" data-i="${i}">
        ${optionWith(options, rel.upper)}
      </select>
      <span class="relation-arrow">之上</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-relation" data-i="${i}"
              type="button">删除</button>
    `;
    elRelations.appendChild(row);
  });
}

// select 选项无法靠内部标记 selected，重写一份带 selected 的
function optionWith(allOptions, selectedId) {
  if (!state.layers.some((l) => l.id === selectedId)) {
    return `<option value="" selected>（请选择）</option>${allOptions}`;
  }
  return state.layers
    .map(
      (l) =>
        `<option value="${escapeHtml(l.id)}"${l.id === selectedId ? " selected" : ""}>${escapeHtml(
          l.id
        )}</option>`
    )
    .join("");
}

// ------------------------------------------------------------ 事件代理 --

document.addEventListener("input", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  if (!act) return;
  const i = Number(t.dataset.i);

  switch (act) {
    case "layer-id":
      state.layers[i].id = t.value;
      renderRelationsKeepFocus(t);
      scheduleSolve();
      break;
    case "layer-hex":
      state.layers[i].color = t.value;
      syncPicker(t, "layer-picker", i, t.value);
      t.classList.toggle("invalid", normalizeHex(t.value) === null);
      scheduleSolve();
      break;
    case "layer-picker":
      state.layers[i].color = t.value.toLowerCase();
      syncTextInput("layer-hex", i, t.value.toLowerCase());
      scheduleSolve();
      break;
    case "layer-opacity": {
      const v = parseFloat(t.value);
      state.layers[i].opacity = Number.isNaN(v) ? t.value : v;
      if (typeof state.layers[i].opacity === "number" &&
          state.layers[i].opacity >= 0 && state.layers[i].opacity <= 1) {
        syncRange(i, state.layers[i].opacity);
      }
      scheduleSolve();
      break;
    }
    case "layer-opacity-range":
      state.layers[i].opacity = parseFloat(t.value);
      syncNumberInput(i, state.layers[i].opacity);
      scheduleSolve();
      break;
    case "sample-bg":
    case "sample-target": {
      const key = act === "sample-bg" ? "background" : "target";
      state.samples[i][key] = t.value;
      syncPicker(t, act + "-picker", i, t.value);
      t.classList.toggle("invalid", normalizeHex(t.value) === null);
      scheduleSolve();
      break;
    }
    case "sample-bg-picker":
      state.samples[i].background = t.value.toLowerCase();
      syncTextInput("sample-bg", i, t.value.toLowerCase());
      scheduleSolve();
      break;
    case "sample-target-picker":
      state.samples[i].target = t.value.toLowerCase();
      syncTextInput("sample-target", i, t.value.toLowerCase());
      scheduleSolve();
      break;
    case "rel-lower":
      state.relations[i].lower = t.value;
      scheduleSolve();
      break;
    case "rel-upper":
      state.relations[i].upper = t.value;
      scheduleSolve();
      break;
    case "suggest-hex":
      suggestState.candidates[i] = t.value;
      syncPicker(t, "suggest-picker", i, t.value);
      refreshSuggestCandValidity();
      markSuggestStaleness();
      renderReviewBgOptions();
      markReviewStaleness();
      break;
    case "suggest-picker":
      suggestState.candidates[i] = t.value.toLowerCase();
      syncTextInput("suggest-hex", i, t.value.toLowerCase());
      refreshSuggestCandValidity();
      markSuggestStaleness();
      renderReviewBgOptions();
      markReviewStaleness();
      break;
    case "suggest-tolerance": {
      const v = parseFloat(t.value);
      suggestState.tolerance = Number.isNaN(v) ? t.value : v;
      markSuggestStaleness();
      markReviewStaleness();
      break;
    }
    case "review-color":
      reviewState.measuredColor = t.value;
      {
        const hx = normalizeHex(t.value);
        if (hx) $("#reviewPicker").value = hx;
      }
      t.classList.toggle("invalid", normalizeHex(t.value) === null);
      markReviewStaleness();
      break;
    case "review-picker":
      reviewState.measuredColor = t.value.toLowerCase();
      {
        const colorInput = $("#reviewColor");
        colorInput.value = t.value.toLowerCase();
        colorInput.classList.remove("invalid");
      }
      markReviewStaleness();
      break;
    case "review-limit": {
      const v = parseFloat(t.value);
      reviewState.measurementLimit = Number.isNaN(v) ? t.value : v;
      markReviewStaleness();
      break;
    }
    case "transition-limit": {
      const v = parseFloat(t.value);
      transitionState.limit = t.value.trim() === "" || Number.isNaN(v) ? null : v;
      markTransitionStaleness();
      break;
    }
  }
});

function syncPicker(textEl, pickerAct, i, raw) {
  const hx = normalizeHex(raw);
  const picker = document.querySelector(`input[data-act="${pickerAct}"][data-i="${i}"]`);
  if (picker && hx) picker.value = hx;
}
function syncTextInput(act, i, value) {
  const el = document.querySelector(`input[data-act="${act}"][data-i="${i}"]`);
  if (el && el.value !== value) {
    el.value = value;
    el.classList.remove("invalid");
  }
}
function syncRange(i, value) {
  const el = document.querySelector(`input[data-act="layer-opacity-range"][data-i="${i}"]`);
  if (el) el.value = value;
  const val = document.querySelectorAll(".layer-row")[i]?.querySelector(".opacity-val");
  if (val) val.textContent = Math.round(value * 100) + "%";
}
function syncNumberInput(i, value) {
  const el = document.querySelector(`input[data-act="layer-opacity"][data-i="${i}"]`);
  if (el && parseFloat(el.value) !== value) el.value = value;
  const val = document.querySelectorAll(".layer-row")[i]?.querySelector(".opacity-val");
  if (val) val.textContent = Math.round(value * 100) + "%";
}

// ID 文本框输入时只重建关系下拉，避免打断图层区输入焦点
function renderRelationsKeepFocus(activeEl) {
  const activeStart = activeEl.selectionStart;
  const activeEnd = activeEl.selectionEnd;
  renderRelations();
  activeEl.focus();
  try {
    activeEl.setSelectionRange(activeStart, activeEnd);
  } catch (_) { /* ignore */ }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const i = Number(btn.dataset.i);

  if (act === "add-layer" && state.layers.length < MAX_LAYERS) {
    state.layers.push({ id: uniqueId("L"), color: "#808080", opacity: 0.5 });
    render();
    scheduleSolve(0);
  } else if (act === "remove-layer" && state.layers.length > MIN_LAYERS) {
    const removed = state.layers[i].id.trim();
    state.layers.splice(i, 1);
    state.relations = state.relations.filter(
      (r) => r.lower.trim() !== removed && r.upper.trim() !== removed
    );
    render();
    scheduleSolve(0);
  } else if (act === "add-sample" && state.samples.length < MAX_SAMPLES) {
    state.samples.push({ background: "#ffffff", target: "#ffffff" });
    render();
    markTransitionStaleness();
    scheduleSolve(0);
  } else if (act === "remove-sample" && state.samples.length > MIN_SAMPLES) {
    state.samples.splice(i, 1);
    render();
    markTransitionStaleness();
    scheduleSolve(0);
  } else if (act === "add-relation" && state.relations.length < MAX_RELATIONS) {
    const first = state.layers[0]?.id || "";
    const second = state.layers[1]?.id || first;
    state.relations.push({ lower: first, upper: second });
    render();
    scheduleSolve(0);
  } else if (act === "remove-relation") {
    state.relations.splice(i, 1);
    render();
    scheduleSolve(0);
  } else if (act === "suggest-add" && suggestState.candidates.length < MAX_CANDIDATES) {
    suggestState.candidates.push("#808080");
    renderSuggestControls();
    markSuggestStaleness();
    renderReviewBgOptions();
    markReviewStaleness();
  } else if (act === "suggest-remove" && suggestState.candidates.length > MIN_CANDIDATES) {
    suggestState.candidates.splice(i, 1);
    renderSuggestControls();
    markSuggestStaleness();
    renderReviewBgOptions();
    markReviewStaleness();
  }
});

let idCounter = 0;
function uniqueId(prefix) {
  let candidate;
  do {
    idCounter += 1;
    candidate = `${prefix}${idCounter}`;
  } while (state.layers.some((l) => l.id === candidate));
  return candidate;
}

// ------------------------------------------------------------ 调用后端 --

function buildSolvePayload() {
  return {
    layers: state.layers.map((l) => ({
      id: l.id,
      color: l.color,
      opacity: l.opacity,
    })),
    samples: state.samples.map((s) => ({
      background: s.background,
      target: s.target,
    })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
  };
}

// 响应守卫：只有「仍是最新一次求解」且「发出后图层 / 样本 / 关系未再变化」的响应
// 可以落地；响应体读完之后必须再次判定——读取期间发生的输入变化或较新请求同样作数。
function solveResponseCurrent(token, epoch) {
  return token === inflightToken && epoch === solveInputEpoch;
}

async function runSolve() {
  // 成环确认请求在途时跳过自动求解：确认成功后会用删除关系后的输入触发求解；
  // 确认被作废 / 失败后，用户的下一次输入会重新走「求解 → 方案」流程，避免
  // 「在途确认尚未落地、自动求解先用旧关系渲染」造成的短暂不一致。
  if (cycleState.confirmReqId !== 0) return;
  const payload = buildSolvePayload();

  const token = ++inflightToken;
  const epoch = solveInputEpoch;
  elStatus.textContent = "计算中…";
  elStatus.className = "status busy";

  try {
    const resp = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!solveResponseCurrent(token, epoch)) return; // 已有更新的请求或输入已变，丢弃旧响应
    const data = await resp.json();
    // 响应体读取期间输入可能又变、或较新请求已发出：落地前必须再过一次守卫，
    // 过期响应无论成功、HTTP 错误还是解析失败都不得改动结果、错误与加载状态
    if (!solveResponseCurrent(token, epoch)) return;
    if (!resp.ok) {
      const errors = data.errors || [{ scope: "form", message: "求解失败" }];
      showErrors(errors);
      lastSolveResult = null; // 无有效求解结果：禁用合成预览生成
      lastSolveEpoch = 0;     // 输入非法 / 求解失败：旧顺序不再对应当前输入
      updateCompositeRunBtn();
      // 是否成环、以及待确认解除方案，都以 /api/resolve-cycle 的判定为准；
      // 其他非法输入（无环 / 混有别的错误）时该伴随请求不会展示方案卡片。
      void runCyclePlan(payload, { silentOnError: true });
    } else {
      showErrors([]);
      lastSolveResult = data;
      lastSolveEpoch = epoch; // 记录该有效求解顺序对应的输入纪元
      clearCyclePlan();
      renderResult(data);
      updateCompositeRunBtn();
    }
  } catch (err) {
    if (!solveResponseCurrent(token, epoch)) return;
    showErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
    // 尚未取得当前输入的求解结果（连接异常）：旧顺序不再对应当前输入，禁止合成
    lastSolveResult = null;
    lastSolveEpoch = 0;
    updateCompositeRunBtn();
  }
}

function showErrors(errors) {
  const key = JSON.stringify(errors);
  if (key === lastErrorKey) {
    // 内容不变时只更新状态文字，不重绘
    if (errors.length) {
      elStatus.textContent = "存在输入错误";
      elStatus.className = "status";
    }
    return;
  }
  lastErrorKey = key;

  if (!errors.length) {
    elErrorBanner.hidden = true;
    elErrorList.innerHTML = "";
    return;
  }
  elErrorList.innerHTML = errors
    .map((er) => `<li>${escapeHtml(er.message)}</li>`)
    .join("");
  elErrorBanner.hidden = false;
  elStatus.textContent = "存在输入错误";
  elStatus.className = "status";
  elResultBody.innerHTML = `<div class="result-empty">修正输入后将自动重新计算。</div>`;
  $("#inferCard").hidden = true;
}

// ------------------------------------------------------------ 结果渲染 --

function renderResult(r) {
  elStatus.textContent = "";
  elStatus.className = "status";

  const chips = r.order
    .map((id, k) => {
      const layer = r.layers[k];
      const rgba = hexToRgba(layer.color, layer.opacity);
      return `
        <span class="chip">
          <span class="dot" style="background:${rgba}" title="${escapeHtml(id)}"></span>
          <span class="cid">${escapeHtml(id)}</span>
          <span class="cop">α=${Number(layer.opacity.toFixed(2))}</span>
        </span>`;
    })
    .join('<span class="order-sep">↑</span>');

  const body = `
    <div class="order-panel">
      <div class="order-title">最优叠放顺序（底 → 顶）</div>
      <div class="checker">
        <div class="order-chips">
          <span class="order-ends">底</span>
          ${chips}
          <span class="order-ends">↑ 顶</span>
        </div>
      </div>
      <div class="metric-row">
        <span>总平方误差（未取整 0–255 通道）：<b>${fmtSse(r.totalSse)}</b></span>
        <span>枚举排列：<b>${r.permutationsChecked}</b> 个</span>
        <span>满足约束：<b>${r.feasibleCount}</b> 个</span>
        <span>同分时按 ID 字典序决胜</span>
      </div>
    </div>
    ${renderDiagnosis(r)}
    ${r.samples.map(renderSample).join("")}
  `;
  elResultBody.innerHTML = body;
  $("#suggestCard").hidden = false;
  $("#reviewCard").hidden = false;
  renderReviewBgOptions();
  syncInferPanel(r);
  syncTransitionPanel(r);
}

function renderSample(s) {
  const targetRgb = s.targetRgb.map((v) => Math.round(v)).join(", ");
  const predRgb = s.predictedRgb.map((v) => Math.round(v)).join(", ");
  const [cr, cg, cb] = s.channelSse;
  const rating =
    s.sse < 1 ? "r-good" : s.sse < 100 ? "r-mid" : "r-bad";
  return `
    <div class="sample-result">
      <div class="sample-result-head">
        <span>样本 ${s.index + 1}</span>
        <span class="${rating}">SSE = ${fmtSse(s.sse)}</span>
      </div>
      <div class="compare">
        <div class="swatch-box">
          <span class="swatch-big" style="background:${s.target}"></span>
          <span class="swatch-meta">
            <div class="name">目标色</div>
            <div class="hexval">${s.target}</div>
            <div class="name">rgb(${targetRgb})</div>
          </span>
        </div>
        <div class="compare-arrow">→</div>
        <div class="swatch-box">
          <span class="swatch-big" style="background:${s.predictedHex}"></span>
          <span class="swatch-meta">
            <div class="name">预测色</div>
            <div class="hexval">${s.predictedHex}</div>
            <div class="name">rgb(${predRgb})</div>
          </span>
        </div>
      </div>
      <div class="bg-note">
        <span class="mini" style="background:${s.background}"></span>
        在背景 ${s.background} 上叠放
      </div>
      <div class="sse-line">
        <span class="sse-chan">R²误差 ${fmtSse(cr)}</span>
        <span class="sse-chan">G²误差 ${fmtSse(cg)}</span>
        <span class="sse-chan">B²误差 ${fmtSse(cb)}</span>
      </div>
    </div>
  `;
}

function hexToRgba(hex, alpha) {
  const h = normalizeHex(hex) || "#000000";
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ------------------------------------------------------------ 图层影响诊断 --

function fmtPct(w) {
  return Number((w * 100).toFixed(2)).toString() + "%";
}

// 差值 = 禁用后 − 原值：正值表示该层有助于匹配，负值表示该层增大误差
function fmtDelta(d) {
  if (Math.abs(d) < 1e-9) return "持平";
  return `${d > 0 ? "+" : "−"}${fmtSse(Math.abs(d))}`;
}

function diagDeltaCls(d) {
  if (Math.abs(d) < 1e-9) return "";
  return d > 0 ? "diag-pos" : "diag-neg";
}

// 诊断随求解结果一起落地与更新（同一响应、同一守卫），无需单独的失效处理
function renderDiagnosis(r) {
  const diag = r.diagnosis;
  if (!diag || !diag.layers) return "";

  // ---- 有效权重条（底 → 顶：背景在最左，顶层在最右）----
  const barSegs = [
    `<span class="diag-seg diag-seg-bg" style="width:${diag.backgroundWeight * 100}%"` +
      ` title="背景权重 ${fmtPct(diag.backgroundWeight)}"></span>`,
  ];
  diag.layers.forEach((d, k) => {
    const layer = r.layers[k];
    barSegs.push(
      `<span class="diag-seg" style="width:${d.weight * 100}%;` +
        ` background:${hexToRgba(layer.color, layer.opacity)}"` +
        ` title="${escapeHtml(d.id)} 有效权重 ${fmtPct(d.weight)}"></span>`
    );
  });

  // ---- 权重明细行（零权重标为无直接颜色贡献）----
  const zeroBadge = '<span class="diag-zero-badge">无直接颜色贡献</span>';
  const bgRow = `
    <div class="diag-weight-row">
      <span class="mini-dot diag-bg-dot"></span>
      <span class="diag-wid">背景</span>
      <span class="spacer"></span>
      <span class="diag-w">权重 <b>${fmtPct(diag.backgroundWeight)}</b></span>
      ${diag.backgroundWeight === 0 ? zeroBadge : ""}
    </div>`;
  const weightRows = diag.layers
    .map((d, k) => {
      const layer = r.layers[k];
      return `
        <div class="diag-weight-row">
          <span class="mini-dot" style="background:${hexToRgba(layer.color, layer.opacity)}"></span>
          <span class="diag-wid hexval">${escapeHtml(d.id)}</span>
          <span class="hint">α=${fmtOpacity(d.opacity)}</span>
          <span class="spacer"></span>
          <span class="diag-w">有效权重 <b>${fmtPct(d.weight)}</b></span>
          ${d.weight === 0 ? zeroBadge : ""}
        </div>`;
    })
    .join("");

  // ---- 逐层禁用影响（仅该层 α 临时置 0，其余参数与叠序不变）----
  const layerBlocks = diag.layers
    .map((d, k) => {
      const layer = r.layers[k];
      const cls = diagDeltaCls(d.totalDelta);
      const verdict =
        Math.abs(d.totalDelta) < 1e-9
          ? "影响持平"
          : d.totalDelta > 0
            ? "该层有助于匹配"
            : "该层增大误差";
      const sampleRows = d.samples
        .map((s) => {
          const rgbTxt = s.predictedRgb.map((v) => Math.round(v)).join(", ");
          return `
            <div class="diag-sample-row">
              <span class="diag-sample-tag">样本 ${s.index + 1}</span>
              <span class="hint">背景 ${s.background}</span>
              <span class="mini" style="background:${s.predictedHex}"></span>
              <span class="hexval">${s.predictedHex}</span>
              <span class="hint">rgb(${rgbTxt})</span>
              <span class="spacer"></span>
              <span class="hint">SSE <b>${fmtSse(s.sse)}</b></span>
              <span class="diag-delta ${diagDeltaCls(s.sseDelta)}">${fmtDelta(s.sseDelta)}</span>
            </div>`;
        })
        .join("");
      return `
        <div class="diag-layer">
          <div class="diag-layer-head">
            <span class="mini-dot" style="background:${hexToRgba(layer.color, layer.opacity)}"></span>
            <b class="hexval">${escapeHtml(d.id)}</b>
            <span class="hint">α=${fmtOpacity(d.opacity)} · 有效权重 ${fmtPct(d.weight)}</span>
            <span class="spacer"></span>
            <span class="hint">禁用后总误差 <b>${fmtSse(d.totalSse)}</b></span>
            <span class="diag-delta ${cls}">${fmtDelta(d.totalDelta)}</span>
            <span class="diag-verdict ${cls}">${verdict}</span>
          </div>
          <div class="diag-samples">${sampleRows}</div>
        </div>`;
    })
    .join("");

  return `
    <div class="diag-panel">
      <div class="order-title">图层影响诊断（基于本次最优叠序，不重新择序）</div>
      <div class="diag-sec">
        有效权重 ＝ 该层 α × 其上各层 (1−α) 的乘积；背景权重 ＝ 全部层 (1−α) 的乘积（底 → 顶）
      </div>
      <div class="checker"><div class="diag-bar">${barSegs.join("")}</div></div>
      <div class="diag-weights">${bgRow}${weightRows}</div>
      <div class="diag-sec">
        逐层禁用影响：仅把该层 α 临时设为 0，其余参数与叠序不变；差值 ＝ 禁用后 − 原值，
        正值表示该层有助于匹配，负值表示该层增大误差
      </div>
      ${layerBlocks}
    </div>`;
}

function fmtSse(v) {
  if (v === 0) return "0";
  if (v < 0.001) return v.toExponential(3);
  return Number(v.toFixed(4)).toString();
}

// 网格值（0.01 整数倍）显示为两位小数；原始参数组入选时保留必要精度
function fmtOpacity(v) {
  if (Math.abs(v - Math.round(v * 100) / 100) < 1e-9) return Number(v.toFixed(2)).toString();
  return String(v);
}

// ============================================================ 不透明度反推 ==

const inferState = {
  order: [],          // 当前确认顺序（ID 数组）
  picks: new Set(),   // 勾选的待调 ID
  result: null,       // 最近一次成功返回
  resultKey: "",      // 结果产生时的输入指纹
  appliedSig: "",     // 上一次点「应用」之后的输入指纹（与当前一致则结果仍代表现状）
  applied: false,     // 当前结果是否已写回图层
  invalidated: false, // 结果展示后参与输入是否曾变化过：一旦置位，改回原值也不恢复应用资格
  inflightId: 0,      // 当前仍可落地的在途请求序号；0 表示无（已完成 / 被更新请求取代 / 因输入变化作废）
  inflightSig: "",    // 当前在途请求发出时的输入指纹
  reqSeq: 0,          // 单调递增的请求序号源，永不归零，避免请求序号在完成后被新请求复用
};

let orderSlotBefore = "";

const elInferCard = $("#inferCard");
const elInferOrder = $("#inferOrder");
const elInferPick = $("#inferPick");
const elInferHint = $("#inferHint");
const elInferErrors = $("#inferErrors");
const elInferResult = $("#inferResult");
const elInferStatus = $("#inferStatus");

function inferSignature() {
  // 用于判断已有反推结果是否对应当前输入
  return JSON.stringify({
    layers: state.layers,
    samples: state.samples,
    relations: state.relations,
    order: inferState.order,
    picks: [...inferState.picks].sort(),
  });
}

function syncInferPanel(solveResult) {
  elInferCard.hidden = false;
  const idSig = state.layers.map((l) => l.id).join("");
  const layerSet = new Set(state.layers.map((l) => l.id));

  if (inferState._idSig !== idSig) {
    // 图层集合（ID 列表）变化：重建顺序与勾选，默认采用求解顺序
    inferState._idSig = idSig;
    inferState.order = [...solveResult.order];
    inferState.picks = new Set();
    inferState.result = null;
    inferState.resultKey = "";
    inferState.appliedSig = "";
    inferState.applied = false;
    inferState.invalidated = false;
    elInferResult.innerHTML = "";
    elInferErrors.hidden = true;
  } else {
    // 集合未变：把求解新出现、但当前顺序未包含的 ID 补齐（防御性）
    inferState.order = inferState.order.filter((id) => layerSet.has(id));
    solveResult.order.forEach((id) => {
      if (!inferState.order.includes(id)) inferState.order.push(id);
    });
    inferState.picks = new Set([...inferState.picks].filter((id) => layerSet.has(id)));
  }
  renderInferControls();
  markInferStaleness();
}

function layerById(id) {
  return state.layers.find((l) => l.id === id);
}

function renderInferControls() {
  // ---- 顺序槽 ----
  elInferOrder.innerHTML = "";
  inferState.order.forEach((id, pos) => {
    const layer = layerById(id);
    const hex = (layer && normalizeHex(layer.color)) || "#000000";
    const op = layer && Number.isFinite(layer.opacity) ? layer.opacity : null;
    const slot = document.createElement("span");
    slot.className = "order-slot";
    slot.innerHTML = `
      <select data-act="infer-order" data-pos="${pos}" title="该位置（底 → 顶第 ${pos + 1} 层）的图层">
        ${state.layers
          .map(
            (l) =>
              `<option value="${escapeHtml(l.id)}"${l.id === id ? " selected" : ""}>${escapeHtml(
                l.id
              )}</option>`
          )
          .join("")}
      </select>
      <span class="mini-dot" style="background:${hexToRgba(hex, op == null ? 1 : op)}"></span>
      <span class="mini-op">${op == null ? "α 非法" : "α=" + Number(op.toFixed(2))}</span>
    `;
    elInferOrder.appendChild(slot);
    if (pos < inferState.order.length - 1) {
      const ar = document.createElement("span");
      ar.className = "infer-arrow";
      ar.textContent = "↑";
      elInferOrder.appendChild(ar);
    }
  });

  // ---- 待调勾选 ----
  elInferPick.innerHTML = "";
  state.layers.forEach((l) => {
    const hex = normalizeHex(l.color) || "#000000";
    const checked = inferState.picks.has(l.id);
    const disabled = !checked && inferState.picks.size >= 2;
    const label = document.createElement("label");
    label.className = "pick-item" + (disabled ? " disabled" : "");
    label.innerHTML = `
      <input type="checkbox" data-act="infer-pick" data-id="${escapeHtml(l.id)}"
             ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
      <span class="pick-dot" style="background:${hexToRgba(hex, l.opacity)}"></span>
      <span>${escapeHtml(l.id)}</span>
    `;
    elInferPick.appendChild(label);
  });

  updateInferRunHint();
  markInferStaleness();
}

function updateInferRunHint() {
  const btn = $("#inferRunBtn");
  const n = inferState.picks.size;
  btn.disabled = n < 1 || n > 2;
  elInferHint.textContent =
    n === 0 ? "请勾选 1～2 个待调图层" : `已选 ${n} 个，将在 0.00～1.00（步长 0.01）网格上联合反推`;
}

function markInferStaleness() {
  // 参与输入（图层 / 样本 / 先后关系 / 反推顺序 / 待调选择）变化时：在途请求（及其
  // 响应）立即失效，不能再改动建议 / 错误 / 加载状态。这里仅结束加载态并作废在途
  // 请求；旧响应返回后会在响应守卫处被丢弃。reqSeq 不清零，请求序号始终单调递增。
  if (inferState.inflightId !== 0 && inferSignature() !== inferState.inflightSig) {
    inferState.inflightId = 0;
    inferState.inflightSig = "";
    elInferStatus.textContent = "";
    elInferStatus.className = "status";
  }
  if (!inferState.result) return;
  const sig = inferSignature();
  // 资格锚点随应用状态二选一，绝不允许旧锚点给新状态背书：
  //  - 尚未应用：只以结果产生时的指纹 resultKey 为准；
  //  - 已应用：只以应用后的指纹 appliedSig 为准（应用前的 resultKey 已不再代表现状，
  //    把图层改回请求 / 反推发出时的历史值也不能恢复资格）。
  // 但只要曾偏离过锚点，应用资格即被永久撤销——改回原值也不能恢复。
  const anchorSig = inferState.applied ? inferState.appliedSig : inferState.resultKey;
  const matches = sig === anchorSig;
  if (!matches) inferState.invalidated = true;
  const fresh = matches && !inferState.invalidated;
  inferState.applied = inferState.applied && fresh;
  const old = elInferResult.querySelector(".stale-note");
  if (!fresh && !old) {
    const note = document.createElement("div");
    note.className = "stale-note";
    note.textContent = "输入或选择已变化，以下建议已失效（即使改回原值也不能再应用），请重新反推。";
    elInferResult.prepend(note);
  } else if (fresh && old) {
    old.remove();
  }
  // 应用按钮的可用状态随失效状态同步：失效的建议不能再写回图层
  const applyBtn = elInferResult.querySelector('button[data-act="infer-apply"]');
  if (applyBtn) applyBtn.disabled = !fresh || inferState.applied;
}

// 结果是否仍代表当前输入且保有应用资格；false 时「应用」按钮不可点击
function inferResultFresh() {
  if (!inferState.result || inferState.invalidated) return false;
  const sig = inferSignature();
  // 与 markInferStaleness 同一套锚点规则：未应用只认结果指纹，已应用只认应用后指纹
  const anchorSig = inferState.applied ? inferState.appliedSig : inferState.resultKey;
  return sig === anchorSig;
}

document.addEventListener("change", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  if (act === "infer-order") {
    const pos = Number(t.dataset.pos);
    const prev = orderSlotBefore;
    // 与原占据新 ID 的槽位交换，保证顺序始终是全部图层的一个排列
    const other = inferState.order.findIndex((id, p) => p !== pos && id === t.value);
    inferState.order[pos] = t.value;
    if (other !== -1 && prev) inferState.order[other] = prev;
    renderInferControls();
  } else if (act === "transition-order") {
    // 手动调整当前叠序：立即终止旧执行（已确认记录保留，输入不回滚）
    terminateTransitionExecution("order");
    const pos = Number(t.dataset.pos);
    const prev = orderSlotBefore;
    // 与原占据新 ID 的槽位交换，保证当前顺序始终是全部图层的一个排列
    const other = transitionState.order.findIndex((id, p) => p !== pos && id === t.value);
    transitionState.order[pos] = t.value;
    if (other !== -1 && prev) transitionState.order[other] = prev;
    renderTransitionControls(lastSolveResult);
    markTransitionStaleness();
  } else if (act === "infer-pick") {
    const id = t.dataset.id;
    if (t.checked) inferState.picks.add(id);
    else inferState.picks.delete(id);
    renderInferControls();
  } else if (act === "review-bg") {
    reviewState.selectedBackground = t.value;
    markReviewStaleness();
  }
});

// select change 前记录原值，供交换使用
document.addEventListener("focusin", (e) => {
  if (e.target.dataset && e.target.dataset.act === "infer-order") {
    const pos = Number(e.target.dataset.pos);
    orderSlotBefore = inferState.order[pos];
  }
  if (e.target.dataset && e.target.dataset.act === "transition-order") {
    const pos = Number(e.target.dataset.pos);
    orderSlotBefore = transitionState.order[pos];
  }
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "infer-run") runInfer();
  if (btn.dataset.act === "infer-apply") applyInferResult();
  if (btn.dataset.act === "suggest-run") runSuggest();
  if (btn.dataset.act === "review-run") runReview();
  if (btn.dataset.act === "review-append") appendReviewSample();
  if (btn.dataset.act === "transition-run") runTransition();
  if (btn.dataset.act === "transition-reset") resetTransitionOrder();
  if (btn.dataset.act === "transition-exec-start") startTransitionExecution();
  if (btn.dataset.act === "transition-exec-confirm") confirmTransitionStep(Number(btn.dataset.step));
  if (btn.dataset.act === "cycle-confirm") confirmCyclePlan();
});

// 响应守卫：只有「当前在途请求」且「发出后参与输入未再变化」的响应可以落地。
// 请求序号取自永不归零的单调计数器，因此某请求完成（成功 / HTTP 错误 / 连接异常 /
// 解析失败）不会释放其序号：输入不变时连续反推，较早请求即便后返回也无法冒充成
// 新请求，其各种结局都只会被直接忽略，不触碰当前建议、错误提示或加载状态。
function inferResponseCurrent(reqId, reqSig) {
  return (
    inferState.inflightId === reqId &&
    inferState.inflightSig === reqSig &&
    inferSignature() === reqSig
  );
}

async function runInfer() {
  const payload = {
    layers: state.layers.map((l) => ({ id: l.id, color: l.color, opacity: l.opacity })),
    samples: state.samples.map((s) => ({ background: s.background, target: s.target })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
    order: inferState.order,
    adjustIds: [...inferState.picks].sort(),
  };
  // 从永不归零的单调计数器取得本次请求序号，并登记为当前在途请求；
  // 连续反推或输入变化时，旧请求即便后返回也不会覆盖较新结果（见 inferResponseCurrent）。
  const reqId = ++inferState.reqSeq;
  inferState.inflightId = reqId;
  const reqSig = inferSignature();
  inferState.inflightSig = reqSig;

  elInferStatus.textContent = "反推中…";
  elInferStatus.className = "status busy";
  elInferErrors.hidden = true;

  try {
    const resp = await fetch("/api/infer-opacity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!inferResponseCurrent(reqId, reqSig)) return; // 已有更新的请求或输入已变，丢弃旧响应
    const data = await resp.json();
    // 响应体读取期间输入可能又变、或较新请求已发出：落地前必须再过一次守卫，
    // 过期响应无论成功、HTTP 错误还是解析失败都不得改动建议、错误与加载状态
    if (!inferResponseCurrent(reqId, reqSig)) return;
    inferState.inflightId = 0;
    inferState.inflightSig = "";
    elInferStatus.textContent = "";
    elInferStatus.className = "status";
    if (!resp.ok) {
      showInferErrors(data.errors || [{ scope: "form", message: "反推失败" }]);
      return;
    }
    inferState.result = data;
    inferState.resultKey = reqSig;
    inferState.applied = false;
    // 新建议绝不能沿用上一次应用留下的资格：清空 appliedSig。否则「应用 R1 →
    // 改动另一图层后重新反推得到 R2 → 把该图层改回 R1 应用时的值」会让指纹重新
    // 等于旧 appliedSig，R2 借此冒充「已应用」状态、其应用按钮被重新放行。
    inferState.appliedSig = "";
    inferState.invalidated = false; // 新建议落地，重新获得应用资格
    renderInferResult(data);
  } catch (err) {
    if (!inferResponseCurrent(reqId, reqSig)) return;
    inferState.inflightId = 0;
    inferState.inflightSig = "";
    elInferStatus.textContent = "";
    elInferStatus.className = "status";
    showInferErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showInferErrors(errors) {
  elInferErrors.innerHTML =
    '<ul>' + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elInferErrors.hidden = false;
}

function renderInferResult(r) {
  const delta = r.afterTotalSse - r.beforeTotalSse;
  const deltaCls = delta < -1e-9 ? "sse-delta-down" : delta > 1e-9 ? "sse-delta-up" : "";
  const deltaTxt =
    Math.abs(delta) < 1e-9 ? "持平" : `${delta > 0 ? "+" : "−"}${fmtSse(Math.abs(delta))}`;

  const rows = r.adjustments
    .map((a) => {
      const changed =
        Math.abs(a.originalOpacity - a.suggestedOpacity) > 1e-9;
      return `
        <tr>
          <td>${escapeHtml(a.id)}</td>
          <td class="num">${fmtOpacity(a.originalOpacity)}</td>
          <td class="op-arrow">→</td>
          <td class="num ${changed ? "op-new" : "op-same"}">
            ${fmtOpacity(a.suggestedOpacity)}${changed ? "" : "（原值即最优）"}
          </td>
        </tr>`;
    })
    .join("");

  const samples = r.afterSamples
    .map((s, k) => renderInferSample(s, r.beforeSamples[k]))
    .join("");

  const fresh = inferResultFresh();
  const applied = fresh && inferState.applied;
  elInferResult.innerHTML = `
    <table class="adj-table">
      <thead><tr><th>待调图层</th><th>原不透明度</th><th></th><th>建议不透明度</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sse-compare">
      <span>调整前总误差：<b>${fmtSse(r.beforeTotalSse)}</b></span>
      <span class="after">调整后总误差：<b>${fmtSse(r.afterTotalSse)}</b></span>
      <span class="${deltaCls}">变化：<b>${deltaTxt}</b></span>
      <span>评估组合：<b>${r.combosChecked}</b> 组（含原始参数组）</span>
    </div>
    ${samples}
    <div class="infer-apply-row">
      <button class="btn btn-small" data-act="infer-apply" type="button"
              ${applied || !fresh ? "disabled" : ""}>应用建议值回图层并重新求解</button>
      ${applied ? '<span class="applied-note">已应用，左侧图层与上方校准结果已更新。</span>' : ""}
    </div>
  `;
}

function renderInferSample(after, before) {
  return `
    <div class="sample-result">
      <div class="sample-result-head">
        <span>样本 ${after.index + 1}</span>
        <span class="hint">背景 ${after.background}</span>
      </div>
      <div class="tri-compare">
        ${triCell("目标色", after.target, after.targetRgb, null)}
        <span class="tri-arrow">→</span>
        ${triCell("调整前预测", before.predictedHex, before.predictedRgb, before.sse)}
        <span class="tri-arrow">→</span>
        ${triCell("调整后预测", after.predictedHex, after.predictedRgb, after.sse)}
      </div>
    </div>
  `;
}

function triCell(tag, hex, rgb, sse) {
  const rgbTxt = rgb.map((v) => Math.round(v)).join(", ");
  return `
    <div class="tri-cell">
      <div class="cell-tag">
        <span>${tag}</span>
        ${sse == null ? "" : `<span class="tag-sse">SSE ${fmtSse(sse)}</span>`}
      </div>
      <div class="tri-swatch">
        <span class="swatch-big" style="background:${hex}"></span>
        <span>
          <div class="hexval">${hex}</div>
          <div class="name">rgb(${rgbTxt})</div>
        </span>
      </div>
    </div>
  `;
}

function applyInferResult() {
  const r = inferState.result;
  // 应用前再次核对资格：建议已失效（参与输入曾变化，即使改回原值）时不改任何图层
  if (!r || inferState.applied || !inferResultFresh()) return;
  r.adjustments.forEach((a) => {
    const layer = state.layers.find((l) => l.id === a.id);
    if (layer) layer.opacity = a.suggestedOpacity;
  });
  // 记录应用后的状态指纹：在再次改动输入前，结果始终代表当前图层
  inferState.applied = true;
  inferState.appliedSig = inferSignature();
  // 一次有效应用永久作废此前在途的反推：「已有有效建议时再反推，等待 / 读取响应体
  // 期间应用该建议，随后把输入改回请求发出时的值」也不能让旧请求复活——序号不会被
  // 复用（reqSeq 只增），且这里直接摘除当前在途身份；旧请求即便以成功、HTTP 错误、
  // 连接异常或解析失败结束，响应守卫都会丢弃它，不覆盖已应用结果 / 提示，也不结束
  // 较新请求的加载状态。加载指示（可能正显示「反推中…」）随在途身份一并结束。
  if (inferState.inflightId !== 0) {
    inferState.inflightId = 0;
    inferState.inflightSig = "";
    elInferStatus.textContent = "";
    elInferStatus.className = "status";
  }
  renderInferResult(inferState.result);
  render();
  noteSolveInputChanged();
  markCycleStaleness();
  markTransitionStaleness();
  runSolve();
}

// ============================================================ 过渡步骤规划 ==

const transitionState = {
  order: [],        // 当前实际底→顶顺序（ID 数组）
  limit: null,      // 过渡总误差上限（null 表示沿用最近一次求解的总误差）
  result: null,     // 最近一次成功返回
  resultKey: "",    // 结果产生时的输入指纹
  _idSig: "",
  _bestSse: null,   // 最近一次求解的最优总误差（用于默认上限与提示）
  inflightId: 0,        // 当前仍可落地的在途请求序号；0 表示无（已完成 / 被更新请求取代 / 因输入变化作废）
  inflightSig: "",      // 当前在途请求发出时的输入指纹
  reqSeq: 0,            // 单调递增的请求序号源，永不归零，避免请求序号在完成后被新请求复用
  exec: null,           // 当前过渡执行会话（见 startTransitionExecution）；null 表示未开始 / 已被新规划取代
};

const elTransitionOrder = $("#transitionOrder");
const elTransitionTarget = $("#transitionTarget");
const elTransitionResult = $("#transitionResult");
const elTransitionExec = $("#transitionExec");
const elTransitionErrors = $("#transitionErrors");
const elTransitionStatus = $("#transitionStatus");
const elTransitionLimit = $("#transitionLimit");
const elTransitionLimitHint = $("#transitionLimitHint");

function transitionSignature() {
  // 用于判断已有过渡步骤是否对应当前输入。
  // 执行会话激活期间，「当前实际叠序」按启动时冻结的起始叠序计入指纹：
  // 确认步骤会把该步叠序写回当前叠序控件，这种执行写回不视为输入变化——
  // 不会让规划结果失效、也不会终止执行；手动调整 / 重置当前叠序则由对应
  // 事件处理显式终止执行（见 transition-order / transition-reset）。
  const exec = transitionState.exec;
  const execActive = exec && !exec.terminated && !exec.done;
  return JSON.stringify({
    layers: state.layers,
    samples: state.samples,
    relations: state.relations,
    currentOrder: execActive ? exec.startOrder : transitionState.order,
    transitionLimit: transitionState.limit == null ? null : transitionState.limit,
  });
}

function effectiveTransitionLimit() {
  return transitionState.limit == null ? transitionState._bestSse : transitionState.limit;
}

function syncTransitionPanel(solveResult) {
  $("#transitionCard").hidden = false;
  const idSig = state.layers.map((l) => l.id).join("");
  const layerSet = new Set(state.layers.map((l) => l.id));

  transitionState._bestSse = solveResult.totalSse;
  if (transitionState._idSig !== idSig) {
    // 图层集合变化：当前顺序重置为最新最优叠序，上限默认取当前最优总误差
    transitionState._idSig = idSig;
    transitionState.order = [...solveResult.order];
    transitionState.limit = null;
    transitionState.result = null;
    transitionState.resultKey = "";
    elTransitionResult.innerHTML = "";
    elTransitionErrors.hidden = true;
  } else {
    // 集合未变：补齐 / 剔除，保持当前实际顺序始终是全部图层的一个排列
    transitionState.order = transitionState.order.filter((id) => layerSet.has(id));
    solveResult.order.forEach((id) => {
      if (!transitionState.order.includes(id)) transitionState.order.push(id);
    });
  }
  renderTransitionControls(solveResult);
  markTransitionStaleness();
}

function renderOrderSlots(container, ids) {
  container.innerHTML = "";
  ids.forEach((id, pos) => {
    const layer = layerById(id);
    const hex = (layer && normalizeHex(layer.color)) || "#000000";
    const op = layer && Number.isFinite(layer.opacity) ? layer.opacity : null;
    const slot = document.createElement("span");
    slot.className = "order-slot";
    slot.innerHTML = `
      <span class="mini-dot" style="background:${hexToRgba(hex, op == null ? 1 : op)}"></span>
      <span class="slot-id">${escapeHtml(id)}</span>
      <span class="mini-op">${op == null ? "α 非法" : "α=" + Number(op.toFixed(2))}</span>
    `;
    container.appendChild(slot);
    if (pos < ids.length - 1) {
      const ar = document.createElement("span");
      ar.className = "infer-arrow";
      ar.textContent = "↑";
      container.appendChild(ar);
    }
  });
}

function renderTransitionControls(solveResult) {
  // ---- 当前顺序：可改的下拉槽 ----
  elTransitionOrder.innerHTML = "";
  transitionState.order.forEach((id, pos) => {
    const layer = layerById(id);
    const hex = (layer && normalizeHex(layer.color)) || "#000000";
    const op = layer && Number.isFinite(layer.opacity) ? layer.opacity : null;
    const slot = document.createElement("span");
    slot.className = "order-slot";
    slot.innerHTML = `
      <select data-act="transition-order" data-pos="${pos}"
              title="该位置（底 → 顶第 ${pos + 1} 层）的图层；改动会与原占该 ID 的槽位交换">
        ${state.layers
          .map(
            (l) =>
              `<option value="${escapeHtml(l.id)}"${l.id === id ? " selected" : ""}>${escapeHtml(
                l.id
              )}</option>`
          )
          .join("")}
      </select>
      <span class="mini-dot" style="background:${hexToRgba(hex, op == null ? 1 : op)}"></span>
      <span class="mini-op">${op == null ? "α 非法" : "α=" + Number(op.toFixed(2))}</span>
    `;
    elTransitionOrder.appendChild(slot);
    if (pos < transitionState.order.length - 1) {
      const ar = document.createElement("span");
      ar.className = "infer-arrow";
      ar.textContent = "↑";
      elTransitionOrder.appendChild(ar);
    }
  });

  // ---- 目标顺序：只读展示 ----
  renderOrderSlots(elTransitionTarget, solveResult.order);

  // ---- 上限输入：空白时默认取最优总误差 ----
  if (transitionState.limit == null && document.activeElement !== elTransitionLimit) {
    elTransitionLimit.value = solveResult.totalSse == null ? "" : String(solveResult.totalSse);
  }
  elTransitionLimitHint.textContent =
    `留空默认取最优总误差 ${fmtSse(solveResult.totalSse)}；当前实际叠序的旧样本总误差也必须不超过该上限`;

  markTransitionStaleness();
}

function resetTransitionOrder() {
  const r = lastSolveResult;
  if (!r) return;
  // 手动重置当前叠序：立即终止旧执行（已确认记录保留，输入不回滚）
  terminateTransitionExecution("order");
  transitionState.order = [...r.order];
  transitionState.limit = null;
  renderTransitionControls(r);
}

function markTransitionStaleness() {
  // 执行会话的终止判定：图层 / 样本 / 先后关系 / 过渡上限一旦偏离启动时冻结的
  // 指纹，立即终止旧执行——终止是永久的，改回原值也不能续走，须重新规划后开始。
  // （执行中「当前实际叠序」按冻结的起始叠序计入指纹，确认步骤的写回不算偏离；
  //   手动调整 / 重置当前叠序、重新发起规划由对应入口显式终止。）
  const exec = transitionState.exec;
  if (exec && !exec.terminated && !exec.done &&
      transitionSignature() !== exec.signature) {
    exec.terminated = true;
    exec.terminateReason = "input";
  }
  // 输入指纹变化时：在途请求（及其响应）立即失效，不能再改动结果 / 错误 / 加载状态。
  // 这里仅结束加载态并作废在途请求；旧响应返回后会在响应守卫处被丢弃。
  // 注意 reqSeq 不清零，请求序号始终单调递增，旧序号不会被后续请求复用。
  if (transitionState.inflightId !== 0 &&
      transitionSignature() !== transitionState.inflightSig) {
    transitionState.inflightId = 0;
    transitionState.inflightSig = "";
    elTransitionStatus.textContent = "";
    elTransitionStatus.className = "status";
  }
  if (transitionState.result) {
    const fresh = transitionSignature() === transitionState.resultKey;
    const old = elTransitionResult.querySelector(".stale-note");
    if (!fresh && !old) {
      const note = document.createElement("div");
      note.className = "stale-note";
      note.textContent = "参与规划的输入已变化，以下交换步骤已失效，请重新规划。";
      elTransitionResult.prepend(note);
    } else if (fresh && old) {
      old.remove();
    }
  }
  renderTransitionExec();
}

function transitionResultFresh() {
  if (!transitionState.result) return false;
  return transitionSignature() === transitionState.resultKey;
}

// 响应守卫：只有「当前在途请求」且「发出后参与输入未再变化」的响应可以落地。
// 请求序号取自永不归零的单调计数器，因此某请求完成（成功 / HTTP 错误 / 连接异常）
// 不会释放其序号：输入不变时连续规划，较早请求即便后返回也无法冒充成新请求，
// 其三种结局都只会被直接忽略，不触碰当前步骤、错误提示或加载状态。
function transitionResponseCurrent(reqId, reqSig) {
  return (
    transitionState.inflightId === reqId &&
    transitionState.inflightSig === reqSig &&
    transitionSignature() === reqSig
  );
}

async function runTransition() {
  // 发起重新规划：立即终止旧执行（已确认记录保留展示，输入不回滚，
  // 改回原值也不能续走；新规划成功落地后才允许再次开始执行）
  terminateTransitionExecution("replan");
  const limit = effectiveTransitionLimit();
  const payload = {
    layers: state.layers.map((l) => ({ id: l.id, color: l.color, opacity: l.opacity })),
    samples: state.samples.map((s) => ({ background: s.background, target: s.target })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
    currentOrder: transitionState.order,
    transitionLimit: limit,
  };
  // 从永不归零的单调计数器取得本次请求序号，并登记为当前在途请求；
  // 连续规划或输入变化时，旧请求即便后返回也不会覆盖较新结果（见 transitionResponseCurrent）。
  const reqId = ++transitionState.reqSeq;
  transitionState.inflightId = reqId;
  const reqSig = transitionSignature();
  transitionState.inflightSig = reqSig;

  elTransitionStatus.textContent = "规划中…";
  elTransitionStatus.className = "status busy";
  elTransitionErrors.hidden = true;
  renderTransitionExec(); // 规划请求在途期间禁止开始执行

  try {
    const resp = await fetch("/api/plan-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!transitionResponseCurrent(reqId, reqSig)) return;
    transitionState.inflightId = 0;
    transitionState.inflightSig = "";
    elTransitionStatus.textContent = "";
    elTransitionStatus.className = "status";
    if (!resp.ok) {
      showTransitionErrors(data.errors || [{ scope: "form", message: "规划失败" }]);
      renderTransitionExec();
      return;
    }
    transitionState.result = data;
    transitionState.resultKey = reqSig;
    // 新规划落地：旧执行（含已终止的记录）随之结束，等待用户重新开始
    transitionState.exec = null;
    renderTransitionResult(data);
    renderTransitionExec();
  } catch (err) {
    if (!transitionResponseCurrent(reqId, reqSig)) return;
    transitionState.inflightId = 0;
    transitionState.inflightSig = "";
    elTransitionStatus.textContent = "";
    elTransitionStatus.className = "status";
    showTransitionErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
    renderTransitionExec();
  }
}

function showTransitionErrors(errors) {
  elTransitionErrors.innerHTML =
    "<ul>" + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elTransitionErrors.hidden = false;
}

function renderTransitionResult(r) {
  elTransitionErrors.hidden = true;
  let html = `
    <div class="metric-row">
      <span>当前总误差：<b>${fmtSse(r.currentTotalSse)}</b></span>
      <span>目标总误差：<b>${fmtSse(r.targetTotalSse)}</b></span>
      <span>过渡总误差上限：<b>${fmtSse(r.transitionLimit)}</b></span>
      <span>合规叠序：<b>${r.feasibleCount}</b> 条</span>
      <span>上限内可停留：<b>${r.allowedCount}</b> 条</span>
    </div>
  `;

  if (r.alreadyTarget) {
    html += `
      <div class="suggest-none">当前实际叠序就是目标最优叠序，无需交换（0 步）。</div>`;
    elTransitionResult.innerHTML = html;
    return;
  }

  if (!r.reachable) {
    html += `
      <div class="review-incompat">目标叠序不可到达：${escapeHtml(r.message)}</div>`;
    elTransitionResult.innerHTML = html;
    return;
  }

  html += `
    <div class="suggest-sec-title">
      最少交换 <b>${r.stepCount}</b> 步
      （并列时按每步交换前「下方 ID, 上方 ID」对的字典序决胜；访问状态 ${r.statesVisited} 个）
    </div>`;

  // 起点（第 0 步）
  html += `<div class="transition-steps">`;
  html += renderTransitionStateBlock("起点", null, r.currentOrder, r.currentTotalSse, r.currentSamples);

  r.steps.forEach((st) => {
    html += renderTransitionStateBlock(
      `第 ${st.step} 步`,
      st,
      st.order,
      st.totalSse,
      st.samples
    );
  });
  html += `</div>`;
  elTransitionResult.innerHTML = html;
}

function renderTransitionStateBlock(tag, step, order, totalSse, samples) {
  const chips = order
    .map((id) => {
      const layer = layerById(id);
      const hex = (layer && normalizeHex(layer.color)) || "#000000";
      const op = layer && Number.isFinite(layer.opacity) ? layer.opacity : 1;
      const swapped =
        step && (id === step.swappedLowerId || id === step.swappedUpperId) ? " swapped" : "";
      return `
        <span class="chip${swapped}">
          <span class="dot" style="background:${hexToRgba(hex, op)}" title="${escapeHtml(id)}"></span>
          <span class="cid">${escapeHtml(id)}</span>
        </span>`;
    })
    .join('<span class="order-sep">↑</span>');

  let head;
  if (step) {
    head = `
      <div class="trans-step-head">
        <span class="trans-step-tag">${tag}</span>
        <span>交换相邻两层
          <b class="hexval">${escapeHtml(step.swappedLowerId)}</b>
          <span class="hint">（下）⇅</span>
          <b class="hexval">${escapeHtml(step.swappedUpperId)}</b>
          <span class="hint">（上）</span>
        </span>
        <span class="spacer"></span>
        <span class="review-meas">总误差 <b>${fmtSse(totalSse)}</b></span>
      </div>`;
  } else {
    head = `
      <div class="trans-step-head">
        <span class="trans-step-tag start">${tag}</span>
        <span class="hint">调整前叠序</span>
        <span class="spacer"></span>
        <span class="review-meas">总误差 <b>${fmtSse(totalSse)}</b></span>
      </div>`;
  }

  const sampleHtml = samples.map(renderSample).join("");
  return `
    <div class="trans-step">
      ${head}
      <div class="checker"><div class="order-chips">
        <span class="order-ends">底</span>${chips}<span class="order-ends">↑ 顶</span>
      </div></div>
      ${sampleHtml}
    </div>`;
}

// ---------------------------------------------------------- 过渡执行（逐步确认） --
//
// 执行会话只保存在当前页面内存中（刷新即清空），不持久化。开始执行时固定起始
// 叠序、目标叠序、有效上限与全部步骤（快照）；确认步骤把该步叠序写回当前叠序
// 控件并推进。图层 / 样本 / 先后关系 / 过渡上限变化、手动调整或重置当前叠序、
// 重新发起规划都会立即终止会话：已确认记录保留展示、输入不回滚，改回原值也
// 不能续走，必须重新规划后才能开始新的执行。

// 终止当前执行会话（若有且仍在进行）：已确认记录保留展示，输入不回滚；
// 一旦终止即不可续走（改回原值也一样），须重新规划后开始新的执行。
function terminateTransitionExecution(reason) {
  const exec = transitionState.exec;
  if (!exec || exec.terminated || exec.done) return; // 已完成 / 已终止的不重复处理
  exec.terminated = true;
  exec.terminateReason = reason;
  renderTransitionExec();
}

// 开始执行：仅当「当前规划有效、可达且没有规划请求在等待」时可用；
// 执行期间（未终止也未完成）不能再次开始；已终止的执行必须重新规划后才可再开始。
function startTransitionExecution() {
  const r = transitionState.result;
  if (!r || !transitionResultFresh() || !r.reachable) return;
  if (transitionState.inflightId !== 0) return;
  const prev = transitionState.exec;
  if (prev && !prev.done) return;
  const steps = Array.isArray(r.steps) ? r.steps : [];
  // 登记前计算指纹：此时无激活执行，签名使用实时当前叠序（即起始叠序）
  const signature = transitionSignature();
  transitionState.exec = {
    startOrder: [...r.currentOrder],  // 固定起始叠序
    targetOrder: [...r.targetOrder],  // 固定目标叠序
    limit: r.transitionLimit,         // 固定有效上限
    steps: steps.map((st) => ({       // 固定执行步骤
      step: st.step,
      swappedLowerId: st.swappedLowerId,
      swappedUpperId: st.swappedUpperId,
      order: [...st.order],
      totalSse: st.totalSse,
    })),
    confirmedCount: 0,                // 已确认（完成）步数
    done: steps.length === 0,         // 空路径直接完成
    terminated: false,
    terminateReason: "",
    signature,
  };
  renderTransitionExec();
}

// 确认当前一步：把该步交换后的叠序写回原「当前实际叠序」控件并推进；
// 只能按顺序确认当前步，同一步重复确认只计一次；全部确认后标为完成。
function confirmTransitionStep(k) {
  const exec = transitionState.exec;
  if (!exec || exec.terminated || exec.done) return;
  if (k !== exec.confirmedCount) return; // 已确认过的步再确认只计一次（忽略）
  const step = exec.steps[k];
  if (!step) return;
  exec.confirmedCount += 1;
  if (exec.confirmedCount >= exec.steps.length) exec.done = true;
  // 执行写回不视为手动调整，不终止执行（指纹中叠序已冻结）；余下执行步骤仍可用
  transitionState.order = [...step.order];
  renderTransitionControls(lastSolveResult || { order: exec.targetOrder, totalSse: exec.limit });
  renderTransitionExec();
}

// 渲染执行区：无执行记录时只显示「开始执行」控制；有执行记录时显示执行面板
function renderTransitionExec() {
  const r = transitionState.result;
  const exec = transitionState.exec;
  if (!exec && !r) {
    elTransitionExec.innerHTML = "";
    return;
  }
  let html = exec ? renderTransitionExecPanel(exec) : "";
  // 开始控制：未开始过、或上次执行已完成时可出现；已终止的执行须重新规划
  // （新规划落地会清空执行记录）后才允许再开始
  if (r && (!exec || exec.done)) {
    const busy = transitionState.inflightId !== 0;
    const fresh = transitionResultFresh();
    const canStart = fresh && r.reachable && !busy;
    let hint;
    if (busy) hint = "规划请求进行中，待其返回后才能开始";
    else if (!fresh) hint = "当前规划已失效，不能开始，请重新规划";
    else if (!r.reachable) hint = "目标叠序不可到达，不能开始执行";
    else if (exec && exec.done) hint = "本次执行已完成；再次开始将重新固定起始叠序、目标、上限与步骤";
    else if (r.stepCount === 0) hint = "当前已是目标叠序：空路径，开始后将直接完成";
    else hint = `将固定起始叠序、目标、有效上限与 ${r.stepCount} 步交换路径，逐步确认执行`;
    html += `
      <div class="infer-actions exec-start-row">
        <button class="btn btn-small" data-act="transition-exec-start" type="button"
                ${canStart ? "" : "disabled"}>开始执行</button>
        <span class="hint">${hint}</span>
      </div>`;
  }
  elTransitionExec.innerHTML = html;
}

function execTerminateReasonText(reason) {
  return {
    input: "图层、样本、先后关系或过渡上限已变化",
    order: "当前实际叠序被手动调整或重置",
    replan: "已发起重新规划",
  }[reason] || "参与规划的输入已变化";
}

function execOrderChips(ids) {
  const chips = ids
    .map((id) => {
      const layer = layerById(id);
      const hex = (layer && normalizeHex(layer.color)) || "#000000";
      const op = layer && Number.isFinite(layer.opacity) ? layer.opacity : 1;
      return `
        <span class="chip">
          <span class="dot" style="background:${hexToRgba(hex, op)}" title="${escapeHtml(id)}"></span>
          <span class="cid">${escapeHtml(id)}</span>
        </span>`;
    })
    .join('<span class="order-sep">↑</span>');
  return `<span class="checker exec-chips"><span class="order-chips">` +
    `<span class="order-ends">底</span>${chips}<span class="order-ends">↑ 顶</span></span></span>`;
}

function renderTransitionExecPanel(exec) {
  const total = exec.steps.length;
  const doneN = exec.confirmedCount;
  const tag = exec.terminated ? "已终止" : exec.done ? "已完成" : "执行中";
  const tagCls = exec.terminated ? "exec-tag-terminated" : exec.done ? "exec-tag-done" : "exec-tag-active";

  // 下一次交换（仅执行中有）
  let nextHtml;
  if (exec.terminated) {
    nextHtml = '<span class="hint">执行已终止，无下一次交换</span>';
  } else if (exec.done) {
    nextHtml = `<span class="hint">无剩余交换：全部 ${total} 步已确认</span>`;
  } else {
    const st = exec.steps[doneN];
    nextHtml = `
      <span>下一次交换：第 <b>${doneN + 1}</b> 步 — 交换
        <b class="hexval">${escapeHtml(st.swappedLowerId)}</b><span class="hint">（下）</span>
        <span class="exec-swap-arrow">⇅</span>
        <b class="hexval">${escapeHtml(st.swappedUpperId)}</b><span class="hint">（上）</span>
      </span>
      <button class="btn btn-small" data-act="transition-exec-confirm" data-step="${doneN}"
              type="button">确认当前一步</button>`;
  }

  const stepRows = exec.steps
    .map((st, k) => {
      const confirmed = k < doneN;
      const isCurrent = !exec.terminated && !exec.done && k === doneN;
      const cls = confirmed ? "exec-step-confirmed" : isCurrent ? "exec-step-current" : "exec-step-pending";
      const statusTxt = confirmed ? "已确认" : isCurrent ? "当前步" : "待确认";
      const confirmBtn = isCurrent
        ? `<button class="btn btn-small" data-act="transition-exec-confirm" data-step="${k}"
                   type="button">确认此步</button>`
        : "";
      return `
        <div class="exec-step-row ${cls}">
          <span class="exec-step-status">${statusTxt}</span>
          <span>第 ${k + 1} 步：交换
            <b class="hexval">${escapeHtml(st.swappedLowerId)}</b><span class="hint">（下）</span>
            <span class="exec-swap-arrow">⇅</span>
            <b class="hexval">${escapeHtml(st.swappedUpperId)}</b><span class="hint">（上）</span>
          </span>
          <span class="exec-step-order hexval">${st.order.map(escapeHtml).join(" ↑ ")}</span>
          <span class="hint">总误差 ${fmtSse(st.totalSse)}</span>
          <span class="spacer"></span>
          ${confirmBtn}
        </div>`;
    })
    .join("");

  const terminatedNote = exec.terminated
    ? `<div class="exec-terminated-note">
        执行已终止（${execTerminateReasonText(exec.terminateReason)}）。已确认记录保留如上，
        图层、样本、上限与当前叠序等输入均未回滚；即使改回原值也不能续走，须重新规划后开始新的执行。
      </div>`
    : "";

  return `
    <div class="exec-panel">
      <div class="exec-head">
        <span class="exec-tag ${tagCls}">${tag}</span>
        <span>已完成 <b>${doneN}</b> / <b>${total}</b> 步</span>
        <span>有效上限 <b>${fmtSse(exec.limit)}</b></span>
      </div>
      <div class="exec-row">
        <span class="hint">当前实际叠序（与上方当前叠序控件同步）：</span>
        ${execOrderChips(transitionState.order)}
      </div>
      <div class="exec-row exec-next-row">${nextHtml}</div>
      <div class="exec-row">
        <span class="hint">固定起始叠序：</span>${execOrderChips(exec.startOrder)}
      </div>
      <div class="exec-row">
        <span class="hint">固定目标叠序：</span>${execOrderChips(exec.targetOrder)}
      </div>
      <div class="exec-steps">
        <div class="exec-step-row exec-step-start">
          <span class="exec-step-status">起点</span>
          <span class="exec-step-order hexval">${exec.startOrder.map(escapeHtml).join(" ↑ ")}</span>
          <span class="hint">起始叠序（第 0 步，未交换）</span>
        </div>
        ${stepRows}
      </div>
      ${terminatedNote}
    </div>`;
}

// ====================================================== 下一次背景测量建议 ==

const suggestState = {
  candidates: ["#ffffff", "#000000"], // 候选背景 HEX（按录入原样保存，提交时由后端规范化校验）
  tolerance: 0,                       // 误差容差（非负有限数字；非法输入保留原样交后端报错）
  result: null,                       // 最近一次成功返回
  resultKey: "",                      // 结果产生时的输入指纹
};

const elSuggestResult = $("#suggestResult");
const elSuggestErrors = $("#suggestErrors");
const elSuggestStatus = $("#suggestStatus");

function suggestSignature() {
  // 用于判断已有建议是否对应当前输入
  return JSON.stringify({
    layers: state.layers,
    samples: state.samples,
    relations: state.relations,
    candidates: suggestState.candidates,
    tolerance: suggestState.tolerance,
  });
}

function renderSuggestControls() {
  const box = $("#suggestCands");
  box.innerHTML = "";
  suggestState.candidates.forEach((cand, i) => {
    const hx = normalizeHex(cand);
    const row = document.createElement("div");
    row.className = "sample-row";
    row.innerHTML = `
      <span class="row-index">${i + 1}</span>
      <input type="color" data-act="suggest-picker" data-i="${i}"
             value="${hx || "#000000"}" title="选色" />
      <input class="hex-input" data-act="suggest-hex" data-i="${i}" type="text"
             value="${escapeHtml(cand)}" placeholder="#RRGGBB" />
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="suggest-remove" data-i="${i}"
              type="button" ${suggestState.candidates.length <= MIN_CANDIDATES ? "disabled" : ""}>删除</button>
    `;
    box.appendChild(row);
  });
  $("#addSuggestCandBtn").disabled = suggestState.candidates.length >= MAX_CANDIDATES;
  refreshSuggestCandValidity();
}

// 不重绘行、就地切换非法/重复标记，避免打断输入焦点
function refreshSuggestCandValidity() {
  const inputs = [...document.querySelectorAll('input[data-act="suggest-hex"]')];
  const norms = inputs.map((el) => normalizeHex(el.value));
  const counts = {};
  norms.forEach((hx) => {
    if (hx) counts[hx] = (counts[hx] || 0) + 1;
  });
  inputs.forEach((el, k) => {
    const hx = norms[k];
    el.classList.toggle("invalid", !hx || counts[hx] > 1);
    el.title = hx && counts[hx] > 1 ? "候选背景规范化后重复" : "";
  });
}

function markSuggestStaleness() {
  if (!suggestState.result) return;
  const fresh = suggestSignature() === suggestState.resultKey;
  const old = elSuggestResult.querySelector(".stale-note");
  if (!fresh && !old) {
    const note = document.createElement("div");
    note.className = "stale-note";
    note.textContent = "输入已变化，以下建议可能过期，请重新计算。";
    elSuggestResult.prepend(note);
  } else if (fresh && old) {
    old.remove();
  }
}

async function runSuggest() {
  const payload = {
    layers: state.layers.map((l) => ({ id: l.id, color: l.color, opacity: l.opacity })),
    samples: state.samples.map((s) => ({ background: s.background, target: s.target })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
    candidateBackgrounds: [...suggestState.candidates],
    tolerance: suggestState.tolerance,
  };
  elSuggestStatus.textContent = "计算中…";
  elSuggestStatus.className = "status busy";
  elSuggestErrors.hidden = true;

  try {
    const resp = await fetch("/api/suggest-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    elSuggestStatus.textContent = "";
    elSuggestStatus.className = "status";
    if (!resp.ok) {
      showSuggestErrors(data.errors || [{ scope: "form", message: "建议计算失败" }]);
      return;
    }
    suggestState.result = data;
    suggestState.resultKey = suggestSignature();
    renderSuggestResult(data);
  } catch (err) {
    elSuggestStatus.textContent = "";
    elSuggestStatus.className = "status";
    showSuggestErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showSuggestErrors(errors) {
  elSuggestErrors.innerHTML =
    "<ul>" + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elSuggestErrors.hidden = false;
}

function renderSuggestResult(r) {
  const orderRows = r.orders
    .map(
      (o, k) => `
        <div class="suggest-order-row">
          <span class="row-index">${k + 1}</span>
          <span class="suggest-order-ids">${o.order.map(escapeHtml).join(" ↑ ")}</span>
          <span class="hint">总误差 ${fmtSse(o.totalSse)}</span>
        </div>`
    )
    .join("");

  let html = `
    <div class="metric-row">
      <span>最优总误差：<b>${fmtSse(r.bestSse)}</b></span>
      <span>容差：<b>${fmtSse(r.tolerance)}</b></span>
      <span>符合容差的叠序总数：<b>${r.withinCount}</b>（可行共 ${r.feasibleCount} 条）</span>
      <span>按总误差、ID 序列排序，展示前 <b>${r.orders.length}</b> 条</span>
    </div>
    <div class="suggest-orders">${orderRows}</div>
  `;

  if (!r.needsMeasurement) {
    html += `
      <div class="suggest-none">容差内不足两条叠序，当前样本已能唯一区分叠放顺序，无需追加背景测量。</div>`;
    elSuggestResult.innerHTML = html;
    return;
  }

  const rec = r.recommended;
  const candRows = r.candidates
    .map((c) => {
      const isRec = rec && c.hex === rec.hex;
      return `
        <div class="suggest-cand-row ${isRec ? "rec" : ""}">
          <span class="mini" style="background:${c.hex}"></span>
          <span class="hexval">${c.hex}</span>
          <span class="suggest-score">最小平方距离得分 <b>${fmtSse(c.score)}</b></span>
          ${isRec ? '<span class="rec-badge">推荐</span>' : ""}
        </div>`;
    })
    .join("");

  html += `
    <div class="suggest-sec-title">各候选背景得分（任意两条预测色未取整 RGB 平方距离的最小值，越大越易区分）</div>
    <div class="suggest-cand-list">${candRows}</div>
    <div class="suggest-sec-title">
      推荐下一次测量背景
      <span class="mini" style="background:${rec.hex}"></span>
      <b class="hexval">${rec.hex}</b>
      ，其最难区分的一对叠序：
    </div>
    <div class="compare suggest-pair">
      ${suggestPairCell(rec.pair.a)}
      <div class="compare-arrow">⇄</div>
      ${suggestPairCell(rec.pair.b)}
    </div>
    <div class="hint suggest-pair-note">
      两者在 ${rec.hex} 上的未取整 RGB 平方距离为 ${fmtSse(rec.score)}；
      在该背景下补测一次，可最大程度拉开这对顺序的预测色差距。
    </div>
  `;
  elSuggestResult.innerHTML = html;
}

function suggestPairCell(side) {
  const rgbTxt = side.predictedRgb.map((v) => Math.round(v)).join(", ");
  return `
    <div class="swatch-box">
      <span class="swatch-big" style="background:${side.predictedHex}"></span>
      <span class="swatch-meta">
        <div class="name">${side.order.map(escapeHtml).join(" ↑ ")}</div>
        <div class="hexval">${side.predictedHex}</div>
        <div class="name">rgb(${rgbTxt})</div>
      </span>
    </div>`;
}

// ====================================================== 实测颜色复核 ==

const reviewState = {
  selectedBackground: "",   // 选定的候选背景规范化 HEX
  measuredColor: "#808080", // 实测目标色（按录入原样保存，提交时由后端校验）
  measurementLimit: 1,      // 新测量误差上限（非负有限；非法原样交后端报错）
  result: null,             // 最近一次成功返回
  resultKey: "",            // 结果产生时的输入指纹
};

const elReviewResult = $("#reviewResult");
const elReviewErrors = $("#reviewErrors");
const elReviewStatus = $("#reviewStatus");
const elReviewBgSelect = $("#reviewBgSelect");

function reviewSignature() {
  // 用于判断已有复核结果是否对应当前输入
  return JSON.stringify({
    layers: state.layers,
    samples: state.samples,
    relations: state.relations,
    candidates: suggestState.candidates,
    tolerance: suggestState.tolerance,
    selectedBackground: reviewState.selectedBackground,
    measuredColor: reviewState.measuredColor,
    measurementLimit: reviewState.measurementLimit,
  });
}

// 复核下拉只列候选背景中规范化后合法且不重复的 HEX
function validReviewCandidates() {
  const seen = new Set();
  const out = [];
  suggestState.candidates.forEach((raw) => {
    const hx = normalizeHex(raw);
    if (hx && !seen.has(hx)) {
      seen.add(hx);
      out.push(hx);
    }
  });
  return out;
}

function renderReviewBgOptions() {
  const options = validReviewCandidates();
  if (!options.includes(reviewState.selectedBackground)) {
    reviewState.selectedBackground = options[0] || "";
  }
  elReviewBgSelect.innerHTML = options.length
    ? options.map((hx) => `<option value="${hx}">${hx}</option>`).join("")
    : '<option value="">（候选背景均非法，请先修正上方候选）</option>';
  elReviewBgSelect.value = reviewState.selectedBackground;
}

function markReviewStaleness() {
  if (!reviewState.result) return;
  const fresh = reviewSignature() === reviewState.resultKey;
  const old = elReviewResult.querySelector(".stale-note");
  if (!fresh && !old) {
    const note = document.createElement("div");
    note.className = "stale-note";
    note.textContent = "参与复核的输入已变化，以下复核结果已失效，请重新复核（旧结果不能再用于追加样本）。";
    elReviewResult.prepend(note);
  } else if (fresh && old) {
    old.remove();
  }
  // 追加按钮的可用状态随失效状态同步
  const appendBtn = elReviewResult.querySelector('button[data-act="review-append"]');
  if (appendBtn) {
    const canAppend = fresh && reviewState.result.canAppendSample;
    appendBtn.disabled = !canAppend;
  }
}

function reviewResultFresh() {
  if (!reviewState.result) return false;
  return reviewSignature() === reviewState.resultKey;
}

async function runReview() {
  const payload = {
    layers: state.layers.map((l) => ({ id: l.id, color: l.color, opacity: l.opacity })),
    samples: state.samples.map((s) => ({ background: s.background, target: s.target })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
    candidateBackgrounds: [...suggestState.candidates],
    tolerance: suggestState.tolerance,
    selectedBackground: reviewState.selectedBackground,
    measuredColor: reviewState.measuredColor,
    measurementLimit: reviewState.measurementLimit,
  };
  elReviewStatus.textContent = "复核中…";
  elReviewStatus.className = "status busy";
  elReviewErrors.hidden = true;

  try {
    const resp = await fetch("/api/review-measurement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    elReviewStatus.textContent = "";
    elReviewStatus.className = "status";
    if (!resp.ok) {
      showReviewErrors(data.errors || [{ scope: "form", message: "复核失败" }]);
      return;
    }
    reviewState.result = data;
    reviewState.resultKey = reviewSignature();
    renderReviewResult(data);
  } catch (err) {
    elReviewStatus.textContent = "";
    elReviewStatus.className = "status";
    showReviewErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showReviewErrors(errors) {
  elReviewErrors.innerHTML =
    "<ul>" + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elReviewErrors.hidden = false;
}

function renderReviewResult(r) {
  const fresh = reviewResultFresh();
  let html = `
    <div class="metric-row">
      <span>复核背景：<b>${r.selectedBackground}</b></span>
      <span>实测目标色：<b class="hexval">${r.measuredColor}</b></span>
      <span>新测量误差上限：<b>${fmtSse(r.measurementLimit)}</b></span>
      <span>建议容差：<b>${fmtSse(r.tolerance)}</b></span>
    </div>
    <div class="metric-row">
      <span>合规叠序：<b>${r.feasibleCount}</b> 条</span>
      <span>容差内（筛选前）：<b>${r.withinCount}</b> 条</span>
      <span>新测量上限内（筛选后）：<b>${r.matchedCount}</b> 条</span>
      <span>按新测量误差、旧总误差、ID 序列排序，展示前 <b>${r.shownCount}</b> 条
        （筛选覆盖全部 ${r.withinCount} 条，未因展示截断而漏检）</span>
    </div>
  `;

  if (!r.compatible) {
    html += `
      <div class="review-incompat">
        实测色 ${r.measuredColor} 在背景 ${r.selectedBackground} 上与现有候选不相容：
        容差内的 ${r.withinCount} 条叠序在该背景上的预测色，新测量误差均超过上限
        ${fmtSse(r.measurementLimit)}。请检查实测颜色 / 误差上限 / 候选背景，或调整图层与旧样本。
      </div>`;
    elReviewResult.innerHTML = html;
    return;
  }

  const orderRows = r.orders
    .map((o, k) => {
      const rgbTxt = o.predictedRgb.map((v) => Math.round(v)).join(", ");
      return `
        <div class="review-order-row">
          <span class="row-index">${k + 1}</span>
          <span class="mini" style="background:${o.predictedHex}"></span>
          <span class="review-order-ids">${o.order.map(escapeHtml).join(" ↑ ")}</span>
          <span class="hint">旧总误差 ${fmtSse(o.oldTotalSse)}</span>
          <span class="review-meas">新测量误差 <b>${fmtSse(o.measurementSse)}</b></span>
          <span class="spacer"></span>
          <span class="hexval">${o.predictedHex}</span>
          <span class="hint">rgb(${rgbTxt})</span>
        </div>`;
    })
    .join("");
  html += `<div class="review-orders">${orderRows}</div>`;

  if (r.canAppendSample) {
    html += `
      <div class="review-append-row">
        <button class="btn btn-small" data-act="review-append" type="button"
                ${fresh ? "" : "disabled"}>把本次测量追加为第 ${r.sampleCount + 1} 组样本并重新求解</button>
        <span class="hint">当前 ${r.sampleCount} 组旧样本（少于 4 组）；追加后旧复核结果即失效</span>
      </div>`;
  } else {
    html += `
      <div class="hint review-append-row">
        旧样本已有 ${r.sampleCount} 组（上限 4 组），不能再追加；如需纳入本次测量，请先在左侧样本区替换或删除一组。
      </div>`;
  }

  elReviewResult.innerHTML = html;
  if (!fresh) markReviewStaleness();
}

function appendReviewSample() {
  const r = reviewState.result;
  if (!r || !reviewResultFresh() || !r.canAppendSample) return;
  // 以「选定候选背景 + 实测目标色」追加为一组新样本，随后触发原求解；
  // 追加即输入变化，复核与建议结果一并失效，不能再用于下一次追加。
  state.samples.push({ background: r.selectedBackground, target: r.measuredColor });
  render();
  noteSolveInputChanged();
  markCycleStaleness();
  markInferStaleness();
  markSuggestStaleness();
  renderSuggestControls();
  markReviewStaleness();
  markTransitionStaleness();
  markExtractStaleness();
  runSolve();
}

// ======================================================== 成环解除方案 ==

const cycleState = {
  plan: null,          // 最近一次成功获取的待确认方案（含冲突链与待删对）
  planKey: "",         // 方案产生时的输入指纹（图层 / 样本 / 关系）
  invalidated: false,  // 方案展示后输入是否曾变化过：一旦置位，改回原值也不复活
  planReqId: 0,        // 当前仍可落地的在途「方案」请求序号；0 表示无
  planReqEpoch: 0,     // 在途方案请求发出时的输入纪元
  confirmReqId: 0,     // 当前仍可落地的在途「确认」请求序号；0 表示无
  confirmReqEpoch: 0,  // 在途确认请求发出时的输入纪元
  reqSeq: 0,           // 单调递增的请求序号源（方案/确认共用），永不归零
};

// 是否有在途的方案或确认请求
function cycleBusy() {
  return cycleState.planReqId !== 0 || cycleState.confirmReqId !== 0;
}

const elCycleCard = $("#cycleCard");
const elCycleResult = $("#cycleResult");
const elCycleErrors = $("#cycleErrors");
const elCycleStatus = $("#cycleStatus");

function cycleSignature(payload) {
  // 方案仅取决于当前图层、样本与关系
  return JSON.stringify({
    layers: payload.layers,
    samples: payload.samples,
    relations: payload.relations,
  });
}

function clearCyclePlan() {
  cycleState.plan = null;
  cycleState.planKey = "";
  cycleState.invalidated = false;
  cycleState.planReqId = 0;
  cycleState.planReqEpoch = 0;
  cycleState.confirmReqId = 0;
  cycleState.confirmReqEpoch = 0;
  elCycleCard.hidden = true;
  elCycleResult.innerHTML = "";
  elCycleErrors.hidden = true;
  elCycleStatus.textContent = "";
  elCycleStatus.className = "status";
}

// 输入（图层 / 样本 / 关系）变化时：在途的方案 / 确认请求若发出纪元与当前不一致则
// 立即作废（加载态随之结束，旧响应——无论成功、HTTP 错误、连接异常还是解析失败——
// 都在响应守卫处被丢弃）；纪元只增不减，改回原值也不能让旧请求复活。
// 已展示方案一旦在获取后发生过任何变化即永久作废——改回原值也不能恢复确认资格。
// reqSeq 永不归零。
function markCycleStaleness() {
  const sig = cycleSignature(buildSolvePayload());
  if (cycleState.planReqId !== 0 && solveInputEpoch !== cycleState.planReqEpoch) {
    cycleState.planReqId = 0;
    cycleState.planReqEpoch = 0;
  }
  if (cycleState.confirmReqId !== 0 && solveInputEpoch !== cycleState.confirmReqEpoch) {
    cycleState.confirmReqId = 0;
    cycleState.confirmReqEpoch = 0;
  }
  if (!cycleBusy()) {
    elCycleStatus.textContent = "";
    elCycleStatus.className = "status";
  }
  if (!cycleState.plan) return;
  if (sig !== cycleState.planKey) cycleState.invalidated = true;
  const dead = cycleState.invalidated;
  const old = elCycleResult.querySelector(".stale-note");
  const btn = elCycleResult.querySelector('button[data-act="cycle-confirm"]');
  if (dead) {
    if (!old) {
      const note = document.createElement("div");
      note.className = "stale-note";
      note.textContent = "图层、样本或关系已变化，以下解除方案已作废（即使改回原值也不能再确认），请等待新方案。";
      elCycleResult.prepend(note);
    }
    if (btn) btn.disabled = true;
  } else if (old) {
    old.remove();
    if (btn) btn.disabled = false;
  }
}

function cyclePlanFresh() {
  return !!cycleState.plan &&
    !cycleState.invalidated &&
    cycleSignature(buildSolvePayload()) === cycleState.planKey;
}

// 响应守卫：只有「当前在途的该类请求」且「发出后输入纪元未变」的响应可以
// 更新方案 / 关系 / 结果 / 错误 / 加载状态；旧请求无论成功、HTTP 错误、
// 连接异常还是解析失败都丢弃。判定在响应体读完之后进行，读取期间发生的变化同样作数。
function cycleResponseCurrent(kind, reqId, reqEpoch) {
  const id = kind === "confirm" ? cycleState.confirmReqId : cycleState.planReqId;
  return id === reqId && reqEpoch === solveInputEpoch;
}

async function runCyclePlan(payload, opts = {}) {
  // silentOnError：作为自动求解的伴随请求时，业务 400（其他非法输入）不单独
  // 在卡片内报错——同样的错误已由顶部错误横幅展示；这里只需隐藏方案卡片。
  const silentOnError = !!opts.silentOnError;
  const reqId = ++cycleState.reqSeq;
  cycleState.planReqId = reqId;
  const reqSig = cycleSignature(payload); // 仅用于记录方案对应的输入指纹（planKey）
  const reqEpoch = solveInputEpoch;
  cycleState.planReqEpoch = reqEpoch;

  elCycleCard.hidden = false;
  elCycleErrors.hidden = true;
  elCycleStatus.textContent = "分析解除方案中…";
  elCycleStatus.className = "status busy";
  elCycleResult.innerHTML = `<div class="result-empty">正在从至多 ${MAX_RELATIONS} 条关系中寻找删去条数最少的一组…</div>`;

  try {
    const resp = await fetch("/api/resolve-cycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!cycleResponseCurrent("plan", reqId, reqEpoch)) return;
    const data = await resp.json();
    // 响应体读取期间输入可能又变、或较新请求已发出：落地前必须再过一次守卫
    if (!cycleResponseCurrent("plan", reqId, reqEpoch)) return;
    cycleState.planReqId = 0;
    cycleState.planReqEpoch = 0;
    elCycleStatus.textContent = "";
    elCycleStatus.className = "status";
    if (!resp.ok) {
      // 其他非法输入仍按现有规则报错：自动伴随模式下交给顶部横幅，这里仅隐藏卡片
      if (!silentOnError) {
        showCycleErrors(data.errors || [{ scope: "form", message: "解除方案分析失败" }]);
        elCycleResult.innerHTML =
          '<div class="result-empty">请先按顶部错误提示修正输入，再获取解除方案。</div>';
      }
      cycleState.plan = null;
      cycleState.planKey = "";
      cycleState.invalidated = false;
      elCycleCard.hidden = true;
      elCycleResult.innerHTML = "";
      return;
    }
    if (!data.cyclic) {
      // 无环：空方案，不展示卡片
      clearCyclePlan();
      return;
    }
    cycleState.plan = data;
    cycleState.planKey = reqSig;
    cycleState.invalidated = false;
    renderCyclePlan(data, true);
  } catch (err) {
    if (!cycleResponseCurrent("plan", reqId, reqEpoch)) return;
    cycleState.planReqId = 0;
    cycleState.planReqEpoch = 0;
    elCycleStatus.textContent = "";
    elCycleStatus.className = "status";
    showCycleErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showCycleErrors(errors) {
  elCycleErrors.innerHTML =
    "<ul>" + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elCycleErrors.hidden = false;
}

function renderCyclePlan(plan, fresh) {
  elCycleErrors.hidden = true;
  const rows = plan.removePairs
    .map((p, k) => `
      <div class="cycle-pair-row${p.selfLoop ? " self-loop" : ""}">
        <span class="row-index">${k + 1}</span>
        <b class="hexval">${escapeHtml(p.lower)}</b>
        <span class="relation-arrow">${p.selfLoop ? "↺ 自环（下方与上方是同一图层）" : "在更下方 ▲ 叠在"}</span>
        ${p.selfLoop ? "" : `<b class="hexval">${escapeHtml(p.upper)}</b><span class="relation-arrow">之上</span>`}
        <span class="spacer"></span>
        <span class="hint">同向重复 ${p.occurrences} 条将一并移除</span>
      </div>`)
    .join("");

  elCycleResult.innerHTML = `
    <div class="cycle-conflict">
      当前冲突链（底 → 顶）：<b class="hexval">${escapeHtml(plan.conflictChain)}</b>
    </div>
    <div class="suggest-sec-title">
      待确认解除方案：删除 <b>${plan.removeCount}</b> 种关系
      （覆盖 ${plan.removedOccurrences} 条同向重复输入；去重后共 ${plan.relationCount} 条关系）——
      已保证删去种数最少且剩余关系无环，并列时取关系对列表字典序最小者
    </div>
    <div class="rows cycle-pairs">${rows}</div>
    <div class="infer-actions">
      <button class="btn btn-small" data-act="cycle-confirm" type="button"
              ${fresh ? "" : "disabled"}>确认并移除这些关系后重新求解</button>
      <span class="hint">不会自动修改；确认前其他输入保持原样，确认后一次性移除上述各对的全部重复项并触发原求解</span>
    </div>
  `;
  if (!fresh) markCycleStaleness();
}

async function confirmCyclePlan() {
  const plan = cycleState.plan;
  if (!plan || !cyclePlanFresh()) return;
  if (cycleState.confirmReqId !== 0) return; // 确认已在途，防重复点击

  const payload = buildSolvePayload();
  const reqId = ++cycleState.reqSeq;
  cycleState.confirmReqId = reqId;
  const reqEpoch = solveInputEpoch;
  cycleState.confirmReqEpoch = reqEpoch;
  // 确认是较新请求：此前发出、尚未返回的求解响应一律作废，不得覆盖确认后的结果
  inflightToken += 1;

  const body = {
    ...payload,
    removePairs: plan.removePairs.map((p) => ({ lower: p.lower, upper: p.upper })),
  };

  // 确认在途期间禁用按钮，待其成功（卡片随结果清除）或失败 / 作废后再处理
  const confirmBtnEl = elCycleResult.querySelector('button[data-act="cycle-confirm"]');
  if (confirmBtnEl) confirmBtnEl.disabled = true;
  elCycleStatus.textContent = "确认移除并重新求解中…";
  elCycleStatus.className = "status busy";
  elCycleErrors.hidden = true;

  try {
    const resp = await fetch("/api/confirm-cycle-resolution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!cycleResponseCurrent("confirm", reqId, reqEpoch)) return;
    const data = await resp.json();
    // 响应体读取期间输入可能又变：落地前必须再过一次守卫，
    // 过期确认不得移除关系、覆盖结果或结束较新请求的加载状态
    if (!cycleResponseCurrent("confirm", reqId, reqEpoch)) return;
    cycleState.confirmReqId = 0;
    cycleState.confirmReqEpoch = 0;
    elCycleStatus.textContent = "";
    elCycleStatus.className = "status";
    if (!resp.ok) {
      showCycleErrors(data.errors || [{ scope: "form", message: "确认解除失败" }]);
      // 服务端认定方案已不匹配当前输入：本地同步作废，须重新获取方案
      cycleState.plan = null;
      cycleState.planKey = "";
      cycleState.invalidated = false;
      elCycleResult.innerHTML =
        '<div class="result-empty">解除方案已失效，请在当前输入下重新获取方案。</div>';
      return;
    }
    // 一次性移除这些对的全部重复项（按规范化 ID 匹配），保留其他输入
    const removeSet = new Set(plan.removePairs.map((p) => `${p.lower.trim()} ${p.upper.trim()}`));
    state.relations = state.relations.filter(
      (r) => !removeSet.has(`${String(r.lower).trim()} ${String(r.upper).trim()}`)
    );
    noteSolveInputChanged(); // 关系已移除：此前发出的求解等在途请求一律作废
    render();
    markInferStaleness();
    markSuggestStaleness();
    markReviewStaleness();
    markTransitionStaleness();
    clearCyclePlan();
    showErrors([]);
    lastSolveResult = data;
    // 确认成功后移除关系并触发纪元 +1，data 正是新输入下的有效求解结果：
    // 以当前纪元锚定，合成预览可立即使用该顺序
    lastSolveEpoch = solveInputEpoch;
    updateCompositeRunBtn();
    renderResult(data);
  } catch (err) {
    if (!cycleResponseCurrent("confirm", reqId, reqEpoch)) return;
    cycleState.confirmReqId = 0;
    cycleState.confirmReqEpoch = 0;
    elCycleStatus.textContent = "";
    elCycleStatus.className = "status";
    showCycleErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

// ============================================================ 背景图片合成预览 ==

// 把「当前有效的最佳叠序」（最近一次成功求解、且仍对应当前校准输入的 order）
// 叠到上传的背景图每个像素上。
//
// 失效与请求竞态规则（与求解 / 反推 / 过渡同样严格）：
//  - 合成纪元 epoch：图层、样本、关系（noteSolveInputChanged 内同步 +1 并立即
//    调 markCompositeStaleness）或已选图片（选择的第一时间，先于解码）每次变化
//    都 +1，只增不减；旧预览下载资格与在途合成资格立即撤销，即使把输入或图片
//    改回原值也不会恢复（纪元不回落）。
//  - 有效求解顺序：lastSolveResult 锚定其产生时的求解输入纪元 lastSolveEpoch；
//    只有 lastSolveEpoch === solveInputEpoch 时该顺序才可用于生成。新求解在途、
//    求解失败（HTTP 400）、连接异常或输入非法期间一律禁用，直接调用 runComposite
//    也不发请求。
//  - 合成请求 reqSeq：永不归零的单调序号；连续选图 / 生成只接纳「最近一次且相关
//    输入始终未变」的操作，上传、图片解码或响应体读取期间输入 / 图片发生变化也
//    丢弃旧操作——无论成功、HTTP 错误、连接异常还是解析失败，都不改动预览、错误
//    或较新操作的加载状态。
//  - 生成失败不改动任何校准输入。
const compositeState = {
  file: null,          // 当前选中的 File（未重新上传即不变）
  fileMeta: "",        // 展示用「文件名 W×H」
  epoch: 0,            // 图层 / 样本 / 关系 / 图片纪元（只增不减）
  result: null,        // 最近一次仍有效的 { blobUrl, origUrl, order, width, height }
  invalidated: false,  // 当前展示的预览是否已失去下载资格（一旦置位不复位）
  inflightId: 0,       // 当前仍可落地的在途请求序号；0 表示无
  inflightEpoch: 0,    // 在途请求发出时的纪元
  reqSeq: 0,           // 单调递增请求序号源，永不归零
};

const elCompositeStatus = $("#compositeStatus");
const elCompositeFile = $("#compositeFile");
const elCompositeFileHint = $("#compositeFileHint");
const elCompositeRunBtn = $("#compositeRunBtn");
const elCompositeHint = $("#compositeHint");
const elCompositeErrors = $("#compositeErrors");
const elCompositeResult = $("#compositeResult");

// 图层 / 样本 / 关系变化时由 noteSolveInputChanged（合成纪元已先同步 +1）调用；
// 图片变化时在选择处理的最开始调用。
function markCompositeStaleness() {
  // 在途请求若发出后纪元已变，立即摘除其在途身份并结束加载态；
  // 旧响应返回后（含上传 / 读取响应体期间的变化）一律在守卫处丢弃。
  if (compositeState.inflightId !== 0 &&
      compositeState.epoch !== compositeState.inflightEpoch) {
    compositeState.inflightId = 0;
    compositeState.inflightEpoch = 0;
    elCompositeStatus.textContent = "";
    elCompositeStatus.className = "status";
  }
  updateCompositeRunBtn();
  if (!compositeState.result) return;
  // 已展示预览一旦在生成后遇到任何相关变化（含把输入 / 图片改回原值），下载资格
  // 永久撤销：epoch 只增不减、invalidated 一旦置位不复位。
  if (compositeState.epoch !== compositeState.result.epoch) {
    compositeState.invalidated = true;
  }
  renderCompositeResultIfAny();
}

// 生成只可使用「当前校准输入对应的有效求解顺序」：最近一次成功求解必须仍锚定在
// 当前求解输入纪元上。尚未取得结果（自动求解在途）、求解失败（HTTP 400）、连接
// 异常或输入非法时均为 false；输入变化后即使改回原值，旧求解的纪元也已落后。
function compositeSolveOrderValid() {
  return !!lastSolveResult && lastSolveEpoch === solveInputEpoch;
}

function updateCompositeRunBtn() {
  const can =
    compositeSolveOrderValid() &&
    !!compositeState.file &&
    compositeState.inflightId === 0;
  elCompositeRunBtn.disabled = !can;
  if (!compositeSolveOrderValid()) {
    elCompositeHint.textContent = "当前校准输入尚无有效求解结果（等待重新求解 / 求解失败 / 输入非法），无法生成";
  } else if (!compositeState.file) {
    elCompositeHint.textContent = "请先选择一张不超过 2 MiB、宽高各不超过 512 像素的 RGB PNG 背景图";
  } else if (compositeState.inflightId !== 0) {
    elCompositeHint.textContent = "正在生成…";
  } else {
    elCompositeHint.textContent = "固定使用当前最优叠序，逐像素线性光合成，输出同尺寸 RGB PNG";
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (btn && btn.dataset.act === "composite-run") void runComposite();
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "extract-run") void runExtract();
  if (btn.dataset.act === "extract-append") appendExtractedSamples();
  if (btn.dataset.act === "extract-clear") clearExtractPoints();
});

elCompositeFile.addEventListener("change", () => {
  const file = elCompositeFile.files && elCompositeFile.files[0] ? elCompositeFile.files[0] : null;
  void selectCompositeFile(file);
});

async function selectCompositeFile(file) {
  // 换图（含清空选择）即相关输入变化：纪元 +1（只增不减）并【立即】调用
  // markCompositeStaleness——不等待图片解码完成：旧预览下载链接、在途合成资格与
  // 加载态在选择发生的同一时刻就被撤销 / 结束；已登记的 File 也立即摘除，杜绝
  // 「解码期间用旧请求资格 + 新输入 / 新图片」的窗口。记下本次选择的纪元：
  // probeImage 是异步的，快速连续选两次或解码期间校准输入又变时，较早一次的解码
  // 可能在较新一次之后才完成——落地前必须确认纪元未变，否则旧结果一律丢弃。
  const selectEpoch = compositeState.epoch + 1;
  compositeState.epoch = selectEpoch;
  compositeState.file = null;
  elCompositeFileHint.textContent = "";
  showCompositeErrors([]);
  markCompositeStaleness();
  if (!file) return;
  // 客户端预检：扩展名 / MIME、体积；再用浏览器解码确认可解码与尺寸（最终以服务端判定为准）。
  const errs = [];
  const nameOk = /\.png$/i.test(file.name) || file.type === "image/png";
  if (!nameOk) errs.push("文件必须是 PNG 格式（不接受 JPEG / GIF / WebP 等）");
  if (file.size > 2 * 1024 * 1024) {
    errs.push(`图片体积 ${file.size} 字节超出 2 MiB（2097152 字节）上限`);
  }
  let dims = null;
  if (nameOk && file.size <= 2 * 1024 * 1024) {
    try {
      dims = await probeImage(file);
    } catch (msg) {
      errs.push(msg);
    }
  }
  // 解码期间用户又选了别的文件 / 改了校准输入：本次选择整体作废，不得覆盖较新状态
  if (compositeState.epoch !== selectEpoch) return;
  if (dims && (dims.width > 512 || dims.height > 512)) {
    errs.push(`图片尺寸 ${dims.width}×${dims.height} 超出上限：宽、高均不得超过 512 像素（不会缩放）`);
  }
  if (errs.length) {
    showCompositeErrors(errs.map((m) => ({ scope: "image", message: m })));
    compositeState.file = null;
    elCompositeFileHint.textContent = "";
    markCompositeStaleness();
    return;
  }
  showCompositeErrors([]);
  compositeState.file = file;
  compositeState.fileMeta = `${file.name} · ${dims.width}×${dims.height} · ${file.size} 字节`;
  elCompositeFileHint.textContent = compositeState.fileMeta;
  markCompositeStaleness();
}

// 浏览器无法区分全不透明 RGBA 与 RGB PNG（位图一律解成可绘制 RGBA），因此这里只预检
// 可解码性与尺寸；RGB 模式由服务端严格校验并明确报错（最终判定以服务端为准）。
function probeImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    let settled = false;
    img.onload = () => {
      const done = () => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      // decode() 能把部分「load 成功但像素不完整」的损坏文件也暴露出来
      if (img.decode) {
        img.decode().then(done).catch(() => {
          if (settled) return;
          settled = true;
          URL.revokeObjectURL(url);
          reject("图片已损坏或无法解码：请确认上传的是完整、未加密的 PNG 图片");
        });
      } else {
        done();
      }
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      reject("图片已损坏或无法解码：请确认上传的是完整、未加密的 PNG 图片");
    };
    img.src = url;
  });
}

function compositeResponseCurrent(reqId, reqEpoch) {
  return (
    compositeState.inflightId === reqId &&
    compositeState.inflightEpoch === reqEpoch &&
    compositeState.epoch === reqEpoch
  );
}

async function runComposite() {
  const solve = lastSolveResult;
  // 直接调用也不得发送请求：必须同时满足「当前输入对应的有效求解顺序」「已选图片
  // （客户端预检通过）」「无在途合成」三项；缺少当前有效求解（尚未返回 / 失败 /
  // 非法）、旧求解纪元落后或输入被改回原值但尚未重新求解时一律直接返回。
  if (!compositeSolveOrderValid() || !solve ||
      !compositeState.file || compositeState.inflightId !== 0) return;
  const reqId = ++compositeState.reqSeq;
  const reqEpoch = compositeState.epoch;
  compositeState.inflightId = reqId;
  compositeState.inflightEpoch = reqEpoch;
  updateCompositeRunBtn();
  elCompositeStatus.textContent = "生成中…";
  elCompositeStatus.className = "status busy";
  elCompositeErrors.hidden = true;

  const payload = {
    ...buildSolvePayload(),
    // 固定使用当前有效最佳叠序：不重新择序；服务端还会校验其完整性与先后关系
    order: solve.order,
  };
  const fd = new FormData();
  fd.append("payload", JSON.stringify(payload));
  fd.append("image", compositeState.file);

  try {
    const resp = await fetch("/api/composite-preview", { method: "POST", body: fd });
    if (!compositeResponseCurrent(reqId, reqEpoch)) return; // 上传期间已有变化 / 更新请求
    const blob = await resp.blob(); // 响应体读取窗口：读完后再过一次守卫
    if (!compositeResponseCurrent(reqId, reqEpoch)) return;
    compositeState.inflightId = 0;
    compositeState.inflightEpoch = 0;
    elCompositeStatus.textContent = "";
    elCompositeStatus.className = "status";
    if (!resp.ok) {
      let errs = [{ scope: "form", message: "合成预览生成失败" }];
      try {
        const data = JSON.parse(await blob.text());
        if (Array.isArray(data.errors) && data.errors.length) errs = data.errors;
      } catch (_) { /* 保留兜底错误 */ }
      showCompositeErrors(errs);
      updateCompositeRunBtn();
      return;
    }
    showCompositeErrors([]);
    revokeCompositeResultUrls();
    // 回显头异常（缺失 / 非 JSON）时回退到本次提交的顺序，不让解析异常吞掉有效响应
    let respOrder = null;
    const orderHeader = resp.headers.get("X-Composite-Order");
    if (orderHeader) {
      try {
        const parsed = JSON.parse(orderHeader);
        if (Array.isArray(parsed)) respOrder = parsed;
      } catch (_) { /* 回退到提交顺序 */ }
    }
    compositeState.result = {
      blobUrl: URL.createObjectURL(blob),
      origUrl: URL.createObjectURL(compositeState.file),
      order: respOrder || [...solve.order],
      width: Number(resp.headers.get("X-Composite-Width")),
      height: Number(resp.headers.get("X-Composite-Height")),
      epoch: reqEpoch,
    };
    compositeState.invalidated = false;
    renderCompositeResultIfAny();
    updateCompositeRunBtn();
  } catch (err) {
    if (!compositeResponseCurrent(reqId, reqEpoch)) return;
    compositeState.inflightId = 0;
    compositeState.inflightEpoch = 0;
    elCompositeStatus.textContent = "";
    elCompositeStatus.className = "status";
    showCompositeErrors([{ scope: "form", message: "无法连接合成服务：" + err.message }]);
    updateCompositeRunBtn();
  }
}

function revokeCompositeResultUrls() {
  const r = compositeState.result;
  if (!r) return;
  URL.revokeObjectURL(r.blobUrl);
  URL.revokeObjectURL(r.origUrl);
  compositeState.result = null;
}

function showCompositeErrors(errors) {
  if (!errors.length) {
    elCompositeErrors.hidden = true;
    elCompositeErrors.innerHTML = "";
    return;
  }
  elCompositeErrors.innerHTML =
    "<ul>" + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elCompositeErrors.hidden = false;
}

function renderCompositeResultIfAny() {
  const r = compositeState.result;
  if (!r) {
    elCompositeResult.innerHTML = "";
    return;
  }
  const dead = compositeState.invalidated || compositeState.epoch !== r.epoch;
  const chips = r.order
    .map((id) => {
      const layer = layerById(id);
      const hex = (layer && normalizeHex(layer.color)) || "#000000";
      const op = layer && Number.isFinite(layer.opacity) ? layer.opacity : 1;
      return `
        <span class="chip">
          <span class="dot" style="background:${hexToRgba(hex, op)}" title="${escapeHtml(id)}"></span>
          <span class="cid">${escapeHtml(id)}</span>
        </span>`;
    })
    .join('<span class="order-sep">↑</span>');

  elCompositeResult.innerHTML = `
    ${dead
      ? '<div class="stale-note">图层、样本、关系或背景图片已变化，以下旧预览已失去下载资格（即使改回原值也不恢复），请重新生成。</div>'
      : ""}
    <div class="composite-preview-grid">
      <figure class="composite-fig">
        <figcaption>原图（${r.width}×${r.height}）</figcaption>
        <img src="${r.origUrl}" alt="原图" class="composite-img" />
      </figure>
      <span class="compare-arrow">→</span>
      <figure class="composite-fig">
        <figcaption>合成图（${r.width}×${r.height}，RGB PNG）</figcaption>
        <img src="${r.blobUrl}" alt="合成图" class="composite-img" />
      </figure>
    </div>
    <div class="composite-order-line">
      <span class="hint">所用底 → 顶顺序：</span>
      <span class="checker"><span class="order-chips">
        <span class="order-ends">底</span>${chips}<span class="order-ends">↑ 顶</span>
      </span></span>
    </div>
    <div class="infer-apply-row">
      <a class="btn btn-small composite-download${dead ? " is-disabled" : ""}"
         ${dead ? 'aria-disabled="true"' : `href="${r.blobUrl}" download="composite-preview.png"`}>
        下载合成 PNG
      </a>
      <span class="hint">逐像素复用现有线性光合成，按现有 HEX 取整规则输出；不缩放、不重新择序</span>
    </div>
  `;
  if (dead) {
    const a = elCompositeResult.querySelector(".composite-download");
    if (a) a.addEventListener("click", (ev) => ev.preventDefault());
  }
}

window.addEventListener("beforeunload", () => {
  revokeCompositeResultUrls();
  if (extractState.bgUrl) URL.revokeObjectURL(extractState.bgUrl);
});

// ======================================================== 图片取点提取样本 ==
//
// 从背景图与叠层实测图的对应像素提取「背景 / 目标」颜色对，确认后整批追加为样本。
//
// 失效与请求竞态规则（与复核 / 合成同样严格）：
//  - 换图（含清空选择）立即清空取点和候选：纪元 +1（只增不减），在途提取作废；
//    取点每次变化同样让纪元 +1——旧候选与在途结果都不能再用于追加，即使改回
//    原值也不恢复（纪元不回落）。
//  - 候选 / 在途请求的指纹 = 纪元 + 当前样本列表：样本一经变化（左侧编辑、
//    复核追加、本功能追加），旧候选与在途提取结果一律不能用于追加。
//  - 同批候选仅能追加一次：成功追加即清空候选；追加后超过 4 组上限的批次
//    整批拒绝，样本不被改动。
//  - 请求序号取自永不归零的单调计数器；过期响应无论成功、HTTP 错误、连接异常
//    还是解析失败都被直接丢弃，不改动候选、错误提示或较新请求的加载状态。
const MAX_PICK_POINTS = 4;

const extractState = {
  bgFile: null,        // 当前背景图 File（未重新选择即不变）
  bgDims: null,        // 背景图 {width, height}
  bgUrl: "",           // 背景图展示用 objectURL
  meFile: null,        // 当前叠层实测图 File
  meDims: null,        // 实测图 {width, height}
  bgError: "",         // 背景图客户端预检错误（空串表示无）
  meError: "",         // 实测图客户端预检错误
  serverErrors: [],    // 最近一次提取请求返回的服务端错误
  points: [],          // 取点 [{x, y}]（原图零基坐标，左上角原点，提交顺序）
  epoch: 0,            // 图片或取点每次变化 +1（只增不减）
  selectSeq: { bg: 0, me: 0 }, // 每个文件槽各自的选择序号（解码竞态守卫）
  result: null,        // 最近一次成功提取 {width, height, pairs}
  resultKey: "",       // 结果产生时的指纹（纪元 + 样本）
  lastAppendNote: "",  // 成功追加后的提示（候选已清空时展示）
  inflightId: 0,       // 当前仍可落地的在途请求序号；0 表示无
  inflightSig: "",     // 在途请求发出时的指纹
  reqSeq: 0,           // 单调递增请求序号源，永不归零
};

const elExtractBgFile = $("#extractBgFile");
const elExtractMeFile = $("#extractMeFile");
const elExtractBgHint = $("#extractBgHint");
const elExtractMeHint = $("#extractMeHint");
const elExtractPickArea = $("#extractPickArea");
const elExtractBgImg = $("#extractBgImg");
const elExtractMarkers = $("#extractMarkers");
const elExtractPoints = $("#extractPoints");
const elExtractRunBtn = $("#extractRunBtn");
const elExtractHint = $("#extractHint");
const elExtractErrors = $("#extractErrors");
const elExtractResult = $("#extractResult");
const elExtractStatus = $("#extractStatus");

// 候选 / 在途请求的指纹：图片与取点由纪元覆盖，样本列表直接计入——
// 取点或样本任一变化后，旧候选与在途结果都不能再用于追加。
function extractSignature() {
  return JSON.stringify({
    epoch: extractState.epoch,
    samples: state.samples.map((s) => [String(s.background), String(s.target)]),
  });
}

// 候选是否仍对应当前图片 / 取点 / 样本；false 时「确认追加」不可点击
function extractResultFresh() {
  return !!extractState.result && extractSignature() === extractState.resultKey;
}

// 两图均已通过客户端预检且尺寸一致（RGB 模式由服务端最终判定）
function extractImagesReady() {
  const b = extractState.bgDims;
  const m = extractState.meDims;
  return !!(
    extractState.bgFile && extractState.meFile && b && m &&
    b.width === m.width && b.height === m.height &&
    !extractState.bgError && !extractState.meError
  );
}

function refreshExtractErrors() {
  const errs = [];
  if (extractState.bgError) errs.push({ scope: "background", message: extractState.bgError });
  if (extractState.meError) errs.push({ scope: "measured", message: extractState.meError });
  const b = extractState.bgDims;
  const m = extractState.meDims;
  if (b && m && (b.width !== m.width || b.height !== m.height)) {
    errs.push({
      scope: "measured",
      message: `两张图片尺寸不一致：背景图 ${b.width}×${b.height}，实测图 ${m.width}×${m.height}，请使用同尺寸的两张图`,
    });
  }
  errs.push(...extractState.serverErrors);
  if (!errs.length) {
    elExtractErrors.hidden = true;
    elExtractErrors.innerHTML = "";
    return;
  }
  elExtractErrors.innerHTML =
    "<ul>" + errs.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elExtractErrors.hidden = false;
}

function updateExtractRunBtn() {
  const n = extractState.points.length;
  const busy = extractState.inflightId !== 0;
  const ready = extractImagesReady();
  elExtractRunBtn.disabled = busy || !ready || n < 1 || n > MAX_PICK_POINTS;
  let hint;
  if (!extractState.bgFile || !extractState.meFile) {
    hint = "请先选择背景图与叠层实测图（同尺寸 RGB PNG）";
  } else if (!ready) {
    hint = "两张图片须均可解码且尺寸一致（详见上方错误提示）";
  } else if (n < 1) {
    hint = "在背景图上点击 1～4 个互异位置后再提取";
  } else if (busy) {
    hint = "正在提取…";
  } else {
    hint = `将按 ${n} 个取点逐像素读取两图原始 RGB（不插值、不合成）`;
  }
  elExtractHint.textContent = hint;
}

// 输入（图层 / 样本 / 关系）变化时由 scheduleSolve 调用；样本变化会使指纹失配，
// 在途提取立即作废、旧候选标记失效（不能再追加）。图层 / 关系变化不影响指纹。
function markExtractStaleness() {
  if (extractState.inflightId !== 0 && extractSignature() !== extractState.inflightSig) {
    extractState.inflightId = 0;
    extractState.inflightSig = "";
    elExtractStatus.textContent = "";
    elExtractStatus.className = "status";
  }
  updateExtractRunBtn();
  renderExtractResult();
}

function renderExtractPoints() {
  const dims = extractState.bgDims;
  const show = !!dims && !!extractState.bgUrl;
  elExtractPickArea.hidden = !show;
  if (show && elExtractBgImg.getAttribute("src") !== extractState.bgUrl) {
    elExtractBgImg.src = extractState.bgUrl;
  }
  elExtractMarkers.innerHTML = "";
  if (dims) {
    extractState.points.forEach((p, k) => {
      const m = document.createElement("span");
      m.className = "extract-marker";
      m.style.left = ((p.x + 0.5) / dims.width) * 100 + "%";
      m.style.top = ((p.y + 0.5) / dims.height) * 100 + "%";
      m.textContent = String(k + 1);
      m.title = `取点 ${k + 1}：(${p.x}, ${p.y})，再次点击该位置可取消`;
      elExtractMarkers.appendChild(m);
    });
  }
  const n = extractState.points.length;
  if (!dims) {
    elExtractPoints.textContent = "";
  } else if (n === 0) {
    elExtractPoints.textContent = "尚未取点：在背景图上点击 1～4 个互异位置（坐标按原图像素计）";
  } else {
    const pts = extractState.points.map((p, k) => `${k + 1}. (${p.x}, ${p.y})`).join("　");
    elExtractPoints.textContent =
      `已选 ${n} 个取点（零基坐标，左上角原点）：${pts}` +
      (n >= MAX_PICK_POINTS ? "；已达 4 个上限，点击已选位置可取消" : "");
  }
}

function renderExtractResult() {
  const r = extractState.result;
  if (!r) {
    elExtractResult.innerHTML = extractState.lastAppendNote
      ? `<div class="applied-note">${escapeHtml(extractState.lastAppendNote)}</div>`
      : "";
    return;
  }
  const fresh = extractResultFresh();
  const pairs = r.pairs || [];
  const rows = pairs
    .map(
      (p, k) => `
        <div class="extract-pair-row">
          <span class="row-index">${k + 1}</span>
          <span class="extract-coord">(${p.x}, ${p.y})</span>
          <span class="mini" style="background:${p.background}"></span>
          <span class="hexval">${p.background}</span>
          <span class="compare-arrow">→</span>
          <span class="mini" style="background:${p.target}"></span>
          <span class="hexval">${p.target}</span>
        </div>`
    )
    .join("");
  const total = state.samples.length + pairs.length;
  const fits = total <= MAX_SAMPLES;
  let appendRow;
  if (!fits) {
    // 追加后超过 4 组：整批拒绝，样本不被改动
    appendRow = `
      <div class="review-incompat">
        当前已有 ${state.samples.length} 组样本，整批追加 ${pairs.length} 组后共 ${total} 组，
        超过 ${MAX_SAMPLES} 组上限——整批拒绝，样本未改动。请先减少现有样本或减少取点数量后重新提取。
      </div>`;
  } else {
    appendRow = `
      <div class="review-append-row">
        <button class="btn btn-small" data-act="extract-append" type="button"
                ${fresh ? "" : "disabled"}>确认追加 ${pairs.length} 组样本并重新求解</button>
        <span class="hint">当前 ${state.samples.length} 组样本，追加后共 ${total} 组（上限 ${MAX_SAMPLES} 组）；
          同批仅能追加一次，取点或样本变化后需重新提取</span>
      </div>`;
  }
  elExtractResult.innerHTML = `
    ${fresh ? "" : '<div class="stale-note">取点或样本已变化，以下候选颜色对已失效（不能再追加），请重新提取。</div>'}
    <div class="suggest-sec-title">候选颜色对（两图对应像素的原始 RGB，不插值、不合成；确认后整批追加为样本）：</div>
    <div class="rows">${rows}</div>
    ${appendRow}`;
}

async function selectExtractFile(kind, file) {
  // 换图（含清空选择）立即清空取点和候选：纪元 +1（只增不减），在途提取作废并
  // 结束加载态——不等待图片解码完成；旧候选 / 在途结果即使改回同一张图也不恢复。
  extractState.epoch += 1;
  extractState.points = [];
  extractState.result = null;
  extractState.resultKey = "";
  extractState.lastAppendNote = "";
  extractState.serverErrors = [];
  if (extractState.inflightId !== 0) {
    extractState.inflightId = 0;
    extractState.inflightSig = "";
    elExtractStatus.textContent = "";
    elExtractStatus.className = "status";
  }
  const slot = kind === "bg" ? "bg" : "me";
  const label = slot === "bg" ? "背景图" : "实测图";
  const seq = ++extractState.selectSeq[slot];
  if (slot === "bg") {
    extractState.bgFile = null;
    extractState.bgDims = null;
    extractState.bgError = "";
    if (extractState.bgUrl) {
      URL.revokeObjectURL(extractState.bgUrl);
      extractState.bgUrl = "";
    }
    elExtractBgHint.textContent = "";
  } else {
    extractState.meFile = null;
    extractState.meDims = null;
    extractState.meError = "";
    elExtractMeHint.textContent = "";
  }
  refreshExtractErrors();
  renderExtractPoints();
  renderExtractResult();
  updateExtractRunBtn();
  if (!file) return;

  // 客户端预检：扩展名 / MIME、体积；再用浏览器解码确认可解码与尺寸
  // （RGB 模式无法在前端区分，由服务端严格校验并明确报错）。
  const errs = [];
  const nameOk = /\.png$/i.test(file.name) || file.type === "image/png";
  if (!nameOk) errs.push(`${label}必须是 PNG 格式（不接受 JPEG / GIF / WebP 等）`);
  if (file.size > 2 * 1024 * 1024) {
    errs.push(`${label}体积 ${file.size} 字节超出 2 MiB（2097152 字节）上限`);
  }
  let dims = null;
  if (nameOk && file.size <= 2 * 1024 * 1024) {
    try {
      dims = await probeImage(file);
    } catch (msg) {
      errs.push(String(msg).replace(/^图片/, label));
    }
  }
  // 解码期间同一槽位又换了图：本次选择整体作废，不得覆盖较新状态
  if (extractState.selectSeq[slot] !== seq) return;
  if (dims && (dims.width > 512 || dims.height > 512)) {
    errs.push(`${label}尺寸 ${dims.width}×${dims.height} 超出上限：宽、高均不得超过 512 像素（不会缩放）`);
  }
  if (errs.length) {
    if (slot === "bg") extractState.bgError = errs.join("；");
    else extractState.meError = errs.join("；");
    refreshExtractErrors();
    updateExtractRunBtn();
    return;
  }
  if (slot === "bg") {
    extractState.bgFile = file;
    extractState.bgDims = dims;
    extractState.bgUrl = URL.createObjectURL(file);
    elExtractBgHint.textContent = `${file.name} · ${dims.width}×${dims.height} · ${file.size} 字节`;
  } else {
    extractState.meFile = file;
    extractState.meDims = dims;
    elExtractMeHint.textContent = `${file.name} · ${dims.width}×${dims.height} · ${file.size} 字节`;
  }
  refreshExtractErrors(); // 两图尺寸一致性预检（最终以服务端判定为准）
  renderExtractPoints();
  updateExtractRunBtn();
}

elExtractBgFile.addEventListener("change", () => {
  const file = elExtractBgFile.files && elExtractBgFile.files[0] ? elExtractBgFile.files[0] : null;
  void selectExtractFile("bg", file);
});
elExtractMeFile.addEventListener("change", () => {
  const file = elExtractMeFile.files && elExtractMeFile.files[0] ? elExtractMeFile.files[0] : null;
  void selectExtractFile("me", file);
});

// 在背景图上点选 / 取消取点：缩放显示按显示比例换算回原图零基像素坐标
elExtractPickArea.addEventListener("click", (e) => {
  const dims = extractState.bgDims;
  if (!dims) return;
  const rect = elExtractBgImg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const fx = (e.clientX - rect.left) / rect.width;
  const fy = (e.clientY - rect.top) / rect.height;
  if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return;
  const x = Math.min(dims.width - 1, Math.floor(fx * dims.width));
  const y = Math.min(dims.height - 1, Math.floor(fy * dims.height));
  toggleExtractPoint(x, y);
});

function toggleExtractPoint(x, y) {
  const pts = extractState.points;
  const idx = pts.findIndex((p) => p.x === x && p.y === y);
  if (idx >= 0) {
    pts.splice(idx, 1);
  } else if (pts.length < MAX_PICK_POINTS) {
    pts.push({ x, y });
  } else {
    return; // 已达 4 个上限：忽略本次点击（提示见取点行）
  }
  extractState.epoch += 1; // 取点变化：旧候选与在途结果立即失效
  extractState.serverErrors = []; // 上一次提取的服务端报错随取点变化一并清除
  refreshExtractErrors();
  markExtractStaleness();
  renderExtractPoints();
}

function clearExtractPoints() {
  if (!extractState.points.length) return;
  extractState.points = [];
  extractState.epoch += 1; // 取点变化：旧候选与在途结果立即失效
  extractState.serverErrors = [];
  refreshExtractErrors();
  markExtractStaleness();
  renderExtractPoints();
}

// 响应守卫：只有「当前在途请求」且「发出后图片 / 取点 / 样本未再变化」的响应
// 可以落地；响应体读完之后再次判定，读取窗口内的变化同样作数。
function extractResponseCurrent(reqId, reqSig) {
  return (
    extractState.inflightId === reqId &&
    extractState.inflightSig === reqSig &&
    extractSignature() === reqSig
  );
}

async function runExtract() {
  // 直接调用也不得发送请求：两图就绪、1～4 个取点、无在途提取三者缺一不可
  if (!extractImagesReady()) return;
  const n = extractState.points.length;
  if (n < 1 || n > MAX_PICK_POINTS || extractState.inflightId !== 0) return;

  const reqId = ++extractState.reqSeq;
  extractState.inflightId = reqId;
  const reqSig = extractSignature();
  extractState.inflightSig = reqSig;
  extractState.serverErrors = [];
  refreshExtractErrors();
  elExtractStatus.textContent = "提取中…";
  elExtractStatus.className = "status busy";
  updateExtractRunBtn();

  const fd = new FormData();
  fd.append("points", JSON.stringify(extractState.points));
  fd.append("background", extractState.bgFile);
  fd.append("measured", extractState.meFile);

  try {
    const resp = await fetch("/api/extract-samples", { method: "POST", body: fd });
    if (!extractResponseCurrent(reqId, reqSig)) return; // 上传期间已有变化 / 更新请求
    const data = await resp.json(); // 响应体读取窗口：读完后再过一次守卫
    if (!extractResponseCurrent(reqId, reqSig)) return;
    extractState.inflightId = 0;
    extractState.inflightSig = "";
    elExtractStatus.textContent = "";
    elExtractStatus.className = "status";
    if (!resp.ok) {
      extractState.serverErrors = data.errors || [{ scope: "form", message: "提取失败" }];
      refreshExtractErrors();
      updateExtractRunBtn();
      return;
    }
    extractState.result = data;
    extractState.resultKey = reqSig;
    extractState.lastAppendNote = "";
    renderExtractResult();
    updateExtractRunBtn();
  } catch (err) {
    if (!extractResponseCurrent(reqId, reqSig)) return;
    extractState.inflightId = 0;
    extractState.inflightSig = "";
    elExtractStatus.textContent = "";
    elExtractStatus.className = "status";
    extractState.serverErrors = [{ scope: "form", message: "无法连接提取服务：" + err.message }];
    refreshExtractErrors();
    updateExtractRunBtn();
  }
}

function appendExtractedSamples() {
  const r = extractState.result;
  // 追加前再次核对资格：候选已失效（取点 / 样本曾变化）时不改任何样本
  if (!r || !extractResultFresh()) return;
  const pairs = Array.isArray(r.pairs) ? r.pairs : [];
  if (!pairs.length) return;
  // 追加后超过 4 组上限：整批拒绝，样本不被改动
  if (state.samples.length + pairs.length > MAX_SAMPLES) return;
  pairs.forEach((p) => {
    state.samples.push({ background: p.background, target: p.target });
  });
  // 同批仅能追加一次：清空候选，仅保留一条已追加提示
  extractState.result = null;
  extractState.resultKey = "";
  extractState.lastAppendNote =
    `已把 ${pairs.length} 组颜色对整批追加为样本并触发重新求解；同批不能重复追加，可重新取点提取。`;
  renderExtractResult();
  // 成功追加沿用输入变更流程：旧计算与调序执行失效（已确认记录保留）、重新求解
  render();
  noteSolveInputChanged();
  markCycleStaleness();
  markInferStaleness();
  markSuggestStaleness();
  renderSuggestControls();
  markReviewStaleness();
  markTransitionStaleness();
  runSolve();
}

// ------------------------------------------------------------ 启动 --
render();
renderSuggestControls();
renderReviewBgOptions();
renderExtractPoints();
updateExtractRunBtn();
runSolve();
