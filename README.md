# Cider Log

A small web app for tracking one-gallon cider batches: start, bottling, and tasting ratings.

## What it tracks

- **Start:** batch name, start date, apple juice, yeast, other ingredients (with amounts), notes
- **Bottling:** date bottled, what you added at bottling (with amounts), notes
- **Ratings:** one or more dated ratings (1 to 5) with tasting notes, so you can see how a batch ages

Juice, yeast, and ingredient fields suggest entries you have used before.

## Deploy to Railway

1. Put these files in a GitHub repository. `package.json` and `server.js` must sit at the top level of the repo, not inside a subfolder.
2. In Railway, choose **New Project > Deploy from GitHub repo** and pick the repository.
3. In the same project, choose **New > Database > Add PostgreSQL**.
4. Open the app service, go to **Variables**, and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Railway offers this as a reference variable)
   - `APP_PASSWORD` = a password of your choice (optional, but recommended; see below)
5. Go to **Settings > Networking** and click **Generate Domain**.

The app creates its tables automatically on first start. Railway detects Node and runs `npm start`.

### Password protection

The app has no user accounts. If you set `APP_PASSWORD`, your browser asks for a login before showing
anything. Type any username and that password. Without it, anyone who finds the URL can view and edit your log.

## Troubleshooting

Open the app service in Railway and check **Deployments > View logs**. The app explains most problems there and on screen.

- **"The database is not connected"**: add the `DATABASE_URL` variable with the value `${{Postgres.DATABASE_URL}}`, then redeploy.
- **"Cannot reach the database"**: confirm the Postgres service shows as running in the same project. The app retries on its own every few seconds.
- **Build fails with "no start command" or "could not determine how to build"**: `package.json` is inside a subfolder. Move the files to the top of the repo, or set **Settings > Root Directory** to that folder.
- **"Application failed to respond"**: under **Settings > Networking**, delete the domain and generate it again without typing a port, so Railway uses the port it assigns.
- Visit `/health` on your domain. It shows `ok` when everything is connected.

## Run locally (optional)

Requires Node 18+ and a Postgres database.

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/cider npm start
```

Then open http://localhost:3000.

If you connect to a remote Postgres that requires SSL, also set `PGSSL=true`.

## Files

- `server.js` - Express server, API routes, database setup
- `public/index.html`, `public/styles.css`, `public/app.js` - the interface
