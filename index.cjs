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

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
    const { distKey, distributionList, totalQty, totalWeight } = await parseJSON(req);
    if (!distKey || !Array.isArray(distributionList)
        || typeof totalQty !== 'number'
        || typeof totalWeight !== 'number') {
      throw new Error('Invalid payload – il manque distKey, distributionList, totalQty ou totalWeight');
    }

    // On stocke TOUT l’objet, pas seulement la liste
    const payload = { distributionList, totalQty, totalWeight };
    await redis.set(`dist:${distKey}`,
                    JSON.stringify(payload),
                    { EX: 60 * 60 * 2 }); // expiration 2h

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
// 1) valeurs passées par l’URL : ?tw= & ?tq=
const urlTW = parseFloat(url.searchParams.get('tw') || '0');   // ex. 47.157
const urlTQ = parseInt(url.searchParams.get('tq') || '0', 10); // ex. 1750

// 2) sinon on retombe sur les quantités de la liste
const totalQty    = urlTQ || distributionList.reduce((s, l) => s + l.qty, 0);
const totalWeight = urlTW || 0;                                // 0 si absent

const unitWeight  = totalQty ? totalWeight / totalQty : 0;     // 0,026947 …
const price       = +(totalWeight * 2.3).toFixed(2);           // tarif indicatif



res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({
  distributionList,            // maintenant c’est bien un Array
  totalQty,
  totalWeight,
  unitWeight: +unitWeight.toFixed(6),
  price
}));

  }

  /* —— POST /webhook  (appelé par Pressero) ————————— */
  // —— POST /webhook (calcul des frais multiadresse) —————————
// —— POST /webhook (calcul des frais multiadresse) —————————
// index.cjs

if (req.method === 'POST' && req.url === '/webhook') {
  try {
    const body = await parseJSON(req);
    console.log('Webhook body:', body);

    // 1) Récupérer liste + totaux depuis Redis
    let list = [], totalWeight = 0, totalQty = 0;

    if (body.distKey) {
      const raw = await redis.get(`dist:${body.distKey}`);
      if (raw) {
        const stored = JSON.parse(raw);
        list         = stored.distributionList || [];
        totalQty     = parseInt(stored.totalQty  || '0', 10);
        totalWeight  = parseFloat(stored.totalWeight || '0');
      }
    }

    // 2) Si pas de liste, fallback sur adresse “To” et poids total Pressero
    if (!list.length && Array.isArray(body.packagesinfo)) {
      const fallbackAddr = body.packagesinfo[0].to;
      // on prend la quantité totale envoyée (hdnTotalQty) ou 1
      totalQty    = parseInt(body.hdnTotalQty || '1', 10);
      totalWeight = parseFloat(body.hdnTotalWeight || body.packagesinfo[0].weight || '0');
      list = [{ address: fallbackAddr, qty: totalQty }];
    }

    // 3) Poids unitaire
    const unitWeight = totalQty ? totalWeight / totalQty : 0;
    console.log({ totalWeight, totalQty, unitWeight });

    // 4) Calcul tarif pour chaque adresse
    const carrier   = 'DHL';
    const prefixLen = 2;
    let totalCost   = 0;

    const packages = list.map(({ address, qty }) => {
      const weight = +(unitWeight * qty).toFixed(3);
      const postal = extractPostal(address);
      const prefix = postal.slice(0, prefixLen);
      const rate   = findRate(carrier, prefix, weight);
      totalCost   += rate;

      return {
        Package: {
          ID:            null,
          From:          body.packagesinfo[0].from,
          To:            { Postal: postal },
          Weight:        weight.toFixed(3),
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

    // 5) Répondre à Pressero
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


  /* —— 404 Fallback —————————————————————————— */
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

/* ───────────── 5. Démarrage ───────────── */
server.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));

