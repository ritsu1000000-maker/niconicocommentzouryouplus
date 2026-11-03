// ????????????NG ???????????????
const logger = (msg, load) => {
  const p = document.createElement("p");
  p.innerText = msg;
  if (load != false) {
    loading_text.innerText = msg;
  }

  console.log(msg);
  CommentLoadingScreen.appendChild(p);
  CommentLoadingScreenWrapper.scrollBy(0, CommentLoadingScreen.clientHeight);
};

const sleep = (time) => {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, time);
  });
};

let NG_LIST_COMMAND = [];
let NG_LIST_COMMENT = [];
const COMMENT_CONTROL = (comments) => {
  return new Promise((resolve) => {
    let ng_score = document.getElementById("ng_score").value;
    let nicoru_limit = document.getElementById("nicoru_num");
    let premium_filter = document.getElementById("premium_filter");

    console.log(ng_score);
    for (const i in comments) {
      const comment = comments[i];
      if (comment.commands === undefined) {
        comment.commands = [];
      } else {
        comment.commands = comment.commands.map((value) => value.toLowerCase());
      }
    }
    NG_LIST_COMMAND.forEach((NG) => {
      // 不正なNG項目が残っていてもコメントの読み込みを続ける。
      if (typeof NG !== "string" || NG.trim() === "") return;
      let commands = NG.toLowerCase().split(" ");
      comments = comments.filter((comment) => {
        let ng_point = commands.length;
        commands.forEach((command) => {
          if (comment.commands.includes(command)) {
            ng_point -= 1;
          }
        });
        return ng_point > 0;
      });
    });
    NG_LIST_COMMENT.filter(
      (NG) => typeof NG === "string" && NG.trim() !== ""
    ).forEach(
      (NG) =>
        (comments = comments.filter(
          (comment) => comment.body.includes(NG) === false
        ))
    );
    comments = comments.filter((comment) => comment.score >= ng_score);
    comments = comments.filter(
      (comment) => comment.nicoruCount >= nicoru_limit.value
    );
    if (premium_filter.checked) {
      comments = comments.filter((comment) => comment.isPremium === true);
    }

    logger(comments.length + "件に減りました");
    resolve(comments);
  });
};


// 軽量描画: 再生位置1秒ごとのコメント数に上限を設け、超えた分を間引いて描画する。
// ニコる数が多いコメントを優先し、同点はコメ番から作った擬似乱数で全体から均等に残す。
// 元のコメント(一覧・検索・書き出し)は変更せず、描画に渡す分だけを減らす。
function lightenComments(list) {
  const enabled = document.getElementById("islight")?.checked;
  const limit = Math.floor(Number(document.getElementById("light_num")?.value) || 40);
  if (!enabled || !(limit > 0) || list.length === 0) return list;
  const keepCA = document.getElementById("checkbox4")?.checked;
  const hash = (no) => {
    let x = (Number(no) || 0) * 2654435761;
    x ^= x >>> 15;
    return (x >>> 0) / 4294967296;
  };
  const buckets = new Map();
  const kept = [];
  for (const comment of list) {
    // コメントアート保護がONなら、複数行のコメントは間引かない。
    if (keepCA && typeof comment.body === "string" && comment.body.includes("\n")) {
      kept.push(comment);
      continue;
    }
    const key = Math.floor((comment.vposMs || 0) / 1000);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(comment);
  }
  for (const bucket of buckets.values()) {
    if (bucket.length <= limit) {
      kept.push(...bucket);
      continue;
    }
    bucket.sort(
      (a, b) => (b.nicoruCount || 0) - (a.nicoruCount || 0) || hash(a.no) - hash(b.no),
    );
    kept.push(...bucket.slice(0, limit));
  }
  kept.sort((a, b) => a.vposMs - b.vposMs);
  return kept;
}

// コメントアート(CA)らしいコメントかを判定する。
// ・複数行のコメント
// ・CA用のコマンド(ender / full / patissier / ca)が付いている
// ・罫線・ブロック・点字などCAでよく使う記号が多い
// ・上下固定(ue/shita)+大きさ指定(small/big)で、記号や全角スペースを含む長めのコメント
const CA_COMMANDS = new Set(["ender", "full", "patissier", "ca"]);
const CA_CHARS =
  /[\u2500-\u259f\u25a0-\u25ff\u2800-\u28ff\u2580-\u259f\u3000\u30fb\uff3f\u2015\u2010-\u2027\u2190-\u21ff\u2660-\u267f\u2701-\u27bf]/g;
function isCommentArt(comment) {
  const body = typeof comment?.body === "string" ? comment.body : "";
  if (!body) return false;
  if (body.includes("\n")) return true;
  const commands = (comment.commands || []).map((c) => String(c).toLowerCase());
  if (commands.some((c) => CA_COMMANDS.has(c))) return true;
  const symbols = (body.match(CA_CHARS) || []).length;
  if (symbols >= 5 && symbols / body.length >= 0.3) return true;
  const fixed = commands.includes("ue") || commands.includes("shita");
  const sized = commands.includes("small") || commands.includes("big");
  return fixed && sized && body.length >= 8 && symbols >= 2;
}

function lightenThreads(threads) {
  const caOnly = document.getElementById("isca_only")?.checked;
  return threads.map((thread) => {
    // CAだけ残すときは間引かない(CAが崩れるため)。投稿者コメントもCAだけにする。
    if (caOnly) return { ...thread, comments: thread.comments.filter(isCommentArt) };
    return thread.fork === "owner" ? thread : { ...thread, comments: lightenComments(thread.comments) };
  });
}
