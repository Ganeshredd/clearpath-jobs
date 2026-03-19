/**
 * ClearPath OS — Backend Server v3
 * ─────────────────────────────────────────────────────────────────────────
 * Dynamic Tangent-style architecture:
 *   ✓ PostgreSQL persistence (jobs survive restarts)
 *   ✓ User accounts + JWT auth
 *   ✓ Per-candidate job matching & scoring
 *   ✓ Application pipeline (Saved→Applied→Screen→Interview→Offer)
 *   ✓ AI resume generation via Claude API (server-side, key never exposed)
 *   ✓ Trackable resume links (know when recruiter opens)
 *   ✓ Real-time SSE (apply counts + resume view alerts)
 *   ✓ Morning Feed (curated daily jobs scored per user)
 *   ✓ No Competition jobs (< 6 hours old)
 *   ✓ AI Quick Answer + AI Mock Interview
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const cron     = require('node-cron');
const axios    = require('axios');
const cheerio  = require('cheerio');
const path     = require('path');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { runJobBoards } = require('./job-boards');

const app  = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'clearpath-os-dev-secret';
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── DB SETUP ─────────────────────────────────────────────────────────────
let db = null;
let dbAvailable = false;

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn('[DB] No DATABASE_URL — running in memory-only mode');
    return;
  }
  try {
    const { Pool } = require('pg');
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 10
    });
    await db.query('SELECT 1');
    dbAvailable = true;
    console.log('[DB] PostgreSQL connected ✓');
    await runMigrations();
    await loadJobsFromDb();
  } catch(e) {
    console.warn('[DB] PostgreSQL unavailable:', e.message);
    dbAvailable = false;
  }
}

async function runMigrations() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      name TEXT, title TEXT, yoe INTEGER, skills TEXT,
      summary TEXT, visa TEXT DEFAULT 'citizen',
      target_roles TEXT, min_salary INTEGER, work_pref TEXT DEFAULT 'any',
      linkedin TEXT, phone TEXT, location TEXT, resume_text TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, company TEXT NOT NULL,
      location TEXT, type TEXT DEFAULT 'Full-time', level TEXT DEFAULT 'mid',
      salary_min INTEGER, salary_max INTEGER, desc TEXT, tags TEXT[],
      apply_url TEXT, posted_at TIMESTAMPTZ, posted_ago TEXT, source TEXT,
      remote BOOLEAN DEFAULT FALSE, h1b_sponsor BOOLEAN DEFAULT FALSE,
      is_new BOOLEAN DEFAULT TRUE,
      first_seen TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS applications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      job_id TEXT, title TEXT NOT NULL, company TEXT NOT NULL,
      apply_url TEXT, stage TEXT DEFAULT 'saved', notes TEXT,
      salary_offered INTEGER, applied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS generated_resumes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      job_id TEXT, job_title TEXT, company TEXT,
      content TEXT NOT NULL, type TEXT DEFAULT 'resume',
      track_token TEXT UNIQUE DEFAULT encode(gen_random_bytes(16),'hex'),
      view_count INTEGER DEFAULT 0, last_viewed TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS resume_views (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token TEXT NOT NULL, ip TEXT, user_agent TEXT,
      viewed_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS apply_counts (
      job_id TEXT PRIMARY KEY, count INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS jobs_posted_at ON jobs(posted_at DESC);
    CREATE INDEX IF NOT EXISTS apps_user_id ON applications(user_id);
    CREATE INDEX IF NOT EXISTS resumes_track ON generated_resumes(track_token);
  `);
  console.log('[DB] Migrations complete');
}

async function loadJobsFromDb() {
  try {
    const r = await db.query('SELECT * FROM jobs ORDER BY posted_at DESC NULLS LAST LIMIT 5000');
    cache.jobs = r.rows.map(dbRowToJob);
    console.log(`[DB] Loaded ${cache.jobs.length} jobs from database`);
  } catch(e) { console.warn('[DB] Could not load jobs:', e.message); }
}

function dbRowToJob(row) {
  return {
    id: row.id, title: row.title, company: row.company,
    location: row.location||'United States', type: row.type||'Full-time',
    level: row.level||'mid', salaryMin: row.salary_min, salaryMax: row.salary_max,
    desc: row.desc||'', tags: row.tags||[], applyUrl: row.apply_url,
    postedAt: row.posted_at, postedAgo: row.posted_ago||timeAgo(row.posted_at),
    source: row.source, remote: row.remote, h1bSponsor: row.h1b_sponsor, isNew: row.is_new
  };
}

// ─── CACHE ────────────────────────────────────────────────────────────────
let cache = {
  jobs: [], newJobIds: [], lastUpdated: null, isRunning: false,
  scrapeLog: [], stats: { total:0, clearanceBlocked:0, sources:{} }
};
let sseClients = [];

// ─── HELPERS ──────────────────────────────────────────────────────────────
const clean = s => (s||'').replace(/\s+/g,' ').replace(/[\r\n\t]/g,' ').trim();

function timeAgo(dateStr) {
  if (!dateStr) return 'Recently';
  const d = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (d < 120)   return 'just now';
  if (d < 3600)  return `${Math.floor(d/60)} minutes ago`;
  if (d < 86400) return `${Math.floor(d/3600)} hours ago`;
  return `${Math.floor(d/86400)} days ago`;
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}

const CLEARANCE_DENY = ['security clearance','clearance required','top secret','ts/sci','secret clearance','active secret','public trust','polygraph','dod clearance','classified information','q clearance','sci eligible','sensitive compartmented','national security clearance','special access program'];
const CYBER_ALLOW = ['security engineer','security analyst','security architect','security researcher','security consultant','security specialist','security operations','security manager','security director','security officer','ciso','vp of security','head of security','principal security','staff security','lead security','penetration test','pentesting','pen test','ethical hack','red team','blue team','threat intelligence','threat hunter','incident response','digital forensics','dfir','malware analyst','vulnerability','soc analyst','soc engineer','detection engineer','devsecops','appsec','application security','product security','platform security','cloud security','network security','infrastructure security','endpoint security','identity security','iam engineer','zero trust','information security','infosec','cybersecurity','cyber security','grc analyst','compliance engineer','privacy engineer','data security','container security','siem engineer'];

const isClearanceJob = t => CLEARANCE_DENY.some(k=>(t||'').toLowerCase().includes(k));
const isCyberJob = (title,desc) => CYBER_ALLOW.some(k=>((title||'')+' '+(desc||'')).toLowerCase().includes(k));

const levelOf = t => {
  if (/intern|student|co-?op/i.test(t)) return 'intern';
  if (/staff|principal|fellow|director|vp |head |ciso/i.test(t)) return 'lead';
  if (/senior|sr\b|sr\.|lead\b/i.test(t)) return 'senior';
  if (/junior|jr\b|associate|entry/i.test(t)) return 'entry';
  return 'mid';
};

const TOP_TIER = new Set(['Google','Meta','Apple','Microsoft','Amazon','Netflix','Stripe','CrowdStrike','Palo Alto Networks','SentinelOne','Wiz','Databricks','Snowflake','Cloudflare','OpenAI','Anthropic','Uber','Airbnb']);
const salaryOf = (level, company) => {
  const base = { intern:[25,45], entry:[70,95], mid:[100,135], senior:[130,175], lead:[155,220] };
  const [lo,hi] = base[level]||base.mid;
  const bump = TOP_TIER.has(company) ? 18 : 0;
  return { salaryMin: lo+bump, salaryMax: hi+bump };
};

const H1B = new Set(['Google','Microsoft','Amazon','Apple','Meta','Stripe','Salesforce','Oracle','IBM','NVIDIA','Cisco','Databricks','Snowflake','MongoDB','Elastic','GitLab','Datadog','Okta','CrowdStrike','SentinelOne','Palo Alto Networks','Wiz','Cloudflare','Zscaler','BeyondTrust','Armis Security','Dragos','BigID','Anthropic','xAI','Palantir']);

const TAG_POOL = ['SIEM','EDR','XDR','SOAR','Splunk','Elastic','CrowdStrike','SentinelOne','AWS Security','GCP Security','Azure Security','Kubernetes','Terraform','Python','Go','Rust','OWASP','Burp Suite','MITRE ATT&CK','Zero Trust','IAM','OAuth','SAML','DFIR','Forensics','Malware Analysis','Threat Intel','OSINT','Pen Testing','Red Team','Detection Engineering','Sigma','YARA','KQL','ISO 27001','SOC 2','PCI-DSS','HIPAA','DevSecOps','CSPM','CNAPP','AppSec','Cloud Security'];
const extractTags = text => TAG_POOL.filter(t=>(text||'').toLowerCase().includes(t.toLowerCase())).slice(0,7);

function scoreJobForUser(job, user) {
  if (!user) return 0;
  let score = 0;
  const jt = ((job.title||'')+' '+(job.desc||'')+' '+(job.tags||[]).join(' ')).toLowerCase();
  (user.skills||'').split(',').forEach(s => { if (s.trim() && jt.includes(s.trim().toLowerCase())) score += 10; });
  (user.target_roles||'').split(',').forEach(r => { if (r.trim() && (job.title||'').toLowerCase().includes(r.trim().toLowerCase())) score += 20; });
  if (user.min_salary && job.salaryMax >= user.min_salary) score += 5;
  if (user.work_pref === 'remote' && job.remote) score += 10;
  if (job.postedAt) {
    const hrs = (Date.now()-new Date(job.postedAt).getTime())/3600000;
    if (hrs<6) score+=30; else if (hrs<24) score+=15; else if (hrs<72) score+=5;
  }
  return score;
}

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(r => { try { r.write(msg); return true; } catch(e) { return false; } });
}

// ─── ATS SCRAPERS ─────────────────────────────────────────────────────────

async function scrapeGreenhouse(company, token) {
  const { data } = await axios.get(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`, { timeout:15000 });
  return (data.jobs||[]).map(j => ({ id:`gh-${token}-${j.id}`, title:clean(j.title), company, location:clean(j.location?.name||'United States'), type:'Full-time', desc:clean(cheerio.load(j.content||'')('body').text()).slice(0,400), applyUrl:j.absolute_url||`https://boards.greenhouse.io/${token}/jobs/${j.id}`, postedAt:j.updated_at, postedAgo:timeAgo(j.updated_at), source:'Greenhouse', remote:/remote/i.test(j.location?.name||''), tags:extractTags(j.title+' '+(j.content||'')) }));
}

async function scrapeLever(company, token) {
  const { data } = await axios.get(`https://api.lever.co/v0/postings/${token}?mode=json`, { timeout:15000 });
  return (Array.isArray(data)?data:[]).map(j => ({ id:`lv-${token}-${j.id}`, title:clean(j.text), company, location:clean(j.categories?.location||j.workplaceType||'United States'), type:clean(j.categories?.commitment||'Full-time'), desc:clean(j.descriptionPlain||'').slice(0,400), applyUrl:j.hostedUrl||`https://jobs.lever.co/${token}/${j.id}`, postedAt:j.createdAt?new Date(j.createdAt).toISOString():null, postedAgo:j.createdAt?timeAgo(new Date(j.createdAt).toISOString()):'Recently', source:'Lever', remote:/remote/i.test(j.categories?.location||j.workplaceType||''), tags:extractTags(j.text+' '+(j.descriptionPlain||'')) }));
}

async function scrapeAshby(company, token) {
  const { data } = await axios.post('https://jobs.ashbyhq.com/api/non-user-graphql', { operationName:'ApiJobBoardWithTeams', variables:{ organizationHostedJobsPageName:token }, query:`query ApiJobBoardWithTeams($organizationHostedJobsPageName:String!){jobBoard:jobBoardWithTeams(organizationHostedJobsPageName:$organizationHostedJobsPageName){jobPostings{id title locationName employmentType descriptionSocial publishedAt isRemote}}}` }, { timeout:15000 });
  return (data?.data?.jobBoard?.jobPostings||[]).map(j => ({ id:`ash-${token}-${j.id}`, title:clean(j.title), company, location:clean(j.locationName||'United States'), type:clean(j.employmentType||'Full-time'), desc:clean(j.descriptionSocial||'').slice(0,400), applyUrl:`https://jobs.ashbyhq.com/${token}/${j.id}`, postedAt:j.publishedAt, postedAgo:timeAgo(j.publishedAt), source:'Ashby', remote:j.isRemote||/remote/i.test(j.locationName||''), tags:extractTags(j.title+' '+(j.descriptionSocial||'')) }));
}

async function scrapeSmartRecruiter(company, token) {
  const { data } = await axios.get(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100&status=PUBLISHED`, { timeout:15000 });
  return (data.content||[]).map(j => ({ id:`sr-${token}-${j.id}`, title:clean(j.name), company, location:clean(j.location?.city?`${j.location.city}, ${j.location.region||j.location.country}`:'United States'), type:clean(j.typeOfEmployment?.label||'Full-time'), desc:clean(j.jobAd?.sections?.jobDescription?.text||'').slice(0,400), applyUrl:`https://jobs.smartrecruiters.com/${token}/${j.id}`, postedAt:j.releasedDate, postedAgo:timeAgo(j.releasedDate), source:'SmartRecruiters', remote:/remote/i.test(j.location?.city||''), tags:extractTags(j.name) }));
}

async function scrapeWorkday(company, tenant, ns) {
  const namespaces = [ns,'External_Career_Site','External','careers',tenant].filter((v,i,a)=>v&&a.indexOf(v)===i);
  const subdomains = [`${tenant}.wd5.myworkdayjobs.com`,`${tenant}.wd1.myworkdayjobs.com`,`${tenant}.wd3.myworkdayjobs.com`];
  const headers = { 'Content-Type':'application/json', 'Accept':'application/json', 'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept-Language':'en-US,en;q=0.9', 'Origin':`https://${tenant}.wd5.myworkdayjobs.com`, 'Referer':`https://${tenant}.wd5.myworkdayjobs.com/${ns}` };
  for (const subdomain of subdomains) {
    for (const nsUsed of namespaces) {
      try {
        const { data } = await axios.post(`https://${subdomain}/wday/cxs/${tenant}/${nsUsed}/jobs`, { limit:100, offset:0, searchText:'', appliedFacets:{} }, { headers, timeout:12000 });
        const jobs = data.jobPostings||[];
        if (jobs.length>0) return jobs.map(j => ({ id:`wd-${tenant}-${(j.externalPath||j.title||Math.random().toString(36).slice(2,8)).replace(/[^a-z0-9-]/gi,'-').slice(0,60)}`, title:clean(j.title), company, location:clean(j.locationsText||'United States'), type:'Full-time', desc:clean(j.jobDescription||'').slice(0,400), applyUrl:`https://${subdomain}/${nsUsed}/job/${j.externalPath||''}`, postedAt:j.postedOn, postedAgo:timeAgo(j.postedOn), source:'Workday', remote:/remote/i.test(j.locationsText||''), tags:extractTags(j.title+' '+(j.jobDescription||'')) }));
      } catch(e) { /* try next */ }
    }
  }
  throw new Error(`Workday failed: ${tenant}`);
}

async function scrapeWorkable(company, subdomain) {
  const { data } = await axios.post(`https://apply.workable.com/api/v3/accounts/${subdomain}/jobs`, { query:'security', location:[], department:[], worktype:[], remote:[] }, { timeout:15000, headers:{'Content-Type':'application/json'} });
  return (data.results||[]).map(j => ({ id:`wb-${subdomain}-${j.id}`, title:clean(j.title), company, location:clean(j.location?.city?`${j.location.city}, ${j.location.country}`:'United States'), type:clean(j.employment_type||'Full-time'), desc:clean(j.description||'').slice(0,400), applyUrl:`https://apply.workable.com/${subdomain}/j/${j.shortcode}`, postedAt:j.published_on, postedAgo:timeAgo(j.published_on), source:'Workable', remote:j.remote||/remote/i.test(j.location?.city||''), tags:extractTags(j.title+' '+(j.description||'')) }));
}

async function scrapeBamboohr(company, subdomain) {
  const { data } = await axios.get(`https://${subdomain}.bamboohr.com/jobs/embed2.php?version=1.0.0`, { timeout:15000 });
  const jobs = [];
  (data.result||[]).forEach(dept => (dept.positions||[]).forEach(j => jobs.push({ id:`bhr-${subdomain}-${j.id}`, title:clean(j.title), company, location:clean(j.location?.city?`${j.location.city}, ${j.location.state||''}`:'United States'), type:clean(j.employmentStatusLabel||'Full-time'), desc:clean(cheerio.load(j.jobOpeningDescription||'')('body').text()).slice(0,400), applyUrl:`https://${subdomain}.bamboohr.com/jobs/view.php?id=${j.id}`, postedAt:j.datePosted, postedAgo:timeAgo(j.datePosted), source:'BambooHR', remote:/remote/i.test(j.location?.city||''), tags:extractTags(j.title+' '+(j.jobOpeningDescription||'')) })));
  return jobs;
}

async function scrapeJobvite(company, token) {
  for (const url of [`https://jobs.jobvite.com/api/jobs?c=${token}&limit=100`,`https://jobs.jobvite.com/${token}/jobs.json`]) {
    try {
      const { data } = await axios.get(url, { timeout:10000 });
      const jobs = data.requisitions||data.jobs||(Array.isArray(data)?data:[]);
      if (jobs.length>0) return jobs.map(j => ({ id:`jv-${token}-${j.id||j.jobId}`, title:clean(j.title||j.jobTitle), company, location:clean(j.location||'United States'), type:clean(j.jobType||'Full-time'), desc:clean(cheerio.load(j.description||j.jobDescription||'')('body').text()).slice(0,400), applyUrl:j.applyUrl||j.url||`https://jobs.jobvite.com/careers/${token}/job/${j.id}`, postedAt:j.datePublished||j.postedDate, postedAgo:timeAgo(j.datePublished||j.postedDate), source:'Jobvite', remote:/remote/i.test(j.location||''), tags:extractTags(j.title||'') }));
    } catch(e) { continue; }
  }
  throw new Error('Jobvite failed');
}

async function scrapeRippling(company, token) {
  for (const url of [`https://app.rippling.com/api/o/ats/jobs/?company_slug=${token}&status=ACTIVE&limit=100`]) {
    try {
      const { data } = await axios.get(url, { timeout:10000, headers:{'Accept':'application/json'} });
      const jobs = data.results||(Array.isArray(data)?data:[]);
      if (jobs.length>0) return jobs.map(j => ({ id:`rp-${token}-${j.id||j.job_id}`, title:clean(j.title||j.name||''), company, location:clean(j.location?.name||j.location||'United States'), type:clean(j.employment_type||'Full-time'), desc:clean(cheerio.load(j.description||'')('body').text()).slice(0,400), applyUrl:j.apply_url||`https://app.rippling.com/job-boards/${token}/job/${j.id}`, postedAt:j.published_at||j.created_at, postedAgo:timeAgo(j.published_at||j.created_at), source:'Rippling', remote:j.remote||/remote/i.test(j.location?.name||j.location||''), tags:extractTags(j.title||'') }));
    } catch(e) { continue; }
  }
  throw new Error('Rippling failed');
}

async function scrapeTeamtailor(company, token) {
  const { data } = await axios.get('https://api.teamtailor.com/v1/jobs?fields[jobs]=title,body,apply-button-text&filter[feed]=public', { headers:{'Authorization':`Token token=${token}`,'X-Api-Version':'20210218'}, timeout:12000 });
  return (data.data||[]).map(j => ({ id:`tt-${token}-${j.id}`, title:clean(j.attributes?.title||''), company, location:'United States', type:'Full-time', desc:clean(cheerio.load(j.attributes?.body||'')('body').text()).slice(0,400), applyUrl:j.links?.['careersite-job-url']||'#', postedAt:j.attributes?.['created-at'], postedAgo:timeAgo(j.attributes?.['created-at']), source:'Teamtailor', remote:j.attributes?.['remote-status']==='remote', tags:extractTags(j.attributes?.title||'') }));
}

async function scrapePaycom(company, companyId) {
  const { data } = await axios.get(`https://www.paycomonline.net/v4/ats/web.php/jobs/listing?clientkey=${companyId}`, { timeout:12000 });
  return (data.jobs||data||[]).map(j => ({ id:`pc-${companyId}-${j.jobId||j.id}`, title:clean(j.title||j.jobTitle||''), company, location:clean(j.location||'United States'), type:'Full-time', desc:clean(j.description||'').slice(0,400), applyUrl:j.applyUrl||`https://www.paycomonline.net/v4/ats/web.php/jobs/details?clientkey=${companyId}&jobid=${j.jobId}`, postedAt:j.postDate, postedAgo:timeAgo(j.postDate), source:'Paycom', remote:/remote/i.test(j.location||''), tags:extractTags(j.title||'') }));
}

// ─── COMPANIES ────────────────────────────────────────────────────────────
const COMPANIES = [
  { fn:'greenhouse', company:'CrowdStrike',            token:'crowdstrike'           },
  { fn:'greenhouse', company:'SentinelOne',             token:'sentinelone'           },
  { fn:'greenhouse', company:'Cybereason',              token:'cybereason'            },
  { fn:'greenhouse', company:'Malwarebytes',            token:'malwarebytes'          },
  { fn:'greenhouse', company:'Tanium',                  token:'tanium'                },
  { fn:'lever',      company:'Huntress',                token:'huntresslabs'          },
  { fn:'lever',      company:'Expel',                   token:'expel'                 },
  { fn:'lever',      company:'UltraViolet Cyber',       token:'uvcyber'               },
  { fn:'ashby',      company:'Tines',                   token:'tines'                 },
  { fn:'greenhouse', company:'Palo Alto Networks',      token:'paloaltonetworks'      },
  { fn:'greenhouse', company:'Fortinet',                token:'fortinet'              },
  { fn:'greenhouse', company:'Imperva',                 token:'imperva'               },
  { fn:'greenhouse', company:'Illumio',                 token:'illumio'               },
  { fn:'greenhouse', company:'Fastly',                  token:'fastly'                },
  { fn:'lever',      company:'Cloudflare',              token:'cloudflare'            },
  { fn:'lever',      company:'Zscaler',                 token:'zscaler'               },
  { fn:'lever',      company:'Netskope',                token:'netskope'              },
  { fn:'lever',      company:'Proofpoint',              token:'proofpoint'            },
  { fn:'lever',      company:'Cato Networks',           token:'catonetworks'          },
  { fn:'lever',      company:'ThreatLocker',            token:'threatlocker'          },
  { fn:'workday',    company:'Splunk',   tenant:'splunk',   ns:'Splunk'               },
  { fn:'greenhouse', company:'Exabeam',                 token:'exabeam'               },
  { fn:'greenhouse', company:'Cribl',                   token:'cribl'                 },
  { fn:'ashby',      company:'Panther Labs',             token:'pantherlabs'           },
  { fn:'greenhouse', company:'Wiz',                     token:'wiz'                   },
  { fn:'greenhouse', company:'Lacework',                token:'lacework'              },
  { fn:'greenhouse', company:'Orca Security',           token:'orca-security'         },
  { fn:'greenhouse', company:'Aqua Security',           token:'aquasecurity'          },
  { fn:'greenhouse', company:'Sysdig',                  token:'sysdig'                },
  { fn:'ashby',      company:'Gem Security',            token:'gemsecurity'           },
  { fn:'ashby',      company:'Dazz',                    token:'dazz'                  },
  { fn:'greenhouse', company:'Okta',                    token:'okta'                  },
  { fn:'greenhouse', company:'CyberArk',                token:'cyberark'              },
  { fn:'greenhouse', company:'SailPoint',               token:'sailpoint'             },
  { fn:'greenhouse', company:'BeyondTrust',             token:'beyondtrust'           },
  { fn:'greenhouse', company:'Delinea',                 token:'delinea'               },
  { fn:'ashby',      company:'Opal Security',           token:'opal'                  },
  { fn:'greenhouse', company:'Qualys',                  token:'qualys'                },
  { fn:'greenhouse', company:'Tenable',                 token:'tenableinc'            },
  { fn:'greenhouse', company:'Rapid7',                  token:'rapid7'                },
  { fn:'greenhouse', company:'Vulncheck',               token:'vulncheck'             },
  { fn:'lever',      company:'Bishop Fox',              token:'bishopfox'             },
  { fn:'lever',      company:'Bugcrowd',                token:'bugcrowd'              },
  { fn:'greenhouse', company:'HackerOne',               token:'hackerone'             },
  { fn:'lever',      company:'Cobalt',                  token:'cobalt'                },
  { fn:'greenhouse', company:'Recorded Future',         token:'recordedfuture'        },
  { fn:'greenhouse', company:'Mandiant',                token:'mandiant'              },
  { fn:'lever',      company:'ZeroFox',                 token:'zerofox'               },
  { fn:'greenhouse', company:'Snyk',                    token:'snyk'                  },
  { fn:'greenhouse', company:'Checkmarx',               token:'checkmarx'             },
  { fn:'greenhouse', company:'Veracode',                token:'veracode'              },
  { fn:'ashby',      company:'Semgrep',                 token:'semgrep'               },
  { fn:'ashby',      company:'Endor Labs',              token:'endorlabs'             },
  { fn:'greenhouse', company:'Drata',                   token:'drata'                 },
  { fn:'greenhouse', company:'Vanta',                   token:'vanta'                 },
  { fn:'greenhouse', company:'Secureworks',             token:'secureworks'           },
  { fn:'greenhouse', company:'Arctic Wolf',             token:'arcticwolf'            },
  { fn:'lever',      company:'BlueVoyant',              token:'bluevoyant'            },
  { fn:'greenhouse', company:'Dragos',                  token:'dragos'                },
  { fn:'greenhouse', company:'Claroty',                 token:'claroty'               },
  { fn:'greenhouse', company:'Nozomi Networks',         token:'nozominetworks'        },
  { fn:'greenhouse', company:'Armis Security',          token:'armissecurity'         },
  { fn:'greenhouse', company:'Axonius',                 token:'axoniusltd'            },
  { fn:'greenhouse', company:'Varonis',                 token:'varonis'               },
  { fn:'greenhouse', company:'BigID',                   token:'bigid'                 },
  { fn:'greenhouse', company:'Abnormal Security',       token:'abnormalsecurity'      },
  { fn:'greenhouse', company:'KnowBe4',                 token:'knowbe4'               },
  { fn:'lever',      company:'Coalition Inc',           token:'coalitioninc'          },
  { fn:'lever',      company:'GuidePoint Security',     token:'guidepointsecurity'    },
  { fn:'lever',      company:'Optiv Security',          token:'optiv'                 },
  { fn:'greenhouse', company:'Cyware',                  token:'cyware'                },
  { fn:'greenhouse', company:'Hyperproof',              token:'hyperproof'            },
  { fn:'greenhouse', company:'Thoropass',               token:'thoropass'             },
  { fn:'ashby',      company:'Sprinto',                 token:'sprinto'               },
  { fn:'greenhouse', company:'OpenAI',                  token:'openai'                },
  { fn:'greenhouse', company:'Anthropic',               token:'anthropic'             },
  { fn:'greenhouse', company:'Scale AI',                token:'scaleai'               },
  { fn:'greenhouse', company:'Databricks',              token:'databricks'            },
  { fn:'greenhouse', company:'xAI',                     token:'xai'                   },
  { fn:'greenhouse', company:'Stripe',                  token:'stripe'                },
  { fn:'greenhouse', company:'Twilio',                  token:'twilio'                },
  { fn:'greenhouse', company:'Datadog',                 token:'datadog'               },
  { fn:'greenhouse', company:'GitLab',                  token:'gitlab'                },
  { fn:'greenhouse', company:'Elastic',                 token:'elastic'               },
  { fn:'greenhouse', company:'MongoDB',                 token:'mongodb'               },
  { fn:'greenhouse', company:'Snowflake',               token:'snowflake'             },
  { fn:'greenhouse', company:'Grafana Labs',            token:'grafanalabs'           },
  { fn:'lever',      company:'Atlassian',               token:'atlassian'             },
  { fn:'lever',      company:'Coinbase',                token:'coinbase'              },
  { fn:'lever',      company:'Palantir',                token:'palantir'              },
  { fn:'workday', company:'JPMorgan Chase',    tenant:'jpmc',             ns:'External_Career_Site' },
  { fn:'workday', company:'Bank of America',   tenant:'bankofamerica',    ns:'External_Career_Site' },
  { fn:'workday', company:'Goldman Sachs',     tenant:'goldmansachs',     ns:'External_Career_Site' },
  { fn:'workday', company:'Capital One',       tenant:'capitalone',       ns:'External_Career_Site' },
  { fn:'workday', company:'Visa',              tenant:'visa',             ns:'External'             },
  { fn:'workday', company:'Mastercard',        tenant:'mastercard',       ns:'External'             },
  { fn:'workday', company:'Microsoft',         tenant:'microsoftcorporation', ns:'External_Career_Site' },
  { fn:'workday', company:'IBM',               tenant:'ibm',              ns:'External'             },
  { fn:'workday', company:'Oracle',            tenant:'oracle',           ns:'External'             },
  { fn:'workday', company:'Cisco',             tenant:'cisco',            ns:'External'             },
  { fn:'workday', company:'NVIDIA',            tenant:'nvidia',           ns:'External'             },
  { fn:'workday', company:'Salesforce',        tenant:'salesforce',       ns:'External_Career_Site' },
  { fn:'smartrecruiter', company:'Google',     token:'Google'                                        },
  { fn:'smartrecruiter', company:'Deloitte',   token:'Deloitte'                                      },
  { fn:'smartrecruiter', company:'Accenture',  token:'Accenture'                                     },
  { fn:'workday', company:'UnitedHealth Group',tenant:'unitedhealthgroup', ns:'External_Career_Site' },
  { fn:'workday', company:'CVS Health',        tenant:'cvshealth',         ns:'External_Career_Site' },
  { fn:'workday', company:'Walmart',           tenant:'walmart',           ns:'External_Career_Site' },
  { fn:'workday', company:'Verizon',           tenant:'verizon',           ns:'External_Career_Site' },
  { fn:'workday', company:'Boeing',            tenant:'boeing',            ns:'External_Career_Site' },
  { fn:'workday', company:'Raytheon',          tenant:'raytheon',          ns:'External_Career_Site' },
  { fn:'workday', company:'Lockheed Martin',   tenant:'lmco',              ns:'External_Career_Site' },
  { fn:'workday', company:'Booz Allen',        tenant:'boozallencsn',      ns:'External'             },
  { fn:'workday', company:'Leidos',            tenant:'leidos',            ns:'External'             },
  { fn:'lever',   company:'Anduril',           token:'anduril'                                       },
  { fn:'lever',   company:'Kroll',             token:'kroll'                                         },
  { fn:'greenhouse', company:'Netflix',        token:'netflix'                                       },
  { fn:'greenhouse', company:'Shopify',        token:'shopify'                                       },
  { fn:'workable', company:'Red Canary',   subdomain:'redcanary'   },
  { fn:'workable', company:'Corelight',    subdomain:'corelight'   },
  { fn:'workable', company:'Blumira',      subdomain:'blumira'     },
  { fn:'bamboohr', company:'SolarWinds',   subdomain:'solarwinds'  },
  { fn:'bamboohr', company:'Lucid',        subdomain:'lucid'       },
];

// ─── SCRAPE ORCHESTRATOR ──────────────────────────────────────────────────
async function scrapeAll() {
  if (cache.isRunning) return;
  cache.isRunning = true;
  const started = Date.now();
  console.log(`\n[${new Date().toISOString()}] Starting scrape (${COMPANIES.length} companies)...`);
  const allRaw = [], errors = [];
  const existingIds = new Set(cache.jobs.map(j => j.id));
  const JAN_2026 = new Date('2026-01-01T00:00:00.000Z').getTime();

  const BATCH = 8;
  for (let i = 0; i < COMPANIES.length; i += BATCH) {
    await Promise.all(COMPANIES.slice(i, i+BATCH).map(async src => {
      try {
        let results = [];
        if      (src.fn==='greenhouse')     results = await scrapeGreenhouse(src.company, src.token);
        else if (src.fn==='lever')          results = await scrapeLever(src.company, src.token);
        else if (src.fn==='workday')        results = await scrapeWorkday(src.company, src.tenant, src.ns);
        else if (src.fn==='ashby')          results = await scrapeAshby(src.company, src.token);
        else if (src.fn==='smartrecruiter') results = await scrapeSmartRecruiter(src.company, src.token);
        else if (src.fn==='workable')       results = await scrapeWorkable(src.company, src.subdomain);
        else if (src.fn==='bamboohr')       results = await scrapeBamboohr(src.company, src.subdomain);
        else if (src.fn==='jobvite')        results = await scrapeJobvite(src.company, src.token);
        else if (src.fn==='rippling')       results = await scrapeRippling(src.company, src.token);
        else if (src.fn==='teamtailor')     results = await scrapeTeamtailor(src.company, src.token);
        else if (src.fn==='paycom')         results = await scrapePaycom(src.company, src.companyId);

        let passed = 0, blocked = 0;
        results.forEach(job => {
          const combined = (job.title+' '+job.desc).toLowerCase();
          if (isClearanceJob(combined)) { blocked++; cache.stats.clearanceBlocked++; return; }
          if (!isCyberJob(job.title, job.desc)) return;
          if (job.postedAt && new Date(job.postedAt).getTime() < JAN_2026) return;
          const level = levelOf(job.title);
          const salary = salaryOf(level, job.company);
          allRaw.push({ ...job, level, ...salary, h1bSponsor: H1B.has(job.company), isNew: !existingIds.has(job.id) });
          passed++;
        });
        cache.stats.sources[src.company] = { passed, blocked, total: results.length };
        if (passed > 0) console.log(`  ✓ ${src.company}: ${passed} jobs`);
      } catch(err) { errors.push({ company: src.company, error: err.message }); }
    }));
    await new Promise(r => setTimeout(r, 150));
  }

  // Job boards
  try {
    const boardJobs = await runJobBoards();
    boardJobs.forEach(j => { const l=levelOf(j.title); allRaw.push({...j,level:l,...salaryOf(l,j.company),isNew:!existingIds.has(j.id)}); });
    console.log(`[Boards] +${boardJobs.length} jobs`);
  } catch(e) { console.log(`[Boards] ${e.message}`); }

  const seen = new Set();
  const deduped = allRaw.filter(j => { if (seen.has(j.id)) return false; seen.add(j.id); return true; });
  deduped.sort((a,b) => { const at=a.postedAt?new Date(a.postedAt).getTime():0; const bt=b.postedAt?new Date(b.postedAt).getTime():0; return bt-at; });

  cache.newJobIds = deduped.filter(j=>j.isNew).map(j=>j.id);
  cache.jobs = deduped;
  cache.lastUpdated = new Date().toISOString();
  cache.stats.total = deduped.length;
  cache.isRunning = false;
  cache.scrapeLog.unshift({ time:cache.lastUpdated, total:deduped.length, newJobs:deduped.filter(j=>j.isNew).length, companies:Object.keys(cache.stats.sources).length, errors:errors.length });
  cache.scrapeLog = cache.scrapeLog.slice(0,30);

  if (dbAvailable && deduped.length > 0) upsertJobsToDb(deduped);
  broadcastSSE({ type:'jobs_updated', total:deduped.length });
  console.log(`[${new Date().toISOString()}] Done: ${deduped.length} jobs, ${errors.length} errors, ${Math.round((Date.now()-started)/1000)}s\n`);
}

async function upsertJobsToDb(jobs) {
  const CHUNK = 100;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const chunk = jobs.slice(i, i+CHUNK);
    try {
      const vals = chunk.map((_,idx) => { const b=idx*16; return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16})`; }).join(',');
      const flat = chunk.flatMap(j => [j.id,j.title,j.company,j.location,j.type,j.level,j.salaryMin,j.salaryMax,j.desc,j.tags||[],j.applyUrl,j.postedAt||null,j.postedAgo,j.source,j.remote||false,j.h1bSponsor||false]);
      await db.query(`INSERT INTO jobs (id,title,company,location,type,level,salary_min,salary_max,desc,tags,apply_url,posted_at,posted_ago,source,remote,h1b_sponsor) VALUES ${vals} ON CONFLICT (id) DO UPDATE SET posted_ago=EXCLUDED.posted_ago,last_seen=NOW(),is_new=FALSE`, flat);
    } catch(e) { console.warn('[DB] Upsert error:', e.message); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// AUTH
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email||!password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    let userId = uuidv4();
    if (dbAvailable) {
      const r = await db.query('INSERT INTO users (email,password,name) VALUES ($1,$2,$3) RETURNING id', [email.toLowerCase(),hash,name||'']);
      userId = r.rows[0].id;
    }
    res.json({ token: jwt.sign({userId,email},JWT_SECRET,{expiresIn:'30d'}), user:{id:userId,email,name:name||''} });
  } catch(e) {
    if (e.code==='23505') return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email||!password) return res.status(400).json({ error: 'Email and password required' });
  try {
    if (!dbAvailable) {
      const token = jwt.sign({userId:uuidv4(),email},JWT_SECRET,{expiresIn:'30d'});
      return res.json({ token, user:{email,name:email.split('@')[0]} });
    }
    const r = await db.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!r.rows.length||!await bcrypt.compare(password,r.rows[0].password)) return res.status(401).json({ error: 'Invalid credentials' });
    const u = r.rows[0];
    res.json({ token: jwt.sign({userId:u.id,email:u.email},JWT_SECRET,{expiresIn:'30d'}), user:{id:u.id,email:u.email,name:u.name} });
  } catch(e) { res.status(500).json({ error: 'Login failed' }); }
});

// USER PROFILE
app.get('/api/user/profile', requireAuth, async (req, res) => {
  if (!dbAvailable) return res.json({ id:req.user.userId, email:req.user.email });
  try {
    const r = await db.query('SELECT id,email,name,title,yoe,skills,summary,visa,target_roles,min_salary,work_pref,linkedin,phone,location FROM users WHERE id=$1', [req.user.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/user/profile', requireAuth, async (req, res) => {
  const { name,title,yoe,skills,summary,visa,target_roles,min_salary,work_pref,linkedin,phone,location,resume_text } = req.body;
  if (!dbAvailable) return res.json({ ok:true });
  try {
    await db.query('UPDATE users SET name=$1,title=$2,yoe=$3,skills=$4,summary=$5,visa=$6,target_roles=$7,min_salary=$8,work_pref=$9,linkedin=$10,phone=$11,location=$12,resume_text=$13,updated_at=NOW() WHERE id=$14',
      [name,title,yoe,skills,summary,visa,target_roles,min_salary,work_pref,linkedin,phone,location,resume_text,req.user.userId]);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// JOBS
app.get('/api/jobs', async (req, res) => {
  const { q,location,level,salary,company,remote,type,limit=1000,offset=0,since,fresh,scored } = req.query;
  let jobs = [...cache.jobs];
  if (q)          { const ql=q.toLowerCase(); jobs=jobs.filter(j=>(j.title+j.company+(j.desc||'')+(j.tags||[]).join(' ')).toLowerCase().includes(ql)); }
  if (location)   { jobs=jobs.filter(j=>(j.location||'').toLowerCase().includes(location.toLowerCase())); }
  if (level)      { jobs=jobs.filter(j=>j.level===level); }
  if (salary)     { jobs=jobs.filter(j=>j.salaryMin>=parseInt(salary)); }
  if (company)    { jobs=jobs.filter(j=>j.company===company); }
  if (remote==='true') { jobs=jobs.filter(j=>j.remote); }
  if (type)       { jobs=jobs.filter(j=>(j.type||'').toLowerCase()===type.toLowerCase()); }
  if (since)      { const ms=new Date(since).getTime(); jobs=jobs.filter(j=>j.postedAt&&new Date(j.postedAt).getTime()>ms); }
  if (fresh==='true') { const cut=Date.now()-6*3600000; jobs=jobs.filter(j=>j.postedAt&&new Date(j.postedAt).getTime()>cut); }
  if (scored==='true' && req.headers.authorization) {
    try {
      const dec = jwt.verify(req.headers.authorization.slice(7),JWT_SECRET);
      if (dbAvailable) {
        const r = await db.query('SELECT * FROM users WHERE id=$1',[dec.userId]);
        if (r.rows.length) { jobs=jobs.map(j=>({...j,_score:scoreJobForUser(j,r.rows[0])})); jobs.sort((a,b)=>(b._score||0)-(a._score||0)); }
      }
    } catch(e) {}
  }
  res.json({ jobs:jobs.slice(+offset,+offset + +limit), total:jobs.length, newJobIds:cache.newJobIds, lastUpdated:cache.lastUpdated, isRunning:cache.isRunning });
});

app.get('/api/jobs/:id', (req,res) => {
  const job = cache.jobs.find(j=>j.id===req.params.id);
  if (!job) return res.status(404).json({ error:'Not found' });
  res.json(job);
});

app.get('/api/status', (req,res) => res.json({ lastUpdated:cache.lastUpdated, totalJobs:cache.jobs.length, isRunning:cache.isRunning, companiesTotal:COMPANIES.length, companiesDone:Object.keys(cache.stats.sources).length, clearanceBlocked:cache.stats.clearanceBlocked, sources:cache.stats.sources, log:cache.scrapeLog, dbConnected:dbAvailable }));

app.post('/api/scrape', (req,res) => { if (cache.isRunning) return res.json({status:'already_running'}); scrapeAll(); res.json({status:'started'}); });

// APPLICATIONS
app.get('/api/applications', requireAuth, async (req,res) => {
  if (!dbAvailable) return res.json([]);
  try { const r=await db.query('SELECT * FROM applications WHERE user_id=$1 ORDER BY created_at DESC',[req.user.userId]); res.json(r.rows); } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/applications', requireAuth, async (req,res) => {
  const { job_id,title,company,apply_url,stage,notes } = req.body;
  if (!title||!company) return res.status(400).json({error:'title and company required'});
  if (!dbAvailable) return res.json({id:uuidv4(),title,company,stage:stage||'saved',created_at:new Date()});
  try { const r=await db.query('INSERT INTO applications (user_id,job_id,title,company,apply_url,stage,notes,applied_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[req.user.userId,job_id||null,title,company,apply_url||null,stage||'saved',notes||null,stage==='applied'?new Date():null]); res.json(r.rows[0]); } catch(e) { res.status(500).json({error:e.message}); }
});

app.put('/api/applications/:id', requireAuth, async (req,res) => {
  const { stage,notes,salary_offered } = req.body;
  if (!dbAvailable) return res.json({ok:true});
  try {
    const updates=[],vals=[];let i=1;
    if (stage!==undefined){updates.push(`stage=$${i++}`);vals.push(stage);}
    if (notes!==undefined){updates.push(`notes=$${i++}`);vals.push(notes);}
    if (salary_offered!==undefined){updates.push(`salary_offered=$${i++}`);vals.push(salary_offered);}
    if (stage==='applied'){updates.push(`applied_at=$${i++}`);vals.push(new Date());}
    updates.push(`updated_at=$${i++}`);vals.push(new Date());
    vals.push(req.params.id,req.user.userId);
    await db.query(`UPDATE applications SET ${updates.join(',')} WHERE id=$${i++} AND user_id=$${i}`,vals);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/api/applications/:id', requireAuth, async (req,res) => {
  if (!dbAvailable) return res.json({ok:true});
  try { await db.query('DELETE FROM applications WHERE id=$1 AND user_id=$2',[req.params.id,req.user.userId]); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// AI RESUME GENERATION
app.post('/api/resumes/generate', requireAuth, async (req,res) => {
  const { job_id,job_title,company,job_description,type } = req.body;
  if (!job_description) return res.status(400).json({error:'job_description required'});
  if (!CLAUDE_KEY) return res.status(503).json({error:'Add ANTHROPIC_API_KEY to Railway env vars'});

  let up = { name:'Candidate', skills:'', summary:'', title:'' };
  if (dbAvailable) { try { const r=await db.query('SELECT * FROM users WHERE id=$1',[req.user.userId]); if (r.rows.length) up=r.rows[0]; } catch(e) {} }

  const isResume = (type||'resume')==='resume';
  const system = isResume
    ? 'You are an expert cybersecurity resume writer. Generate a complete, ATS-optimized tailored resume matching the job description. Use strong action verbs, quantify achievements, mirror JD keywords. Sections: Professional Summary, Core Competencies, Experience, Education, Certifications.'
    : 'You are an expert career coach. Write a compelling 3-paragraph cover letter directly addressing job requirements, highlighting cybersecurity experience, showing genuine enthusiasm. Avoid clichés. Be specific.';

  try {
    const aiRes = await axios.post('https://api.anthropic.com/v1/messages',
      { model:'claude-sonnet-4-20250514', max_tokens:1500, system, messages:[{ role:'user', content:`JOB: ${job_title||'Security Role'} at ${company||'Company'}\n\nJD:\n${job_description.slice(0,2000)}\n\nCANDIDATE:\nName: ${up.name||'Candidate'}\nTitle: ${up.title||'Security Professional'}\nSkills: ${up.skills||''}\nSummary: ${up.summary||''}\n\nGenerate tailored ${isResume?'resume':'cover letter'}.` }] },
      { headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'}, timeout:30000 }
    );
    const content = aiRes.data.content?.[0]?.text||'';
    let token = uuidv4().replace(/-/g,'');
    if (dbAvailable) {
      try {
        const r=await db.query('INSERT INTO generated_resumes (user_id,job_id,job_title,company,content,type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING track_token',[req.user.userId,job_id||null,job_title||null,company||null,content,type||'resume']);
        token = r.rows[0].track_token;
      } catch(e) {}
    }
    res.json({ content, trackUrl:`${req.protocol}://${req.get('host')}/api/track/${token}`, trackToken:token });
  } catch(e) { res.status(500).json({error:'AI generation failed: '+e.message}); }
});

app.get('/api/resumes', requireAuth, async (req,res) => {
  if (!dbAvailable) return res.json([]);
  try { const r=await db.query('SELECT id,job_title,company,type,track_token,view_count,last_viewed,created_at FROM generated_resumes WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',[req.user.userId]); res.json(r.rows); } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/resumes/:id', requireAuth, async (req,res) => {
  if (!dbAvailable) return res.status(404).json({error:'Not found'});
  try { const r=await db.query('SELECT * FROM generated_resumes WHERE id=$1 AND user_id=$2',[req.params.id,req.user.userId]); if (!r.rows.length) return res.status(404).json({error:'Not found'}); res.json(r.rows[0]); } catch(e) { res.status(500).json({error:e.message}); }
});

// TRACKABLE LINKS
app.get('/api/track/:token', async (req,res) => {
  const { token } = req.params;
  if (dbAvailable) {
    try {
      await db.query('UPDATE generated_resumes SET view_count=view_count+1,last_viewed=NOW() WHERE track_token=$1',[token]);
      await db.query('INSERT INTO resume_views (token,ip,user_agent) VALUES ($1,$2,$3)',[token,req.ip,req.headers['user-agent']||'']);
      const r=await db.query('SELECT user_id,job_title,company FROM generated_resumes WHERE track_token=$1',[token]);
      if (r.rows.length) broadcastSSE({ type:'resume_viewed', jobTitle:r.rows[0].job_title, company:r.rows[0].company, token, time:new Date().toISOString() });
    } catch(e) {}
  }
  // Serve a simple tracking page then redirect
  res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"><title>Opening resume…</title></head><body style="background:#060608;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><p>Opening resume…</p></body></html>`);
});

app.get('/api/track/:token/stats', requireAuth, async (req,res) => {
  if (!dbAvailable) return res.json({views:[]});
  try {
    const views=await db.query('SELECT * FROM resume_views WHERE token=$1 ORDER BY viewed_at DESC',[req.params.token]);
    const meta=await db.query('SELECT view_count,last_viewed,job_title,company FROM generated_resumes WHERE track_token=$1 AND user_id=$2',[req.params.token,req.user.userId]);
    res.json({ meta:meta.rows[0]||{}, views:views.rows });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// AI QUICK ANSWER
app.post('/api/ai/answer', requireAuth, async (req,res) => {
  const { question, job_context } = req.body;
  if (!question) return res.status(400).json({error:'question required'});
  if (!CLAUDE_KEY) return res.status(503).json({error:'Add ANTHROPIC_API_KEY to env vars'});
  let up = {};
  if (dbAvailable) { try { const r=await db.query('SELECT title,yoe,skills,summary FROM users WHERE id=$1',[req.user.userId]); if (r.rows.length) up=r.rows[0]; } catch(e) {} }
  try {
    const aiRes=await axios.post('https://api.anthropic.com/v1/messages',
      { model:'claude-sonnet-4-20250514', max_tokens:600, system:'You are an expert cybersecurity career coach. Give a strong STAR-method answer. Be concise (150-250 words). Cybersecurity context.', messages:[{role:'user',content:`Candidate: ${up.title||'Security Pro'}, ${up.yoe||''}yrs, skills: ${up.skills||'security'}.${job_context?'\nContext: '+job_context:''}\n\nQuestion: "${question}"\n\nGive a strong tailored answer.`}] },
      { headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'}, timeout:20000 }
    );
    res.json({ answer:aiRes.data.content?.[0]?.text||'' });
  } catch(e) { res.status(500).json({error:'AI failed'}); }
});

// AI MOCK INTERVIEW
app.post('/api/ai/interview', requireAuth, async (req,res) => {
  const { role,company,type,history,answer } = req.body;
  if (!CLAUDE_KEY) return res.status(503).json({error:'Add ANTHROPIC_API_KEY to env vars'});
  try {
    const messages=(history||[]).concat(answer?[{role:'user',content:answer}]:[]);
    if (!messages.length) messages.push({role:'user',content:`Start a ${type||'mixed'} interview for ${role||'Security Engineer'}${company?' at '+company:''}.`});
    const aiRes=await axios.post('https://api.anthropic.com/v1/messages',
      { model:'claude-sonnet-4-20250514', max_tokens:500, system:'You are a tough but fair cybersecurity interviewer. Ask one question at a time. After each answer, give brief feedback then ask the next. For the last question give scores: Communication/10, Technical Depth/10, Conciseness/10, STAR Structure/10.', messages },
      { headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'}, timeout:20000 }
    );
    res.json({ response:aiRes.data.content?.[0]?.text||'' });
  } catch(e) { res.status(500).json({error:'AI failed'}); }
});

// APPLY COUNTS
app.get('/api/apply/counts', async (req,res) => {
  if (!dbAvailable) return res.json({});
  try { const r=await db.query('SELECT job_id,count FROM apply_counts ORDER BY count DESC LIMIT 500'); const c={}; r.rows.forEach(row=>c[row.job_id]=row.count); res.json(c); } catch(e) { res.json({}); }
});

app.post('/api/apply/:jobId', async (req,res) => {
  const id = req.params.jobId;
  let count = 1;
  if (dbAvailable) { try { const r=await db.query('INSERT INTO apply_counts (job_id,count) VALUES ($1,1) ON CONFLICT (job_id) DO UPDATE SET count=apply_counts.count+1,updated_at=NOW() RETURNING count',[id]); count=r.rows[0]?.count||1; } catch(e) {} }
  broadcastSSE({ type:'apply', jobId:id, count });
  res.json({ jobId:id, count, ok:true });
});

app.get('/api/apply/stream', (req,res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({type:'init'})}\n\n`);
  sseClients.push(res);
  const hb=setInterval(()=>{try{res.write(': heartbeat\n\n');}catch(e){}},25000);
  req.on('close',()=>{clearInterval(hb);sseClients=sseClients.filter(c=>c!==res);});
});

// CATCH-ALL
app.get('*', (req,res) => { if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname,'public','index.html')); });

// BOOT
cron.schedule('*/5 * * * *', () => scrapeAll());

app.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          ClearPath OS v3 — Dynamic Tangent Backend            ║
╠═══════════════════════════════════════════════════════════════╣
║  Web:           http://localhost:${PORT}                         ║
║  Auth:          POST /api/auth/register | /api/auth/login       ║
║  Jobs:          GET  /api/jobs                                  ║
║  Pipeline:      GET/POST/PUT/DELETE /api/applications           ║
║  AI Resume:     POST /api/resumes/generate                      ║
║  Resume Track:  GET  /api/track/:token                          ║
║  AI Answer:     POST /api/ai/answer                             ║
║  AI Interview:  POST /api/ai/interview                          ║
║  SSE:           GET  /api/apply/stream                          ║
║  Companies:     ${COMPANIES.length} configured                             ║
╚═══════════════════════════════════════════════════════════════╝
  `);
  await initDb();
  scrapeAll();
});
