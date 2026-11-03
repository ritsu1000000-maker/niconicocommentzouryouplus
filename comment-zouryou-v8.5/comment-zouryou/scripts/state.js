// ? content script ?????????????
let CommentRenderer,
  zouryouCanvasElement,
  SuperDanmakuCanvasElement,
  videoElement,
  pipVideoElement,
  VideoSymbolContainer,
  CommentLoadingScreen,
  CustomVideoContainer,
  DefaultVideoContainer,
  PlayerContainer,
  CommentLoadingScreenWrapper,
  loading,
  loading_text,
  link,
  OLD_DATE,
  OLD_TIME,
  DRAW_,
  net,
  firstaccess,
  aspect,
  apiData;
let COMMENT = [];
// 引用元は保存せず、現在の視聴ページだけで保持する。
let videoCitations = [];
let localCommentFiles = [];
let CommentLimit = 40;

let niconiComments, comment_list_active;
let download_comment;
let blob;
// 検索・統計用に、NG適用前の全コメントを保持する。
let RAW_COMMENTS = { comments: [], ownerComments: [], sourceOf: new WeakMap() };
// 検索結果だけを描画しているかどうか。
let searchDrawActive = false;
// 検索パネル側で設定される連携用フック。
let onCommentsLoaded;
let updateSearchDrawButton;
// 設定画面からNGを追加する関数(settings.jsで設定)。
let addNgEntry;
