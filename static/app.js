let currentAnalysis = null;
let priceChart = null;
let indicatorChart = null;

const $ = (id) => document.getElementById(id);

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function fmtCompact(value) {
  if (value === null || value === undefined) return "--";
  return Number(value).toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 2 });
}

function pctClass(value) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "";
}

function setStatus(text) {
  $("statusText").textContent = text;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function analyze(symbol) {
  setStatus("正在拉取行情并计算指标...");
  $("generateReport").disabled = true;
  $("reportBody").className = "reportBody empty";
  $("reportBody").textContent = "行情分析中...";
  try {
    const data = await fetchJson(`/api/analyze?symbol=${encodeURIComponent(symbol)}`);
    currentAnalysis = data;
    renderAnalysis(data);
    $("generateReport").disabled = false;
    $("reportBody").className = "reportBody empty";
    $("reportBody").textContent = data.news?.length
      ? "行情、指标和新闻已更新，可以生成 AI 分析报告。"
      : "行情和指标已更新。新闻源暂时没有返回资讯，仍可生成分析报告。";
    setStatus("分析完成 · 可生成报告");
  } catch (error) {
    setStatus("分析失败");
    $("reportBody").className = "reportBody empty";
    $("reportBody").textContent = error.message;
  }
}

function renderAnalysis(data) {
  $("assetType").textContent = `${data.asset_type} · ${data.exchange || "Yahoo Finance"}`;
  $("title").textContent = `${data.symbol} ${data.name && data.name !== data.symbol ? "· " + data.name : ""}`;
  $("price").textContent = `${fmt(data.quote.price, 2)} ${data.currency || ""}`.trim();
  $("change").textContent = `${fmt(data.quote.change_pct, 2)}%`;
  $("change").className = pctClass(data.quote.change_pct);
  $("volume").textContent = fmtCompact(data.quote.volume);
  $("overall").textContent = fmt(data.scores.overall, 1);
  renderSignal(data.signal);
  renderTimeframeSignals(data.timeframe_signals || []);
  $("quoteDate").textContent = data.quote.date;
  $("scoreTrend").textContent = fmt(data.scores.trend, 1);
  $("scoreMomentum").textContent = fmt(data.scores.momentum, 1);
  $("scoreVolume").textContent = fmt(data.scores.volume, 1);
  $("scoreRisk").textContent = fmt(data.scores.risk_control, 1);
  renderIndicators(data.latest_indicators, data.quote.performance);
  renderMarketBrief(data);
  renderNews(data.news || []);
  renderCharts(data);
}

function renderSignal(signal) {
  if (!signal) return;
  $("signalLabel").textContent = signal.label || "--";
  $("signalMetric").className = `metric signalMetric ${signal.tone || "neutral"}`;
  const reasons = toArray(signal.reasons).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const cautions = toArray(signal.cautions).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const levels = signal.levels || {};
  $("signalDetail").className = "signalDetail";
  $("signalDetail").innerHTML = `
    <div class="signalHeader">
      <span class="signalBadge ${signal.tone || "neutral"}">${escapeHtml(signal.label || "等待确认")}</span>
      <strong>${fmt(signal.confidence, 1)}%</strong>
    </div>
    ${reasons ? `<div><strong>触发理由</strong><ul>${reasons}</ul></div>` : ""}
    ${cautions ? `<div><strong>风险提醒</strong><ul>${cautions}</ul></div>` : ""}
    <div class="signalLevels">
      支撑：${(levels.support || []).join(" / ") || "--"}<br>
      压力：${(levels.resistance || []).join(" / ") || "--"}<br>
      止损参考：${levels.stop_reference ?? "--"}
    </div>
    <div class="muted">${escapeHtml(signal.disclaimer || "仅供研究观察。")}</div>
  `;
}

function renderTimeframeSignals(signals) {
  const rows = toArray(signals);
  if (!rows.length) {
    $("timeframeSignals").innerHTML = '<div class="emptyNews">暂无多周期信号。</div>';
    return;
  }
  $("timeframeSignals").innerHTML = rows
    .map((item) => {
      const notes = toArray(item.notes).map((note) => `<li>${escapeHtml(note)}</li>`).join("");
      return `
        <article class="timeframeCard ${item.tone || "neutral"}">
          <div class="timeframeHead">
            <div>
              <strong>${escapeHtml(item.name || "--")}</strong>
              <span>${escapeHtml(item.horizon || "")}</span>
            </div>
            <span class="signalBadge ${item.tone || "neutral"}">${escapeHtml(item.label || "等待确认")}</span>
          </div>
          <div class="timeframeMetric">
            <span>置信度 ${fmt(item.confidence, 1)}%</span>
            <span class="${pctClass(Number(item.performance))}">${fmt(item.performance, 2)}%</span>
          </div>
          <p>${escapeHtml(item.focus || "")}</p>
          ${notes ? `<ul>${notes}</ul>` : ""}
        </article>
      `;
    })
    .join("");
}

function renderMarketBrief(data) {
  const i = data.latest_indicators;
  const p = data.quote.performance;
  const rows = [
    ["20日表现", p["20d"], "%", true],
    ["60日表现", p["60d"], "%", true],
    ["120日表现", p["120d"], "%", true],
    ["年化波动", i.volatility_60d_annualized, "%", false],
    ["ATR14", i.atr14, "", false],
    ["量比", i.volume_ratio, "", false],
  ];
  $("marketBrief").innerHTML = rows
    .map(([label, value, suffix, signed]) => {
      const cls = signed ? pctClass(Number(value)) : "";
      return `<div class="briefItem"><span>${label}</span><strong class="${cls}">${fmt(value, 2)}${suffix}</strong></div>`;
    })
    .join("");
}

function renderIndicators(indicators, performance) {
  const rows = [
    ["MA20", indicators.ma20],
    ["MA60", indicators.ma60],
    ["RSI14", indicators.rsi14],
    ["MACD 柱体", indicators.macd_hist],
    ["BOLL 上轨", indicators.boll_upper],
    ["BOLL 下轨", indicators.boll_lower],
    ["ATR14", indicators.atr14],
    ["量比(20日)", indicators.volume_ratio],
    ["60日年化波动", indicators.volatility_60d_annualized, "%"],
    ["20日表现", performance["20d"], "%"],
    ["60日表现", performance["60d"], "%"],
    ["120日表现", performance["120d"], "%"],
  ];
  $("indicatorList").innerHTML = rows
    .map(([label, value, suffix]) => {
      const numeric = Number(value);
      const cls = label.includes("表现") ? pctClass(numeric) : "";
      return `<div class="indicator"><span>${label}</span><strong class="${cls}">${fmt(value, 2)}${suffix || ""}</strong></div>`;
    })
    .join("");
}

function renderCharts(data) {
  if (!priceChart) priceChart = echarts.init($("priceChart"));
  if (!indicatorChart) indicatorChart = echarts.init($("indicatorChart"));
  const dates = data.series.map((row) => row.date);
  const candle = data.series.map((row) => [row.open, row.close, row.low, row.high]);
  const close = data.series.map((row) => row.close);
  const ma20 = data.series.map((row) => row.ma20);
  const ma60 = data.series.map((row) => row.ma60);
  const upper = data.series.map((row) => row.boll_upper);
  const lower = data.series.map((row) => row.boll_lower);
  priceChart.setOption({
    animation: false,
    tooltip: { trigger: "axis" },
    legend: { top: 0, data: ["K线", "收盘", "MA20", "MA60", "BOLL上轨", "BOLL下轨"] },
    grid: { left: 55, right: 20, top: 45, bottom: 42 },
    xAxis: { type: "category", data: dates, boundaryGap: true, axisLabel: { hideOverlap: true } },
    yAxis: { scale: true },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 22, bottom: 8 }],
    series: [
      { name: "K线", type: "candlestick", data: candle, itemStyle: { color: "#15803d", color0: "#b42318", borderColor: "#15803d", borderColor0: "#b42318" } },
      { name: "收盘", type: "line", data: close, showSymbol: false, smooth: true, lineStyle: { width: 1.3, color: "#334155" } },
      { name: "MA20", type: "line", data: ma20, showSymbol: false, smooth: true, lineStyle: { width: 1.5, color: "#0f766e" } },
      { name: "MA60", type: "line", data: ma60, showSymbol: false, smooth: true, lineStyle: { width: 1.5, color: "#2456a6" } },
      { name: "BOLL上轨", type: "line", data: upper, showSymbol: false, smooth: true, lineStyle: { width: 1, color: "#b7791f", type: "dashed" } },
      { name: "BOLL下轨", type: "line", data: lower, showSymbol: false, smooth: true, lineStyle: { width: 1, color: "#b7791f", type: "dashed" } },
    ],
  });

  indicatorChart.setOption({
    animation: false,
    tooltip: { trigger: "axis" },
    legend: { top: 0, data: ["RSI", "MACD", "Signal", "Histogram"] },
    grid: [
      { left: 50, right: 20, top: 42, height: 95 },
      { left: 50, right: 20, top: 178, height: 75 },
    ],
    xAxis: [
      { type: "category", data: dates, axisLabel: { hideOverlap: true } },
      { type: "category", data: dates, gridIndex: 1, axisLabel: { hideOverlap: true } },
    ],
    yAxis: [{ scale: true }, { scale: true, gridIndex: 1 }],
    series: [
      { name: "RSI", type: "line", data: data.series.map((row) => row.rsi), showSymbol: false, xAxisIndex: 0, yAxisIndex: 0, lineStyle: { color: "#0f766e" } },
      { name: "MACD", type: "line", data: data.series.map((row) => row.macd), showSymbol: false, xAxisIndex: 1, yAxisIndex: 1, lineStyle: { color: "#2456a6" } },
      { name: "Signal", type: "line", data: data.series.map((row) => row.macd_signal), showSymbol: false, xAxisIndex: 1, yAxisIndex: 1, lineStyle: { color: "#b7791f" } },
      { name: "Histogram", type: "bar", data: data.series.map((row) => row.macd_hist), xAxisIndex: 1, yAxisIndex: 1, itemStyle: { color: "#94a3b8" } },
    ],
  });
}

function renderNews(news) {
  $("newsCount").textContent = news.length ? `${news.length} 条资讯` : "暂无资讯";
  if (!news.length) {
    $("newsList").innerHTML = '<div class="emptyNews">新闻源暂时没有返回相关资讯，行情和指标分析仍可使用。</div>';
    return;
  }
  $("newsList").innerHTML = news
    .map((item) => {
      const title = escapeHtml(item.title || "Untitled");
      const publisher = escapeHtml(item.publisher || "Yahoo Finance");
      const date = escapeHtml(item.published_at || "");
      const summary = escapeHtml(item.summary || "");
      const href = item.link ? escapeHtml(item.link) : "#";
      return `
        <article class="newsItem">
          <a href="${href}" target="_blank" rel="noreferrer">${title}</a>
          <div class="newsMeta">${publisher}${date ? " · " + date : ""}</div>
          ${summary ? `<div class="newsSummary">${summary}</div>` : ""}
        </article>
      `;
    })
    .join("");
}

async function generateReport() {
  if (!currentAnalysis) return;
  setStatus("正在生成并保存报告...");
  $("generateReport").disabled = true;
  $("reportBody").className = "reportBody empty";
  $("reportBody").textContent = "报告生成中...";
  try {
    const data = await fetchJson("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: currentAnalysis.symbol, analysis: currentAnalysis }),
    });
    renderReport(data.report);
    await loadReports();
    setStatus(`报告已保存 #${data.id}`);
  } catch (error) {
    $("reportBody").className = "reportBody empty";
    $("reportBody").textContent = error.message;
    setStatus("报告生成失败");
  } finally {
    $("generateReport").disabled = false;
  }
}

function renderReport(report) {
  const stanceLabel = { bullish: "偏多", neutral: "中性", bearish: "偏空" }[report.stance] || report.stance;
  const support = toArray(report.key_levels?.support);
  const resistance = toArray(report.key_levels?.resistance);
  $("reportBody").className = "reportBody";
  $("reportBody").innerHTML = `
    <span class="stance ${report.stance || "neutral"}">${stanceLabel}</span>
    <div><h4>结论</h4><div>${escapeHtml(report.summary || "")}</div></div>
    ${renderList("机会", report.opportunities)}
    ${renderList("风险", report.risks)}
    ${renderReportSignal(report.trade_signal)}
    ${renderNewsBrief(report.news_brief)}
    <div><h4>关键价位</h4><div>支撑：${support.join(" / ") || "--"}　压力：${resistance.join(" / ") || "--"}</div></div>
    ${renderList("观察计划", report.watch_plan)}
    <div class="muted">${escapeHtml(report.disclaimer || "仅供研究和信息分析，不构成投资建议。")}</div>
  `;
}

function renderReportSignal(signal) {
  if (!signal) return "";
  return `
    <div>
      <h4>买卖信号</h4>
      <div><span class="signalBadge ${signal.tone || "neutral"}">${escapeHtml(signal.label || "")}</span> 置信度 ${fmt(signal.confidence, 1)}%</div>
    </div>
  `;
}

function renderNewsBrief(items) {
  items = toArray(items);
  if (!items.length) return "";
  const safe = items
    .map((item) => {
      if (typeof item === "string") return `<li>${escapeHtml(item)}</li>`;
      return `<li>${escapeHtml(item.title || JSON.stringify(item))} <span class="muted">${escapeHtml(item.publisher || "")}</span></li>`;
    })
    .join("");
  return `<div><h4>参考资讯</h4><ul>${safe}</ul></div>`;
}

function renderList(title, items) {
  const safe = toArray(items).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return `<div><h4>${title}</h4><ul>${safe || "<li>--</li>"}</ul></div>`;
}

function toArray(value) {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") {
    return Object.entries(value).map(([key, val]) => `${key}: ${typeof val === "object" ? JSON.stringify(val) : val}`);
  }
  return [String(value)];
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizedInputSymbol() {
  return $("symbolInput").value.trim().toUpperCase();
}

function getWatchSymbols() {
  return JSON.parse(localStorage.getItem("quantWatchSymbols") || "[]");
}

function saveWatchSymbols(symbols) {
  localStorage.setItem("quantWatchSymbols", JSON.stringify(symbols));
}

function addWatchSymbol() {
  const symbol = normalizedInputSymbol();
  if (!symbol) return;
  const symbols = getWatchSymbols();
  if (!symbols.includes(symbol)) {
    symbols.unshift(symbol);
    saveWatchSymbols(symbols.slice(0, 30));
  }
  renderWatchList();
}

function removeWatchSymbol(symbol) {
  saveWatchSymbols(getWatchSymbols().filter((item) => item !== symbol));
  renderWatchList();
}

function renderWatchList() {
  const symbols = getWatchSymbols();
  $("watchList").innerHTML = symbols.length
    ? symbols
        .map(
          (symbol) => `
            <div class="watchItem">
              <button class="watchSymbol" data-watch-symbol="${escapeHtml(symbol)}">${escapeHtml(symbol)}</button>
              <button class="ghost watchRemove" data-remove-symbol="${escapeHtml(symbol)}">移除</button>
            </div>
          `,
        )
        .join("")
    : '<div class="historyItem"><p>暂无关注股票</p></div>';
}

async function loadReports() {
  try {
    const data = await fetchJson("/api/reports");
    $("historyList").innerHTML = data.reports.length
      ? data.reports
          .map(
            (item) => `
            <div class="historyItem">
              <strong>${escapeHtml(item.symbol)} · ${escapeHtml(item.stance)}</strong>
              <p>${escapeHtml(item.summary || "")}</p>
              <p>${new Date(item.created_at).toLocaleString()}</p>
            </div>
          `,
          )
          .join("")
      : '<div class="historyItem"><p>暂无历史报告</p></div>';
  } catch {
    $("historyList").innerHTML = '<div class="historyItem"><p>历史报告读取失败</p></div>';
  }
}

$("symbolForm").addEventListener("submit", (event) => {
  event.preventDefault();
  analyze($("symbolInput").value);
});

document.querySelectorAll("[data-symbol]").forEach((button) => {
  button.addEventListener("click", () => {
    $("symbolInput").value = button.dataset.symbol;
    analyze(button.dataset.symbol);
  });
});

$("generateReport").addEventListener("click", generateReport);
$("refreshReports").addEventListener("click", loadReports);
$("addWatch").addEventListener("click", addWatchSymbol);
$("refreshWatch").addEventListener("click", renderWatchList);
$("watchList").addEventListener("click", (event) => {
  const watchSymbol = event.target.closest("[data-watch-symbol]")?.dataset.watchSymbol;
  const removeSymbol = event.target.closest("[data-remove-symbol]")?.dataset.removeSymbol;
  if (watchSymbol) {
    $("symbolInput").value = watchSymbol;
    analyze(watchSymbol);
  }
  if (removeSymbol) removeWatchSymbol(removeSymbol);
});
window.addEventListener("resize", () => {
  priceChart?.resize();
  indicatorChart?.resize();
});

loadReports();
renderWatchList();
analyze($("symbolInput").value);
