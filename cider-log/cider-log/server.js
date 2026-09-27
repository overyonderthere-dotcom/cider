const express = require('express');
const path = require('path');
const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings so no timezone shifting happens.
types.setTypeParser(1082, (v) => v);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add a Postgres database and link its DATABASE_URL.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const app = express();
app.use(express.json({ limit: '200kb' }));

// Health check stays open so Railway can monitor the service.
app.get('/health', (req, res) => res.send('ok'));

// Optional password protection: set APP_PASSWORD to require it (any username works).
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const password = decoded.slice(decoded.indexOf(':') + 1);
      if (password === process.env.APP_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Cider Log"');
    res.status(401).send('Password required');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const items = (v) =>
  Array.isArray(v)
    ? v
        .map((i) => ({ name: str(i && i.name, 200), amount: str(i && i.amount, 100) }))
        .filter((i) => i.name)
        .slice(0, 50)
    : [];

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
  });

function readStartFields(body) {
  const f = {
    name: str(body.name, 200),
    start_date: body.start_date,
    juice: str(body.juice, 200),
    yeast: str(body.yeast, 200),
    ingredients: items(body.ingredients),
    start_notes: str(body.start_notes),
  };
  if (!isDate(f.start_date)) return { error: 'Choose a start date.' };
  if (!f.juice) return { error: 'Enter the apple juice you used.' };
  if (!f.yeast) return { error: 'Enter the yeast you used.' };
  return { f };
}

// ---------- routes ----------
app.get('/api/batches', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT b.*,
           COALESCE(r.cnt, 0)::int AS rating_count,
           r.avg_score,
           r.latest_date
      FROM batches b
      LEFT JOIN LATERAL (
        SELECT count(*) AS cnt,
               round(avg(score)::numeric, 1)::float AS avg_score,
               max(rating_date) AS latest_date
          FROM ratings WHERE batch_id = b.id
      ) r ON true
     ORDER BY b.start_date DESC, b.id DESC`);
  res.json(rows);
}));

app.get('/api/batches/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await pool.query('SELECT * FROM batches WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'That batch no longer exists.' });
  const ratings = await pool.query(
    'SELECT * FROM ratings WHERE batch_id = $1 ORDER BY rating_date DESC, id DESC', [id]);
  res.json({ ...rows[0], ratings: ratings.rows });
}));

app.post('/api/batches', wrap(async (req, res) => {
  const { f, error } = readStartFields(req.body || {});
  if (error) return res.status(400).json({ error });
  const { rows } = await pool.query(
    `INSERT INTO batches (name, start_date, juice, yeast, ingredients, start_notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [f.name, f.start_date, f.juice, f.yeast, JSON.stringify(f.ingredients), f.start_notes]);
  res.status(201).json(rows[0]);
}));

app.put('/api/batches/:id', wrap(async (req, res) => {
  const { f, error } = readStartFields(req.body || {});
  if (error) return res.status(400).json({ error });
  const { rows } = await pool.query(
    `UPDATE batches SET name=$1, start_date=$2, juice=$3, yeast=$4, ingredients=$5, start_notes=$6
      WHERE id=$7 RETURNING *`,
    [f.name, f.start_date, f.juice, f.yeast, JSON.stringify(f.ingredients), f.start_notes,
     parseInt(req.params.id, 10)]);
  if (!rows.length) return res.status(404).json({ error: 'That batch no longer exists.' });
  res.json(rows[0]);
}));

app.put('/api/batches/:id/bottling', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isDate(b.bottled_date)) return res.status(400).json({ error: 'Choose a bottling date.' });
  const { rows } = await pool.query(
    `UPDATE batches SET bottled_date=$1, bottling_additions=$2, bottling_notes=$3
      WHERE id=$4 RETURNING *`,
    [b.bottled_date, JSON.stringify(items(b.bottling_additions)), str(b.bottling_notes),
     parseInt(req.params.id, 10)]);
  if (!rows.length) return res.status(404).json({ error: 'That batch no longer exists.' });
  res.json(rows[0]);
}));

app.delete('/api/batches/:id/bottling', wrap(async (req, res) => {
  await pool.query(
    `UPDATE batches SET bottled_date=NULL, bottling_additions='[]', bottling_notes=''
      WHERE id=$1`, [parseInt(req.params.id, 10)]);
  res.status(204).end();
}));

app.delete('/api/batches/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM batches WHERE id = $1', [parseInt(req.params.id, 10)]);
  res.status(204).end();
}));

app.post('/api/batches/:id/ratings', wrap(async (req, res) => {
  const b = req.body || {};
  const score = parseInt(b.score, 10);
  if (!isDate(b.rating_date)) return res.status(400).json({ error: 'Choose a rating date.' });
  if (!(score >= 1 && score <= 5)) return res.status(400).json({ error: 'Pick a score from 1 to 5.' });
  const { rows } = await pool.query(
    `INSERT INTO ratings (batch_id, rating_date, score, notes)
     SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM batches WHERE id = $1)
     RETURNING *`,
    [parseInt(req.params.id, 10), b.rating_date, score, str(b.notes)]);
  if (!rows.length) return res.status(404).json({ error: 'That batch no longer exists.' });
  res.status(201).json(rows[0]);
}));

app.delete('/api/ratings/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM ratings WHERE id = $1', [parseInt(req.params.id, 10)]);
  res.status(204).end();
}));

// Past entries power the autocomplete lists in the forms.
app.get('/api/suggestions', wrap(async (req, res) => {
  const q = async (sql) => (await pool.query(sql)).rows.map((r) => r.v);
  const [juices, yeasts, ingredients, additions] = await Promise.all([
    q(`SELECT DISTINCT juice AS v FROM batches WHERE juice <> '' ORDER BY 1`),
    q(`SELECT DISTINCT yeast AS v FROM batches WHERE yeast <> '' ORDER BY 1`),
    q(`SELECT DISTINCT i->>'name' AS v FROM batches, jsonb_array_elements(ingredients) i ORDER BY 1`),
    q(`SELECT DISTINCT i->>'name' AS v FROM batches, jsonb_array_elements(bottling_additions) i ORDER BY 1`),
  ]);
  res.json({ juices, yeasts, ingredients, additions });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------- startup ----------
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS batches (
      id                 SERIAL PRIMARY KEY,
      name               TEXT NOT NULL DEFAULT '',
      start_date         DATE NOT NULL,
      juice              TEXT NOT NULL DEFAULT '',
      yeast              TEXT NOT NULL DEFAULT '',
      ingredients        JSONB NOT NULL DEFAULT '[]',
      start_notes        TEXT NOT NULL DEFAULT '',
      bottled_date       DATE,
      bottling_additions JSONB NOT NULL DEFAULT '[]',
      bottling_notes     TEXT NOT NULL DEFAULT '',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ratings (
      id          SERIAL PRIMARY KEY,
      batch_id    INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      rating_date DATE NOT NULL,
      score       INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
      notes       TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ratings_batch_idx ON ratings(batch_id);
  `);
}

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log(`Cider Log running on port ${PORT}`)))
  .catch((err) => {
    console.error('Could not connect to the database:', err.message);
    process.exit(1);
  });
