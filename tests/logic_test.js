// 実行: cd gas-shopify-sheet-sync-sample/v1 && node tests/logic_test.js
const assert = require('assert');
const fs = require('fs');

function readJson(name) {
  return JSON.parse(fs.readFileSync('sample_data/' + name, 'utf8'));
}

function loadGs(relativePath, extraParams, extraArgs, sleepFn, urlFetchApp) {
  const src = fs.readFileSync(relativePath, 'utf8');
  const mod = { exports: {} };
  const params = ['module', 'exports', 'PropertiesService', 'UrlFetchApp', 'Utilities'].concat(extraParams || []);
  const args = [
    mod,
    mod.exports,
    { getScriptProperties: function () { return { getProperty: function () { return null; } }; } },
    urlFetchApp || {},
    { sleep: sleepFn || function () {} }
  ].concat(extraArgs || []);
  new Function(...params, src)(...args);
  return mod.exports;
}

const retry = loadGs('src/Retry.gs');
const shopify = loadGs(
  'src/ShopifySync.gs',
  ['SpreadsheetApp', 'shopifyWithRetry_', 'shopifyHttpShouldRetry_'],
  [{}, retry.shopifyWithRetry_, retry.shopifyHttpShouldRetry_]
);

function jsonResponse(obj, headers) {
  return {
    getResponseCode: function () { return 200; },
    getContentText: function () { return JSON.stringify(obj); },
    getHeaders: function () { return headers || {}; }
  };
}

function makeFakeSheet(name) {
  return {
    name: name,
    data: [],
    getLastRow: function () { return this.data.length; },
    getRange: function (row, col, numRows, numCols) {
      const self = this;
      return {
        setValues: function (values) {
          for (let i = 0; i < values.length; i++) {
            self.data[row - 1 + i] = values[i];
          }
          return this;
        },
        setFontWeight: function () { return this; }
      };
    },
    setFrozenRows: function () {},
    clearContents: function () { this.data = []; },
    appendRow: function (row) { this.data.push(row); }
  };
}

function makeFakeSpreadsheet() {
  const sheets = {};
  return {
    sheets: sheets,
    getSheetByName: function (name) { return sheets[name] || null; },
    insertSheet: function (name) {
      const sh = makeFakeSheet(name);
      sheets[name] = sh;
      return sh;
    }
  };
}

function makeShopifyForSync(fakeSpreadsheetApp) {
  return loadGs(
    'src/ShopifySync.gs',
    ['SpreadsheetApp', 'shopifyWithRetry_', 'shopifyHttpShouldRetry_'],
    [fakeSpreadsheetApp, retry.shopifyWithRetry_, retry.shopifyHttpShouldRetry_]
  );
}

let pass = 0;
function t(name, fn) {
  fn();
  pass++;
  console.log('ok', name);
}

t('parseShopifyNextLink', () => {
  const link = '<https://shop.example/admin/api/2024-10/orders.json?page_info=abc>; rel="next", <https://shop.example/admin/api/2024-10/orders.json?page_info=xyz>; rel="previous"';
  assert.strictEqual(
    shopify.parseShopifyNextLink_(link),
    'https://shop.example/admin/api/2024-10/orders.json?page_info=abc'
  );
  assert.strictEqual(shopify.parseShopifyNextLink_(''), null);
});

t('ordersToSheetRows', () => {
  const rows = shopify.ordersToSheetRows_([
    { id: 1001, created_at: '2026-10-29T10:00:00-05:00', location_id: 7101001, total_price: '98.00', currency: 'USD', line_items: [{}, {}] }
  ]);
  assert.deepStrictEqual(rows[0], [1001, '2026-10-29T10:00:00-05:00', 7101001, '98.00', 'USD', 2]);
});

t('inventoryToSheetRows', () => {
  const rows = shopify.inventoryToSheetRows_([
    { location_id: 7101001, inventory_item_id: 90001, available: 3, updated_at: '2026-10-29T12:00:00Z' }
  ]);
  assert.deepStrictEqual(rows[0], [7101001, 90001, 3, '2026-10-29T12:00:00Z']);
});

t('inventoryToSheetRows available が null/undefined の場合は空文字にする', () => {
  const rows = shopify.inventoryToSheetRows_([
    { location_id: 1, inventory_item_id: 2, available: null, updated_at: 'x' },
    { location_id: 1, inventory_item_id: 3, updated_at: 'y' }
  ]);
  assert.deepStrictEqual(rows[0], [1, 2, '', 'x']);
  assert.deepStrictEqual(rows[1], [1, 3, '', 'y']);
});

t('fetchShopifyPaged maxPages', () => {
  var calls = 0;
  shopify.setShopifyFetchImpl_(function (url) {
    calls++;
    return jsonResponse(
      { orders: [{ id: calls }] },
      { Link: '<https://shop.example/admin/api/2024-10/orders.json?page_info=next>; rel="next"' }
    );
  });
  assert.throws(function () {
    shopify.fetchShopifyPaged_('/orders.json?limit=250', 'orders', {
      shop: 'demo.myshopify.com',
      token: 'shpat_test',
      maxPages: 2
    });
  }, /上限\(2ページ\)/);
  assert.strictEqual(calls, 2);
});

t('ページ送りでの注文取得(sample_data 2ページ分)', () => {
  const page1 = readJson('orders_page1.json');
  const page2 = readJson('orders_page2.json');
  const nextUrl = 'https://sample-store.myshopify.com/admin/api/2024-10/orders.json?status=any&limit=250&page_info=page2';
  shopify.setShopifyFetchImpl_(function (url) {
    if (String(url).indexOf('page_info=page2') >= 0) return jsonResponse(page2);
    return jsonResponse(page1, { Link: '<' + nextUrl + '>; rel="next"' });
  });
  const orders = shopify.fetchShopifyPaged_('/orders.json?status=any&limit=250', 'orders', {
    shop: 'sample-store.myshopify.com',
    token: 'shpat_sample'
  });
  assert.strictEqual(orders.length, 3);
  const rows = shopify.ordersToSheetRows_(orders);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[2], [5003, '2026-10-20T11:47:00-05:00', 9102, '76.25', 'USD', 3]);
});

t('Linkヘッダーが小文字キー(headers.link)でもページ送りできる', () => {
  const page1 = readJson('orders_page1.json');
  const page2 = readJson('orders_page2.json');
  const nextUrl = 'https://sample-store.myshopify.com/admin/api/2024-10/orders.json?status=any&limit=250&page_info=page2';
  shopify.setShopifyFetchImpl_(function (url) {
    if (String(url).indexOf('page_info=page2') >= 0) return jsonResponse(page2);
    return jsonResponse(page1, { link: '<' + nextUrl + '>; rel="next"' });
  });
  const orders = shopify.fetchShopifyPaged_('/orders.json?status=any&limit=250', 'orders', {
    shop: 'sample-store.myshopify.com',
    token: 'shpat_sample'
  });
  assert.strictEqual(orders.length, 3);
});

t('ロケーション一覧の取得(sample_data)', () => {
  shopify.setShopifyFetchImpl_(function () {
    return jsonResponse(readJson('locations.json'));
  });
  const locations = shopify.fetchShopifyPaged_('/locations.json', 'locations', {
    shop: 'sample-store.myshopify.com',
    token: 'shpat_sample'
  });
  assert.strictEqual(locations.length, 2);
  assert.deepStrictEqual(locations.map(function (l) { return l.id; }), [9101, 9102]);
});

t('在庫レベルの変換(sample_data)', () => {
  const levels = readJson('inventory_levels.json').inventory_levels;
  const rows = shopify.inventoryToSheetRows_(levels);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], [9101, 70001, 12, '2026-10-20T08:00:00Z']);
});

t('非JSON応答は分かるメッセージで失敗し、再試行しない(attempts=1)', () => {
  let attempts = 0;
  shopify.setShopifyFetchImpl_(function () {
    attempts++;
    return {
      getResponseCode: function () { return 200; },
      getContentText: function () { return '<html>not json</html>'; },
      getHeaders: function () { return {}; }
    };
  });
  assert.throws(function () {
    shopify.fetchShopifyPaged_('/orders.json', 'orders', { shop: 'sample-store.myshopify.com', token: 'shpat_sample' });
  }, /JSON/);
  assert.strictEqual(attempts, 1);
});

t('shopifyFetchImpl_ が例外を投げた場合(DNS・タイムアウト相当)は再試行して成功する', () => {
  let attempts = 0;
  shopify.setShopifyFetchImpl_(function () {
    attempts++;
    if (attempts < 2) throw new Error('timed out');
    return jsonResponse(readJson('locations.json'));
  });
  const locations = shopify.fetchShopifyPaged_('/locations.json', 'locations', {
    shop: 'sample-store.myshopify.com',
    token: 'shpat_sample'
  });
  assert.strictEqual(locations.length, 2);
  assert.strictEqual(attempts, 2);
});

t('shopifyFetchImpl_ を使わない場合はUrlFetchApp.fetch(getAllHeaders)経由で取得する(sample_data)', () => {
  const locationsData = readJson('locations.json');
  const fakeUrlFetchApp = {
    fetch: function () {
      return {
        getResponseCode: function () { return 200; },
        getContentText: function () { return JSON.stringify(locationsData); },
        getAllHeaders: function () { return {}; }
      };
    }
  };
  const shopifyDefaultFetch = loadGs(
    'src/ShopifySync.gs',
    ['SpreadsheetApp', 'shopifyWithRetry_', 'shopifyHttpShouldRetry_'],
    [{}, retry.shopifyWithRetry_, retry.shopifyHttpShouldRetry_],
    undefined,
    fakeUrlFetchApp
  );
  const locations = shopifyDefaultFetch.fetchShopifyPaged_('/locations.json', 'locations', {
    shop: 'sample-store.myshopify.com',
    token: 'shpat_sample'
  });
  assert.strictEqual(locations.length, 2);
});

t('shopifyWithRetry_ はretryable:trueのエラーのあと成功する(429相当)', () => {
  let attempts = 0;
  const result = retry.shopifyWithRetry_(function (attempt) {
    attempts++;
    if (attempt < 3) {
      const err = new Error('Shopify HTTP 429');
      err.retryable = true;
      throw err;
    }
    return 'ok';
  }, { maxAttempts: 4, baseMs: 1 });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(attempts, 3);
});

t('shopifyWithRetry_ はretryable:trueのエラーのあと成功する(503相当)', () => {
  let attempts = 0;
  const result = retry.shopifyWithRetry_(function (attempt) {
    attempts++;
    if (attempt < 2) {
      const err = new Error('Shopify HTTP 503');
      err.retryable = true;
      throw err;
    }
    return 'ok';
  }, { maxAttempts: 4, baseMs: 1 });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(attempts, 2);
});

t('shopifyWithRetry_ はretryableでないエラーでは再試行せず即失敗する(400系相当)', () => {
  let attempts = 0;
  assert.throws(function () {
    retry.shopifyWithRetry_(function () {
      attempts++;
      throw new Error('Shopify API error 400: bad request');
    }, { maxAttempts: 4, baseMs: 1 });
  }, /400/);
  assert.strictEqual(attempts, 1);
});

t('shopifyWithRetry_ はエラーメッセージに429や5xxという文字列が含まれていても、retryableでなければ再試行しない', () => {
  let attempts = 0;
  assert.throws(function () {
    retry.shopifyWithRetry_(function () {
      attempts++;
      throw new Error('Shopify API error 400: body contains 429 and 500 by coincidence');
    }, { maxAttempts: 4, baseMs: 1 });
  }, /400/);
  assert.strictEqual(attempts, 1);
});

t('shopifyWithRetry_ は最大試行回数を超えると失敗する', () => {
  let attempts = 0;
  assert.throws(function () {
    retry.shopifyWithRetry_(function () {
      attempts++;
      const err = new Error('Shopify HTTP 429');
      err.retryable = true;
      throw err;
    }, { maxAttempts: 3, baseMs: 1 });
  }, /429/);
  assert.strictEqual(attempts, 3);
});

t('shopifyWithRetry_ はretryAfterMsがあれば指数バックオフより優先する', () => {
  const sleepCalls = [];
  const retrySpy = loadGs('src/Retry.gs', [], [], function (ms) { sleepCalls.push(ms); });
  let attempts = 0;
  const result = retrySpy.shopifyWithRetry_(function (attempt) {
    attempts++;
    if (attempt === 1) {
      const err = new Error('Shopify HTTP 429');
      err.retryable = true;
      err.retryAfterMs = 1200;
      throw err;
    }
    return 'ok';
  }, { maxAttempts: 3, baseMs: 10 });
  assert.strictEqual(result, 'ok');
  assert.deepStrictEqual(sleepCalls, [1200]);
});

t('429のRetry-Afterヘッダーを読んでsleep時間に使う(sample_data)', () => {
  const sleepCalls = [];
  const retryForShopify = loadGs('src/Retry.gs', [], [], function (ms) { sleepCalls.push(ms); });
  const shopifyWithRetrySpy = loadGs(
    'src/ShopifySync.gs',
    ['SpreadsheetApp', 'shopifyWithRetry_', 'shopifyHttpShouldRetry_'],
    [{}, retryForShopify.shopifyWithRetry_, retryForShopify.shopifyHttpShouldRetry_]
  );
  let call = 0;
  shopifyWithRetrySpy.setShopifyFetchImpl_(function () {
    call++;
    if (call === 1) {
      return {
        getResponseCode: function () { return 429; },
        getContentText: function () { return ''; },
        getHeaders: function () { return { 'Retry-After': '2' }; }
      };
    }
    return jsonResponse(readJson('locations.json'));
  });
  const locations = shopifyWithRetrySpy.fetchShopifyPaged_('/locations.json', 'locations', {
    shop: 'sample-store.myshopify.com',
    token: 'shpat_sample'
  });
  assert.strictEqual(locations.length, 2);
  assert.deepStrictEqual(sleepCalls, [2000]);
});

function syncShopifyFetchImplFromSamples() {
  const page1 = readJson('orders_page1.json');
  const page2 = readJson('orders_page2.json');
  const locationsData = readJson('locations.json');
  const levelsData = readJson('inventory_levels.json');
  const nextUrl = 'https://sample-store.myshopify.com/admin/api/2024-10/orders.json?status=any&limit=250&page_info=page2';
  return function (url) {
    const u = String(url);
    if (u.indexOf('orders.json') >= 0) {
      if (u.indexOf('page_info=page2') >= 0) return jsonResponse(page2);
      return jsonResponse(page1, { Link: '<' + nextUrl + '>; rel="next"' });
    }
    if (u.indexOf('locations.json') >= 0) return jsonResponse(locationsData);
    return jsonResponse(levelsData);
  };
}

t('syncShopifyOrdersAndInventory 正常系でOKログと件数を記録する', () => {
  const fakeSs = makeFakeSpreadsheet();
  const shopifyForSync = makeShopifyForSync({ openById: function () { return fakeSs; } });
  shopifyForSync.setShopifyFetchImpl_(syncShopifyFetchImplFromSamples());

  const result = shopifyForSync.syncShopifyOrdersAndInventory({
    shop: 'sample-store.myshopify.com',
    token: 'shpat_sample',
    sheetId: 'fake-sheet-id'
  });

  assert.deepStrictEqual(result, { orders: 3, inventory: 3, dryRun: false });
  const logRows = fakeSs.getSheetByName('ShopifySyncLog').data;
  const last = logRows[logRows.length - 1];
  assert.strictEqual(last[1], 'OK');
  assert.strictEqual(last[2], 'orders=3 inventory=3');
  assert.strictEqual(fakeSs.getSheetByName('ShopifyOrders').data.length, 4);
});

t('syncShopifyOrdersAndInventory dryRun:true はシートを書き換えずDRY_RUNを記録する', () => {
  const fakeSs = makeFakeSpreadsheet();
  const shopifyForSync = makeShopifyForSync({ openById: function () { return fakeSs; } });
  shopifyForSync.setShopifyFetchImpl_(syncShopifyFetchImplFromSamples());

  const existingSheet = fakeSs.insertSheet('ShopifyOrders');
  existingSheet.getRange(1, 1, 1, 1).setValues([['keep-me']]);

  const result = shopifyForSync.syncShopifyOrdersAndInventory({
    shop: 'sample-store.myshopify.com',
    token: 'shpat_sample',
    sheetId: 'fake-sheet-id',
    dryRun: true
  });

  assert.strictEqual(result.dryRun, true);
  assert.deepStrictEqual(existingSheet.data[0], ['keep-me']);
  const logRows = fakeSs.getSheetByName('ShopifySyncLog').data;
  assert.strictEqual(logRows[logRows.length - 1][1], 'DRY_RUN');
});

t('syncShopifyOrdersAndInventory dryRun:true はShopifyOrders/Inventoryシートを新規作成しない', () => {
  const fakeSs = makeFakeSpreadsheet();
  const shopifyForSync = makeShopifyForSync({ openById: function () { return fakeSs; } });
  shopifyForSync.setShopifyFetchImpl_(syncShopifyFetchImplFromSamples());

  const result = shopifyForSync.syncShopifyOrdersAndInventory({
    shop: 'sample-store.myshopify.com',
    token: 'shpat_sample',
    sheetId: 'fake-sheet-id',
    dryRun: true
  });

  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(fakeSs.getSheetByName('ShopifyOrders'), null);
  assert.strictEqual(fakeSs.getSheetByName('ShopifyInventory'), null);
  assert.notStrictEqual(fakeSs.getSheetByName('ShopifySyncLog'), null);
});

t('syncShopifyOrdersAndInventory 取得件数が0件でもヘッダーのみ書き込む', () => {
  const fakeSs = makeFakeSpreadsheet();
  const shopifyForSync = makeShopifyForSync({ openById: function () { return fakeSs; } });
  shopifyForSync.setShopifyFetchImpl_(function () {
    return jsonResponse({ orders: [], locations: [], inventory_levels: [] });
  });

  const result = shopifyForSync.syncShopifyOrdersAndInventory({
    shop: 'sample-store.myshopify.com',
    token: 'shpat_sample',
    sheetId: 'fake-sheet-id'
  });

  assert.deepStrictEqual(result, { orders: 0, inventory: 0, dryRun: false });
  assert.strictEqual(fakeSs.getSheetByName('ShopifyOrders').data.length, 1);
  assert.strictEqual(fakeSs.getSheetByName('ShopifyInventory').data.length, 1);
});

t('syncShopifyOrdersAndInventory 失敗時はERRORログを残して例外を投げ直す', () => {
  const fakeSs = makeFakeSpreadsheet();
  const shopifyForSync = makeShopifyForSync({ openById: function () { return fakeSs; } });

  assert.throws(function () {
    shopifyForSync.syncShopifyOrdersAndInventory({ sheetId: 'fake-sheet-id' });
  }, /SHOPIFY_SHOP_DOMAIN/);

  const logRows = fakeSs.getSheetByName('ShopifySyncLog').data;
  assert.strictEqual(logRows[logRows.length - 1][1], 'ERROR');
});

console.log('\n' + pass + ' tests passed');
