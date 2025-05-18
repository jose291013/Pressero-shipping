// convertRateGrid.js
import xlsx from 'xlsx';
import fs from 'fs';

// Extraction des utilitaires depuis le module commun
const { decode_range, encode_cell } = xlsx.utils;

// 1. Lecture du classeur et de la première feuille
const workbook = xlsx.readFile('rateGrid.xlsx');
const sheet    = workbook.Sheets[workbook.SheetNames[0]];

// 2. Détection de la plage utilisée dans la feuille
const sheetRef = sheet['!ref'];
const range    = decode_range(sheetRef);

// 3. Lecture des limites de poids à la ligne 1 (indice 0), colonnes B jusqu'à la dernière
const weightLimits = [];
for (let col = range.s.c + 1; col <= range.e.c; col++) {
  const addr = encode_cell({ r: 0, c: col });
  const cell = sheet[addr];
  if (cell && cell.v !== undefined && cell.v !== '') {
    const limit = parseFloat(cell.v);
    if (!isNaN(limit)) weightLimits.push(limit);
  }
}

// 4. Lecture des prix à la ligne 9 (indice 8), mêmes colonnes
const prices = [];
for (let col = range.s.c + 1; col <= range.e.c; col++) {
  const addr = encode_cell({ r: 8, c: col });
  const cell = sheet[addr];
  if (cell && cell.v !== undefined && cell.v !== '') {
    const price = parseFloat(cell.v);
    if (!isNaN(price)) prices.push(price);
  }
}

// 5. Construction de la grille tarifaire
const rateGrid = [];
let previousLimit = 0;
for (let i = 0; i < weightLimits.length; i++) {
  rateGrid.push({
    carrier:       'DHL',             // Modifier si nécessaire
    postal_prefix: '',                // À compléter manuellement ou en automatisant
    min_weight:    previousLimit,
    max_weight:    weightLimits[i],
    flat_price:    prices[i] || 0,
    price_per_kg:  null
  });
  previousLimit = weightLimits[i] + 0.0001;
}

// 6. Écriture du fichier JSON final
fs.writeFileSync(
  'rateGrid.json',
  JSON.stringify(rateGrid, null, 2),
  'utf8'
);
console.log(`✅ rateGrid.json généré avec ${rateGrid.length} tranches`);

