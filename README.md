# Backend

## Live Rooms

Dataset viewer supports temporary, account-free collaborative review at `/live/<room-id>#<room-key>`. Up to eight equal editors can collaborate for 24 hours, then room files expire. Exports include edited labelmap, annotations, notes, chat, event history, and report without changing canonical dataset files.

Deployment and local service instructions: [`flask-server/deploy/LIVE_ROOMS.md`](flask-server/deploy/LIVE_ROOMS.md).

#### Create Conda Environment
```
conda create -n PanTS_backend python=3.11
conda activate PanTS_backend
```

#### Set up environment backend
```
cd flask-server
touch .env  # creates the .env file
nano .env
```

Inside .env file (see `flask-server/.env.example` for the full list):
```
BASE_PATH=/

PANTS_PATH=/folder/where/PanTS

USE_SSL=false
```

Password reset emails (`/api/auth/forgot-password`) go out over SMTP:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=bodymaps.official@gmail.com
SMTP_PASSWORD=<16-character Gmail App Password>
PUBLIC_BASE_URL=https://bodymaps.wse.jhu.edu
```

**`SMTP_PASSWORD` must be a Gmail App Password, not the account password** —
Google stopped accepting account passwords for SMTP, and the failure shows up as
`SMTPAuthenticationError` when someone tries to reset. Generate one at Google
Account > Security > 2-Step Verification > App passwords. `PUBLIC_BASE_URL` is
what the emailed link points at, so it must be the address users actually visit.

Leave `SMTP_USER`/`SMTP_PASSWORD` unset and the flow still works end to end: the
message, reset link and all, is printed to the server log instead of being sent.
That is the intended local-dev path — no mailbox needed.

Optional dataset vars:
```
# Writable dir for precomputed PanTS low-res volumes (make_lowres.py output)
PANTS_LOWRES_PATH=/home/visitor/pants_lowres

# CancerVerse (second, CT-only dataset). Leave unset to disable it.
CANCERVERSE_PATH=/folder/where/CancerVerse
CANCERVERSE_LOWRES_PATH=/home/visitor/cancerverse_lowres
```
`CANCERVERSE_PATH` holds the `CV_########/ct.nii.gz` cases; the metadata CSV `CancerVerse_dataset_metadata.csv` sits **next to** that folder (in its parent). When set, `/api/search?dataset=cancerverse` (or `dataset=all`) searches it; CancerVerse has no masks yet, so mask endpoints return `{"masks_available": false}`.

#### Build the search/shuffle quality index

Search and shuffle can rank cases by CT file size and thumbnail display quality without
adding filesystem or vision-model work to API requests. Generate the index offline on
the host that has the dataset mounted:

```
ollama pull qwen3-vl:4b
python scripts/compute_case_quality.py \
  --out /home/visitor/data/bodymaps_case_quality.v1.json \
  --datasets all \
  --vision required \
  --overwrite
```

Then set the same path in `flask-server/.env` before starting the backend:

```
BODYMAPS_CASE_QUALITY_MANIFEST=/home/visitor/data/bodymaps_case_quality.v1.json
BODYMAPS_THUMBNAIL_VISION_MODEL=qwen3-vl:4b
```

Use `--resume` instead of `--overwrite` to reuse unchanged CT and thumbnail records.
`--vision required` fails rather than silently producing an index without vision
classification. If the manifest is unset or unavailable, ranking falls back to scan
shape and voxel-spacing metadata.

#### Install the visitor-location database

The analytics page maps where visitors come from, using MaxMind's GeoLite2
database on this server — no visitor IP is ever sent to a third party. The file
is ~60MB and not redistributable, so it is not in the repo and each deploy
fetches its own copy. Get a free licence key at
https://www.maxmind.com/en/geolite2/signup (Account > Manage License Keys), then:

```
export MAXMIND_LICENSE_KEY=<your key>
python scripts/download_geolite.py
```

It writes `flask-server/data/GeoLite2-City.mmdb` (override with `GEOIP_DB_PATH`).
Re-run it every month or two — a stale database gets quietly less accurate
rather than failing. Skip this entirely and the site works fine: locations
simply aren't recorded and the map says so.

Behind nginx, also set `TRUST_PROXY=true`. Without it every request looks like
it came from the proxy, so every visitor geolocates to the server itself.

Run backend:

```
pip install -r requirements.txt
python app.py
```

# Frontend

```
cd PanTS-Demo
touch .env
nano .env
```

Inside .env:
```
VITE_API_BASE=http://localhost:5001
```

#### Run frontend

```
npm install
npm run dev
```

# Deploying Updates to the Server
---

After pushing changes, SSH into the server and run the following.

```
ssh visitor@bdmap1.wse.jhu.edu
```

#### 1. Back up the database
Accounts, sessions and job state live in SQLite, so take a copy before any deploy that might run migrations.
```
cd /home/visitor/PanTS-Viewer/flask-server && cp *.db ~/db-backup-$(date +%F-%H%M).db 2>/dev/null && echo "backed up" || echo "no db found"
```

#### 2. Pull latest changes
Production must always deploy from `main`. Confirm the branch first, then pull.
```
cd /home/visitor/PanTS-Viewer
git fetch
git checkout main
git pull
```
If `git pull` (or the checkout) refuses because of "local changes would be overwritten," someone edited files directly on the server. Do **not** force past it. Run `git status` to see what changed, then discard each file with `git checkout -- <file>` (or ask the maintainer) before pulling again. The server should never carry local edits.

### Volume-delivery configuration (administrator required)

The viewer's large immutable CT and mask files must be streamed by nginx, not
held open by Gunicorn. Once per server (or whenever the dataset paths change),
an administrator should install the tracked nginx configuration, test it, and
reload nginx:

```
sudo cp /home/visitor/PanTS-Viewer/flask-server/deploy/nginx-bodymaps.conf /etc/nginx/sites-available/bodymaps
sudo ln -sfn /etc/nginx/sites-available/bodymaps /etc/nginx/sites-enabled/bodymaps
sudo nginx -t && sudo systemctl reload nginx
```

Then add `BODYMAPS_ACCEL_REDIRECT_ENABLED=true` to
`/home/visitor/PanTS-Viewer/flask-server/.env`. Do not enable that setting
before `nginx -t` succeeds: the application intentionally falls back to normal
Flask delivery until the private nginx locations exist. A CDN cache rule for
`/api/get-main-nifti/*` and `/api/get-segmentations/*` should also respect the
existing `Cache-Control: public, max-age=604800, immutable` response header;
that is what makes this architecture scale beyond one origin server.

#### 3. Rebuild the frontend and refresh backend dependencies
```
cd /home/visitor/PanTS-Viewer/PanTS-Demo && npm ci && npm run build
/home/visitor/.conda/envs/PanTS_backend/bin/pip install -r /home/visitor/PanTS-Viewer/flask-server/requirements.txt
```
The `pip install` is a fast no-op when nothing changed, but it is required whenever a PR adds or bumps a Python dependency — otherwise the restarted backend crashes on a missing import and the site goes empty. If `npm run build` errors out, **stop here**: nginx keeps serving the old site until a build succeeds, so fix the error before restarting the backend.

#### 4. Apply database migrations
Required whenever a PR adds an Alembic revision; a fast no-op otherwise. Skipping it after a schema change leaves the backend querying tables that do not exist.
```
cd /home/visitor/PanTS-Viewer/flask-server && /home/visitor/.conda/envs/PanTS_backend/bin/alembic upgrade head
```
This step is **mandatory** for the account-recovery release: it carries two
revisions (`password_reset_token`, and the location/device columns on
`analytics_event`). Without it, asking for a password reset returns a 500.

#### 5. Restart the backend
```
# Stop the old gunicorn process and wait for the port to free
pkill -f "gunicorn.*app:app"; sleep 2
pgrep -f "gunicorn.*app:app" && echo "still running - rerun the line above" || echo "port clear"

# Start a new gunicorn process
nohup /home/visitor/.conda/envs/PanTS_backend/bin/gunicorn \
  --worker-class gthread --workers 1 --threads 8 \
  --bind 127.0.0.1:8000 --timeout 3600 \
  --chdir /home/visitor/PanTS-Viewer/flask-server \
  app:app > /tmp/gunicorn.log 2>&1 &
echo "PID: $!"
```

The production environment must set `TRUST_PROXY=true` and `TRUST_PROXY_HOPS=2`
(campus edge proxy + nginx). Forgetting it does not crash anything, which is
exactly the problem: every request then keys rate limits on the proxy's own
address (the whole site shares one 120/min analytics bucket) and analytics
geolocates every visitor to the server. The backend prints a `[boot]` warning
to the gunicorn log when it starts without it.

#### 6. Verify the backend is running
Give it a few seconds to load, then check the backend booted, the dataset loads, and masks serve (all three must succeed).
```
sleep 8
curl http://127.0.0.1:8000/api/ping
curl -s "http://127.0.0.1:8000/api/search?limit=1" | head -c 120; echo
curl -s -o /dev/null -w "segmentations: %{http_code}\n" "http://127.0.0.1:8000/api/get-segmentations/17.nii.gz"
```
Expect `{"message":"pong"}`, a JSON object with `items`, and `segmentations: 200`. If the backend fails to boot, check the log for the traceback.

Then check sign-in is wired up.
```
curl -s http://127.0.0.1:8000/api/auth/oauth/providers
curl -sS -i https://bodymaps.wse.jhu.edu/api/auth/oauth/google | grep -i "^location:" | tr '&' '\n' | grep redirect_uri
```
Expect `{"github":true,"google":true}`, then a `redirect_uri` beginning `https%3A%2F%2Fbodymaps.wse.jhu.edu`. A `http://` scheme there means `PUBLIC_BASE_URL` is unset or stale, and every sign-in fails `redirect_uri_mismatch` — the provider matches that string exactly. Note `providers` only reports whether credentials are non-empty, so it still returns `true` for rotated-but-not-updated secrets; those surface as `invalid_client` at sign-in.

Then check password reset can actually send. This asks for a link for an
address with no account, so nothing is emailed to anyone — it answers 200 either
way, and the point is what the log says next.
```
curl -s -X POST http://127.0.0.1:8000/api/auth/forgot-password \
  -H 'Content-Type: application/json' -d '{"email":"nobody@example.com"}'
grep -i "\[mail\]" /tmp/gunicorn.log | tail -5
```
Expect `{"ok":true}` and **no** `[mail]` lines. A line saying "SMTP is not
configured" means `SMTP_USER`/`SMTP_PASSWORD` are unset and reset links are
going to the log instead of to users. "SMTP rejected the credentials" means
`SMTP_PASSWORD` is an account password rather than a Gmail App Password.

Finally, load `https://bodymaps.wse.jhu.edu/upload` in a browser and confirm a signed-out visitor can still start a run.

Logs are written to `/tmp/gunicorn.log`.
