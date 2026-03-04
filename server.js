const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));

const PORT = process.env.PORT || 3000;
const VENDOR_ID  = (process.env.COUPANG_VENDOR_ID  || '').trim();
const ACCESS_KEY = (process.env.COUPANG_ACCESS_KEY  || '').trim();
const SECRET_KEY = (process.env.COUPANG_SECRET_KEY  || '').trim();

// ===================== 쿠팡 공식 HMAC 서명 =====================
// 핵심: 쿼리스트링 파라미터는 반드시 알파벳 오름차순 정렬!
function sortQueryString(queryStr) {
  if (!queryStr) return '';
  return queryStr.split('&')
    .sort((a, b) => a.localeCompare(b))
    .join('&');
}

function generateHmac(method, path, queryStr) {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const datetime =
    String(now.getUTCFullYear()).slice(2) +
    p(now.getUTCMonth() + 1) + p(now.getUTCDate()) +
    'T' + p(now.getUTCHours()) + p(now.getUTCMinutes()) + p(now.getUTCSeconds()) + 'Z';

  // 쿼리 파라미터 알파벳 정렬 (필수!)
  const sortedQuery = sortQueryString(queryStr);
  const message = datetime + method + path + (sortedQuery || '');

  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(message)
    .digest('hex');

  console.log(`[HMAC] message = ${message}`);

  return {
    authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`,
    sortedQuery  // 실제 요청에 쓸 정렬된 쿼리
  };
}

function callCoupang(method, path, queryStr = '') {
  return new Promise((resolve, reject) => {
    const { authorization, sortedQuery } = generateHmac(method, path, queryStr);
    const fullPath = sortedQuery ? `${path}?${sortedQuery}` : path;
    const options = {
      hostname: 'api-gateway.coupang.com', port: 443,
      path: fullPath, method,
      headers: {
        'Authorization': authorization,
        'X-Requested-By': VENDOR_ID,
        'Content-Type': 'application/json;charset=UTF-8'
      }
    };
    console.log(`[REQ] ${method} ${fullPath}`);
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`[RES] status=${res.statusCode} body=${data.slice(0,200)}`);
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function checkEnv(req, res, next) {
  if (!VENDOR_ID || !ACCESS_KEY || !SECRET_KEY)
    return res.status(400).json({ success: false, error: 'Railway 환경변수 미설정' });
  next();
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '쿠팡 장부 백엔드 서버 정상 작동 중', vendorId: VENDOR_ID ? VENDOR_ID.slice(0,4)+'****' : '미설정', apiReady: !!(VENDOR_ID && ACCESS_KEY && SECRET_KEY) });
});

app.get('/api/test', checkEnv, async (req, res) => {
  try {
    const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;
    const query = `vendorId=${VENDOR_ID}&status=APPROVED&limit=1`;
    const { status, body } = await callCoupang('GET', path, query);
    res.json({ success: status === 200, coupangStatus: status, message: status === 200 ? 'API 연결 성공' : '오류', body });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/debug/products', checkEnv, async (req, res) => {
  try {
    const { status, body } = await callCoupang('GET',
      `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`,
      `vendorId=${VENDOR_ID}&status=APPROVED&limit=3&page=1`);
    res.json({ status, body });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/orders', checkEnv, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const weekAgo = new Date(Date.now()-7*24*60*60*1000).toISOString().slice(0,10);
    const { status, body } = await callCoupang('GET',
      `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets`,
      `createdAtFrom=${weekAgo}T00:00:00&createdAtTo=${today}T23:59:59&status=ACCEPT`);
    res.json({ status, body, period: { from: weekAgo, to: today } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products', checkEnv, async (req, res) => {
  try {
    let allItems = [], page = 1;
    while (true) {
      const { status, body } = await callCoupang('GET',
        `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`,
        `vendorId=${VENDOR_ID}&status=APPROVED&limit=100&page=${page}`);
      if (status !== 200 || !body.data || !body.data.length) break;
      allItems = allItems.concat(body.data);
      if (body.data.length < 100 || page >= 10) break;
      page++;
    }
    const products = [];
    for (const item of allItems) {
      let optionIds = [];
      try {
        const { body: detail } = await callCoupang('GET',
          `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${item.sellerProductId}`, '');
        optionIds = ((detail.data || {}).items || []).map(opt => ({
          optionId: String(opt.vendorItemId || ''),
          optionName: opt.itemName || opt.vendorItemName || ''
        })).filter(o => o.optionId);
      } catch(e) {}
      products.push({
        id: String(item.sellerProductId),
        name: item.sellerProductName || item.displayProductName || '상품명 없음',
        category: item.displayCategoryName || '',
        exposedId: String(item.sellerProductId),
        optionIds,
        createdAt: new Date().toISOString()
      });
    }
    res.json({ success: true, products, count: products.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/sales', checkEnv, async (req, res) => {
  try {
    const from = req.query.from || new Date(Date.now()-30*24*60*60*1000).toISOString().slice(0,10);
    const to   = req.query.to   || new Date().toISOString().slice(0,10);

    const ranges = [];
    let cur = new Date(from + 'T00:00:00Z');
    const endDate = new Date(to + 'T23:59:59Z');
    while (cur <= endDate) {
      const rangeEnd = new Date(cur); rangeEnd.setDate(rangeEnd.getDate() + 6);
      if (rangeEnd > endDate) rangeEnd.setTime(endDate.getTime());
      ranges.push({ from: cur.toISOString().slice(0,10), to: rangeEnd.toISOString().slice(0,10) });
      cur.setDate(cur.getDate() + 7);
    }

    const salesMap = {};
    for (const range of ranges) {
      for (const orderStatus of ['ACCEPT', 'CANCEL']) {
        let nextToken = null, pageCount = 0;
        do {
          let query = `createdAtFrom=${range.from}T00:00:00&createdAtTo=${range.to}T23:59:59&status=${orderStatus}`;
          if (nextToken) query += `&nextToken=${nextToken}`;
          const { status, body } = await callCoupang('GET',
            `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets`, query);
          if (status !== 200 || !body.data) break;
          nextToken = body.nextToken || null;
          for (const order of body.data) {
            const saleDate = (order.orderedAt || order.paidAt || order.createdAt || '').slice(0,10);
            if (!saleDate) continue;
            for (const item of (order.orderItems || order.items || [])) {
              const oid = String(item.vendorItemId || item.itemId || '');
              if (!oid) continue;
              const key = `${saleDate}_${oid}`;
              const price = parseFloat(item.sellingPrice || item.unitPrice || 0);
              const qty = parseInt(item.shippingCount || item.quantity || item.orderCount || 1);
              if (!salesMap[key]) salesMap[key] = { id:`api_${key}`, saleDate, optionId:oid, optionName:item.vendorItemName||item.itemName||'', netAmt:0, netQty:0, grossAmt:0, cancelAmt:0, cancelQty:0 };
              if (orderStatus === 'ACCEPT') {
                salesMap[key].grossAmt += price * qty;
                salesMap[key].netAmt  += price * qty;
                salesMap[key].netQty  += qty;
              } else {
                salesMap[key].cancelAmt += price * qty;
                salesMap[key].cancelQty += qty;
                salesMap[key].netAmt   -= price * qty;
                salesMap[key].netQty   -= qty;
              }
            }
          }
          pageCount++;
        } while (nextToken && pageCount < 20);
      }
    }
    const sales = Object.values(salesMap);
    res.json({ success: true, sales, count: sales.length, period: { from, to } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/ads', checkEnv, (req, res) => {
  res.json({ success: true, daily: [], message: '쿠팡 Open API는 광고비 미제공 — Wing 엑셀로 수동 업로드' });
});

app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중 → 포트 ${PORT}`);
  console.log(`   VENDOR_ID:  ${VENDOR_ID  ? VENDOR_ID.slice(0,4)+'****' : '❌ 미설정'}`);
  console.log(`   ACCESS_KEY: ${ACCESS_KEY ? '****설정됨' : '❌ 미설정'}`);
  console.log(`   SECRET_KEY: ${SECRET_KEY ? '****설정됨' : '❌ 미설정'}`);
});
