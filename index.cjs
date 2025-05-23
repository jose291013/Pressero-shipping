// index.cjs
// ────────────────────────────────────────────────────────────────────
//  Petit service HTTP + Redis pour gestion des listes de distribution
//  et calcul de tarifs de transport (sans Express.js)
// ────────────────────────────────────────────────────────────────────

delete process.env.DEBUG;
delete process.env.DEBUG_URL;

const http          = require('http');
const { createClient } = require('redis');
const fs            = require('fs');
const path          = require('path');
const { URL }       = require('url');

const PORT      = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL;

/* ───────────── 1. Redis ───────────── */
const redis = createClient({ url: REDIS_URL });
redis.on('error', err => console.error('Redis error', err));
redis.connect()
     .then(() => console.log('✅ Connected to Redis'))
     .catch(console.error);

/* ───────────── 2. Tableau de tarifs ───────────── */
const gridData = fs.readFileSync(path.join(__dirname, 'rateGrid.json'), 'utf8');
const rateGrid = JSON.parse(gridData);
console.log(`✅ Loaded rateGrid with ${rateGrid.length} entries`);

/* ───────────── 3. Helpers ───────────── */
function findRate(carrier, prefix, weight) {
  let rules = rateGrid.filter(r => r.carrier === carrier);

  if (prefix) {
    rules = rules.filter(r =>
      r.postal_prefix == null || prefix.startsWith(r.postal_prefix)
    );
  } else {
    rules = rules.filter(r => !r.postal_prefix);
  }

  for (const r of rules) {
    if (weight >= r.min_weight && weight <= r.max_weight) {
      return r.flat_price != null
        ? r.flat_price
        : weight * (r.price_per_kg || 0);
    }
  }
  console.warn(`No rate for carrier=${carrier}, weight=${weight}`);
  return 0;
}

function extractPostal(addr) {
  if (typeof addr === 'string') {
    const m = addr.match(/\b(\d{5})\b/);
    return m ? m[1] : '';
  }
  return addr?.postal || '';
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',
                'https://decoration.ams.v6.pressero.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function parseJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

/* ───────────── 4. Serveur HTTP ───────────── */
const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  /* —— Home ——————————————————————————————— */
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('Service shipping opérationnel');
  }

  /* —— POST /save-distribution ————————————————— */
  if (req.method === 'POST' && req.url === '/save-distribution') {
    try {
      const { distKey, distributionList } = await parseJSON(req);
      if (!distKey || !Array.isArray(distributionList)) {
        throw new Error('Invalid payload');
      }

      await redis.set(`dist:${distKey}`,
                      JSON.stringify(distributionList),
                      { EX: 60 * 60 * 2 }); // 2 h

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', distKey }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  /* —— GET /get-distribution?distKey=... ——————————— */
  if (req.method === 'GET' && req.url.startsWith('/get-distribution')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const distKey = url.searchParams.get('distKey');

    if (!distKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'distKey manquant' }));
    }

    const raw = await redis.get(`dist:${distKey}`);
    if (!raw) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unknown distKey' }));
    }

    const distributionList = JSON.parse(raw);

    /* — Calculs optionnels (totaux + prix indicatif) — */
    const totalQty    = distributionList.reduce((s, l) => s + l.qty, 0);
    const unitWeight  = 0.05;                            // adapte à ton produit
    const totalWeight = +(totalQty * unitWeight).toFixed(3);
    const price       = +(totalWeight * 2.3).toFixed(2); // exemple

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      distributionList, totalQty, totalWeight, price
    }));
  }

  /* —— POST /webhook  (appelé par Pressero) ————————— */
  if (req.method === 'POST' && req.url === '/webhook') {
    try {
      const body = await parseJSON(req);
      console.log('Webhook body:', body);

      // 1) Récupération de la liste
      let list = [];
      if (body.distKey) {
        const stored = await redis.get(`dist:${body.distKey}`);
        list = stored ? JSON.parse(stored) : [];
      }
      if (!list.length && Array.isArray(body.packagesinfo)) {
        list = [{ address: body.packagesinfo[0].to, qty: 1 }];
      }

      // 2) Poids unitaire
      let unitWeight = null;
      if (body.hdnTotalWeight && body.hdnTotalQty) {
        unitWeight = parseFloat(body.hdnTotalWeight) /
                     parseInt(body.hdnTotalQty, 10);
      }

      // 3) Calcul tarif
      const carrier   = 'DHL';
      const prefixLen = 2;
      let totalCost   = 0;
      const packages  = list.map(entry => {
        const qty     = entry.qty;
        const weight  = unitWeight ? unitWeight * qty : 0;
        const postal  = extractPostal(entry.address);
        const prefix  = postal.slice(0, prefixLen);

        const rate    = findRate(carrier, prefix, weight);
        totalCost    += rate;

        return {
          Package: {
            ID: null,
            From:    body.packagesinfo[0].from,
            To:      { Postal: postal },
            Weight:  weight.toFixed(3),
            WeightUnit: 1,
            PackageCost:    rate.toFixed(2),
            TotalOrderCost: rate.toFixed(2),
            CurrencyCode:   'EUR',
            Items:          []
          },
          CanShip:       true,
          Messages:      [],
          Cost:          rate,
          DaysToDeliver: 2,
          MISID:         null
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        Carrier: carrier,
        ServiceCode: 'External',
        TotalCost: parseFloat(totalCost.toFixed(2)),
        Messages: [],
        Packages: packages
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  /* —— 404 Fallback —————————————————————————— */
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

/* ───────────── 5. Démarrage ───────────── */
server.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
