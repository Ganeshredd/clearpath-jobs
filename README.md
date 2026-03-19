# ClearPath OS 🛡

- 🔍 Live jobs from 130+ company career APIs (Greenhouse, Lever, Ashby, Workday, SmartRecruiters...)
- ⚡ No Competition — jobs posted < 6 hours ago
- 📋 Application pipeline (Saved → Applied → Interview → Offer)
- 🤖 AI resume generator + cover letter (Claude API)
- 💡 AI quick answer for interview questions
- 🎯 AI mock interview with scoring
- 🔗 Trackable resume links (know when recruiter opens)
- 👤 User accounts + JWT auth
- 🗄 PostgreSQL persistence
- 📡 Real-time SSE updates

## Deploy on Railway (recommended)

1. Push this repo to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Add PostgreSQL: New → Database → PostgreSQL
4. Set env vars (Variables tab):
   - `ANTHROPIC_API_KEY` — from console.anthropic.com
   - `JWT_SECRET` — any long random string
5. Done — auto-deploys on every push

## Optional: More Job Sources (add to Railway Variables)

| Variable | Source | Cost |
|---|---|---|
| `JSEARCH_KEY` | rapidapi.com/jsearch | $10/mo — adds Indeed/Glassdoor/ZipRecruiter |
| `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` | developer.adzuna.com | Free |
| `USAJOBS_KEY` + `USAJOBS_EMAIL` | developer.usajobs.gov | Free |
| `JOBSPIKR_USER` + `JOBSPIKR_PASS` | jobspikr.com | $200-500/mo — 150K+ live jobs |
| `FANTASTIC_KEY` | fantastic.jobs/api | $99/mo — 54 ATS platforms |

## Run locally

```bash
npm install
node server.js
# Open http://localhost:3001
```

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| POST | /api/auth/register | Create account |
| POST | /api/auth/login | Login |
| GET | /api/jobs | All jobs (with filters) |
| GET | /api/jobs?fresh=true | No Competition (< 6hrs) |
| GET | /api/jobs?scored=true | Scored by your profile |
| GET | /api/status | Scraper status |
| GET/POST | /api/applications | Pipeline management |
| POST | /api/resumes/generate | AI resume generation |
| GET | /api/track/:token | Trackable resume link |
| POST | /api/ai/answer | AI interview answer |
| POST | /api/ai/interview | AI mock interview |
| GET | /api/apply/stream | SSE real-time updates |
