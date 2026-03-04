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
// 참고: https://developers.coupangcorp.com/hc/ko/articles/360033988854
function generateHmac(method, path, queryStr) {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');

  // yyMMddTHHmmssZ 포맷 (UTC 기준)
  const yy  = String(now.getUTCFullYear()).slice(2);
  const MM  = p(now.getUTCMonth() + 1);
  const dd  = p(now.getUTCDate());
  const HH  = p(now.getUTCHours());
  const mm  = p(now.getUTCMinutes());
  const ss  = p(now.getUTCSeconds());
  const datetime = `${yy}${MM}${dd}T${HH}${mm}${ss}Z`;

  // 서명 메시지 = datetime + method + path + queryStr
  // path: 슬래시로 시작하는 경로만 (? 미포함)
  // queryStr: & 구분된 쿼리 (? 미포함)
  const message = datetime + method + path + (queryStr || '');

  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(message)
    .digest('hex');

  // 디버그 로그
  console.log(`[HMAC] datetime   = ${datetime}`);
  console.log(`[HMAC] method     = ${method}`);
  console.log(`[HMAC] path       = ${path}`);
  console.log(`[HMAC] queryStr   = ${queryStr}`);
  console.log(`[HMAC] message    = ${message}`);
  console.log(`[HMAC] sig(앞16)  = ${signature.slice(0,16)}...`);

  return {
    authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`,
    datetime,
    message  // 디버그용
  };
}

function callCoupang(method, path, queryStr = '') {
  return new Promise((resolve, reject) => {
    const hmac = generateHmac(method, path, queryStr);
    const fullPath = queryStr ? `${path}?${queryStr}` : path;
    const options = {
      hostname: 'api-gateway.coupang.com',
      port: 443,
      path: fullPath,
      method,
      headers: {
        'Authorization': hmac.authorization,
        'X-Requested-By': VENDOR_ID,
        'Content-Type': 'application/json;charset=UTF-8'
      }
    };
    console.log(`[REQ] ${method} https://api-gateway.coupang.com${fullPath}`);
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`[RES] status=${res.statusCode} body(앞200)=${data.slice(0,200)}`);
        try { resolve({ status: res.statusCode, body: JSON.parse(data), hmacMessage: hmac.message }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw: data }, hmacMessage: hmac.message }); }
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

// ===== 상태 확인 =====
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: '쿠팡 장부 백엔드 서버 정상 작동 중',
    vendorId: VENDOR_ID ? VENDOR_ID.slice(0,4)+'****' : '미설정',
    apiReady: !!(VENDOR_ID && ACCESS_KEY && SECRET_KEY)
  });
});

// ===== 연결 테스트 (실제 쿠팡 API 호출) =====
app.get('/api/test', checkEnv, async (req, res) => {
  try {
    const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;
    const query = `vendorId=${VENDOR_ID}&status=APPROVED&limit=1`;
    const { status, body, hmacMessage } = await callCoupang('GET', path, query);
    res.json({
      success: status === 200,
      coupangStatus: status,
      message: status === 200 ? 'API 연결 성공' : '서명 오류',
      hmacMessage,  // 서명에 사용된 문자열 (디버그용)
      body
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== 디버그: 상품 원본 =====
app.get('/api/debug/products', checkEnv, async (req, res) => {
  try {
    const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;
    const query = `vendorId=${VENDOR_ID}&status=APPROVED&limit=3&page=1`;
    const result = await callCoupang('GET', path, query);
    res.json({ ...result, hmacMessage: result.hmacMessage });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 디버그: 주문 원본 =====
app.get('/api/debug/orders', checkEnv, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const weekAgo = new Date(Date.now()-7*24*60*60*1000).toISOString().slice(0,10);
    const path = `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets`;
    const query = `createdAtFrom=${weekAgo}T00:00:00&createdAtTo=${today}T23:59:59&status=ACCEPT`;
    const result = await callCoupang('GET', path, query);
    res.json({ ...result, period: { from: weekAgo, to: today } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 상품 목록 =====
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

// ===== 판매 데이터 =====
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
      for (const status of ['ACCEPT', 'CANCEL']) {
        let nextToken = null, pageCount = 0;
        do {
          let query = `createdAtFrom=${range.from}T00:00:00&createdAtTo=${range.to}T23:59:59&status=${status}`;
          if (nextToken) query += `&nextToken=${nextToken}`;
          const { status: httpStatus, body } = await callCoupang('GET',
            `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets`, query);
          if (httpStatus !== 200 || !body.data) break;
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
              if (status === 'ACCEPT') {
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

// ===== 광고비 (미지원) =====
app.get('/api/ads', checkEnv, (req, res) => {
  res.json({ success: true, daily: [], message: '쿠팡 Open API는 광고비 미제공 — Wing 엑셀로 수동 업로드' });
});

app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중 → 포트 ${PORT}`);
  console.log(`   VENDOR_ID:  ${VENDOR_ID  ? VENDOR_ID.slice(0,4)+'****' : '❌ 미설정'}`);
  console.log(`   ACCESS_KEY: ${ACCESS_KEY ? '****설정됨' : '❌ 미설정'}`);
  console.log(`   SECRET_KEY: ${SECRET_KEY ? '****설정됨' : '❌ 미설정'}`);
});
