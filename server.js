const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');

const app = express();
app.use(express.json());

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const PORT = process.env.PORT || 3000;

function cleanKey(val) {
  if (!val) return '';
  return val.replace(/[\u0000-\u001F\u200B-\u200D\uFEFF\u00A0\r\n]/g, '').trim();
}

var VENDOR_ID  = cleanKey(process.env.COUPANG_VENDOR_ID);
var ACCESS_KEY = cleanKey(process.env.COUPANG_ACCESS_KEY);
var SECRET_KEY = cleanKey(process.env.COUPANG_SECRET_KEY);

function generateHmac(method, path, query) {
  var datetime = new Date().toISOString().substr(2, 17).replace(/:/gi, '').replace(/-/gi, '') + 'Z';
  var message = datetime + method + path + query;
  var signature = crypto.createHmac('sha256', SECRET_KEY).update(message).digest('hex');
  return 'CEA algorithm=HmacSHA256, access-key=' + ACCESS_KEY + ', signed-date=' + datetime + ', signature=' + signature;
}

function callCoupangAPI(method, path, query) {
  if (!query) query = '';
  return new Promise(function(resolve, reject) {
    var authorization = generateHmac(method, path, query);
    var fullUrl = query ? path + '?' + query : path;

    // 매 요청마다 새 에이전트 사용 (연결 풀링 비활성화)
    var agent = new https.Agent({ keepAlive: false });
    var options = {
      hostname: 'api-gateway.coupang.com',
      port: 443,
      path: fullUrl,
      method: method,
      agent: agent,
      timeout: 30000,
      headers: {
        'Authorization': authorization,
        'Content-Type': 'application/json;charset=UTF-8',
        'X-EXTENDED-TIMEOUT': '90000',
        'Accept-Encoding': 'gzip'
      }
    };

    var req = https.request(options, function(res) {
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        var buffer = Buffer.concat(chunks);
        var encoding = res.headers['content-encoding'];

        function parseResult(buf) {
          try { resolve(JSON.parse(buf.toString('utf-8'))); }
          catch (e) { resolve({ raw: buf.toString('utf-8').substring(0, 200) }); }
        }

        if (encoding === 'gzip') {
          zlib.gunzip(buffer, function(err, decoded) {
            if (err) { parseResult(buffer); }
            else { parseResult(decoded); }
          });
        } else {
          parseResult(buffer);
        }
        agent.destroy();
      });
    });
    req.on('timeout', function() { req.destroy(); agent.destroy(); reject(new Error('timeout')); });
    req.on('error', function(e) { agent.destroy(); reject(e); });
    req.end();
  });
}

// ===== 전체 상품 목록 (페이지네이션) =====
async function fetchAllProducts() {
  var allProducts = [];
  var path = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';
  var nextToken = '';
  var maxPages = 50;
  var page = 0;

  while (page < maxPages) {
    var query = 'vendorId=' + VENDOR_ID + '&status=APPROVED';
    if (nextToken) {
      query = query + '&nextToken=' + nextToken;
    }

    var result = await callCoupangAPI('GET', path, query);

    if (result.code === 'SUCCESS' && result.data) {
      allProducts = allProducts.concat(result.data);

      if (result.nextToken) {
        nextToken = result.nextToken;
        page++;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return allProducts;
}

// ===== items에서 vendorItemId가 있는지 확인 =====
function hasVendorItemIds(items) {
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.vendorItemId) return true;
    if (it.rocketGrowthItemData && it.rocketGrowthItemData.vendorItemId) return true;
    if (it.marketplaceItemData && it.marketplaceItemData.vendorItemId) return true;
  }
  return false;
}

// ===== 상품 상세 (옵션/아이템 포함, 최대 3회 재시도) =====
async function fetchProductItems(productId) {
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await delay(2000);
      var path = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/' + productId;
      var result = await callCoupangAPI('GET', path, '');
      if (result.code === 'SUCCESS' && result.data) {
        var items = result.data.items || [];
        if (items.length === 0) {
          console.log('[WARN] product ' + productId + ' returned 0 items (attempt ' + (attempt+1) + ')');
          continue;
        }
        // items는 있지만 vendorItemId가 없으면 재시도
        if (!hasVendorItemIds(items)) {
          console.log('[WARN] product ' + productId + ' has ' + items.length + ' items but no vendorItemIds (attempt ' + (attempt+1) + ')');
          continue;
        }
        return items;
      } else {
        console.log('[WARN] product ' + productId + ' code=' + result.code + ' (attempt ' + (attempt+1) + ')');
      }
    } catch (e) {
      console.log('[ERR] product ' + productId + ' error: ' + e.message + ' (attempt ' + (attempt+1) + ')');
    }
  }
  console.log('[FAIL] product ' + productId + ' — all 3 attempts failed');
  return [];
}

// ===== 쿠팡 데이터 → 프론트엔드 형식 변환 =====
// vendorItemId는 item 최상위가 아닌 rocketGrowthItemData / marketplaceItemData 안에 있음
// Growth와 Marketplace 각각의 vendorItemId를 모두 옵션으로 등록
function transformProduct(product, items) {
  var optionIds = [];
  (items || []).forEach(function(item, idx) {
    var rgData = item.rocketGrowthItemData;
    var mpData = item.marketplaceItemData;
    if (!rgData && !mpData && !item.vendorItemId) {
      console.log('[WARN] product ' + product.sellerProductId + ' item "' + (item.itemName||'') + '" has no vendorItemId data');
    }
    var name = item.itemName || '';
    var addedIds = {};

    // Rocket Growth vendorItemId
    if (rgData && rgData.vendorItemId) {
      var rgId = String(rgData.vendorItemId);
      if (!addedIds[rgId]) {
        optionIds.push({
          optionId: rgId,
          optionName: name,
          importCost: 0, couponDiscount: 0, commission: 0, shipping: 0,
          channel: 'growth'
        });
        addedIds[rgId] = true;
      }
    }

    // Marketplace(Wing) vendorItemId
    if (mpData && mpData.vendorItemId) {
      var mpId = String(mpData.vendorItemId);
      if (!addedIds[mpId]) {
        optionIds.push({
          optionId: mpId,
          optionName: name,
          importCost: 0, couponDiscount: 0, commission: 0, shipping: 0,
          channel: 'wing'
        });
        addedIds[mpId] = true;
      }
    }

    // fallback: 직접 vendorItemId가 있는 경우
    if (item.vendorItemId && !addedIds[String(item.vendorItemId)]) {
      optionIds.push({
        optionId: String(item.vendorItemId),
        optionName: name,
        importCost: 0, couponDiscount: 0, commission: 0, shipping: 0
      });
    }
  });

  return {
    id: String(product.sellerProductId),
    name: product.sellerProductName || '',
    exposedId: String(product.sellerProductId),
    category: '',
    optionIds: optionIds
  };
}

// ===== 상태 확인 =====
app.get('/', function(req, res) {
  res.json({
    status: 'ok',
    message: 'Coupang Ledger Backend Running',
    vendorId: VENDOR_ID ? VENDOR_ID.slice(0, 4) + '****' : 'NOT SET',
    apiReady: !!(VENDOR_ID && ACCESS_KEY && SECRET_KEY)
  });
});

// ===== API 연결 테스트 =====
app.get('/api/test', async function(req, res) {
  if (!VENDOR_ID || !ACCESS_KEY || !SECRET_KEY) {
    return res.status(400).json({ success: false, error: 'ENV not set' });
  }
  try {
    var path = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';
    var query = 'vendorId=' + VENDOR_ID + '&status=APPROVED&limit=1';
    var result = await callCoupangAPI('GET', path, query);
    res.json({ success: true, message: 'API connected', sample: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== 상품 동기화 (프론트엔드 형식으로 변환, 2-pass 전략) =====
app.get('/api/products', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ success: false, error: 'VENDOR_ID not set' });
  try {
    var products = await fetchAllProducts();
    console.log('전체 상품 수: ' + products.length);
    var transformedMap = {}; // productId -> transformed

    // === 1차 조회 (1000ms 간격) ===
    console.log('=== 1차 조회 시작 ===');
    var failedIndices = [];
    for (var i = 0; i < products.length; i++) {
      if (i > 0) await delay(1000);
      var items = await fetchProductItems(products[i].sellerProductId);
      var t = transformProduct(products[i], items);
      transformedMap[products[i].sellerProductId] = t;
      if (t.optionIds.length === 0) {
        failedIndices.push(i);
      }
      if ((i+1) % 10 === 0) console.log('  1차 조회: ' + (i+1) + '/' + products.length);
    }
    console.log('1차 결과: 성공=' + (products.length - failedIndices.length) + ', 실패=' + failedIndices.length);

    // === 2차 조회 (실패한 상품만, 3초 대기 후 2000ms 간격) ===
    if (failedIndices.length > 0) {
      console.log('=== 2차 조회 시작 (5초 대기 후) ===');
      await delay(5000);
      var retryFailed = 0;
      for (var j = 0; j < failedIndices.length; j++) {
        if (j > 0) await delay(2000);
        var idx = failedIndices[j];
        var pid = products[idx].sellerProductId;
        var items2 = await fetchProductItems(pid);
        var t2 = transformProduct(products[idx], items2);
        if (t2.optionIds.length > 0) {
          transformedMap[pid] = t2;
          console.log('  2차 성공: ' + pid + ' (' + t2.optionIds.length + '개 옵션)');
        } else {
          retryFailed++;
        }
      }
      console.log('2차 결과: 복구=' + (failedIndices.length - retryFailed) + ', 최종실패=' + retryFailed);
    }

    // 결과 조립 (원래 순서 유지)
    var transformed = products.map(function(p) { return transformedMap[p.sellerProductId]; });
    var totalOpts = 0, okCount = 0;
    transformed.forEach(function(t) { totalOpts += t.optionIds.length; if (t.optionIds.length > 0) okCount++; });
    console.log('최종: 상품=' + transformed.length + ', 옵션=' + totalOpts + ', 성공=' + okCount + ', 실패=' + (transformed.length - okCount));

    res.json({ success: true, count: transformed.length, products: transformed });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== 상품 상세 조회 =====
app.get('/api/product-items', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ success: false, error: 'VENDOR_ID not set' });
  try {
    var productId = req.query.productId;
    if (!productId) return res.status(400).json({ success: false, error: 'productId required' });
    var path = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/' + productId;
    var result = await callCoupangAPI('GET', path, '');
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== 날짜 범위를 30일 단위로 분할 =====
function splitDateRange(from, to, maxDays) {
  var ranges = [];
  var start = new Date(from);
  var end = new Date(to);
  while (start <= end) {
    var chunkEnd = new Date(start);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd = end;
    ranges.push({
      from: start.toISOString().slice(0, 10),
      to: chunkEnd.toISOString().slice(0, 10)
    });
    start = new Date(chunkEnd);
    start.setDate(start.getDate() + 1);
  }
  return ranges;
}

// ===== 특정 상태의 주문 가져오기 (페이지네이션) =====
async function fetchOrdersByStatus(from, to, status) {
  var allOrders = [];
  var path = '/v2/providers/openapi/apis/api/v4/vendors/' + VENDOR_ID + '/ordersheets';
  var nextToken = '';
  var maxPages = 50;
  var page = 0;

  while (page < maxPages) {
    var query = 'createdAtFrom=' + from + '&createdAtTo=' + to + '&status=' + status;
    if (nextToken) {
      query = query + '&nextToken=' + nextToken;
    }

    var result = await callCoupangAPI('GET', path, query);

    if (result.data) {
      var orders = Array.isArray(result.data) ? result.data : [];
      allOrders = allOrders.concat(orders);

      if (result.nextToken) {
        nextToken = result.nextToken;
        page++;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return allOrders;
}

// ===== 모든 상태의 일반 주문 가져오기 (30일 자동 분할) =====
async function fetchAllOrders(from, to) {
  var statuses = ['ACCEPT', 'INSTRUCT', 'DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY'];
  var ranges = splitDateRange(from, to, 30);
  var allOrders = [];

  for (var r = 0; r < ranges.length; r++) {
    for (var i = 0; i < statuses.length; i++) {
      var orders = await fetchOrdersByStatus(ranges[r].from, ranges[r].to, statuses[i]);
      allOrders = allOrders.concat(orders);
    }
  }

  return allOrders;
}

// ===== 딜레이 함수 =====
function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ===== Rocket Growth 주문 가져오기 (페이지네이션, 단일 기간) =====
async function fetchRGOrdersChunk(from, to) {
  var allOrders = [];
  var path = '/v2/providers/rg_open_api/apis/api/v1/vendors/' + VENDOR_ID + '/rg/orders';
  var nextToken = '';
  var maxPages = 50;
  var page = 0;

  var dateFrom = from.replace(/-/g, '');
  // RG API의 paidDateTo는 배타적(exclusive)이므로 +1일
  var toDate = new Date(to);
  toDate.setDate(toDate.getDate() + 1);
  var dateTo = toDate.toISOString().slice(0, 10).replace(/-/g, '');

  while (page < maxPages) {
    var query = 'paidDateFrom=' + dateFrom + '&paidDateTo=' + dateTo;
    if (nextToken) {
      query = query + '&nextToken=' + nextToken;
    }

    if (page > 0) await delay(1500);
    var result = await callCoupangAPI('GET', path, query);

    if (result.data) {
      var orders = Array.isArray(result.data) ? result.data : [];
      allOrders = allOrders.concat(orders);
      console.log('  RG chunk ' + dateFrom + '~' + dateTo + ' page' + page + ': ' + orders.length + '건');

      if (result.nextToken) {
        nextToken = result.nextToken;
        page++;
      } else {
        break;
      }
    } else {
      console.log('  RG chunk ' + dateFrom + '~' + dateTo + ' page' + page + ': 응답없음', JSON.stringify(result).substring(0, 200));
      break;
    }
  }

  return allOrders;
}

// ===== Rocket Growth 전체 기간 조회 (3일 자동 분할) =====
// RG API는 UTC 기준으로 필터링하므로, KST 기준 정확한 데이터를 위해
// 쿼리 범위를 하루 전/후로 확장하고, 변환 시 KST 날짜로 필터링
async function fetchRocketGrowthOrders(from, to) {
  // 하루 전부터 조회 (KST 자정~09:00 = 전날 UTC 15:00~24:00)
  var expandedFrom = new Date(from);
  expandedFrom.setDate(expandedFrom.getDate() - 1);
  var expandedFromStr = expandedFrom.toISOString().slice(0, 10);

  var ranges = splitDateRange(expandedFromStr, to, 3);
  var allOrders = [];
  for (var r = 0; r < ranges.length; r++) {
    await delay(1500);
    var orders = await fetchRGOrdersChunk(ranges[r].from, ranges[r].to);
    allOrders = allOrders.concat(orders);
  }
  return allOrders;
}

// ===== 일반 주문 → 판매 형식 변환 =====
function convertNormalOrders(orders) {
  var sales = [];
  orders.forEach(function(order) {
    var date = (order.orderedAt || '').slice(0, 10);
    var items = order.orderItems || [];
    items.forEach(function(item) {
      if (item.canceled) return;
      sales.push({
        saleDate: date,
        optionId: String(item.vendorItemId || ''),
        optionName: item.vendorItemName || '',
        netAmt: item.orderPrice || 0,
        netQty: item.shippingCount || 1,
        sellPrice: item.salesPrice || item.orderPrice || 0,
        channel: 'wing'
      });
    });
  });
  return sales;
}

// ===== Rocket Growth 주문 → 판매 형식 변환 (KST 기준) =====
// paidAt(UTC timestamp)를 KST 날짜로 변환하고, 요청 범위 밖 주문 필터링
function convertRGOrders(orders, fromDate, toDate) {
  var sales = [];
  orders.forEach(function(order) {
    var date = '';
    if (order.paidAt) {
      // KST = UTC + 9시간
      var d = new Date(Number(order.paidAt) + 9 * 60 * 60 * 1000);
      date = d.toISOString().slice(0, 10);
    }
    // KST 날짜가 요청 범위 밖이면 스킵
    if (fromDate && toDate && (date < fromDate || date > toDate)) return;
    var items = order.orderItems || [];
    items.forEach(function(item) {
      sales.push({
        saleDate: date,
        optionId: String(item.vendorItemId || ''),
        optionName: item.productName || '',
        netAmt: (item.unitSalesPrice || 0) * (item.salesQuantity || 1),
        netQty: item.salesQuantity || 1,
        sellPrice: item.unitSalesPrice || 0,
        channel: 'growth'
      });
    });
  });
  return sales;
}

// ===== 판매 내역 동기화 (윙 / 그로스 / 통합) =====
// type=wing (윙만), type=growth (그로스만), type=all 또는 생략 (통합)
app.get('/api/sales', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ success: false, error: 'VENDOR_ID not set' });
  try {
    var from = req.query.from || '';
    var to = req.query.to || '';
    var type = req.query.type || 'all';
    if (!from || !to) {
      return res.status(400).json({ success: false, error: 'from, to 날짜를 입력하세요 (YYYY-MM-DD)' });
    }

    var sales = [];
    var wingSales = [];
    var growthSales = [];

    // 윙 조회
    if (type === 'all' || type === 'wing') {
      var normalOrders = await fetchAllOrders(from, to);
      wingSales = convertNormalOrders(normalOrders);
      sales = sales.concat(wingSales);
    }

    // 그로스 조회
    if (type === 'all' || type === 'growth') {
      var rgOrders = await fetchRocketGrowthOrders(from, to);
      growthSales = convertRGOrders(rgOrders, from, to);
      sales = sales.concat(growthSales);
    }

    res.json({
      success: true,
      count: sales.length,
      wingCount: wingSales.length,
      growthCount: growthSales.length,
      type: type,
      sales: sales
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== 광고비 동기화 (Wing 엑셀 업로드 필요) =====
app.get('/api/ads', function(req, res) {
  res.json({ success: true, daily: [], message: '광고 데이터는 쿠팡 Wing에서 엑셀 다운로드 후 업로드해주세요.' });
});

// ===== 매출 내역 =====
app.get('/api/revenue', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ success: false, error: 'VENDOR_ID not set' });
  try {
    var startDate = req.query.startDate;
    var endDate = req.query.endDate;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'startDate, endDate required' });
    }
    var path = '/v2/providers/openapi/apis/api/v1/revenue-history';
    var query = 'startDate=' + startDate + '&endDate=' + endDate;
    var result = await callCoupangAPI('GET', path, query);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== 정산 내역 =====
app.get('/api/settlement', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ success: false, error: 'VENDOR_ID not set' });
  try {
    var year = req.query.year;
    var month = req.query.month;
    if (!year || !month) {
      return res.status(400).json({ success: false, error: 'year, month required' });
    }
    var path = '/v2/providers/marketplace_openapi/apis/api/v1/settlement-histories';
    var query = 'year=' + year + '&month=' + month;
    var result = await callCoupangAPI('GET', path, query);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== 주문 목록 =====
app.get('/api/orders', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ success: false, error: 'VENDOR_ID not set' });
  try {
    var startDate = req.query.startDate;
    var endDate = req.query.endDate;
    var status = req.query.status;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'startDate, endDate required' });
    }
    var path = '/v2/providers/openapi/apis/api/v4/vendors/' + VENDOR_ID + '/ordersheets';
    var query = 'createdAtFrom=' + startDate + '&createdAtTo=' + endDate + '&status=' + (status || 'ACCEPT');
    var result = await callCoupangAPI('GET', path, query);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, function() {
  console.log('Coupang Ledger Server running on port ' + PORT);
});
