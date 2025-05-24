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
  // on conserve seulement les règles valides pour ce transporteur
  let rules = rateGrid.filter(r => r.carrier === carrier
    && (r.postal_prefix == null || (prefix && prefix.startsWith(r.postal_prefix)))
  );
  // on garde celles où weight ∈ [min_weight, max_weight]
  const candidates = rules.filter(r =>
    weight >= r.min_weight && weight <= r.max_weight
  );
  // on choisit la plus spécifique : celle avec le plus grand min_weight
  const best = candidates.sort((a,b) => b.min_weight - a.min_weight)[0];
  if (best) {
    return best.flat_price != null
      ? best.flat_price
      : weight * (best.price_per_kg || 0);
  }
  console.warn(`Aucun tarif pour carrier=${carrier}, weight=${weight}`);
  return 0;
}

function extractPostal(addr) {
  if (typeof addr === 'string') {
    const m = addr.match(/\b(\d{5})\b/);
    return m ? m[1] : '';
  }
  return addr?.postal || '';
}

function setCors(req, res) {
  const origin = req.headers.origin || '';
  // si vous voulez restreindre aux domaines Pressero, vérifiez origin ici
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // retirez cette ligne si vous n’avez pas besoin d’envoyer les cookies
  // ou ne la laissez que si vous echoiez origin explicitement
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
/* ───────────── 4. Serveur HTTP ───────────── */
const server = http.createServer(async (req, res) => {
  // 0) CORS
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // —— Home ———————————————————————————————
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('Service shipping opérationnel');
  }

  // —— GET /get-distribution?distKey=… ———————————
  if (req.method === 'GET' && req.url.startsWith('/get-distribution')) {
    const url     = new URL(req.url, `http://${req.headers.host}`);
    const distKey = url.searchParams.get('distKey') || '';
    if (!distKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'distKey manquant' }));
    }

    // récupère la liste depuis Redis
    const raw = await redis.get(`dist:${distKey}`);
    if (!raw) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unknown distKey' }));
    }
    const distributionList = JSON.parse(raw);

    // totaux passés en query ?tw=&tq=
    const urlTW = parseFloat(url.searchParams.get('tw') || '0');
    const urlTQ = parseInt  (url.searchParams.get('tq') || '0', 10);

    // calcul des totaux
    const totalQty    = urlTQ || distributionList.reduce((s, l) => s + l.qty, 0);
    const totalWeight = urlTW || 0;
    const unitWeight  = totalQty ? totalWeight / totalQty : 0;

    // calcul multi-adresse
    const carrier   = 'DHL';
    const prefixLen = 2;
    let totalCost   = 0;
    for (const entry of distributionList) {
      const w      = +(unitWeight * entry.qty).toFixed(3);
      const postal = extractPostal(entry.address);
      const prefix = postal.slice(0, prefixLen);
      const rate   = findRate(carrier, prefix, w);
      totalCost   += rate;
    }

    // réponse
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      distributionList,
      totalQty,
      totalWeight,
      unitWeight: +unitWeight.toFixed(6),
      price:      parseFloat(totalCost.toFixed(2))
    }));
  }

  // —— POST /webhook ———————————
  if (req.method === 'POST' && req.url === '/webhook') {
    try {
      const body = await parseJSON(req);
      console.log('Webhook body:', body);

      // 1) récupère liste + totaux de Redis
      let list        = [];
      let totalQty    = 0;
      let totalWeight = 0;
      if (body.distKey) {
        const rawStored = await redis.get(`dist:${body.distKey}`);
        if (rawStored) {
          const stored       = JSON.parse(rawStored);
          list               = stored.distributionList || [];
          totalQty           = parseInt(stored.totalQty    || '0', 10);
          totalWeight        = parseFloat(stored.totalWeight || '0');
        }
      }

      // 2) fallback si pas de liste
      if (!list.length && Array.isArray(body.packagesinfo)) {
        totalQty    = parseInt(body.hdnTotalQty    || '1', 10);
        totalWeight = parseFloat(body.hdnTotalWeight || body.packagesinfo[0].weight || '0');
        list = [{ address: body.packagesinfo[0].to, qty: totalQty }];
      }

      // 3) poids unitaire
      const unitWeight = totalQty ? totalWeight / totalQty : 0;
      console.log({ totalWeight, totalQty, unitWeight });

      // 4) calcul des frais
      const carrier   = 'DHL';
      const prefixLen = 2;
      let totalCost   = 0;
      const packages = list.map(entry => {
        const w      = +(unitWeight * entry.qty).toFixed(3);
        const postal = extractPostal(entry.address);
        const prefix = postal.slice(0, prefixLen);
        const rate   = findRate(carrier, prefix, w);
        totalCost   += rate;
        return {
          Package: {
            ID:            null,
            From:          body.packagesinfo[0]?.from,
            To:            { Postal: postal },
            Weight:        w.toFixed(3),
            WeightUnit:    1,
            PackageCost:   rate.toFixed(2),
            TotalOrderCost: rate.toFixed(2),
            CurrencyCode:  'EUR',
            Items:         []
          },
          CanShip:       true,
          Messages:      [],
          Cost:          rate,
          DaysToDeliver: 2,
          MISID:         null
        };
      });

      // 5) réponse
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        Carrier:     carrier,
        ServiceCode: 'External',
        TotalCost:   parseFloat(totalCost.toFixed(2)),
        Messages:    [],
        Packages:    packages
      }));
    } catch (e) {
      console.error('❌ Erreur webhook:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // —— 404 Fallback ——————————————————————————
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

/* ───────────── 5. Démarrage ───────────── */
server.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));


