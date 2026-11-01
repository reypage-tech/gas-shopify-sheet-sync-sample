/**
 * UrlFetch 等の再試行ヘルパー（shopify 部品用。他部品と関数名を共有しない）。
 * fn が投げた Error の retryable プロパティが true の場合のみ再試行する
 * (エラーメッセージの文字列照合ではなく、呼び出し側が明示的に付けた印で判定する)。
 * retryAfterMs（数値）が入っていれば、指数バックオフの代わりにその時間だけ待つ
 * （429 応答の Retry-After ヘッダーを優先する想定）。
 */
function shopifyWithRetry_(fn, opts) {
  opts = opts || {};
  var max = opts.maxAttempts || 4;
  var base = opts.baseMs || 500;
  var lastErr;
  for (var attempt = 1; attempt <= max; attempt++) {
    try {
      return fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= max || !(err && err.retryable === true)) throw err;
      var hasRetryAfter = typeof err.retryAfterMs === 'number' && err.retryAfterMs >= 0;
      var waitMs = hasRetryAfter ? err.retryAfterMs : base * Math.pow(2, attempt - 1);
      Utilities.sleep(waitMs);
    }
  }
  throw lastErr;
}

function shopifyHttpShouldRetry_(code) {
  return code === 429 || (code >= 500 && code <= 599);
}

if (typeof module !== 'undefined') {
  module.exports = { shopifyWithRetry_: shopifyWithRetry_, shopifyHttpShouldRetry_: shopifyHttpShouldRetry_ };
}
