const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings so no timezone shifting happens.
types.setTypeParser(1082, (v) => v);

const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || '';

// Railway's private network (*.railway.internal) and localhost do not use SSL.
// Public database URLs do, so turn it on automatically for those.
function sslSetting(url) {
  if (process.env.PGSSL === 'true') return { rejectUnauthorized: false };
  if (process.env.PGSSL === 'false') return false;
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal')) return false;
    return { rejectUnauthorized: false };
  } catch {
    return false;
  }
}

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: sslSetting(DATABASE_URL), connectionTimeoutMillis: 10000 })
  : null;
if (pool) pool.on('error', (err) => console.error('Database connection error:', err.message));

let dbReady = false;
let dbProblem = DATABASE_URL
  ? 'The app is still connecting to the database. Refresh in a few seconds.'
  : 'The database is not connected. In Railway, open this service, go to Variables, and add DATABASE_URL with the value ${{Postgres.DATABASE_URL}}.';

const app = express();
app.use(express.json({ limit: '200kb' }));

// Health check stays open so Railway can monitor the service.
app.get('/health', (req, res) => res.send(dbReady ? 'ok' : 'starting: ' + dbProblem));

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

// Find the page files. They normally live in /public, but if they were uploaded
// to the top of the repo instead, serve them from there.
const PAGE_FILES = ['index.html', 'app.js', 'styles.css'];
const pageDir = [path.join(__dirname, 'public'), __dirname]
  .find((dir) => fs.existsSync(path.join(dir, 'index.html')));
if (pageDir) {
  console.log(`Serving pages from ${pageDir}`);
  // When serving from the repo root, expose only the page files, never server code or settings.
  if (pageDir === __dirname) {
    app.use((req, res, next) => {
      const ok = req.path === '/' || PAGE_FILES.includes(req.path.slice(1))
        || req.path.startsWith('/api') || req.path === '/health';
      return ok ? next() : res.status(404).send('Not found');
    });
  }
  app.use(express.static(pageDir, { index: 'index.html', dotfiles: 'deny' }));
} else {
  const missing = PAGE_FILES.map((f) => `public/${f}`).join(', ');
  console.error(`Page files not found. Add these to your repo: ${missing}`);
  app.get('/', (req, res) => res.status(500).send(
    `<p style="font-family:sans-serif;max-width:40em;margin:3em auto">The server is running, but the page files are missing.
     Add a folder named <b>public</b> to your GitHub repo containing <b>index.html</b>, <b>app.js</b> and <b>styles.css</b>, then redeploy.</p>`));
}

// Until the database is ready, API calls return a clear explanation instead of crashing.
app.use('/api', (req, res, next) => {
  if (dbReady) return next();
  res.status(503).json({ error: dbProblem });
});

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

// Start the web server first so Railway sees a running app, then connect to the database.
app.listen(PORT, '0.0.0.0', () => console.log(`Cider Log listening on port ${PORT}`));

async function connectWithRetry(attempt = 1) {
  if (!pool) {
    console.error(dbProblem);
    return;
  }
  try {
    await init();
    dbReady = true;
    console.log('Database connected and ready.');
  } catch (err) {
    console.error(`Database connection attempt ${attempt} failed: ${err.message}`);
    dbProblem = `The app cannot reach the database (${err.message}). Check that the Postgres service is running and that DATABASE_URL is set to \${{Postgres.DATABASE_URL}}.`;
    setTimeout(() => connectWithRetry(attempt + 1), Math.min(30000, attempt * 3000));
  }
}
connectWithRetry();

process.on('unhandledRejection', (err) => console.error('Unhandled error:', err));
