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

    var options = {
      hostname: 'api-gateway.coupang.com',
      port: 443,
      path: fullUrl,
      method: method,
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

        function parseResult(str) {
          try { resolve(JSON.parse(str)); }
          catch (e) { resolve({ raw: str }); }
        }

        if (encoding === 'gzip') {
          zlib.gunzip(buffer, function(err, decoded) {
            if (err) { resolve({ raw: buffer.toString() }); }
            else { parseResult(decoded.toString('utf-8')); }
          });
        } else {
          parseResult(buffer.toString('utf-8'));
        }
      });
    });
    req.on('error', reject);
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

// ===== 상품 상세 (옵션/아이템 포함) =====
async function fetchProductItems(productId) {
  try {
    var path = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/' + productId;
    var result = await callCoupangAPI('GET', path, '');
    if (result.code === 'SUCCESS' && result.data) {
      return result.data.items || [];
    }
    return [];
  } catch (e) {
    return [];
  }
}

// ===== 쿠팡 데이터 → 프론트엔드 형식 변환 =====
function transformProduct(product, items) {
  return {
    id: String(product.sellerProductId),
    name: product.sellerProductName || '',
    exposedId: String(product.sellerProductId),
    category: '',
    optionIds: (items || []).map(function(item) {
      return {
        optionId: String(item.vendorItemId || ''),
        optionName: item.itemName || '',
        importCost: 0,
        couponDiscount: 0,
        commission: 0,
        shipping: 0
      };
    })
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

// ===== 상품 동기화 (프론트엔드 형식으로 변환) =====
app.get('/api/products', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ success: false, error: 'VENDOR_ID not set' });
  try {
    var products = await fetchAllProducts();
    var transformed = [];

    // 5개씩 병렬로 상세 정보 가져오기 (옵션 정보 포함)
    for (var i = 0; i < products.length; i += 5) {
      var batch = products.slice(i, i + 5);
      var detailPromises = batch.map(function(p) {
        return fetchProductItems(p.sellerProductId);
      });
      var detailResults = await Promise.all(detailPromises);

      for (var j = 0; j < batch.length; j++) {
        transformed.push(transformProduct(batch[j], detailResults[j]));
      }
    }

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

// ===== 판매 내역 동기화 =====
app.get('/api/sales', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ success: false, error: 'VENDOR_ID not set' });
  try {
    var from = req.query.from || '';
    var to = req.query.to || '';
    if (!from || !to) {
      return res.status(400).json({ success: false, error: 'from, to 날짜를 입력하세요 (YYYY-MM-DD)' });
    }
    var path = '/v2/providers/openapi/apis/api/v4/vendors/' + VENDOR_ID + '/ordersheets';
    var query = 'createdAtFrom=' + from + '&createdAtTo=' + to + '&status=ACCEPT';
    var result = await callCoupangAPI('GET', path, query);

    var sales = [];
    var orders = [];
    if (result.data) {
      orders = Array.isArray(result.data) ? result.data : [];
    }

    orders.forEach(function(order) {
      var date = (order.orderedAt || '').slice(0, 10);
      var items = order.orderItems || [];
      items.forEach(function(item) {
        sales.push({
          saleDate: date,
          optionId: String(item.vendorItemId || ''),
          optionName: item.vendorItemName || '',
          netAmt: item.orderPrice || 0,
          netQty: item.shippingCount || 1,
          sellPrice: item.salesPrice || item.orderPrice || 0
        });
      });
    });

    res.json({ success: true, count: sales.length, sales: sales });
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
