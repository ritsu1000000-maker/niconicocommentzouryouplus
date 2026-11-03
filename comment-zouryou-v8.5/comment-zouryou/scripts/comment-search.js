// コメント検索・統計パネル。取得済みの全コメント(NG適用前)を対象にする。
function setupCommentSearch(root) {
  const $ = (selector) => root.querySelector(selector);
  const panel = $("#comment_search");
  const resultsElement = $("#cs_results");
  const summaryElement = $("#cs_summary");
  const moreButton = $("#cs_more");
  const PAGE_SIZE = 300;
  let currentResults = [];
  let shownCount = 0;
  let highlighter = null;
  let statsDirty = true;
  let searchTimer;

  // ---------- 共通ユーティリティ ----------
  const formatVpos = (ms) => {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  };
  const parseVpos = (text) => {
    const value = String(text || "").trim();
    if (!value) return null;
    const parts = value.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
    return parts.reduce((sum, part) => sum * 60 + part, 0) * 1000;
  };
  const formatDate = (value) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  // 全角半角・カタカナひらがな・大文字小文字の違いを吸収する。
  const normalize = (text) =>
    String(text ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[ー－‐−–—]/g, "ー");
  const seek = (ms) => {
    if (!videoElement) return;
    videoElement.currentTime = Math.max(0, ms / 1000);
  };
  const allComments = () => {
    const raw = RAW_COMMENTS || {};
    return [
      ...(raw.comments || []).map((comment) => ({ comment, owner: false })),
      ...(raw.ownerComments || []).map((comment) => ({ comment, owner: true })),
    ];
  };
  const download = (content, name, type) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const videoId = () => apiData?.video?.id || "comments";

  // ---------- 検索 ----------
  function buildMatcher() {
    const query = $("#cs_query").value.trim();
    const fuzzy = $("#cs_fuzzy").checked;
    const exact = $("#cs_exact").checked;
    const prep = fuzzy ? normalize : (text) => String(text ?? "");
    highlighter = null;
    if (!query) return { test: () => true, error: null };
    if ($("#cs_regex").checked) {
      try {
        const regex = new RegExp(query, fuzzy ? "i" : "");
        highlighter = new RegExp(query, fuzzy ? "gi" : "g");
        return { test: (text) => regex.test(String(text ?? "")), error: null };
      } catch (error) {
        return { test: () => false, error: `正規表現が正しくありません: ${error.message}` };
      }
    }
    if (exact) {
      const target = prep(query);
      return { test: (text) => prep(text) === target, error: null };
    }
    // スペース区切り=AND、|区切り=OR、先頭-=除外
    const include = [];
    const exclude = [];
    // 「A | B」のように|の前後に空白があってもORとして扱う。
    for (const token of query.replace(/\s*\|\s*/g, "|").split(/\s+/)) {
      if (token.startsWith("-") && token.length > 1) exclude.push(prep(token.slice(1)));
      else include.push(token.split("|").filter(Boolean).map(prep));
    }
    const words = include.flat().filter(Boolean);
    if (words.length) {
      const escaped = words
        .sort((a, b) => b.length - a.length)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      // 表記ゆれ無視時は元の本文に直接当てられないため、そのまま一致する部分だけ強調する。
      highlighter = new RegExp(escaped.join("|"), "gi");
    }
    return {
      test: (text) => {
        const value = prep(text);
        return (
          include.every((group) => group.some((word) => value.includes(word))) &&
          exclude.every((word) => !value.includes(word))
        );
      },
      error: null,
    };
  }

  function runSearch() {
    const items = allComments();
    if (!items.length) {
      currentResults = [];
      summaryElement.textContent = "コメントを読み込むと検索できます。";
      resultsElement.replaceChildren();
      moreButton.style.display = "none";
      return;
    }
    const matcher = buildMatcher();
    if (matcher.error) {
      currentResults = [];
      summaryElement.textContent = matcher.error;
      resultsElement.replaceChildren();
      moreButton.style.display = "none";
      return;
    }
    const field = $("#cs_field").value;
    const scope = $("#cs_scope").value;
    const vposFrom = parseVpos($("#cs_vpos_from").value);
    const vposTo = parseVpos($("#cs_vpos_to").value);
    const dateFrom = $("#cs_date_from").value
      ? new Date($("#cs_date_from").value + "T00:00:00").getTime()
      : null;
    const dateTo = $("#cs_date_to").value
      ? new Date($("#cs_date_to").value + "T23:59:59").getTime()
      : null;
    const nicoruMin = Number($("#cs_nicoru").value) || 0;
    const lenMin = $("#cs_len_min").value === "" ? null : Number($("#cs_len_min").value);
    const lenMax = $("#cs_len_max").value === "" ? null : Number($("#cs_len_max").value);
    const premiumOnly = $("#cs_premium").checked;
    const caOnly = $("#cs_ca").checked;
    const afterNg = $("#cs_after_ng").checked;
    const visible = afterNg ? new Set(COMMENT[0]?.comments || []) : null;

    const fieldText = (comment) => {
      switch (field) {
        case "commands":
          return (comment.commands || []).join(" ");
        case "userId":
          return comment.userId || "";
        case "all":
          return `${comment.body} ${(comment.commands || []).join(" ")} ${comment.userId || ""}`;
        default:
          return comment.body;
      }
    };

    const started = performance.now();
    const results = items.filter(({ comment, owner }) => {
      if (scope === "normal" && owner) return false;
      if (scope === "owner" && !owner) return false;
      if (visible && !owner && !visible.has(comment)) return false;
      if (vposFrom != null && comment.vposMs < vposFrom) return false;
      if (vposTo != null && comment.vposMs > vposTo) return false;
      if (dateFrom != null || dateTo != null) {
        const time = new Date(comment.postedAt).getTime();
        if (dateFrom != null && !(time >= dateFrom)) return false;
        if (dateTo != null && !(time <= dateTo)) return false;
      }
      if ((comment.nicoruCount || 0) < nicoruMin) return false;
      const length = (comment.body || "").length;
      if (lenMin != null && length < lenMin) return false;
      if (lenMax != null && length > lenMax) return false;
      if (premiumOnly && !comment.isPremium) return false;
      if (caOnly && !isCommentArt(comment)) return false;
      return matcher.test(fieldText(comment));
    });

    const sorters = {
      vpos: (a, b) => a.comment.vposMs - b.comment.vposMs,
      new: (a, b) => new Date(b.comment.postedAt) - new Date(a.comment.postedAt),
      old: (a, b) => new Date(a.comment.postedAt) - new Date(b.comment.postedAt),
      nicoru: (a, b) => (b.comment.nicoruCount || 0) - (a.comment.nicoruCount || 0),
      no: (a, b) => a.comment.no - b.comment.no,
      length: (a, b) => (b.comment.body || "").length - (a.comment.body || "").length,
    };
    results.sort(sorters[$("#cs_sort").value] || sorters.vpos);
    currentResults = results;
    const ms = Math.round(performance.now() - started);
    summaryElement.textContent = `${results.length.toLocaleString()}件ヒット／全${items.length.toLocaleString()}件（${ms}ms）`;
    shownCount = 0;
    resultsElement.replaceChildren();
    renderMore();
  }

  function highlight(element, text) {
    if (!highlighter) {
      element.textContent = text;
      return;
    }
    highlighter.lastIndex = 0;
    let last = 0;
    const fragment = document.createDocumentFragment();
    for (const match of text.matchAll(highlighter)) {
      if (!match[0]) continue;
      fragment.append(text.slice(last, match.index));
      const mark = document.createElement("mark");
      mark.textContent = match[0];
      fragment.append(mark);
      last = match.index + match[0].length;
    }
    fragment.append(text.slice(last));
    element.replaceChildren(fragment);
  }

  function renderMore() {
    const fragment = document.createDocumentFragment();
    const end = Math.min(currentResults.length, shownCount + PAGE_SIZE);
    const sourceOf = RAW_COMMENTS?.sourceOf;
    const mainId = apiData?.video?.id;
    for (let i = shownCount; i < end; i++) {
      const { comment, owner } = currentResults[i];
      const row = document.createElement("div");
      row.className = "cs-result" + (owner ? " owner" : "");
      row.title = "クリックでこの位置へ移動";
      row.onclick = () => seek(comment.vposMs);

      const vpos = document.createElement("span");
      vpos.className = "cs-vpos";
      vpos.textContent = formatVpos(comment.vposMs);

      const main = document.createElement("div");
      main.className = "cs-main";
      const text = document.createElement("div");
      text.className = "cs-text";
      highlight(text, comment.body || "");
      const meta = document.createElement("div");
      meta.className = "cs-meta";
      const parts = [];
      if (owner) parts.push("投稿者");
      parts.push(`No.${comment.no}`);
      if (comment.nicoruCount) parts.push(`ニコる${comment.nicoruCount}`);
      const posted = formatDate(comment.postedAt);
      if (posted) parts.push(posted);
      if (comment.commands?.length) parts.push(comment.commands.join(" "));
      if (comment.isPremium) parts.push("P");
      const source = sourceOf?.get(comment);
      if (source && source !== mainId) parts.push(`引用:${source}`);
      meta.append(parts.join(" ・ "));
      if (comment.userId) {
        meta.append(" ・ ");
        const user = document.createElement("a");
        user.textContent = comment.userId.length > 14 ? comment.userId.slice(0, 12) + "…" : comment.userId;
        user.title = `このユーザー(${comment.userId})のコメントを検索`;
        user.onclick = (event) => {
          event.stopPropagation();
          searchUser(comment.userId);
        };
        meta.append(user);
      }
      main.append(text, meta);

      const actions = document.createElement("div");
      actions.className = "cs-actions";
      const ng = document.createElement("button");
      ng.type = "button";
      ng.className = "cs-mini";
      ng.textContent = "NG";
      ng.title = "この本文をNGコメントに追加";
      ng.onclick = (event) => {
        event.stopPropagation();
        if (!comment.body) return;
        if (!confirm(`「${comment.body}」をNGコメントに追加しますか？\n（リロードで反映されます）`)) return;
        addNgEntry?.("comment", comment.body);
      };
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "cs-mini";
      copy.textContent = "コピー";
      copy.onclick = (event) => {
        event.stopPropagation();
        navigator.clipboard?.writeText(comment.body || "").then(
          () => (copy.textContent = "済"),
          () => (copy.textContent = "失敗"),
        );
        setTimeout(() => (copy.textContent = "コピー"), 1200);
      };
      actions.append(copy, ng);
      row.append(vpos, main, actions);
      fragment.append(row);
    }
    shownCount = end;
    resultsElement.append(fragment);
    if (!currentResults.length && allComments().length) {
      const empty = document.createElement("p");
      empty.className = "cs-empty";
      empty.textContent = "該当するコメントはありません。";
      resultsElement.append(empty);
    }
    moreButton.style.display = shownCount < currentResults.length ? "inline-block" : "none";
    moreButton.textContent = `さらに表示（残り${(currentResults.length - shownCount).toLocaleString()}件）`;
  }

  function searchUser(userId) {
    switchTab("search");
    $("#cs_field").value = "userId";
    $("#cs_regex").checked = false;
    $("#cs_exact").checked = true;
    $("#cs_query").value = userId;
    runSearch();
  }
  function searchText(text) {
    switchTab("search");
    $("#cs_field").value = "body";
    $("#cs_regex").checked = false;
    $("#cs_exact").checked = true;
    $("#cs_query").value = text;
    runSearch();
  }
  function searchCommand(command) {
    switchTab("search");
    $("#cs_field").value = "commands";
    $("#cs_regex").checked = false;
    $("#cs_exact").checked = false;
    $("#cs_query").value = command;
    runSearch();
  }

  // ---------- 検索結果の描画・書き出し ----------
  updateSearchDrawButton = () => {
    $("#cs_draw").textContent = searchDrawActive ? "描画を元に戻す" : "検索結果だけを描画";
  };
  $("#cs_draw").onclick = () => {
    if (!DRAW_) {
      alert("【コメント増量】先にコメントを読み込んでください。");
      return;
    }
    if (searchDrawActive) {
      // NG適用済みの通常表示へ戻す。
      root.querySelector("#reload_niconicomments").click();
      return;
    }
    const normal = currentResults.filter((item) => !item.owner).map((item) => item.comment);
    const owner = currentResults.filter((item) => item.owner).map((item) => item.comment);
    COMMENT = [
      { commentCount: normal.length, comments: normal, fork: "comment-zouryou", id: 0 },
      { commentCount: owner.length, comments: owner, fork: "owner", id: 1 },
    ];
    searchDrawActive = true;
    updateSearchDrawButton();
    load_NiconiComments();
    LIST_COMMENT();
  };

  $("#cs_export").onclick = () => {
    if (!currentResults.length) {
      alert("【コメント増量】書き出すコメントがありません。");
      return;
    }
    const format = $("#cs_export_format").value;
    const rows = currentResults.map(({ comment, owner }) => ({
      no: comment.no,
      vpos: formatVpos(comment.vposMs),
      vposMs: comment.vposMs,
      body: comment.body,
      commands: (comment.commands || []).join(" "),
      userId: comment.userId || "",
      postedAt: comment.postedAt,
      nicoruCount: comment.nicoruCount || 0,
      score: comment.score || 0,
      isPremium: !!comment.isPremium,
      owner,
    }));
    const base = `${videoId()}_search`;
    if (format === "json") {
      download(JSON.stringify(rows, null, 2), base + ".json", "application/json");
    } else if (format === "txt") {
      download(rows.map((r) => `[${r.vpos}] ${r.body}`).join("\n"), base + ".txt", "text/plain");
    } else {
      const header = Object.keys(rows[0]);
      const escape = (value) => {
        const text = String(value ?? "");
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const csv = [header.join(","), ...rows.map((r) => header.map((key) => escape(r[key])).join(","))].join("\r\n");
      // Excelで文字化けしないようBOMを付ける。
      download("﻿" + csv, base + ".csv", "text/csv");
    }
  };

  // ---------- 統計 ----------
  function topCounts(values, limit) {
    const counts = new Map();
    for (const value of values) {
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  function renderRank(listElement, entries, onPick, formatLabel = (v) => v) {
    listElement.replaceChildren();
    if (!entries.length) {
      const li = document.createElement("li");
      li.textContent = "データがありません";
      listElement.append(li);
      return;
    }
    entries.forEach(([value, count], index) => {
      const li = document.createElement("li");
      const rank = document.createElement("span");
      rank.textContent = `${index + 1}.`;
      const label = document.createElement("span");
      label.className = "cs-rank-text";
      label.textContent = formatLabel(value);
      label.title = String(value);
      const num = document.createElement("span");
      num.className = "cs-rank-count";
      num.textContent = count.toLocaleString();
      li.append(rank, label, num);
      li.onclick = () => onPick(value);
      listElement.append(li);
    });
  }

  let heatBins = [];
  let heatDuration = 0;
  function drawBars(canvas, values, color, markerRatio) {
    const ctx = canvas.getContext("2d");
    const width = (canvas.width = canvas.clientWidth * devicePixelRatio || 600);
    const height = (canvas.height = 110 * devicePixelRatio);
    ctx.clearRect(0, 0, width, height);
    const max = Math.max(1, ...values);
    const barWidth = width / Math.max(1, values.length);
    ctx.fillStyle = color;
    values.forEach((value, i) => {
      const h = (value / max) * (height - 6);
      ctx.fillRect(i * barWidth, height - h, Math.max(1, barWidth - 1), h);
    });
    if (markerRatio != null && Number.isFinite(markerRatio)) {
      ctx.fillStyle = "#ff4d6d";
      ctx.fillRect(Math.min(width - 2, markerRatio * width), 0, 2 * devicePixelRatio, height);
    }
  }

  function renderStats() {
    statsDirty = false;
    const items = allComments();
    const cards = $("#cs_cards");
    cards.replaceChildren();
    const normal = items.filter((item) => !item.owner).map((item) => item.comment);
    const users = new Set(normal.map((c) => c.userId).filter(Boolean));
    const times = normal
      .map((c) => new Date(c.postedAt).getTime())
      .filter((t) => Number.isFinite(t) && t > 0);
    // 大量のコメントでもスタックを溢れさせないようループで求める。
    let oldest = null,
      newest = null;
    for (const t of times) {
      if (oldest === null || t < oldest) oldest = t;
      if (newest === null || t > newest) newest = t;
    }
    const visible = COMMENT[0]?.comments?.length ?? 0;
    const card = (label, value, sub) => {
      const div = document.createElement("div");
      div.className = "cs-card";
      const small = document.createElement("small");
      small.textContent = label;
      const b = document.createElement("b");
      b.textContent = value;
      div.append(small, b);
      if (sub) {
        const s = document.createElement("small");
        s.textContent = sub;
        div.append(s);
      }
      cards.append(div);
    };
    card("取得したコメント", normal.length.toLocaleString(), `表示中 ${visible.toLocaleString()}件`);
    card("ユニークユーザー", users.size.toLocaleString());
    card("投稿者コメント", (items.length - normal.length).toLocaleString());
    card(
      "コメントの期間",
      oldest ? formatDate(oldest).slice(0, 10) : "—",
      newest ? `〜 ${formatDate(newest).slice(0, 10)}` : "",
    );
    if (!normal.length) {
      heatBins = [];
      drawBars($("#cs_heatmap"), [], "#5ac0df");
      drawBars($("#cs_timeline"), [], "#929ffb");
      for (const id of ["#cs_hot", "#cs_top_comments", "#cs_top_commands", "#cs_top_users"]) {
        renderRank($(id), [], () => {});
      }
      return;
    }

    // 盛り上がりグラフ(再生位置のヒストグラム)
    const videoDuration = Number(videoElement?.duration);
    heatDuration =
      Number.isFinite(videoDuration) && videoDuration > 0
        ? videoDuration * 1000
        : normal.reduce((max, c) => Math.max(max, c.vposMs || 0), 0) + 1;
    const binCount = 120;
    heatBins = new Array(binCount).fill(0);
    for (const c of normal) {
      const index = Math.min(binCount - 1, Math.max(0, Math.floor((c.vposMs / heatDuration) * binCount)));
      heatBins[index]++;
    }
    drawHeatmap();

    // 盛り上がりシーン上位
    const hot = heatBins
      .map((count, index) => [index, count])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .filter(([, count]) => count > 0);
    renderRank(
      $("#cs_hot"),
      hot,
      (index) => seek((index / binCount) * heatDuration),
      (index) =>
        `${formatVpos((index / binCount) * heatDuration)} 〜 ${formatVpos(((index + 1) / binCount) * heatDuration)}`,
    );

    // 投稿数の推移(月ごと)
    if (times.length) {
      const first = new Date(oldest);
      const last = new Date(newest);
      const months = (last.getFullYear() - first.getFullYear()) * 12 + last.getMonth() - first.getMonth() + 1;
      const useDays = months <= 2;
      const bucketCount = useDays ? Math.max(1, Math.ceil((newest - oldest) / 86400000) + 1) : months;
      const buckets = new Array(Math.min(bucketCount, 600)).fill(0);
      for (const t of times) {
        const index = useDays
          ? Math.floor((t - oldest) / 86400000)
          : (new Date(t).getFullYear() - first.getFullYear()) * 12 + new Date(t).getMonth() - first.getMonth();
        if (index >= 0 && index < buckets.length) buckets[index]++;
      }
      drawBars($("#cs_timeline"), buckets, "#929ffb");
      $("#cs_timeline").title = `${formatDate(oldest).slice(0, 10)} 〜 ${formatDate(newest).slice(0, 10)}（${useDays ? "日" : "月"}ごと）`;
    }

    renderRank($("#cs_top_comments"), topCounts(normal.map((c) => (c.body || "").trim()), 20), searchText);
    renderRank(
      $("#cs_top_commands"),
      topCounts(normal.flatMap((c) => c.commands || []).filter((c) => c !== "184"), 10),
      searchCommand,
    );
    renderRank(
      $("#cs_top_users"),
      topCounts(normal.map((c) => c.userId), 10),
      searchUser,
      (id) => (id.length > 24 ? id.slice(0, 22) + "…" : id),
    );
  }

  function drawHeatmap() {
    const ratio =
      videoElement && heatDuration ? (videoElement.currentTime * 1000) / heatDuration : null;
    drawBars($("#cs_heatmap"), heatBins, "#5ac0df", ratio);
  }
  $("#cs_heatmap").onclick = (event) => {
    if (!heatDuration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    seek(((event.clientX - rect.left) / rect.width) * heatDuration);
    drawHeatmap();
  };
  // 統計タブ表示中は再生位置マーカーを更新する。
  setInterval(() => {
    if (panel.classList.contains("open") && $("[data-panel=stats]").style.display !== "none" && heatBins.length) {
      drawHeatmap();
    }
  }, 500);

  // ---------- パネル操作 ----------
  function switchTab(tab) {
    root.querySelectorAll("#comment_search .cs-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tab);
    });
    root.querySelectorAll("#comment_search .cs-body").forEach((body) => {
      body.style.display = body.dataset.panel === tab ? "block" : "none";
    });
    if (tab === "stats" && statsDirty) renderStats();
  }
  root.querySelectorAll("#comment_search .cs-tab").forEach((button) => {
    button.onclick = () => switchTab(button.dataset.tab);
  });
  $("#comment_search_open").onclick = () => {
    panel.classList.add("open");
    if (!currentResults.length) runSearch();
    $("#cs_query").focus();
  };
  $("#comment_search_exit").onclick = () => panel.classList.remove("open");

  const debounced = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  };
  $("#cs_query").addEventListener("input", debounced);
  $("#cs_query").addEventListener("keydown", (event) => {
    event.stopPropagation(); // 動画プレイヤーのショートカットを発動させない
    if (event.key === "Enter") {
      clearTimeout(searchTimer);
      runSearch();
    }
  });
  panel.addEventListener("keydown", (event) => event.stopPropagation());
  for (const id of [
    "#cs_field", "#cs_fuzzy", "#cs_regex", "#cs_exact", "#cs_vpos_from", "#cs_vpos_to",
    "#cs_date_from", "#cs_date_to", "#cs_nicoru", "#cs_len_min", "#cs_len_max",
    "#cs_scope", "#cs_premium", "#cs_ca", "#cs_after_ng", "#cs_sort",
  ]) {
    $(id).addEventListener("change", runSearch);
  }
  $("#cs_vpos_now").onclick = () => {
    const now = (videoElement?.currentTime || 0) * 1000;
    $("#cs_vpos_from").value = formatVpos(Math.max(0, now - 30000));
    $("#cs_vpos_to").value = formatVpos(now + 30000);
    $("#cs_sort").value = "vpos";
    runSearch();
  };
  $("#cs_reset").onclick = () => {
    $("#cs_query").value = "";
    for (const id of ["#cs_vpos_from", "#cs_vpos_to", "#cs_date_from", "#cs_date_to", "#cs_len_min", "#cs_len_max"]) {
      $(id).value = "";
    }
    $("#cs_nicoru").value = 0;
    $("#cs_field").value = "body";
    $("#cs_scope").value = "both";
    $("#cs_sort").value = "vpos";
    for (const id of ["#cs_regex", "#cs_exact", "#cs_premium", "#cs_ca", "#cs_after_ng"]) $(id).checked = false;
    $("#cs_fuzzy").checked = true;
    runSearch();
  };
  moreButton.onclick = renderMore;

  // 読み込み完了時に結果と統計を作り直す。
  onCommentsLoaded = () => {
    searchDrawActive = false;
    updateSearchDrawButton();
    statsDirty = true;
    runSearch();
    if ($("[data-panel=stats]").style.display !== "none") renderStats();
  };
  updateSearchDrawButton();
}
