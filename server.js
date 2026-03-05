const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(express.json());

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const PORT = process.env.PORT || 3000;
const VENDOR_ID   = (process.env.COUPANG_VENDOR_ID  || '').trim();
const ACCESS_KEY  = (process.env.COUPANG_ACCESS_KEY || '').trim();
const SECRET_KEY  = (process.env.COUPANG_SECRET_KEY || '').trim();

function generateHmac(method, path, queryStr) {
  const datetime = new Date().toISOString()
    .split('.')[0] + 'Z';
  const signedDate = datetime
    .replace(/:/g, '').replace(/-/g, '')
    .substring(2);

  const message   = signedDate + method + path + (queryStr || '');
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(message)
    .digest('hex');

  return {
    authorization: 'CEA algorithm=HmacSHA256, access-key=' + ACCESS_KEY + ', signed-date=' + signedDate + ', signature=' + signature,
    datetime: signedDate
  };
}

function callCoupangAPI(method, path, queryStr) {
  if (!queryStr) queryStr = '';
  return new Promise(function(resolve, reject) {
    var hmac = generateHmac(method, path, queryStr);
    var fullPath = queryStr ? path + '?' + queryStr : path;

    var options = {
      hostname: 'api-gateway.coupang.com',
      port: 443,
      path: fullPath,
      method: method,
      headers: {
        'Authorization': hmac.authorization,
        'Content-Type': 'application/json;charset=UTF-8',
        'X-EXTENDED-TIMEOUT': '90000'
      }
    };

    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

app.get('/', function(req, res) {
  res.json({
    status: 'ok',
    message: 'Coupang Ledger Backend Running',
    vendorId: VENDOR_ID ? VENDOR_ID.slice(0, 4) + '****' : 'NOT SET',
    apiReady: !!(VENDOR_ID && ACCESS_KEY && SECRET_KEY)
  });
});

app.get('/api/test', async function(req, res) {
  if (!VENDOR_ID || !ACCESS_KEY || !SECRET_KEY) {
    return res.status(400).json({ ok: false, message: 'ENV not set' });
  }
  try {
    var path = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';
    var query = 'vendorId=' + VENDOR_ID + '&status=APPROVED&limit=1';
    var result = await callCoupangAPI('GET', path, query);
    res.json({ ok: true, message: 'API connected', sample: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get('/api/products', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ ok: false, message: 'VENDOR_ID not set' });
  try {
    var page = req.query.page || 1;
    var limit = req.query.limit || 100;
    var status = req.query.status || 'APPROVED';
    var path = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';
    var query = 'vendorId=' + VENDOR_ID + '&status=' + status + '&limit=' + limit + '&page=' + page;
    var result = await callCoupangAPI('GET', path, query);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get('/api/product-items', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ ok: false, message: 'VENDOR_ID not set' });
  try {
    var productId = req.query.productId;
    if (!productId) return res.status(400).json({ ok: false, message: 'productId required' });
    var path = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/' + productId;
    var result = await callCoupangAPI('GET', path, '');
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get('/api/revenue', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ ok: false, message: 'VENDOR_ID not set' });
  try {
    var startDate = req.query.startDate;
    var endDate = req.query.endDate;
    if (!startDate || !endDate) {
      return res.status(400).json({ ok: false, message: 'startDate, endDate required' });
    }
    var path = '/v2/providers/openapi/apis/api/v1/revenue-history';
    var query = 'startDate=' + startDate + '&endDate=' + endDate;
    var result = await callCoupangAPI('GET', path, query);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get('/api/settlement', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ ok: false, message: 'VENDOR_ID not set' });
  try {
    var year = req.query.year;
    var month = req.query.month;
    if (!year || !month) {
      return res.status(400).json({ ok: false, message: 'year, month required' });
    }
    var path = '/v2/providers/marketplace_openapi/apis/api/v1/settlement-histories';
    var query = 'year=' + year + '&month=' + month;
    var result = await callCoupangAPI('GET', path, query);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get('/api/orders', async function(req, res) {
  if (!VENDOR_ID) return res.status(400).json({ ok: false, message: 'VENDOR_ID not set' });
  try {
    var startDate = req.query.startDate;
    var endDate = req.query.endDate;
    var status = req.query.status;
    if (!startDate || !endDate) {
      return res.status(400).json({ ok: false, message: 'startDate, endDate required' });
    }
    var path = '/v2/providers/openapi/apis/api/v4/vendors/' + VENDOR_ID + '/ordersheets';
    var query = 'createdAtFrom=' + startDate + 'T00:00:00&createdAtTo=' + endDate + 'T23:59:59&status=' + (status || 'ACCEPT');
    var result = await callCoupangAPI('GET', path, query);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.listen(PORT, function() {
  console.log('Coupang Ledger Server running on port ' + PORT);
});
