import express from 'express';
// … tes autres imports (Ajv, Redis, etc.) si tu en as

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// === Handler de test pour le webhook ===
app.post('/webhook', (req, res) => {
  console.log('Reçu:', JSON.stringify(req.body, null, 2));

  // On garde ServiceCode sur "External" mais on renomme Carrier
  res.json({
    Carrier:      "DHL test",   // c'est ce qu’on verra dans l’UI
    ServiceCode:  "External",   // doit rester External pour matcher
    TotalCost:    9.99,
    Messages:     [],
    Packages: [
      {
        Package: {
          ID:             null,
          BoxLength:      req.body.packagesinfo?.[0]?.boxlength   || 0,
          BoxHeight:      req.body.packagesinfo?.[0]?.boxheight   || 0,
          BoxDepth:       req.body.packagesinfo?.[0]?.boxdepth    || 0,
          BoxDiameter:    0,
          From:           req.body.packagesinfo?.[0]?.from        || {},
          To:             req.body.packagesinfo?.[0]?.to          || {},
          Weight:         (req.body.packagesinfo?.[0]?.weight || 0).toString(),
          WeightUnit:     req.body.packagesinfo?.[0]?.weightunit  || 1,
          PackageCost:    "9.99",
          TotalOrderCost: "9.99",
          CurrencyCode:   req.body.packagesinfo?.[0]?.currencycode || "EUR",
          Items:          []
        },
        CanShip:       true,
        Messages:      [],
        Cost:          9.99,
        DaysToDeliver: 1,
        MISID:         null
      }
    ]
  });
});


// Tu peux laisser le GET pour valider que le service est bien live
app.get('/', (_, res) =>
  res.send("Service d'écho et test de tarif opérationnel")
);

app.listen(PORT, () =>
  console.log(`Listening on port ${PORT}`)
);

