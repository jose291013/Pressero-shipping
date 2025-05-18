// index.js
import express from 'express';
import { createClient } from 'redis';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL;

// Middleware pour JSON
app.use(express.json());

// Connexion Redis
const redis = createClient({ url: REDIS_URL });
redis.on('error', err => console.error('Redis error', err));
await redis.connect();

// Chargement de la grille tarifaire
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const gridPath = path.join(__dirname, 'rateGrid.json');
let rateGrid = [];
try {
  const raw = fs.readFileSync(gridPath, 'utf8');
  rateGrid = JSON.parse(raw);
  console.log(`Loaded rateGrid with ${rateGrid.length} entries`);
} catch (err) {
  console.error('Erreur chargement rateGrid.json', err);
  process.exit(1);
}

// Utilitaire pour trouver un tarif
function findRate(carrier, prefix, weight) {
  const rules = rateGrid.filter(r => r.carrier === carrier && (!r.postal_prefix || prefix.startsWith(r.postal_prefix)));
  for (const r of rules) {
    if (weight >= r.min_weight && weight <= r.max_weight) {
      const result = r.flat_price != null ? r.flat_price : (weight * (r.price_per_kg || 0));
      console.log(`Matched rate: prefix=${prefix}, weight=${weight.toFixed(3)}, price=${result}`);
      return result;
    }
  }
  console.warn(`No rate found for prefix=${prefix}, weight=${weight.toFixed(3)}`);
  return 0;
}

// Extrait le code postal d'une chaîne ou objet
function extractPostal(addr) {
  let postal = '';
  if (typeof addr === 'string') {
    const m = addr.match(/\b(\d{5})\b/);
    postal = m ? m[1] : '';
  } else if (addr && addr.postal) {
    postal = addr.postal;
  }
  console.log(`Extracted postal: ${postal}`);
  return postal;
}

// Persister la liste de distribution
app.post('/save-distribution', async (req, res) => {
  const { distKey, distributionList } = req.body;
  console.log('save-distribution body:', JSON.stringify(req.body));
  if (!distKey || !Array.isArray(distributionList)) {
    return res.status(400).json({ error: 'distKey et distributionList requis' });
  }
  await redis.set(`dist:${distKey}`, JSON.stringify(distributionList), { EX: 7200 });
  console.log(`Persisted list for distKey=${distKey}, count=${distributionList.length}`);
  res.json({ status: 'ok', distKey });
});

// Webhook calcul tarifaire
app.post('/webhook', async (req, res) => {
  console.log('Webhook request body:', JSON.stringify(req.body));
  const { distKey, packagesinfo } = req.body;

  // Récupération de la liste
  let list = [];
  if (distKey) {
    const stored = await redis.get(`dist:${distKey}`);
    console.log(`Retrieved stored list for ${distKey}:`, stored);
    if (stored) list = JSON.parse(stored);
  }
  // Fallback mono-adresse
  if (!list.length && Array.isArray(packagesinfo)) {
    list = [{ address: packagesinfo[0].to, qty: 1 }];
    console.log('Fallback to mono-address list:', list);
  }

  // Poids unitaire
  let unitWeight = null;
  if (req.body.hdnTotalWeight && req.body.hdnTotalQty) {
    unitWeight = parseFloat(req.body.hdnTotalWeight) / parseInt(req.body.hdnTotalQty, 10);
    console.log(`Computed unitWeight: ${unitWeight}`);
  }

  const carrier = 'DHL';
  const prefixLen = 2;
  let totalCost = 0;
  const packages = [];

  for (const entry of list) {
    const qty = entry.qty;
    const rawAddr = entry.address;
    const postal = extractPostal(rawAddr);
    const weight = unitWeight ? unitWeight * qty : 0;
    console.log(`Processing entry: qty=${qty}, weight=${weight.toFixed(3)}, postal=${postal}`);
    const prefix = postal.slice(0, prefixLen);
    const cost = findRate(carrier, prefix, weight);
    totalCost += cost;

    packages.push({
      Package: {
        ID: null,
        From: packagesinfo?.[0]?.from || {},
        To: { Postal: postal },
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
    });
  }

  console.log(`Total cost for all packages: ${totalCost.toFixed(2)}`);
  res.json({
    Carrier: 'DHL',
    ServiceCode: 'External',
    TotalCost: parseFloat(totalCost.toFixed(2)),
    Messages: [],
    Packages: packages
  });
});

// Health check
app.get('/', (_, res) => res.send('Service shipping opérationnel'));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));


