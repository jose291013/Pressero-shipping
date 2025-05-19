// index.cjs
// Serveur HTTP natif sans Express pour éviter les erreurs path-to-regexp

// Supprimer DEBUG_URL si présent
delete process.env.DEBUG;
delete process.env.DEBUG_URL;

typeof require === 'function';
const http = require('http');
const { createClient } = require('redis');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL;

// Initialisation Redis
const redis = createClient({ url: REDIS_URL });
redis.on('error', err => console.error('Redis error', err));
redis.connect().then(() => console.log('Connected to Redis')).catch(console.error);

// Charger rateGrid.json
const gridData = fs.readFileSync(path.join(__dirname, 'rateGrid.json'), 'utf8');
const rateGrid = JSON.parse(gridData);
console.log(`Loaded rateGrid with ${rateGrid.length} entries`);

// Helper: find rate
function findRate(carrier, prefix, weight) {
  // Si pas de préfixe, on ne garde que les règles sans postal_prefix
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
  console.warn(`Aucun tarif pour carrier=${carrier}, poids=${weight}`);
  return 0;
}



// Extract postal code
function extractPostal(addr) {
  if (typeof addr === 'string') {
    const m = addr.match(/\b(\d{5})\b/);
    return m ? m[1] : '';
  }
  return addr?.postal || '';
}

// CORS headers
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://decoration.ams.v6.pressero.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// Read JSON body
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

// Server
const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('Service shipping opérationnel');
  }

  if (req.method === 'POST' && req.url === '/save-distribution') {
    try {
      const { distKey, distributionList } = await parseJSON(req);
      console.log('save-distribution body:', distributionList.length);
      if (!distKey || !Array.isArray(distributionList)) throw new Error('Invalid payload');
      await redis.set(`dist:${distKey}`, JSON.stringify(distributionList), { EX: 7200 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', distKey }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    try {
      const body = await parseJSON(req);
      console.log('Webhook body:', body);
      let list = [];
      if (body.distKey) {
        const stored = await redis.get(`dist:${body.distKey}`);
        list = stored ? JSON.parse(stored) : [];
      }
      if (!list.length && Array.isArray(body.packagesinfo)) {
        list = [{ address: body.packagesinfo[0].to, qty: 1 }];
      }
      let unitWeight = null;
      if (body.hdnTotalWeight && body.hdnTotalQty) {
        unitWeight = parseFloat(body.hdnTotalWeight) / parseInt(body.hdnTotalQty, 10);
      }
      const carrier = 'DHL';
      const prefixLen = 2;
      let totalCost = 0;
const breakdown = [];

const packages = list.map(entry => {
  const qty    = entry.qty;
  const weight = unitWeight ? unitWeight * qty : 0;
  const postal = extractPostal(entry.address);
  const prefix = postal.slice(0, prefixLen);

  const rate = findRate(carrier, prefix, weight);
  breakdown.push({
    address:   entry.address,
    qty,
    weight:    weight.toFixed(3),
    unitPrice: rate.toFixed(2),
    lineCost:  (rate).toFixed(2)
  });
  totalCost += rate;

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
      Items:           []
    },
    CanShip:       true,
    Messages:      [],
    Cost:          rate,
    DaysToDeliver: 2,
    MISID:         null
  };
});

console.log('💡 Breakdown par adresse :', breakdown);
console.log(`Total général : ${totalCost.toFixed(2)} EUR`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ Carrier: carrier, ServiceCode: 'External', TotalCost: parseFloat(totalCost.toFixed(2)), Messages: [], Packages: packages }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
