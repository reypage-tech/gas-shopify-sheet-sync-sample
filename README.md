# Shopify 注文・在庫のスプレッドシート取り込み（Google Apps Script 見本）

> 見本データのみを用いています。実店舗のアクセストークンやデータは含めていません。

## 概要
Shopify の Admin REST API から注文と在庫レベルを取得し、スプレッドシートの複数シートに書き込む Google Apps Script の見本です。レスポンスの Link ヘッダーにある `rel="next"` の URL をたどってページ送りで全件を集め、注文一覧・在庫一覧・実行ログの3枚のシートに整理します。取得ページ数がパスごとの上限を超えた場合は例外を投げて処理を止めます。

## ファイル構成
- `src/ShopifySync.gs`: 取得・変換・書き込みの本体
- `src/Retry.gs`: HTTP 429・5xx 応答時に待ち直す再試行ヘルパー（関数名の先頭に `shopify` を付けているため、他のスクリプトの部品と同居させても名前が衝突しにくくなっています）
- `src/appsscript.json`: マニフェスト（タイムゾーン・権限スコープ）
- `sample_data/orders_page1.json`, `sample_data/orders_page2.json`: 注文の見本レスポンス（ページ送り2回分、計3件）
- `sample_data/locations.json`: ロケーションの見本レスポンス（2件）
- `sample_data/inventory_levels.json`: 在庫レベルの見本レスポンス（3件）
- `tests/logic_test.js`: Node 上でのロジック確認
- `LICENSE`: MIT

## 設定
1. Shopify 側でカスタムアプリを作り、Admin API のアクセストークンを発行します（トークンはこの見本に含めていません）。必要な API スコープは `read_orders`・`read_locations`・`read_inventory` です。
2. 書き込み先のスプレッドシートを用意します。
3. 拡張機能 > Apps Script に `src/ShopifySync.gs` と `src/Retry.gs` を貼り、マニフェストを `src/appsscript.json` に合わせます（clasp 利用可）。
4. スクリプトプロパティに次を設定します。

| キー | 内容 |
|------|------|
| `SHOPIFY_SHOP_DOMAIN` | 例 `sample-store.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | Admin API のアクセストークン |
| `SHEET_ID` | 書き込み先スプレッドシートの ID |

5. 書き込み先のシート（`ShopifyOrders`・`ShopifyInventory`・`ShopifySyncLog`）は実行時に無ければ自動で作成します。手で用意する必要はありません。

## GASエディタでの実行・トリガー設定
- 初回実行: GASエディタの関数選択欄で `syncShopifyOrdersAndInventory` を選び、実行ボタンを押します。初回はGoogleの承認画面が出るので、スコープを確認して許可します。実行結果は「実行ログ」またはスプレッドシートの `ShopifySyncLog` シートで確認できます。
- 定期実行（トリガー）: GASエディタ左側の時計アイコン「トリガー」を開き、「トリガーを追加」、実行する関数に `syncShopifyOrdersAndInventory` を選択、イベントのソースを「時間主導型」にし、実行間隔（例: 1時間おき、6時間おきなど）を選びます。この手順自体は本見本では実行していません（未確認です）。

## 出力シートの列
`syncShopifyOrdersAndInventory()` を実行すると、次の3シートに書き込みます（1行目は見出し）。

**ShopifyOrders**（注文一覧）
| 列 | 内容 |
|----|------|
| order_id | 注文ID |
| created_at | 注文日時 |
| location_id | 出荷元ロケーションID |
| total_price | 注文合計金額 |
| currency | 通貨コード |
| line_count | 注文に含まれる商品行数 |

**ShopifyInventory**（在庫一覧）
| 列 | 内容 |
|----|------|
| location_id | ロケーションID |
| inventory_item_id | 在庫項目ID |
| available | 在庫数（`null`/未設定の場合は空文字） |
| updated_at | 在庫数の更新日時 |

**ShopifySyncLog**（実行ログ）
| 列 | 内容 |
|----|------|
| Timestamp | 実行日時 |
| Status | `OK`・`DRY_RUN`・`ERROR` のいずれか |
| Message | 取得件数、またはエラー内容 |

## 使い方
```javascript
syncShopifyOrdersAndInventory();

// スクリプトプロパティを引数で上書きする場合（テスト時など）
syncShopifyOrdersAndInventory({
  shop: 'sample-store.myshopify.com',
  token: 'shpat_xxxxxxxx',
  sheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
  maxPages: 20
});

// 書き込み前に件数だけ確かめる場合（シートの内容は変えない）
syncShopifyOrdersAndInventory({ dryRun: true });
```

`maxPages` は注文・ロケーション・在庫、それぞれの API パスごとのページ送り上限です（既定40）。`dryRun: true` を渡すと API からの取得と件数カウント・ログ出力のみ行い、`ShopifyOrders`・`ShopifyInventory` シートへの書き込み（`clearContents` を含む）は行いません。取得や書き込みの途中で失敗した場合は `ShopifySyncLog` シートに `ERROR` 行を追記し、例外を投げ直します。成功時は `OK` 行（`dryRun` 時は `DRY_RUN` 行）と取得件数を記録します。

## テスト
Node 環境で以下を実行します（Google アカウントは不要です）。Node.js v24系で実行確認しています（他のバージョンでの確認はしていません）。

```bash
cd gas-shopify-sheet-sync-sample/v1
node tests/logic_test.js
```

`sample_data/` の架空データ（注文2ページ・計3件、ロケーション2件、在庫3件）を使い、次を確認しています。
- Link ヘッダー（大文字キー `Link`・小文字キー `link` の両方）から `rel="next"` を取り出す処理と、ページ送りでの全件取得・ページ上限到達時の例外
- 注文・在庫のシート行への変換（`available` が `null`/`undefined` の場合に空文字へ置き換える分岐を含む。取得件数が0件の場合に見出し行のみ書き込む分岐を含む）
- `src/Retry.gs` の再試行ヘルパー（`err.retryable === true` の場合のみ再試行する判定、429・5xx での再試行と成功、400系での即失敗、エラーメッセージに429や5xxという文字列が偶然含まれていても `retryable` が無ければ再試行しないこと、最大試行回数超過での失敗、429応答の `Retry-After` ヘッダーを待機時間に使う分岐）
- 非 JSON 応答を受け取った場合に分かるメッセージで失敗し、再試行しないこと（試行回数1回で終わることを確認）
- `shopifyFetchImpl_` が例外を投げた場合（DNS・タイムアウトなど通信そのものの失敗を想定）に再試行して成功する分岐
- `shopifyFetchImpl_` を指定しない場合に使われる、既定の `UrlFetchApp.fetch`（`getAllHeaders()`）経由の取得
- メイン関数 `syncShopifyOrdersAndInventory` を、`SpreadsheetApp` を模したオブジェクト（シート役のオブジェクトを自作したもの）に対して実行した場合の正常系（`OK` ログと件数）・`dryRun: true`（シートを書き換えず、`ShopifyOrders`・`ShopifyInventory` シートも新規作成せずに `DRY_RUN` ログ）・認証情報未設定時の異常系（`ERROR` ログと例外の再送出）

実行すると24件のテストが通過（`ok` 行24件 + `24 tests passed`）します。テストしていないもの: 再試行時の実際の待機時間（`Utilities.sleep` は呼び出し回数と引数のみ確認し、実際に待ってはいません）、実際の `UrlFetchApp`・`SpreadsheetApp`（Google側の実装そのもの）の呼び出し、実際の Shopify アカウントとスプレッドシートでの動作。

単体テストが通過した後、実環境ではまず認証情報とスクリプトプロパティを設定したうえで `syncShopifyOrdersAndInventory({ dryRun: true })` を実行し、通信とスクリプトプロパティの権限だけを確認してから、`dryRun` を外した本来の実行に進む、という流れを想定しています。この実環境での確認手順自体は本見本では実行していません（未確認です）。

## 扱える行数の目安（未検証）
未検証です。見本データは注文3件・在庫3件・ロケーション2件のみで確かめています。実店舗の注文・在庫件数や API のレート制限次第では、ページ送り上限（`maxPages`）や GAS の実行時間上限に先に達する可能性があります。

既定値（`limit=250` × `maxPages=40`）だけで見ると、1回の `syncShopifyOrdersAndInventory()` 実行で1パスあたり理論上は最大10,000件まで取得を試みる設定です。ただし GAS は1回の実行につき実行時間に上限（Googleの公開ドキュメントではおよそ6分）があり、件数が多い場合はページ送り上限より先にこちらに達することがあります。月1,000件・在庫5,000点といった規模で実際に収まるかどうかは確認していません。

件数が多くなる場合は、取得対象を絞る（例えば注文取得のクエリに `created_at_min` を加えて期間を限定する）、または前回実行時刻以降の差分だけを取得する仕組みに拡張する、といった対策が考えられます。いずれも本見本には実装していません。

## 制約
- Shopify 側のアクセストークンはこの見本に含めていません。別途スクリプトプロパティに設定してください。
- レート制限（429）やサーバエラー（5xx）には `src/Retry.gs` が指数的な待ち直しで応じます。429 応答に `Retry-After` ヘッダーがあればその秒数を優先して待ち直し、無ければ指数バックオフにします。上限回数を超えると例外を投げます。
- 書き込み先のシートは（`dryRun: true` を渡さない限り）実行のたびに内容を全部書き直します。シート上のフィルタや列幅などの表示設定は残りません。`dryRun: true` の場合はシートへの書き込みを行わず、取得と件数カウント・ログ出力のみ行います。
- シートに書き込む項目は、注文が ID・日時・ロケーション ID・合計金額・通貨・商品行数、在庫がロケーション ID・在庫項目 ID・在庫数・更新日時のみです。顧客情報や配送先など、それ以外の項目は見ていません。在庫の `available` が `null`/`undefined` で返ってきた場合は空文字として記録します（`0` として記録しません）。
- 再試行の対象かどうかは、エラーメッセージの文字列照合ではなく `err.retryable === true` という明示的な印で判定します。通信そのものが失敗した場合（DNS・タイムアウトなど）と、HTTP 応答が 429・5xx の場合はこの印を付けて再試行対象とします。一方、Shopify の応答が 200 番台で返ってきても内容を JSON として解析できない場合は、再試行せずその場で失敗します（想定外の応答をその場で気づけるようにするためで、再試行しても同じ応答が返る可能性が高いという判断です）。
- `tests/logic_test.js` はロジックの確認のみで、`SpreadsheetApp`・`UrlFetchApp` は模したオブジェクトに置き換えています。実際のスプレッドシートへの書き込みや Shopify API への通信そのものは検証していません。
