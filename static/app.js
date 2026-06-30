let currentAnalysis = null;
let priceChart = null;
let indicatorChart = null;
let latestScanResults = [];
let aiStatus = { configured: false, provider: "local_rules", model: "" };

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

async function loadAiStatus() {
  try {
    aiStatus = await fetchJson("/api/ai-status");
  } catch {
    aiStatus = { configured: false, provider: "local_rules", model: "" };
  }
  $("aiStatus").textContent = aiStatus.configured
    ? `${providerLabel(aiStatus.provider)} 已配置 · ${aiStatus.model}`
    : "未配置 API Key · 使用本地规则";
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
  renderDataWarnings(data.data_warnings || []);
  renderDataHealth(data.data_health || {});
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

function renderDataWarnings(warnings) {
  const rows = toArray(warnings);
  $("dataWarnings").hidden = !rows.length;
  $("dataWarnings").innerHTML = rows.map((item) => `<div>${escapeHtml(item)}</div>`).join("");
}

function renderDataHealth(health) {
  $("dataHealth").hidden = !health || !health.status;
  if ($("dataHealth").hidden) return;
  const suggestions = toArray(health.suggestions)
    .map(
      (item) => `
        <button class="ghost healthSuggestion" data-suggest-symbol="${escapeHtml(item.symbol || "")}">
          改查 ${escapeHtml(item.symbol || "")}
        </button>
      `,
    )
    .join("");
  $("dataHealth").innerHTML = `
    <div class="healthHead">
      <div>
        <strong>数据健康</strong>
        <span class="healthStatus ${escapeHtml(health.status || "ok")}">${escapeHtml(health.status_label || "数据正常")}</span>
      </div>
      <span>${escapeHtml(health.provider || "Yahoo Finance")}</span>
    </div>
    <div class="healthGrid">
      <div><span>源名称</span><b>${escapeHtml(health.source_name || "--")}</b></div>
      <div><span>交易所</span><b>${escapeHtml(health.exchange || "--")}</b></div>
      <div><span>最后 K 线</span><b>${escapeHtml(health.last_date || "--")}</b></div>
      <div><span>样本数</span><b>${fmt(health.bar_count, 0)}</b></div>
    </div>
    ${suggestions ? `<div class="healthActions">${suggestions}</div>` : ""}
  `;
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

async function searchSymbols() {
  const query = normalizedInputSymbol();
  if (!query) return;
  $("symbolSuggestions").hidden = false;
  $("symbolSuggestions").innerHTML = '<div class="suggestionEmpty">正在查找候选代码...</div>';
  try {
    const data = await fetchJson(`/api/search?q=${encodeURIComponent(query)}`);
    renderSymbolSuggestions(data.results || []);
  } catch (error) {
    $("symbolSuggestions").innerHTML = `<div class="suggestionEmpty">${escapeHtml(error.message)}</div>`;
  }
}

function renderSymbolSuggestions(results) {
  $("symbolSuggestions").hidden = false;
  $("symbolSuggestions").innerHTML = results.length
    ? results
        .map(
          (item) => `
            <button type="button" class="suggestionItem" data-suggestion-symbol="${escapeHtml(item.symbol)}">
              <strong>${escapeHtml(item.symbol)}</strong>
              <span>${escapeHtml(item.name || "")}</span>
              <em>${escapeHtml([item.exchange, item.type].filter(Boolean).join(" · "))}</em>
            </button>
          `,
        )
        .join("")
    : '<div class="suggestionEmpty">没有找到候选代码。</div>';
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
    if (data.ai?.used) {
      setStatus(`${providerLabel(data.ai.provider)} 报告已保存 #${data.id}`);
    } else {
      const detail = data.ai?.error ? ` · ${data.ai.error}` : "";
      setStatus(`本地规则报告已保存 #${data.id}${detail}`);
    }
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
  const source = report.source === "ai" ? providerLabel(report.provider || aiStatus.provider) : "本地规则";
  $("reportBody").className = "reportBody";
  $("reportBody").innerHTML = `
    <div class="reportMeta">
      <span class="stance ${report.stance || "neutral"}">${stanceLabel}</span>
      <span class="sourceBadge">${escapeHtml(source)}</span>
    </div>
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

function providerLabel(provider) {
  return {
    deepseek: "DeepSeek",
    openrouter: "OpenRouter",
    openai: "OpenAI",
    local_rules: "本地规则",
  }[provider] || provider || "AI";
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

function getSignalSnapshots() {
  return JSON.parse(localStorage.getItem("quantSignalSnapshots") || "{}");
}

function saveSignalSnapshots(snapshots) {
  localStorage.setItem("quantSignalSnapshots", JSON.stringify(snapshots));
}

function getSignalEvents() {
  return JSON.parse(localStorage.getItem("quantSignalEvents") || "[]");
}

function saveSignalEvents(events) {
  localStorage.setItem("quantSignalEvents", JSON.stringify(events.slice(0, 80)));
}

async function scanWatchlist() {
  const symbols = getWatchSymbols();
  if (!symbols.length) {
    $("scanSummary").textContent = "先把股票加入关注列表，再开始扫描。";
    $("scanResults").innerHTML = "";
    $("signalChanges").innerHTML = "";
    return;
  }
  setStatus("正在扫描关注列表...");
  $("scanWatch").disabled = true;
  $("scanWatchTop").disabled = true;
  $("scanSummary").textContent = `正在扫描 ${symbols.length} 个标的...`;
  try {
    const data = await fetchJson("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols }),
    });
    latestScanResults = data.results || [];
    recordSignalChanges(latestScanResults);
    renderScanResults();
    renderSignalChanges();
    setStatus("自选股扫描完成");
  } catch (error) {
    $("scanSummary").textContent = error.message;
    setStatus("自选股扫描失败");
  } finally {
    $("scanWatch").disabled = false;
    $("scanWatchTop").disabled = false;
  }
}

function recordSignalChanges(results) {
  const snapshots = getSignalSnapshots();
  const events = getSignalEvents();
  const checkedAt = new Date().toISOString();
  results.forEach((item) => {
    if (item.error || !item.symbol || !item.signal) return;
    const previous = snapshots[item.symbol];
    const current = {
      action: item.signal.action,
      label: item.signal.label,
      tone: item.signal.tone,
      checked_at: checkedAt,
    };
    if (previous && previous.action !== current.action) {
      events.unshift({
        symbol: item.symbol,
        previous_label: previous.label || "未知",
        current_label: current.label || "未知",
        tone: current.tone || "neutral",
        price: item.price,
        overall: item.overall,
        checked_at: checkedAt,
      });
    }
    snapshots[item.symbol] = current;
  });
  saveSignalSnapshots(snapshots);
  saveSignalEvents(events);
}

function renderScanResults() {
  const rows = [...latestScanResults].sort((a, b) => scanSortValue(b) - scanSortValue(a));
  const valid = rows.filter((item) => !item.error);
  const changed = getSignalEvents().filter((event) => rows.some((item) => item.symbol === event.symbol)).length;
  $("scanSummary").textContent = valid.length
    ? `已扫描 ${valid.length} 个标的 · ${changed ? `${changed} 条信号变化记录` : "暂无新变化"}`
    : "没有可展示的扫描结果。";
  $("scanResults").innerHTML = rows.length
    ? rows.map(renderScanCard).join("")
    : '<div class="emptyNews">关注股票后，一键扫描信号变化。</div>';
}

function scanSortValue(item) {
  if (item.error) return -Infinity;
  const sort = $("scanSort").value;
  if (sort === "change") return Number(item.change_pct ?? -Infinity);
  if (sort === "risk") return Number(item.risk_control ?? -Infinity);
  if (sort === "signal") return Number(item.signal?.score ?? -Infinity);
  return Number(item.overall ?? -Infinity);
}

function renderScanCard(item) {
  if (item.error) {
    return `
      <article class="scanCard error">
        <strong>${escapeHtml(item.symbol || "--")}</strong>
        <p>${escapeHtml(item.error)}</p>
      </article>
    `;
  }
  const signal = item.signal || {};
  const warning = toArray(item.warnings)[0];
  return `
    <article class="scanCard ${signal.tone || "neutral"}" data-scan-symbol="${escapeHtml(item.symbol)}">
      <div class="scanHead">
        <div>
          <strong>${escapeHtml(item.symbol)}</strong>
          <span>${escapeHtml(item.name || "")}</span>
        </div>
        <span class="signalBadge ${signal.tone || "neutral"}">${escapeHtml(signal.label || "--")}</span>
      </div>
      <div class="scanMetrics">
        <span>价格 <b>${fmt(item.price, 2)}</b></span>
        <span>涨跌 <b class="${pctClass(Number(item.change_pct))}">${fmt(item.change_pct, 2)}%</b></span>
        <span>评分 <b>${fmt(item.overall, 1)}</b></span>
        <span>风险 <b>${fmt(item.risk_control, 1)}</b></span>
      </div>
      <div class="scanFoot">
        <span>${escapeHtml(item.date || "")}</span>
        <span>置信度 ${fmt(signal.confidence, 1)}%</span>
      </div>
      ${warning ? `<div class="scanWarning">${escapeHtml(warning)}</div>` : ""}
    </article>
  `;
}

function renderSignalChanges() {
  const events = getSignalEvents().slice(0, 8);
  $("signalChanges").innerHTML = events.length
    ? `
      <div class="panelHead compactHead"><h3>信号变化</h3><div class="muted">最近 ${events.length} 条</div></div>
      <div class="changeList">
        ${events
          .map(
            (event) => `
              <div class="changeItem">
                <span class="signalBadge ${event.tone || "neutral"}">${escapeHtml(event.current_label)}</span>
                <strong>${escapeHtml(event.symbol)}</strong>
                <span>${escapeHtml(event.previous_label)} → ${escapeHtml(event.current_label)}</span>
                <span class="muted">${new Date(event.checked_at).toLocaleString()}</span>
              </div>
            `,
          )
          .join("")}
      </div>
    `
    : "";
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
$("searchSymbol").addEventListener("click", searchSymbols);
$("scanWatch").addEventListener("click", scanWatchlist);
$("scanWatchTop").addEventListener("click", scanWatchlist);
$("scanSort").addEventListener("change", renderScanResults);
$("symbolSuggestions").addEventListener("click", (event) => {
  const symbol = event.target.closest("[data-suggestion-symbol]")?.dataset.suggestionSymbol;
  if (!symbol) return;
  $("symbolInput").value = symbol;
  $("symbolSuggestions").hidden = true;
  analyze(symbol);
});
$("dataHealth").addEventListener("click", (event) => {
  const symbol = event.target.closest("[data-suggest-symbol]")?.dataset.suggestSymbol;
  if (!symbol) return;
  $("symbolInput").value = symbol;
  analyze(symbol);
});
$("watchList").addEventListener("click", (event) => {
  const watchSymbol = event.target.closest("[data-watch-symbol]")?.dataset.watchSymbol;
  const removeSymbol = event.target.closest("[data-remove-symbol]")?.dataset.removeSymbol;
  if (watchSymbol) {
    $("symbolInput").value = watchSymbol;
    analyze(watchSymbol);
  }
  if (removeSymbol) removeWatchSymbol(removeSymbol);
});
$("scanResults").addEventListener("click", (event) => {
  const symbol = event.target.closest("[data-scan-symbol]")?.dataset.scanSymbol;
  if (!symbol) return;
  $("symbolInput").value = symbol;
  analyze(symbol);
});
window.addEventListener("resize", () => {
  priceChart?.resize();
  indicatorChart?.resize();
});

loadReports();
loadAiStatus();
renderWatchList();
renderSignalChanges();
analyze($("symbolInput").value);
