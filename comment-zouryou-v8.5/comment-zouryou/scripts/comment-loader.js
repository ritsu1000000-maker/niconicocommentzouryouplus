// 視聴情報とコメントを取得し、終了した取得処理の結果は破棄する。
let commentLoadController;
function parseWatchPage(html, videoId) {
  const page = new DOMParser().parseFromString(html, "text/html");
  const embedded = page
    .querySelector('meta[name="server-response"]')
    ?.getAttribute("content");
  if (!embedded) {
    throw new Error(
      `${videoId}: 動画ページに視聴情報がありません。ログイン状態や動画の公開状態を確認してください。`,
    );
  }
  let data;
  try {
    data = JSON.parse(embedded);
  } catch {
    throw new Error(`${videoId}: 動画ページの視聴情報を解析できませんでした。`);
  }
  return parseWatchData(data, videoId);
}

function parseWatchData(data, videoId) {
  const response = data?.data?.response;
  const currentData = response?.$watchV4?.data;
  const sourceData = {
    ...response,
    ...currentData,
    comment: currentData?.comment ?? response?.comment,
    video: currentData?.video ?? response?.video,
  };
  const nvComment = sourceData.comment?.nvComment;
  if (
    (data?.meta?.status !== undefined && data.meta.status !== 200) ||
    sourceData.video?.id !== videoId ||
    typeof nvComment?.server !== "string" ||
    !nvComment.server ||
    typeof nvComment?.threadKey !== "string" ||
    !nvComment.threadKey ||
    !Array.isArray(nvComment?.params?.targets) ||
    !nvComment.params.targets.length ||
    nvComment.params.targets.some(
      (target) => !target?.id || typeof target.fork !== "string",
    ) ||
    !Array.isArray(sourceData.comment?.threads)
  ) {
    throw new Error(
      `${videoId}: コメント取得に必要な視聴情報がありません。ログイン状態や動画の公開状態を確認してください。`,
    );
  }
  return sourceData;
}

async function fetchWatchData(videoId, fetch, checkLoad) {
  const url = "https://www.nicovideo.jp/watch/" + videoId;
  const errors = [];
  // 現在有効なHTML方式を優先し、利用できなければ従来のJSON方式を試す。
  for (const format of ["HTML", "JSON"]) {
    try {
      const response = await fetch(
        format === "HTML" ? url : url + "?responseType=json",
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data =
        format === "HTML"
          ? parseWatchPage(await response.text(), videoId)
          : parseWatchData(await response.json(), videoId);
      checkLoad();
      return data;
    } catch (error) {
      // 中止された取得では、別方式への切り替えを行わない。
      checkLoad();
      if (error.name === "AbortError") throw error;
      errors.push(`${format}: ${error.message}`);
    }
  }
  throw new Error(
    `${videoId}: 動画情報の取得に失敗しました（${errors.join(" / ")}）。`,
  );
}

function parseLocalComments(text) {
  const data = JSON.parse(text.replace(/^\uFEFF/, ""));
  let threads = Array.isArray(data)
    ? data
    : (data?.data?.threads ?? data?.threads);
  if (!Array.isArray(threads))
    throw new Error("対応するコメントJSON形式ではありません。");
  // コメントだけの配列も通常コメントとして扱う。
  if (threads.length && typeof threads[0]?.body === "string") {
    threads = [{ fork: "main", comments: threads }];
  }
  return threads.map((thread) => {
    if (!thread || !Array.isArray(thread.comments)) {
      throw new Error("コメントのスレッド形式が正しくありません。");
    }
    return {
      fork: thread.fork,
      comments: thread.comments.map((comment, index) => {
        if (
          !comment ||
          typeof comment.body !== "string" ||
          !Number.isFinite(comment.vposMs) ||
          comment.vposMs < 0 ||
          (comment.commands !== undefined &&
            (!Array.isArray(comment.commands) ||
              comment.commands.some((command) => typeof command !== "string")))
        ) {
          throw new Error(
            `コメント${index + 1}の本文・再生位置・コマンドが正しくありません。`,
          );
        }
        return {
          id: "",
          no: index + 1,
          isMyPost: false,
          isPremium: false,
          nicoruCount: 0,
          nicoruId: null,
          score: 0,
          source: "",
          userId: "",
          postedAt: "1970-01-01T00:00:00Z",
          ...comment,
          commands: comment.commands ?? [],
        };
      }),
    };
  });
}

function cancelCommentLoad() {
  commentLoadController?.abort();
  commentLoadController = undefined;
}

// 取得設定(並列数・間隔など)を設定画面から読む。
function getFetchSettings() {
  const num = (id, fallback, min, max) => {
    const value = Number(document.getElementById(id)?.value);
    return Number.isFinite(value) && value > 0
      ? Math.min(max, Math.max(min, value))
      : fallback;
  };
  return {
    parallel: document.getElementById("isparallel")?.checked ?? true,
    // 制限に当たらない安全な範囲にだけ設定できるようにする。
    concurrency: Math.floor(num("parallel_num", 2, 1, 4)),
    interval: Math.floor(num("request_interval", 1000, 1000, 5000)),
    perMinute: Math.floor(num("per_minute", 50, 1, 60)),
  };
}

const toEpochSeconds = (value) => {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : NaN;
};

async function LOADCOMMENT(mode) {
  cancelCommentLoad();
  const controller = new AbortController();
  commentLoadController = controller;
  const checkLoad = () => {
    if (controller.signal.aborted)
      throw new DOMException("コメント取得を中止しました", "AbortError");
  };
  // 通信と本文の読み込み後に中止を確認し、古い結果を反映させない。
  const fetch = async (...args) => {
    checkLoad();
    const response = await globalThis.fetch(args[0], {
      ...args[1],
      signal: controller.signal,
    });
    checkLoad();
    return {
      status: response.status,
      headers: response.headers,
      json: async () => {
        const data = await response.json();
        checkLoad();
        return data;
      },
      text: async () => {
        const data = await response.text();
        checkLoad();
        return data;
      },
    };
  };
  // APIの待機も終了時に即座に解除する。
  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      checkLoad();
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("コメント取得を中止しました", "AbortError"));
      };
      const timer = setTimeout(() => {
        controller.signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      controller.signal.addEventListener("abort", abort, { once: true });
    });
  try {
    attachCommentOverlay();

    logger("お待ち下さい");
    loading.style.display = "block";
    document.getElementsByClassName("loadbutton_text")[0].innerText =
      "読み込み中";
    const startedAt = performance.now();

    let match = location.href.match(/\/watch\/((?:sm|so|nm)\d+)/);
    if (match === null) throw new Error("動画IDを取得できませんでした。");

    const files = [...localCommentFiles];
    const citations = videoCitations.filter((item) => item.videoId?.trim());
    for (const item of citations) {
      if (
        !/^(sm|so|nm)\d+$/.test(item.videoId.trim()) ||
        !Number.isSafeInteger(Number(item.multiplier)) ||
        Number(item.multiplier) < 1
      ) {
        throw new Error(
          "動画引用にはsm番号と1以上の整数の倍数を指定してください。",
        );
      }
    }
    const sources = [
      { videoId: match[1], multiplier: Number(CommentLimit) },
      ...citations.map((item) => ({
        videoId: item.videoId.trim(),
        multiplier: Number(item.multiplier),
      })),
    ];
    const ownerComments = [];
    const comments = [];
    const sourceOf = new WeakMap();
    // ファイルは取得開始時の選択を使い、形式を確認してから通信を開始する。
    for (const file of files) {
      let imported;
      try {
        imported = parseLocalComments(await file.text());
      } catch (error) {
        checkLoad();
        throw new Error(`${file.name}: ${error.message}`);
      }
      checkLoad();
      for (const thread of imported) {
        const target = thread.fork === "owner" ? ownerComments : comments;
        for (const comment of thread.comments) {
          sourceOf.set(comment, file.name);
          target.push(comment);
        }
      }
      logger(`${file.name}を読み込みました。`);
    }

    const settings = getFetchSettings();
    // 待機ログは1秒に1回だけ出す(並列ワーカーが同時に待つため)。
    let lastWaitLog = -1;
    const scheduler = new RequestScheduler({
      concurrency: settings.parallel ? settings.concurrency : 1,
      interval: settings.interval,
      perMinute: settings.perMinute,
      signal: controller.signal,
      onWait: (s) => {
        const remaining = s.remainingPause();
        if (remaining <= 0 || remaining === lastWaitLog) return;
        lastWaitLog = remaining;
        logger(
          `回数制限の応答があったため全体を一時停止しています。あと${remaining}秒（${s.describe()}）`,
        );
      },
    });
    logger(`安全ペースで取得します: ${scheduler.describe()}`);
    // 上限に合わせて待つときは、残り時間の目安を表示する。
    let lastPaceLog = 0;
    const paceTimer = setInterval(() => {
      if (controller.signal.aborted) return clearInterval(paceTimer);
      const { at } = scheduler.nextAllowedAt(Date.now());
      const wait = Math.ceil((at - Date.now()) / 1000);
      if (wait >= 3 && Date.now() - lastPaceLog > 4000 && scheduler.queue.length) {
        lastPaceLog = Date.now();
        logger(`回数制限に当たらないよう、1分${scheduler.perMinute}回のペースに合わせて待機中…（約${wait}秒）`);
      }
    }, 1000);
    controller.signal.addEventListener("abort", () => clearInterval(paceTimer), { once: true });

    // 進捗はスレッドごとの予定ページ数の合計で表す。
    const plans = [];
    const updateProgress = () => {
      const total = plans.reduce((sum, plan) => sum + Math.max(plan.planned, plan.used), 0);
      const done = plans.reduce((sum, plan) => sum + plan.used, 0);
      const ratio = total > 0 ? Math.min(1, done / total) : 0;
      document.getElementById("progress_left").style.width =
        100 - ratio * 100 + "%";
      return { done, total };
    };

    let loginAlerted = false;
    const date =
      OLD_DATE.value === ""
        ? new Date()
        : new Date(OLD_DATE.value + " " + OLD_TIME.value);
    const startWhen = Math.floor(date.getTime() / 1000);

    // 1回のスレッド取得(最大1000件)。再試行・回数制限・トークン更新をここで吸収する。
    async function requestPage(ctx, target, when) {
      let networkFails = 0,
        serverFails = 0,
        limitedCount = 0;
      for (;;) {
        const usedKey = ctx.threadKey;
        const outcome = await scheduler.run(async () => {
          let req;
          try {
            req = await fetch(`${ctx.nvComment.server}/v1/threads`, {
              method: "POST",
              headers: {
                "content-type": "text/plain;charset=UTF-8",
                "x-client-os-type": "others",
                "x-frontend-id": "6",
                "x-frontend-version": "0",
              },
              body: JSON.stringify({
                threadKey: usedKey,
                params: {
                  language: ctx.nvComment.params.language,
                  targets: [target],
                },
                additionals: { res_from: -1000, when },
              }),
            });
          } catch (error) {
            checkLoad();
            if (error.name === "AbortError") throw error;
            return { kind: "network", error };
          }
          if (req.status === 429) {
            return { kind: "limited", retryAfter: req.headers?.get("Retry-After") };
          }
          if (req.status >= 500) return { kind: "server", status: req.status };
          let res;
          try {
            res = await req.json();
          } catch (error) {
            checkLoad();
            if (error.name === "AbortError") throw error;
            return { kind: "server", status: req.status };
          }
          return { kind: "ok", res };
        });
        checkLoad();

        if (outcome.kind === "ok") {
          const code = outcome.res?.meta?.errorCode;
          if (code === "TOO_MANY_REQUESTS") {
            outcome.kind = "limited";
          } else if (code === "EXPIRED_TOKEN") {
            await refreshThreadKey(ctx, usedKey);
            continue;
          } else if (code === "INVALID_TOKEN") {
            if (!loginAlerted) {
              loginAlerted = true;
              alert(
                "【コメント増量】ログアウト状態です。ログインをして再度実行してください。",
              );
            }
            throw new Error("ログインしていません。ログインしてから再度実行してください。");
          } else {
            const thread = outcome.res?.data?.threads?.[0];
            if (thread && Array.isArray(thread.comments)) {
              scheduler.success();
              return thread;
            }
            outcome.kind = "server";
            outcome.status = code || "不明な応答";
          }
        }

        if (outcome.kind === "limited") {
          if (++limitedCount > 20)
            throw new Error("回数制限が解除されませんでした。時間をおいて再度お試しください。");
          const retryAfter = outcome.retryAfter;
          const retrySeconds =
            retryAfter && /^\d+$/.test(retryAfter)
              ? Number(retryAfter)
              : retryAfter
                ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)
                : 60;
          scheduler.limited(
            Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds : 60,
          );
          await scheduler.waitForResume(sleep);
          continue;
        }
        if (outcome.kind === "network") {
          // CORSで遮断された429は通信失敗に見えるため、2回目以降は回数制限として全体を待たせる。
          networkFails++;
          scheduler.stats.retries++;
          if (networkFails > 6) throw outcome.error;
          if (networkFails === 1) {
            await sleep(3000);
          } else {
            scheduler.limited(Math.min(70 * 2 ** (networkFails - 2), 240));
            await scheduler.waitForResume(sleep);
          }
          continue;
        }
        // 5xxなど一時的なサーバーエラー
        serverFails++;
        scheduler.stats.retries++;
        if (serverFails > 5)
          throw new Error(`コメントAPIの一時エラーが続きました（${outcome.status}）。`);
        logger(`コメントAPIの一時エラー（${outcome.status}）。${2 ** serverFails}秒後に再試行します。`, false);
        await sleep(2000 * 2 ** (serverFails - 1));
      }
    }

    // 並列ワーカーが同時に期限切れを検出しても、更新は1回にまとめる。
    async function refreshThreadKey(ctx, usedKey) {
      if (ctx.threadKey !== usedKey) return;
      if (!ctx.refreshing) {
        logger(`${ctx.videoId}: threadKeyを新たに取得しています…`);
        ctx.refreshing = fetch(
          "https://nvapi.nicovideo.jp/v1/comment/keys/thread?videoId=" + ctx.videoId,
          {
            headers: {
              "X-Frontend-Id": "6",
              "X-Frontend-Version": "0",
              "Content-Type": "application/json",
            },
            credentials: "include",
          },
        )
          .then((r) => r.json())
          .then((j) => {
            if (!j?.data?.threadKey) throw new Error("threadKeyの再取得に失敗しました。");
            ctx.threadKey = j.data.threadKey;
          })
          .finally(() => {
            ctx.refreshing = undefined;
          });
      }
      await ctx.refreshing;
    }

    // 1スレッド分を取得する。並列時は投稿日時で区間に分けて同時に遡る。
    async function fetchTarget(ctx, target, budget) {
      const label = `${ctx.videoId} ${target.fork}`;
      const plan = { used: 0, planned: budget };
      plans.push(plan);
      const seen = new Set();
      const result = [];
      let reachedHead = false;
      const take = () => {
        if (plan.used >= budget) return false;
        plan.used++;
        return true;
      };
      const add = (list, lower) => {
        let added = 0;
        for (const comment of list) {
          if (lower != null && toEpochSeconds(comment.postedAt) <= lower) continue;
          if (seen.has(comment.no)) continue;
          seen.add(comment.no);
          sourceOf.set(comment, ctx.videoId);
          result.push(comment);
          added++;
        }
        return added;
      };
      const isHead = (list) => list.length === 0 || list[0].no < 5;
      const report = (text) => {
        updateProgress();
        // 倍数の上限はスレッドごとなので、そのスレッドの回数を上限と並べて表示する。
        logger(`[${label} ${plan.used}/${budget}回] ${text}（${result.length}件）`);
      };

      // 区間 [lower, upper] を新しい方から遡る。
      async function walk(upper, lower, segmentLabel) {
        let when = upper + 1;
        while (take()) {
          const thread = await requestPage(ctx, target, when);
          const added = add(thread.comments, lower);
          if (isHead(thread.comments)) {
            reachedHead = true;
            report(`${segmentLabel}スレッドの先頭まで読み込みました`);
            return;
          }
          const oldest = toEpochSeconds(thread.comments[0].postedAt);
          report(`${segmentLabel}コメ番${thread.comments[0].no}まで読み込みました`);
          if (lower != null && oldest <= lower) return;
          // 同じ秒のコメントを取りこぼさないよう1秒重ねて遡り、重複はコメ番で除く。
          // 新しいコメントが1件も無ければ(同じ秒に1000件以上など)必ず前に進める。
          if (!Number.isFinite(oldest)) return;
          when = added > 0 && oldest + 1 < when ? oldest + 1 : Math.min(when - 1, oldest);
        }
      }

      // 1ページ目で総数と最古時刻を把握する。
      take();
      const first = await requestPage(ctx, target, startWhen);
      add(first.comments, null);
      const commentCount = Number(first.commentCount);
      if (Number.isFinite(commentCount) && commentCount > 0) {
        plan.planned = Math.min(budget, Math.max(1, Math.ceil(commentCount / 1000)));
      }
      if (isHead(first.comments)) {
        reachedHead = true;
        plan.planned = plan.used;
        report("スレッドの先頭まで読み込みました");
        return result;
      }
      report(`コメ番${first.comments[0].no}まで読み込みました`);

      const oldestT = toEpochSeconds(first.comments[0].postedAt);
      const registeredT = toEpochSeconds(ctx.registeredAt);
      const remainingBudget = budget - plan.used;
      // 区間の境目では最大1ページ分の重複が出るため、区間数は残りページ数の半分程度に抑える。
      const segmentCount = Math.min(
        remainingBudget,
        settings.concurrency * 2,
        Math.floor(Math.ceil(first.comments[0].no / 1000) / 2),
      );
      if (
        !settings.parallel ||
        segmentCount < 2 ||
        !Number.isFinite(oldestT) ||
        !Number.isFinite(registeredT) ||
        oldestT <= registeredT
      ) {
        await walk(oldestT, null, "");
      } else {
        // 投稿直後ほどコメントが多いため、区間は投稿日側を細かく切る(二乗分布)。
        const span = oldestT - registeredT;
        const bounds = [];
        for (let k = 0; k <= segmentCount; k++) {
          bounds.push(Math.floor(registeredT + span * (k / segmentCount) ** 2));
        }
        const segments = [];
        for (let k = segmentCount - 1; k >= 0; k--) {
          segments.push({
            upper: k === segmentCount - 1 ? oldestT : bounds[k + 1],
            lower: k === 0 ? null : bounds[k],
            label: `区間${segmentCount - k}/${segmentCount} `,
          });
        }
        const workers = Math.min(settings.concurrency, segments.length);
        await Promise.all(
          Array.from({ length: workers }, async () => {
            while (segments.length && plan.used < budget) {
              const segment = segments.shift();
              await walk(segment.upper, segment.lower, segment.label);
            }
          }),
        );
        if (plan.used >= budget) {
          logger(`${label}: 倍数の上限に達したため、全期間から分散して取得しました。`);
        }
      }
      plan.planned = plan.used;
      updateProgress();
      return result;
    }

    // 動画ごとに視聴情報を取得し、全スレッドを同時に処理する(実際の流量はschedulerが制御)。
    const sourceResults = await Promise.all(
      sources.map(async (source, sourceIndex) => {
        const sourceData = await fetchWatchData(source.videoId, fetch, checkLoad);
        if (sourceIndex === 0) apiData = sourceData;
        const nvComment = sourceData.comment.nvComment;
        const ctx = {
          videoId: source.videoId,
          nvComment,
          threadKey: nvComment.threadKey,
          registeredAt: sourceData.video?.registeredAt,
        };
        const targets = nvComment.params.targets.filter(
          (target) =>
            !(
              (document.getElementById("iseasy").checked || mode == "auto") &&
              target.fork == "easy"
            ),
        );
        logger(
          `${source.videoId}: ${targets.length}スレッドをそれぞれ最大${source.multiplier}回読み込みます。`,
        );
        return Promise.all(
          targets.map(async (target) => ({
            fork: target.fork,
            comments: await fetchTarget(ctx, target, source.multiplier),
          })),
        );
      }),
    );
    for (const threads of sourceResults) {
      for (const thread of threads) {
        const destination = thread.fork === "owner" ? ownerComments : comments;
        for (const comment of thread.comments) destination.push(comment);
      }
    }
    clearInterval(paceTimer);
    checkLoad();

    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    CommentLoadingScreenWrapper.style.background = `rgba(0, 0, 0, .9)`;
    logger(
      `${comments.length}件のコメントを${seconds}秒で読み込みました（リクエスト${scheduler.stats.requests}回・制限${scheduler.stats.limited}回）`,
    );
    logger(`NG設定を適用しています`);

    RAW_COMMENTS = { comments, ownerComments, sourceOf };
    const buildComment = (filteredComments) => [
      {
        commentCount: comments.length,
        comments: filteredComments,
        fork: "comment-zouryou",
        id: 0,
      },
      {
        commentCount: ownerComments.length,
        comments: ownerComments, //投稿者コメントにフィルターを適用する?
        fork: "owner",
        id: 1,
      },
    ];
    const filteredComments = await COMMENT_CONTROL(comments);
    checkLoad();
    COMMENT = buildComment(filteredComments);
    document.getElementById("reload_niconicomments").onclick = async () => {
      const filteredComments = await COMMENT_CONTROL(comments);
      if (controller.signal.aborted || !DRAW_) return;
      COMMENT = buildComment(filteredComments);
      searchDrawActive = false;
      updateSearchDrawButton?.();
      load_NiconiComments();
      clearInterval(list_interval);
      LIST_COMMENT();
    };

    logger(`描画準備中`);
    document.getElementById("progress_left").style.width = "0%";
    PLAYCOMMENT();
    onCommentsLoaded?.();
  } catch (error) {
    if (controller.signal.aborted) return;
    console.error("コメント取得に失敗しました", error);
    logger(
      `コメント取得に失敗しました。${error.message || "再度お試しください。"}`,
    );
    loading.style.display = "none";
    document.getElementById("zenkomebutton").disabled = false;
  }
}
