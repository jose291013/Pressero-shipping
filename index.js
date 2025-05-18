// server/index.js
// Service Node.js pour Pressero Shipping Rates

import express from 'express';
import { createClient } from 'redis';
import rateGrid from './rateGrid.json' assert { type: 'json' };

const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL;

// Middleware
app.use(express.json());

// Redis client
const redis = createClient({ url: REDIS_URL });
redis.on('error', err => console.error('Redis error', err));
await redis.connect();

// Endpoint: persister la distribution
app.post('/save-distribution', async (req, res) => {
  const { distKey, distributionList } = req.body;
  if (!distKey || !Array.isArray(distributionList)) {
    return res.status(400).json({ error: 'distKey et distributionList requis' });
  }
  // Stocker en Redis avec TTL 2h
  await redis.set(`dist:${distKey}`, JSON.stringify(distributionList), { EX: 7200 });
  return res.json({ status: 'ok', distKey });
});

// Helper: trouver tarif pour une entrée
function findRate(carrier, prefix, weight) {
  const rules = rateGrid.filter(r => r.carrier === carrier && r.postal_prefix === prefix);
  for (const r of rules) {
    if (weight >= r.min_weight && weight <= r.max_weight) {
      return r.flat_price ?? (weight * r.price_per_kg);
    }
  }
  return null;
}

// Endpoint principal: calcul des tarifs
app.post('/webhook', async (req, res) => {
  const { distKey, packagesinfo } = req.body;
  // Récupération de la liste
  let list = [];
  if (distKey) {
    const stored = await redis.get(`dist:${distKey}`);
    if (stored) list = JSON.parse(stored);
  }
  // Si pas de list, on fallback mono adresse
  if (list.length === 0 && Array.isArray(packagesinfo)) {
    list = [{ address: packagesinfo[0].to, qty: 1 }];
  }

  // Calcul unitaire (si totalWeight et totalQty fournis, sinon fallback poids item)
  let unitWeight = null;
  if (req.body.hdnTotalWeight && req.body.hdnTotalQty) {
    unitWeight = parseFloat(req.body.hdnTotalWeight) / parseInt(req.body.hdnTotalQty, 10);
  }

  const carrier = 'DHL'; // ou dynamique
  const prefixLength = 2;
  let totalCost = 0;
  const packages = list.map(entry => {
    const qty = entry.qty;
    const addr = entry.address;
    const weight = unitWeight ? unitWeight * qty : (entry.weight || 0);
    const prefix = addr.postal.substring(0, prefixLength);
    const cost = findRate(carrier, prefix, weight) ?? 0;
    totalCost += cost;
    return {
      Package: {
        ID: null,
        From: packagesinfo?.[0]?.from || {},
        To: addr,
        Weight: weight.toFixed(3),
        WeightUnit: 1,
        PackageCost: cost.toFixed(2),
        TotalOrderCost: cost.toFixed(2),
        CurrencyCode: 'EUR',
        Items: []
      },
      CanShip: true,
      Messages: [],
      Cost: cost,
      DaysToDeliver: 2,
      MISID: null
    };
  });

  // Réponse JSON
  return res.json({
    Carrier: carrier,
    ServiceCode: 'External',
    TotalCost: parseFloat(totalCost.toFixed(2)),
    Messages: [],
    Packages: packages
  });
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));


