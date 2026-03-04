const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(express.json());

// ✅ CORS 설정 - 어디서든 접근 허용
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ===================== 환경 변수 =====================
const PORT = process.env.PORT || 3000;
const VENDOR_ID   = process.env.COUPANG_VENDOR_ID;
const ACCESS_KEY  = process.env.COUPANG_ACCESS_KEY;
const SECRET_KEY  = process.env.COUPANG_SECRET_KEY;

// ===================== HMAC 서명 생성 =====================
function generateHmac(method, path, queryStr) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const yr  = String(now.getUTCFullYear()).slice(2);
  const datetime =
    yr +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    'T' +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds()) +
    'Z';

  const message   = datetime + method + path + (queryStr || '');
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(message)
    .digest('hex');

  return {
    authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`,
    datetime
  };
}

// ===================== 쿠팡 API 호출 헬퍼 =====================
function callCoupangAPI(method, path, queryStr = '') {
  return new Promise((resolve, reject) => {
    const { authorization } = generateHmac(method, path, queryStr);
    const fullPath = queryStr ? `${path}?${queryStr}` : path;

    const options = {
      hostname: 'api-gateway.coupang.com',
      port: 443,
      path: fullPath,
      method,
      headers: {
        'Authorization':  authorization,
        'X-Requested-By': VENDOR_ID,
        'Content-Type':   'application/json;charset=UTF-8'
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ===================== 상태 확인 =====================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: '쿠팡 장부 백엔드 서버 정상 작동 중',
    vendorId: VENDOR_ID ? VENDOR_ID.slice(0, 4) + '****' : '미설정',
    apiReady: !!(VENDOR_ID && ACCESS_KEY && SECRET_KEY)
  });
});

// ===================== API: 연결 테스트 =====================
app.get('/api/test', async (req, res) => {
  if (!VENDOR_ID || !ACCESS_KEY || !SECRET_KEY) {
    return res.status(400).json({ ok: false, message: '환경 변수가 설정되지 않았습니다.' });
  }
  try {
    const path    = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;
    const query   = `vendorId=${VENDOR_ID}&status=APPROVED&limit=1`;
    const result  = await callCoupangAPI('GET', path, query);
    res.json({ ok: true, message: 'API 연결 성공', sample: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ===================== API: 디버그 - 원본 응답 확인 =====================
app.get('/api/debug/products', async (req, res) => {
  if (!VENDOR_ID) return res.status(400).json({ ok: false, message: 'VENDOR_ID 미설정' });
  try {
    const path   = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;
    const query  = `vendorId=${VENDOR_ID}&status=APPROVED&limit=5&page=1`;
    const result = await callCoupangAPI('GET', path, query);
    // 원본 응답 전체를 그대로 반환
    res.json({ ok: true, vendorId: VENDOR_ID, rawResponse: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get('/api/debug/revenue', async (req, res) => {
  if (!VENDOR_ID) return res.status(400).json({ ok: false, message: 'VENDOR_ID 미설정' });
  try {
    const today = new Date().toISOString().slice(0,10);
    const weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
    const path   = `/v2/providers/openapi/apis/api/v1/revenue-history`;
    const query  = `startDate=${weekAgo}&endDate=${today}`;
    const result = await callCoupangAPI('GET', path, query);
    res.json({ ok: true, vendorId: VENDOR_ID, rawResponse: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ===================== API: 상품 목록 조회 =====================
// GET /api/products?page=1&limit=100
app.get('/api/products', async (req, res) => {
  if (!VENDOR_ID) return res.status(400).json({ ok: false, message: 'VENDOR_ID 미설정' });
  try {
    const page   = req.query.page  || 1;
    const limit  = req.query.limit || 100;
    const status = req.query.status || 'APPROVED';
    const path   = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;
    const query  = `vendorId=${VENDOR_ID}&status=${status}&limit=${limit}&page=${page}`;
    const result = await callCoupangAPI('GET', path, query);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ===================== API: 상품 옵션 상세 조회 =====================
// GET /api/product-items?productId=xxx
app.get('/api/product-items', async (req, res) => {
  if (!VENDOR_ID) return res.status(400).json({ ok: false, message: 'VENDOR_ID 미설정' });
  try {
    const { productId } = req.query;
    if (!productId) return res.status(400).json({ ok: false, message: 'productId 필요' });
    const path   = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${productId}`;
    const result = await callCoupangAPI('GET', path, '');
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ===================== API: 매출 내역 조회 =====================
// GET /api/revenue?startDate=2026-02-01&endDate=2026-02-28
app.get('/api/revenue', async (req, res) => {
  if (!VENDOR_ID) return res.status(400).json({ ok: false, message: 'VENDOR_ID 미설정' });
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ ok: false, message: 'startDate, endDate 필요 (YYYY-MM-DD)' });
    }
    const path   = `/v2/providers/openapi/apis/api/v1/revenue-history`;
    const query  = `startDate=${startDate}&endDate=${endDate}`;
    const result = await callCoupangAPI('GET', path, query);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ===================== API: 정산 내역 조회 =====================
// GET /api/settlement?year=2026&month=02
app.get('/api/settlement', async (req, res) => {
  if (!VENDOR_ID) return res.status(400).json({ ok: false, message: 'VENDOR_ID 미설정' });
  try {
    const { year, month } = req.query;
    if (!year || !month) {
      return res.status(400).json({ ok: false, message: 'year, month 필요' });
    }
    const path   = `/v2/providers/marketplace_openapi/apis/api/v1/settlement-histories`;
    const query  = `year=${year}&month=${month}`;
    const result = await callCoupangAPI('GET', path, query);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ===================== API: 주문 목록 조회 =====================
// GET /api/orders?startDate=2026-02-01&endDate=2026-02-28
app.get('/api/orders', async (req, res) => {
  if (!VENDOR_ID) return res.status(400).json({ ok: false, message: 'VENDOR_ID 미설정' });
  try {
    const { startDate, endDate, status } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ ok: false, message: 'startDate, endDate 필요' });
    }
    const path   = `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets`;
    const query  = `createdAtFrom=${startDate}T00:00:00&createdAtTo=${endDate}T23:59:59&status=${status || 'ACCEPT'}`;
    const result = await callCoupangAPI('GET', path, query);
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ===================== 서버 시작 =====================
app.listen(PORT, () => {
  console.log(`✅ 쿠팡 장부 서버 실행 중 → 포트 ${PORT}`);
  console.log(`   VENDOR_ID: ${VENDOR_ID ? VENDOR_ID.slice(0,4)+'****' : '❌ 미설정'}`);
  console.log(`   ACCESS_KEY: ${ACCESS_KEY ? '****설정됨' : '❌ 미설정'}`);
  console.log(`   SECRET_KEY: ${SECRET_KEY ? '****설정됨' : '❌ 미설정'}`);
});
