import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware pour parser le JSON
app.use(express.json());

// Endpoint POST /webhook qui renvoie en réponse le même JSON
app.post('/webhook', (req, res) => {
  console.log('Reçu:', JSON.stringify(req.body, null, 2));
  res.json({
    receivedAt: new Date().toISOString(),
    payload: req.body
  });
});

app.get('/', (_, res) => res.send('Service d\'écho JSON opérationnel'));

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
