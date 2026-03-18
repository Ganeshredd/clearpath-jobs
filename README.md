# ClearPath Jobs 🛡

**Live cybersecurity jobs board** — 535+ company career pages scraped every 5 minutes.

- ✕ Zero clearance-required jobs (26-keyword permanent filter)
- 🌐 H1B sponsorship data on every card
- 📊 Real-time apply counts (SSE live updates)
- 📄 Built-in Resume Optimizer
- 🔄 Auto-refresh every 5 minutes

## Deploy in 2 minutes (Railway — free)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select this repo → Deploy
4. Done — you get a live URL like `https://clearpath-jobs.up.railway.app`

## Deploy on Render (free)

1. Push to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect repo → Build: `npm install` → Start: `node server.js`
4. Done

## Run locally

```bash
npm install
node server.js
# Open http://localhost:3001
```

## Optional: Add job board API keys

Copy `.env.example` to `.env` and fill in:
```
JSEARCH_KEY=your_rapidapi_key    # $10/mo — adds Indeed/Glassdoor/ZipRecruiter
ADZUNA_APP_ID=your_id            # Free
ADZUNA_APP_KEY=your_key
```

## Live API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/jobs` | All scraped jobs with filters |
| `GET /api/status` | Scraper status |
| `POST /api/apply/:jobId` | Record an apply click |
| `GET /api/apply/stream` | SSE live apply counts |
| `GET /api/apply/admin` | Admin dashboard |
