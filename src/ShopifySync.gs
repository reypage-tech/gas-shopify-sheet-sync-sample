/**
 * Shopify Admin API 取得（ページ送り）とシート書き込み。
 * 認証: スクリプトプロパティ SHOPIFY_SHOP_DOMAIN, SHOPIFY_ACCESS_TOKEN
 */

var SHOPIFY_PROP_SHOP = 'SHOPIFY_SHOP_DOMAIN';
var SHOPIFY_PROP_TOKEN = 'SHOPIFY_ACCESS_TOKEN';
var SHOPIFY_PROP_SHEET = 'SHEET_ID';
var SHOPIFY_API_VERSION = '2024-10';

/** @type {null | function(string, Object=): {getResponseCode:function():number,getContentText:function():string,getHeaders:function():Object}} */
var shopifyFetchImpl_ = null;

function setShopifyFetchImpl_(fn) {
  shopifyFetchImpl_ = fn;
}

/**
 * Link ヘッダから rel=next の URL を取り出す。
 * @param {string} linkHeader
 * @returns {string|null}
 */
function parseShopifyNextLink_(linkHeader) {
  if (!linkHeader) return null;
  var parts = String(linkHeader).split(',');
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i].trim();
    var m = seg.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * 1 パス分をページ送りで集める。
 * @param {string} path 例 /orders.json?status=any&limit=250
 * @param {string} rootKey 例 orders
 * @param {{shop?:string,token?:string,apiVersion?:string}} cfg
 */
function fetchShopifyPaged_(path, rootKey, cfg) {
  cfg = cfg || {};
  var shop = cfg.shop || PropertiesService.getScriptProperties().getProperty(SHOPIFY_PROP_SHOP);
  var token = cfg.token || PropertiesService.getScriptProperties().getProperty(SHOPIFY_PROP_TOKEN);
  if (!shop || !token) {
    throw new Error('SHOPIFY_SHOP_DOMAIN と SHOPIFY_ACCESS_TOKEN をスクリプトプロパティに設定してください');
  }
  var version = cfg.apiVersion || SHOPIFY_API_VERSION;
  var url = 'https://' + shop + '/admin/api/' + version + path;
  var all = [];
  var maxPages = cfg.maxPages != null ? cfg.maxPages : 40;
  var pagesFetched = 0;

  while (url) {
    if (pagesFetched >= maxPages) {
      throw new Error('Shopify ページ送り上限(' + maxPages + 'ページ)に達しました: ' + path);
    }
    pagesFetched++;
    var page = fetchShopifyOnce_(url, token);
    var chunk = page.json[rootKey] || [];
    all = all.concat(chunk);
    url = parseShopifyNextLink_(page.link);
  }
  return all;
}

function fetchShopifyOnce_(url, token) {
  return shopifyWithRetry_(function () {
    var resp;
    try {
      resp = shopifyFetchImpl_
        ? shopifyFetchImpl_(url, {
          method: 'get',
          muteHttpExceptions: true,
          headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' }
        })
        : (function () {
          var r = UrlFetchApp.fetch(url, {
            method: 'get',
            muteHttpExceptions: true,
            headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' }
          });
          return {
            getResponseCode: function () { return r.getResponseCode(); },
            getContentText: function () { return r.getContentText(); },
            getHeaders: function () { return r.getAllHeaders(); }
          };
        })();
    } catch (fetchErr) {
      // DNS・タイムアウトなど、レスポンスを受け取れなかった通信例外。再試行対象として投げ直す。
      var commErr = new Error('Shopify への通信に失敗しました: ' + (fetchErr && fetchErr.message ? fetchErr.message : fetchErr));
      commErr.retryable = true;
      throw commErr;
    }
    var code = resp.getResponseCode();
    var headers = resp.getHeaders ? resp.getHeaders() : {};
    if (shopifyHttpShouldRetry_(code)) {
      var retryErr = new Error('Shopify HTTP ' + code);
      retryErr.retryable = true;
      if (code === 429) {
        var retryAfterRaw = headers['Retry-After'] || headers['retry-after'];
        var retryAfterSec = retryAfterRaw != null ? parseFloat(retryAfterRaw) : NaN;
        if (!isNaN(retryAfterSec) && retryAfterSec >= 0) retryErr.retryAfterMs = retryAfterSec * 1000;
      }
      throw retryErr;
    }
    var text = resp.getContentText();
    if (code < 200 || code >= 300) throw new Error('Shopify API error ' + code + ': ' + text.slice(0, 200));
    var json;
    try {
      json = JSON.parse(text);
    } catch (parseErr) {
      throw new Error('Shopify応答をJSONとして解析できません: ' + text.slice(0, 200));
    }
    var link = headers.Link || headers.link || '';
    return { json: json, link: link };
  });
}

var ORDERS_HEADERS = ['order_id', 'created_at', 'location_id', 'total_price', 'currency', 'line_count'];
var INVENTORY_HEADERS = ['location_id', 'inventory_item_id', 'available', 'updated_at'];

/**
 * 注文と在庫を取得しシートに書く。
 * @param {{shop?:string,token?:string,sheetId?:string,dryRun?:boolean}} options
 *   dryRun: true の場合、取得と件数カウント・ログ出力のみ行いシートへの書き込みを行わない。
 */
function syncShopifyOrdersAndInventory(options) {
  options = options || {};
  var dryRun = !!options.dryRun;
  var ss = openShopifySpreadsheet_(options.sheetId);
  var logSh = ensureHeaderSheet_(ss, 'ShopifySyncLog', ['Timestamp', 'Status', 'Message']);

  try {
    var orders = fetchShopifyPaged_('/orders.json?status=any&limit=250', 'orders', options);
    var locations = fetchShopifyPaged_('/locations.json', 'locations', options);
    var locationIds = locations.map(function (l) { return l.id; }).join(',');
    var levels = locationIds
      ? fetchShopifyPaged_('/inventory_levels.json?location_ids=' + locationIds + '&limit=250', 'inventory_levels', options)
      : [];

    var orderRows = ordersToSheetRows_(orders);
    var invRows = inventoryToSheetRows_(levels);

    if (!dryRun) {
      writeShopifyTable_(ensureHeaderSheet_(ss, 'ShopifyOrders', ORDERS_HEADERS), ORDERS_HEADERS, orderRows);
      writeShopifyTable_(ensureHeaderSheet_(ss, 'ShopifyInventory', INVENTORY_HEADERS), INVENTORY_HEADERS, invRows);
    }

    var status = dryRun ? 'DRY_RUN' : 'OK';
    logSh.appendRow([new Date(), status, 'orders=' + orderRows.length + ' inventory=' + invRows.length]);
    return { orders: orderRows.length, inventory: invRows.length, dryRun: dryRun };
  } catch (err) {
    var msg = String(err.message || err).slice(0, 500);
    logSh.appendRow([new Date(), 'ERROR', msg]);
    throw err;
  }
}

function openShopifySpreadsheet_(sheetId) {
  var id = sheetId || PropertiesService.getScriptProperties().getProperty(SHOPIFY_PROP_SHEET);
  if (!id) throw new Error('SHEET_ID をスクリプトプロパティに設定してください');
  return SpreadsheetApp.openById(id);
}

function ensureHeaderSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function writeShopifyTable_(sheet, header, rows) {
  sheet.clearContents();
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (!rows.length) return;
  sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
}

/**
 * @param {Object[]} orders
 * @returns {*[][]}
 */
function ordersToSheetRows_(orders) {
  return (orders || []).map(function (o) {
    var lineCount = (o.line_items || []).length;
    return [o.id, o.created_at, o.location_id || '', o.total_price, o.currency, lineCount];
  });
}

/**
 * @param {Object[]} levels
 * @returns {*[][]}
 */
function inventoryToSheetRows_(levels) {
  return (levels || []).map(function (l) {
    var available = (l.available === null || l.available === undefined) ? '' : l.available;
    return [l.location_id, l.inventory_item_id, available, l.updated_at || ''];
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseShopifyNextLink_: parseShopifyNextLink_,
    fetchShopifyPaged_: fetchShopifyPaged_,
    ordersToSheetRows_: ordersToSheetRows_,
    inventoryToSheetRows_: inventoryToSheetRows_,
    setShopifyFetchImpl_: setShopifyFetchImpl_,
    syncShopifyOrdersAndInventory: syncShopifyOrdersAndInventory
  };
}
