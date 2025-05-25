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

// 3. Helpers
function setCors(req, res) {
  const origin = req.headers.origin || '';
  // si tu veux restreindre aux appels Pressero
  if (origin === 'https://decoration.ams.v6.pressero.com') {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  // ou alors pour dév tu peux mettre res.setHeader('Access-Control-Allow-Origin', '*');
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
  setCors(req, res);
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
  const url     = new URL(req.url, `http://${req.headers.host}`);
  const distKey = url.searchParams.get('distKey');
  if (!distKey) {
    res.writeHead(400, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ error:'distKey manquant' }));
  }

  // 1) récupérer le JSON stocké
  const raw = await redis.get(`dist:${distKey}`);
  if (!raw) {
    res.writeHead(404, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ error:'Unknown distKey' }));
  }

  // 2) reconstituer la liste
  let stored = JSON.parse(raw);
  let distributionList = Array.isArray(stored)
    ? stored
    : (Array.isArray(stored.distributionList)
        ? stored.distributionList
        : []);

  // 3) totaux de poids/qty (fournis en query ou retombée sur la liste)
  const urlTW = parseFloat(url.searchParams.get('tw') || '0');
  const urlTQ = parseInt  (url.searchParams.get('tq') || '0', 10);
  const totalQty    = urlTQ    || distributionList.reduce((s,l)=>s+l.qty, 0);
  const totalWeight = urlTW    || 0;
  const unitWeight  = totalQty ? totalWeight/totalQty : 0;

  // 4) calcul du tarif pour chaque adresse
  const carrier   = 'DHL';
  const prefixLen = 2;
  let totalCost   = 0;

  // on se base sur le premier élément de packagesinfo (dimensions, etc.)
  // si besoin d’y glisser les BoxLength/Height/Depth, il faut l’injecter dans stored
  const template = {}; 

  const packages = distributionList.map(({ address, qty }) => {
    const weight = +(unitWeight * qty).toFixed(3);
    const postal = extractPostal(address);
    const prefix = postal.slice(0, prefixLen);
    const rate   = findRate(carrier, prefix, weight);
    totalCost   += rate;

    return {
      Package: {
        ID:            null,
        // BoxLength: template.boxlength, // si dispo
        // BoxHeight: template.boxheight,
        // BoxDepth:  template.boxdepth,
        From:          template.from    || {},
        To:            { Postal: postal },
        Weight:        weight.toFixed(3),
        WeightUnit:    1,
        PackageCost:   rate.toFixed(2),
        TotalOrderCost:rate.toFixed(2),
        CurrencyCode:  'EUR',
        Items:         template.items   || []
      },
      CanShip:       true,
      Messages:      [],
      Cost:          rate,
      DaysToDeliver: template.daystodeliver || 0,
      MISID:         null
    };
  });

  // 5) réponse finale
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({
    Carrier:     carrier,
    ServiceCode: 'External',
    TotalCost:   parseFloat(totalCost.toFixed(2)),
    Messages:    [],
    Packages:    packages
  }));
}
  /* —— POST /webhook —————————  */
if (req.method === 'POST' && req.url === '/webhook') {
  try {
    const body = await parseJSON(req);

    // → 1) récupérer liste + totaux
    let list = [], totalQty = 0, totalWeight = 0;
    if (body.distKey) {
      const raw = await redis.get(`dist:${body.distKey}`);
      if (raw) {
        const stored     = JSON.parse(raw);
        list              = stored.distributionList  || [];
        totalQty          = stored.totalQty          || 0;
        totalWeight       = stored.totalWeight       || 0;
      }
    }

    // → 2) fallback si pas de liste
    if (!list.length && Array.isArray(body.packagesinfo)) {
      totalWeight = parseFloat(body.hdnTotalWeight || body.packagesinfo[0].weight || 0);
      totalQty    = parseInt(body.hdnTotalQty    || '1', 10);
      list = [{ address: body.packagesinfo[0].to, qty: totalQty }];
    }

    // → 3) calcul unitaire et total
    const unitW = totalQty ? totalWeight / totalQty : 0;
    const carrier = 'DHL', prefixLen = 2;
    let totalCost = 0;
    const packages = list.map(({address,qty}) => {
      const w      = +(unitW * qty).toFixed(3);
      const postal = extractPostal(address);
      const prefix = postal.slice(0, prefixLen);
      const rate   = findRate(carrier, prefix, w);
      totalCost   += rate;
      return {
        Package:{
          ID: null,
          From: body.packagesinfo[0]?.from || {},
          To:   {Postal:postal},
          Weight: w.toFixed(3),
          WeightUnit:1,
          PackageCost: rate.toFixed(2),
          TotalOrderCost: rate.toFixed(2),
          CurrencyCode:'EUR',
          Items:[]
        },
        CanShip:true,
        Messages:[],
        Cost: rate,
        DaysToDeliver:2,
        MISID:null
      };
    });

    // → 4) on renvoie **un tableau** d’une seule méthode
    const method = {
      ServiceName:  'Livraison multi-adresses',
      ServiceCode:  'External',
      Carrier:      carrier,
      TotalCost:    parseFloat(totalCost.toFixed(2)),
      Messages:     [],
      Packages:     packages
    };

    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify([ method ]));

  } catch (e) {
    console.error('❌ Erreur webhook:', e);
    res.writeHead(500, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({error:e.message}));
  }
}


  /* —— 404 Fallback —————————————————————————— */
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

/* ───────────── 5. Démarrage ───────────── */
server.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));

