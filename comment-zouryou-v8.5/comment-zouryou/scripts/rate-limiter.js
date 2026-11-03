// コメントAPIへのリクエストを全スレッド・全動画・全タブで共有する流量制御。
// 回数制限(429)に「当たってから待つ」のではなく、最初から上限より遅いペースに固定して当たらないようにする。
// ・リクエスト開始間隔の最小値(既定1秒)
// ・直近60秒のリクエスト数の上限(既定1分50回)
// ・この記録はlocalStorageに保存し、再読み込み・別タブ・連続実行でも合算して守る
// ・万一429が返った場合は、指定秒数だけ全体を止めて同時接続数を1にする(保険)
const REQUEST_LOG_KEY = "zouryou_request_log";

function readRequestLog(now = Date.now()) {
  try {
    const log = JSON.parse(localStorage.getItem(REQUEST_LOG_KEY) || "[]");
    return Array.isArray(log) ? log.filter((t) => Number.isFinite(t) && now - t < 60000) : [];
  } catch {
    return [];
  }
}

function writeRequestLog(log) {
  try {
    localStorage.setItem(REQUEST_LOG_KEY, JSON.stringify(log));
  } catch {}
}

class RequestScheduler {
  constructor({ concurrency = 2, interval = 1000, perMinute = 50, signal, onWait } = {}) {
    this.maxConcurrency = Math.max(1, Math.min(4, Math.floor(concurrency) || 1));
    this.concurrency = this.maxConcurrency;
    this.interval = Math.max(1000, Number(interval) || 1000);
    this.perMinute = Math.max(1, Math.min(60, Math.floor(perMinute) || 50));
    this.signal = signal;
    this.onWait = onWait;
    this.active = 0;
    this.queue = [];
    this.pausedUntil = 0;
    this.stats = { requests: 0, limited: 0, retries: 0 };
    this.pumpTimer = undefined;
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(this.pumpTimer);
        const queued = this.queue.splice(0);
        for (const item of queued) {
          item.reject(new DOMException("コメント取得を中止しました", "AbortError"));
        }
      },
      { once: true },
    );
  }

  // task は「枠を確保してから」実行される。戻り値をそのまま返す。
  run(task) {
    return new Promise((resolve, reject) => {
      if (this.signal?.aborted) {
        reject(new DOMException("コメント取得を中止しました", "AbortError"));
        return;
      }
      this.queue.push({ task, resolve, reject });
      this.pump();
    });
  }

  // 次にリクエストを開始してよい時刻(他タブ・過去の実行分も含めて計算する)。
  nextAllowedAt(now) {
    const log = readRequestLog(now);
    let at = this.pausedUntil;
    if (log.length) {
      // 直前のリクエストから最小間隔を空ける。
      at = Math.max(at, log[log.length - 1] + this.interval);
      // 直近60秒の回数が上限なら、一番古いものが60秒前になるまで待つ。
      if (log.length >= this.perMinute) {
        at = Math.max(at, log[log.length - this.perMinute] + 60000 + 100);
      }
    }
    return { at, log };
  }

  pump() {
    clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    if (this.signal?.aborted) return;
    while (this.queue.length && this.active < this.concurrency) {
      const now = Date.now();
      const { at, log } = this.nextAllowedAt(now);
      if (at > now) {
        this.pumpTimer = setTimeout(() => this.pump(), Math.min(at - now, 5000));
        return;
      }
      log.push(now);
      writeRequestLog(log);
      const item = this.queue.shift();
      this.active++;
      this.stats.requests++;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  success() {}

  // 保険: 万一429が返ったら全体を止め、この取得の間は同時接続数を1にする。
  limited(waitSeconds) {
    this.stats.limited++;
    const until = Date.now() + waitSeconds * 1000;
    if (until > this.pausedUntil) this.pausedUntil = until;
    this.concurrency = 1;
    this.onWait?.(this);
  }

  // 一時停止が解除されるまで待つ(既に枠を持っている再試行用)。
  async waitForResume(sleep) {
    while (Date.now() < this.pausedUntil) {
      await sleep(Math.min(1000, this.pausedUntil - Date.now()));
      this.onWait?.(this);
    }
  }

  remainingPause() {
    return Math.max(0, Math.ceil((this.pausedUntil - Date.now()) / 1000));
  }

  describe() {
    return `同時${this.concurrency}接続・間隔${this.interval}ms・1分${this.perMinute}回まで`;
  }
}
