/**
 * ClearPath Jobs — Backend Server v2
 * ────────────────────────────────────────────────────────────────────────────
 * Scrapes 150+ US company career APIs every 5 minutes.
 * Covers: Pure cybersecurity vendors, Big Tech, Finance, Healthcare,
 *         Retail, Telecom, Cloud, Consulting, Insurance, and more.
 * Auto-filters ALL clearance-required roles permanently.
 *
 * Usage:  npm install && npm start
 * API:    http://localhost:3001
 * Web:    http://localhost:3001  (serves frontend automatically)
 */

require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const cron         = require('node-cron');
const axios        = require('axios');
const cheerio      = require('cheerio');
const path         = require('path');
const { runJobBoards } = require('./job-boards');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory store ──────────────────────────────────────────────────────
let store = {
  jobs: [],
  newJobIds: [],       // IDs added in the most recent scrape cycle
  lastUpdated: null,
  isRunning: false,
  stats: { total: 0, clearanceBlocked: 0, errors: [], sources: {}, boards: { linkedin:0, jsearch:0, adzuna:0, indeed:0 } },
  log: []
};

// ─── Live Apply Counter ───────────────────────────────────────────────────
const fs   = require('fs');
const APPLY_FILE = require('path').join(__dirname, 'apply-counts.json');
let applyCounts = {};
try { applyCounts = JSON.parse(fs.readFileSync(APPLY_FILE, 'utf8')); } catch(e) {}
function saveApplyCounts() {
  try { fs.writeFileSync(APPLY_FILE, JSON.stringify(applyCounts, null, 2)); } catch(e) {}
}
let sseClients = [];
function broadcastApply(jobId, count) {
  const msg = `data: ${JSON.stringify({ jobId, count })}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(msg); return true; } catch(e) { return false; }
  });
}

// ─── Clearance block-list (any match = discard job) ──────────────────────
const CLEARANCE_DENY = [
  'security clearance','clearance required','clearance preferred',
  'top secret','ts/sci','ts/sci eligible','secret clearance','active secret',
  'public trust','polygraph','dod clearance','dod secret','dod top secret',
  'cia ','nsa ','dhs clearance','government clearance','federal clearance',
  'classified information','q clearance','l clearance','nato secret',
  'sci eligible','sci eligibility','sensitive compartmented',
  'collateral clearance','background investigation suitability',
  'national security clearance','must hold clearance','obtain a clearance',
  'ability to obtain a secret','interim clearance','clearance sponsorship',
  'clearance adjudication','sfpc','ssbi','tier 3','tier 5 investigation',
  'special access program','sap access','controlled unclassified information clearance'
];

// ─── Cyber allow-list (job title/desc must match at least one) ───────────
const CYBER_ALLOW = [
  // role titles
  'security engineer','security analyst','security architect','security researcher',
  'security consultant','security specialist','security operations','security manager',
  'security director','security officer','ciso','vp of security','head of security',
  'principal security','staff security','lead security',
  // disciplines
  'penetration test','pentesting','pen test','ethical hack','red team','blue team',
  'purple team','offensive security','defensive security',
  'threat intelligence','threat hunter','threat hunting','threat detection',
  'incident response','digital forensics','dfir','malware analyst','malware analysis',
  'vulnerability','vulnerability management','vulnerability researcher',
  'soc analyst','soc engineer','detection engineer','detection & response',
  'devsecops','appsec','application security','product security','platform security',
  'cloud security','network security','infrastructure security','endpoint security',
  'identity security','iam engineer','identity and access','zero trust',
  'information security','infosec','cybersecurity','cyber security',
  'grc analyst','governance risk','compliance engineer',
  'bug bounty','security awareness','privacy engineer','data security',
  'container security','kubernetes security','runtime security',
  'cryptography engineer','pki engineer','secrets management',
  'security data scientist','security automation','soar engineer',
  'trust & safety','trust and safety',
  // tools/certs often in titles
  'siem engineer','splunk security','crowdstrike','sentinelone engineer'
];

// ─── Helpers ──────────────────────────────────────────────────────────────
const clean = s => (s || '').replace(/\s+/g,' ').replace(/[\r\n\t]/g,' ').trim();

const isClearanceJob = text => {
  const t = (text || '').toLowerCase();
  return CLEARANCE_DENY.some(kw => t.includes(kw));
};

const isCyberJob = (title, desc) => {
  const t = ((title || '') + ' ' + (desc || '')).toLowerCase();
  return CYBER_ALLOW.some(kw => t.includes(kw));
};

const timeAgo = dateStr => {
  if (!dateStr) return 'Recently';
  const d = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (d < 120)    return `${d} seconds ago`;
  if (d < 3600)   return `${Math.floor(d/60)} minutes ago`;
  if (d < 86400)  return `${Math.floor(d/3600)} hours ago`;
  return `${Math.floor(d/86400)} days ago`;
};

const levelOf = title => {
  const t = (title || '').toLowerCase();
  if (/intern|student|co-?op/i.test(t))                    return 'intern';
  if (/staff|principal|fellow|director|vp |head |ciso/i.test(t)) return 'lead';
  if (/senior|sr\b|sr\.|lead\b/i.test(t))                  return 'senior';
  if (/junior|jr\b|associate|entry/i.test(t))              return 'entry';
  return 'mid';
};

const salaryOf = (level, company) => {
  const base = { intern:[25,45], entry:[70,95], mid:[100,135], senior:[130,175], lead:[155,220] };
  const [lo, hi] = base[level] || base.mid;
  const topTier = ['Google','Meta','Apple','Microsoft','Amazon','Netflix','Stripe',
    'CrowdStrike','Palo Alto Networks','SentinelOne','Wiz','Databricks','Snowflake',
    'Cloudflare','OpenAI','Anthropic','Uber','Lyft','Airbnb','Block'];
  const bump = topTier.some(c => company.includes(c)) ? 18 : 0;
  return { salaryMin: lo + bump, salaryMax: hi + bump };
};

const TAG_POOL = [
  'SIEM','EDR','XDR','SOAR','Splunk','Elastic','CrowdStrike','SentinelOne',
  'AWS Security','GCP Security','Azure Security','Kubernetes','Terraform',
  'Python','Go','Rust','Java','OWASP','Burp Suite','Metasploit',
  'MITRE ATT&CK','Zero Trust','SASE','ZTNA','IAM','OAuth','SAML','PKI',
  'TLS','DFIR','Forensics','Malware Analysis','Threat Intel','OSINT',
  'Vulnerability Mgmt','Pen Testing','Red Team','Detection Engineering',
  'Sigma','YARA','KQL','ISO 27001','SOC 2','PCI-DSS','HIPAA','FedRAMP',
  'DevSecOps','CI/CD','CSPM','CNAPP','IDS/IPS','Firewall','VPN',
  'Incident Response','CVSS','Bug Bounty','AppSec','Cloud Security',
  'Network Security','Endpoint Security','Container Security'
];

const extractTags = text => {
  const lo = (text || '').toLowerCase();
  return TAG_POOL.filter(t => lo.includes(t.toLowerCase())).slice(0, 7);
};

// ─── ATS scrapers ─────────────────────────────────────────────────────────

async function scrapeGreenhouse(company, token) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
  const { data } = await axios.get(url, { timeout: 12000 });
  return (data.jobs || []).map(j => ({
    id:        `gh-${token}-${j.id}`,
    title:     clean(j.title),
    company,
    location:  clean(j.location?.name || 'United States'),
    type:      'Full-time',
    desc:      clean(cheerio.load(j.content || '')('body').text()).slice(0, 400),
    applyUrl:  j.absolute_url || `https://boards.greenhouse.io/${token}/jobs/${j.id}`,
    postedAt:  j.updated_at,
    postedAgo: timeAgo(j.updated_at),
    source:    'Greenhouse',
    remote:    /remote/i.test(j.location?.name || ''),
    tags:      extractTags(j.title + ' ' + (j.content || ''))
  }));
}

async function scrapeLever(company, token) {
  const url = `https://api.lever.co/v0/postings/${token}?mode=json`;
  const { data } = await axios.get(url, { timeout: 12000 });
  return (data || []).map(j => ({
    id:        `lv-${token}-${j.id}`,
    title:     clean(j.text),
    company,
    location:  clean(j.categories?.location || j.workplaceType || 'United States'),
    type:      clean(j.categories?.commitment || 'Full-time'),
    desc:      clean(j.descriptionPlain || j.description || '').slice(0, 400),
    applyUrl:  j.hostedUrl || `https://jobs.lever.co/${token}/${j.id}`,
    postedAt:  j.createdAt ? new Date(j.createdAt).toISOString() : null,
    postedAgo: j.createdAt ? timeAgo(new Date(j.createdAt).toISOString()) : 'Recently',
    source:    'Lever',
    remote:    /remote/i.test(j.categories?.location || j.workplaceType || ''),
    tags:      extractTags(j.text + ' ' + (j.descriptionPlain || ''))
  }));
}

async function scrapeWorkday(company, tenant, ns) {
  // Browser-like headers — Workday blocks plain axios without them
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': `https://${tenant}.wd5.myworkdayjobs.com`,
    'Referer': `https://${tenant}.wd5.myworkdayjobs.com/${ns}`,
  };

  // Try primary namespace first, then fallbacks — sequential to avoid rate limits
  const namespacesToTry = [ns, 'External_Career_Site', 'External', 'careers', tenant]
    .filter((v, i, a) => v && a.indexOf(v) === i);
  const subdomains = [
    `${tenant}.wd5.myworkdayjobs.com`,
    `${tenant}.wd1.myworkdayjobs.com`,
    `${tenant}.wd3.myworkdayjobs.com`,
  ];

  const mapJobs = (jobs, subdomain, nsUsed) => jobs.map(j => ({
    id:        `wd-${tenant}-${(j.externalPath || j.title || Math.random().toString(36).slice(2,8)).replace(/[^a-z0-9-]/gi, '-').slice(0, 60)}`,
    title:     clean(j.title), company,
    location:  clean(j.locationsText || 'United States'),
    type:      'Full-time',
    desc:      clean(j.jobDescription || '').slice(0, 400),
    applyUrl:  `https://${subdomain}/${nsUsed}/job/${j.externalPath || ''}`,
    postedAt:  j.postedOn, postedAgo: timeAgo(j.postedOn), source: 'Workday',
    remote:    /remote/i.test(j.locationsText || ''),
    tags:      extractTags(j.title + ' ' + (j.jobDescription || ''))
  }));

  for (const subdomain of subdomains) {
    for (const nsUsed of namespacesToTry) {
      try {
        const url = `https://${subdomain}/wday/cxs/${tenant}/${nsUsed}/jobs`;
        // Try with empty searchText first (more results), then 'security'
        for (const searchText of ['', 'security']) {
          try {
            const { data } = await axios.post(url,
              { limit: 100, offset: 0, searchText, appliedFacets: {} },
              { headers, timeout: 15000 }
            );
            const jobs = (data.jobPostings || []);
            if (jobs.length > 0) return mapJobs(jobs, subdomain, nsUsed);
          } catch(e) { /* try next searchText */ }
        }
      } catch(e) { /* try next namespace */ }
    }
  }
  throw new Error(`Workday failed: ${tenant}`);
}

async function scrapeAshby(company, token) {
  const url = `https://jobs.ashbyhq.com/api/non-user-graphql`;
  const { data } = await axios.post(url, {
    operationName: 'ApiJobBoardWithTeams',
    variables: { organizationHostedJobsPageName: token },
    query: `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
      jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
        jobPostings { id title locationName employmentType descriptionSocial publishedAt isRemote }
      }
    }`
  }, { timeout: 12000 });
  const jobs = data?.data?.jobBoard?.jobPostings || [];
  return jobs.map(j => ({
    id:        `ash-${token}-${j.id}`,
    title:     clean(j.title),
    company,
    location:  clean(j.locationName || 'United States'),
    type:      clean(j.employmentType || 'Full-time'),
    desc:      clean(j.descriptionSocial || '').slice(0, 400),
    applyUrl:  `https://jobs.ashbyhq.com/${token}/${j.id}`,
    postedAt:  j.publishedAt,
    postedAgo: timeAgo(j.publishedAt),
    source:    'Ashby',
    remote:    j.isRemote || /remote/i.test(j.locationName || ''),
    tags:      extractTags(j.title + ' ' + (j.descriptionSocial || ''))
  }));
}

async function scrapeSmartRecruiter(company, token) {
  const url = `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100&status=PUBLISHED`;
  const { data } = await axios.get(url, { timeout: 12000 });
  return (data.content || []).map(j => ({
    id:        `sr-${token}-${j.id}`,
    title:     clean(j.name),
    company,
    location:  clean(j.location?.city ? `${j.location.city}, ${j.location.region||j.location.country}` : 'United States'),
    type:      clean(j.typeOfEmployment?.label || 'Full-time'),
    desc:      clean(j.jobAd?.sections?.jobDescription?.text || '').slice(0, 400),
    applyUrl:  `https://jobs.smartrecruiters.com/${token}/${j.id}`,
    postedAt:  j.releasedDate,
    postedAgo: timeAgo(j.releasedDate),
    source:    'SmartRecruiters',
    remote:    /remote/i.test(j.location?.city || ''),
    tags:      extractTags(j.name + ' ' + (j.jobAd?.sections?.jobDescription?.text || ''))
  }));
}

// ─── NEW ATS SCRAPERS ─────────────────────────────────────────────────────

// iCIMS — public XML job feed, no auth needed
// URL pattern: https://careers.COMPANY.icims.com/jobs/search?ss=1&searchCategory=KEYWORD&in_iframe=1
// Most iCIMS customers expose: https://COMPANY.jobs.net/jobs.xml OR use careers.icims.com
async function scrapeIcims(company, customerId) {
  // iCIMS public search endpoint (no auth required for job listings)
  const url = `https://api.icims.com/customers/${customerId}/search/jobs`;
  const { data } = await axios.post(url, {
    filters: [{ name: 'joblocation.state', value: ['United States'] }],
    fields: ['jobtitle', 'joblocation', 'joblastmodified', 'jobtype', 'jobdescription']
  }, { timeout: 12000, headers: { 'Content-Type': 'application/json' } });
  const jobs = data.searchResults || [];
  return jobs.map(j => ({
    id:        `ic-${customerId}-${j.id}`,
    title:     clean(j.jobtitle || ''),
    company,
    location:  clean(j.joblocation || 'United States'),
    type:      clean(j.jobtype || 'Full-time'),
    desc:      clean(j.jobdescription || '').slice(0, 400),
    applyUrl:  `https://careers.icims.com/jobs/${j.id}`,
    postedAt:  j.joblastmodified,
    postedAgo: timeAgo(j.joblastmodified),
    source:    'iCIMS',
    remote:    /remote/i.test(j.joblocation || ''),
    tags:      extractTags((j.jobtitle || '') + ' ' + (j.jobdescription || ''))
  }));
}

// Jobvite — public JSON API, no auth needed
async function scrapeJobvite(company, token) {
  const url = `https://jobs.jobvite.com/api/jobs?c=${token}&d=&l=&limit=100&cf=Security`;
  const { data } = await axios.get(url, { timeout: 12000 });
  const jobs = data.requisitions || [];
  return jobs.map(j => ({
    id:        `jv-${token}-${j.id}`,
    title:     clean(j.title),
    company,
    location:  clean(j.location || 'United States'),
    type:      clean(j.jobType || 'Full-time'),
    desc:      clean(cheerio.load(j.description || '')('body').text()).slice(0, 400),
    applyUrl:  j.applyUrl || `https://jobs.jobvite.com/careers/${token}/job/${j.id}`,
    postedAt:  j.datePublished,
    postedAgo: timeAgo(j.datePublished),
    source:    'Jobvite',
    remote:    /remote/i.test(j.location || ''),
    tags:      extractTags(j.title + ' ' + (j.description || ''))
  }));
}

// Rippling — public ATS jobs endpoint
async function scrapeRippling(company, token) {
  const url = `https://app.rippling.com/api/o/ats/jobs/?company_slug=${token}&status=ACTIVE&limit=100`;
  const { data } = await axios.get(url, { timeout: 12000, headers: { 'Accept': 'application/json' } });
  const jobs = data.results || data || [];
  return (Array.isArray(jobs) ? jobs : []).map(j => ({
    id:        `rp-${token}-${j.id || j.job_id}`,
    title:     clean(j.title || j.name || ''),
    company,
    location:  clean(j.location?.name || j.location || 'United States'),
    type:      clean(j.employment_type || 'Full-time'),
    desc:      clean(cheerio.load(j.description || '')('body').text()).slice(0, 400),
    applyUrl:  j.apply_url || `https://app.rippling.com/job-boards/${token}/job/${j.id}`,
    postedAt:  j.published_at || j.created_at,
    postedAgo: timeAgo(j.published_at || j.created_at),
    source:    'Rippling',
    remote:    j.remote || /remote/i.test(j.location?.name || j.location || ''),
    tags:      extractTags((j.title || '') + ' ' + (j.description || ''))
  }));
}

// Teamtailor — public REST API
async function scrapeTeamtailor(company, token) {
  const url = `https://api.teamtailor.com/v1/jobs?filter[status]=open&include=department,role,locations&page[size]=100`;
  const { data } = await axios.get(url, {
    timeout: 12000,
    headers: { 'Authorization': `Token token=${token}`, 'X-Api-Version': '20210218' }
  });
  const jobs = data.data || [];
  return jobs.map(j => {
    const a = j.attributes || {};
    return {
      id:        `tt-${token}-${j.id}`,
      title:     clean(a.title || ''),
      company,
      location:  clean(a['remote-status'] === 'fully_remote' ? 'Remote' : 'United States'),
      type:      'Full-time',
      desc:      clean(cheerio.load(a.body || '')('body').text()).slice(0, 400),
      applyUrl:  a['career-site-url'] || `https://jobs.teamtailor.com/${token}`,
      postedAt:  a['created-at'],
      postedAgo: timeAgo(a['created-at']),
      source:    'Teamtailor',
      remote:    a['remote-status'] === 'fully_remote',
      tags:      extractTags((a.title || '') + ' ' + (a.body || ''))
    };
  });
}

// BambooHR — public jobs API (no auth needed for job listings)
async function scrapeBamboohr(company, subdomain) {
  const url = `https://${subdomain}.bamboohr.com/jobs/embed2.php?version=1.0.0`;
  const { data } = await axios.get(url, { timeout: 12000 });
  // BambooHR returns JSON with departments and jobs
  const depts = data.result || [];
  const jobs = [];
  depts.forEach(dept => {
    (dept.positions || []).forEach(j => {
      jobs.push({
        id:        `bhr-${subdomain}-${j.id}`,
        title:     clean(j.title),
        company,
        location:  clean(j.location?.city ? `${j.location.city}, ${j.location.state}` : 'United States'),
        type:      clean(j.employmentStatusLabel || 'Full-time'),
        desc:      clean(cheerio.load(j.jobOpeningDescription || '')('body').text()).slice(0, 400),
        applyUrl:  `https://${subdomain}.bamboohr.com/jobs/view.php?id=${j.id}`,
        postedAt:  j.datePosted,
        postedAgo: timeAgo(j.datePosted),
        source:    'BambooHR',
        remote:    /remote/i.test(j.location?.city || ''),
        tags:      extractTags(j.title + ' ' + (j.jobOpeningDescription || ''))
      });
    });
  });
  return jobs;
}

// Workable — public jobs API
async function scrapeWorkable(company, subdomain) {
  const url = `https://apply.workable.com/api/v3/accounts/${subdomain}/jobs`;
  const { data } = await axios.post(url, { query: '', location: [], department: [], worktype: [], remote: [] }, {
    timeout: 12000, headers: { 'Content-Type': 'application/json' }
  });
  const jobs = data.results || [];
  return jobs.map(j => ({
    id:        `wb-${subdomain}-${j.id}`,
    title:     clean(j.title),
    company,
    location:  clean(j.location?.city ? `${j.location.city}, ${j.location.country}` : 'United States'),
    type:      clean(j.employment_type || 'Full-time'),
    desc:      clean(j.description || '').slice(0, 400),
    applyUrl:  `https://apply.workable.com/${subdomain}/j/${j.shortcode}`,
    postedAt:  j.published_on,
    postedAgo: timeAgo(j.published_on),
    source:    'Workable',
    remote:    j.remote || /remote/i.test(j.location?.city || ''),
    tags:      extractTags(j.title + ' ' + (j.description || ''))
  }));
}

// Paycom — public XML job feed scraper
async function scrapePaycom(company, companyId) {
  const url = `https://www.paycomonline.net/v4/ats/web.php/jobs?wcID=${companyId}&action=externalListings`;
  const { data } = await axios.get(url, { timeout: 12000 });
  const $ = cheerio.load(data, { xmlMode: true });
  const jobs = [];
  $('job, position, listing').each((_, el) => {
    const $el = $(el);
    jobs.push({
      id:        `pc-${companyId}-${$el.attr('id') || $el.find('id').text() || Math.random().toString(36).slice(2)}`,
      title:     clean($el.find('title, jobtitle, positionTitle').first().text()),
      company,
      location:  clean($el.find('location, city, state').first().text() || 'United States'),
      type:      'Full-time',
      desc:      clean($el.find('description, jobdescription').first().text()).slice(0, 400),
      applyUrl:  $el.find('url, applyurl, link').first().text() || `https://www.paycomonline.net/v4/ats/web.php/jobs?wcID=${companyId}`,
      postedAt:  null,
      postedAgo: 'Recently',
      source:    'Paycom',
      remote:    /remote/i.test($el.find('location').first().text() || ''),
      tags:      extractTags($el.find('title').first().text() + ' ' + $el.find('description').first().text())
    });
  });
  return jobs;
}

// ─── THE MASTER COMPANY LIST — 300+ US companies ─────────────────────────
// Covers every major US sector that regularly posts cybersecurity jobs.
// ATS platforms: Greenhouse, Lever, Workday, Ashby, SmartRecruiters, iCIMS

const COMPANIES = [

  // ══════════════════════════════════════════════════════════
  // 🛡 PURE CYBERSECURITY VENDORS
  // ══════════════════════════════════════════════════════════

  // Endpoint / XDR
  { fn:'greenhouse', company:'CrowdStrike',            token:'crowdstrike'           },
  { fn:'greenhouse', company:'SentinelOne',             token:'sentinelone'           },
  { fn:'greenhouse', company:'Cybereason',              token:'cybereason'            },
  { fn:'greenhouse', company:'Malwarebytes',            token:'malwarebytes'          },
  { fn:'greenhouse', company:'Tanium',                  token:'tanium'                },
  { fn:'greenhouse', company:'Trellix',                 token:'trellix'               },
  { fn:'lever',      company:'Huntress',                token:'huntresslabs'          },
  { fn:'lever',      company:'Deepwatch',               token:'deepwatch'             },
  { fn:'lever',      company:'eSentire',                token:'esentire'              },
  { fn:'lever',      company:'Expel',                   token:'expel'                 },
  { fn:'lever',      company:'UltraViolet Cyber',       token:'uvcyber'               },
  { fn:'ashby',      company:'Stairwell',               token:'stairwell'             },
  { fn:'ashby',      company:'Tines',                   token:'tines'                 },

  // Network / Perimeter / SASE
  { fn:'greenhouse', company:'Palo Alto Networks',      token:'paloaltonetworks'      },
  { fn:'greenhouse', company:'Fortinet',                token:'fortinet'              },
  { fn:'greenhouse', company:'F5 Networks',             token:'f5networks'            },
  { fn:'greenhouse', company:'Imperva',                 token:'imperva'               },
  { fn:'greenhouse', company:'Illumio',                 token:'illumio'               },
  { fn:'greenhouse', company:'Akamai',                  token:'akamai'                },
  { fn:'greenhouse', company:'Fastly',                  token:'fastly'                },
  { fn:'greenhouse', company:'A10 Networks',            token:'a10networks'           },
  { fn:'lever',      company:'Cloudflare',              token:'cloudflare'            },
  { fn:'lever',      company:'Zscaler',                 token:'zscaler'               },
  { fn:'lever',      company:'Netskope',                token:'netskope'              },
  { fn:'lever',      company:'Lookout',                 token:'lookout'               },
  { fn:'lever',      company:'Mimecast',                token:'mimecast'              },
  { fn:'lever',      company:'Proofpoint',              token:'proofpoint'            },
  { fn:'lever',      company:'Barracuda Networks',      token:'barracuda'             },
  { fn:'lever',      company:'Cato Networks',           token:'catonetworks'          },
  { fn:'lever',      company:'ThreatLocker',            token:'threatlocker'          },
  { fn:'lever',      company:'Perimeter 81',            token:'perimeter81'           },
  { fn:'lever',      company:'Axis Security',           token:'axissecurity'          },
  { fn:'lever',      company:'Aryaka Networks',         token:'aryaka'                },

  // SIEM / SOAR / Detection
  { fn:'workday',    company:'Splunk',   tenant:'splunk',   ns:'Splunk'               },
  { fn:'greenhouse', company:'Exabeam',                 token:'exabeam'               },
  { fn:'greenhouse', company:'Cribl',                   token:'cribl'                 },
  { fn:'greenhouse', company:'Torq',                    token:'torqio'                },
  { fn:'greenhouse', company:'Anvilogic',               token:'anvilogic'             },
  { fn:'greenhouse', company:'Devo',                    token:'devo'                  },
  { fn:'ashby',      company:'Panther Labs',             token:'pantherlabs'           },
  { fn:'ashby',      company:'Hunters',                  token:'hunters'               },

  // Cloud Security / CNAPP / CSPM
  { fn:'greenhouse', company:'Wiz',                     token:'wiz'                   },
  { fn:'greenhouse', company:'Lacework',                token:'lacework'              },
  { fn:'greenhouse', company:'Orca Security',           token:'orca-security'         },
  { fn:'greenhouse', company:'Aqua Security',           token:'aquasecurity'          },
  { fn:'greenhouse', company:'Sysdig',                  token:'sysdig'                },
  { fn:'greenhouse', company:'Ermetic',                 token:'ermetic'               },
  { fn:'greenhouse', company:'Sonrai Security',         token:'sonraisecurity'        },
  { fn:'greenhouse', company:'Laminar',                 token:'laminar'               },
  { fn:'greenhouse', company:'Normalyze',               token:'normalyze'             },
  { fn:'greenhouse', company:'Cyolo',                   token:'cyolo'                 },
  { fn:'greenhouse', company:'Upwind Security',         token:'upwindsecurity'        },
  { fn:'ashby',      company:'Gem Security',            token:'gemsecurity'           },
  { fn:'ashby',      company:'Dazz',                    token:'dazz'                  },

  // Identity & Access Management
  { fn:'greenhouse', company:'Okta',                    token:'okta'                  },
  { fn:'greenhouse', company:'CyberArk',                token:'cyberark'              },
  { fn:'greenhouse', company:'SailPoint',               token:'sailpoint'             },
  { fn:'greenhouse', company:'Saviynt',                 token:'saviynt'               },
  { fn:'greenhouse', company:'BeyondTrust',             token:'beyondtrust'           },
  { fn:'greenhouse', company:'Delinea',                 token:'delinea'               },
  { fn:'lever',      company:'Transmit Security',       token:'transmitsecurity'      },
  { fn:'ashby',      company:'Opal Security',           token:'opal'                  },

  // Vulnerability / Pen Testing
  { fn:'greenhouse', company:'Qualys',                  token:'qualys'                },
  { fn:'greenhouse', company:'Tenable',                 token:'tenableinc'            },
  { fn:'greenhouse', company:'Rapid7',                  token:'rapid7'                },
  { fn:'greenhouse', company:'Pentera',                 token:'pentera'               },
  { fn:'greenhouse', company:'Vulncheck',               token:'vulncheck'             },
  { fn:'greenhouse', company:'Rezilion',                token:'rezilion'              },
  { fn:'lever',      company:'Horizon3.ai',             token:'horizon3'              },
  { fn:'lever',      company:'Bishop Fox',              token:'bishopfox'             },
  { fn:'lever',      company:'NetSPI',                  token:'netspi'                },
  { fn:'lever',      company:'Bugcrowd',                token:'bugcrowd'              },
  { fn:'greenhouse', company:'HackerOne',               token:'hackerone'             },
  { fn:'lever',      company:'Cobalt',                  token:'cobalt'                },
  { fn:'lever',      company:'Synack',                  token:'synack'                },

  // Threat Intelligence
  { fn:'greenhouse', company:'Recorded Future',         token:'recordedfuture'        },
  { fn:'greenhouse', company:'ThreatConnect',           token:'threatconnect'         },
  { fn:'greenhouse', company:'Mandiant',                token:'mandiant'              },
  { fn:'lever',      company:'Intel 471',               token:'intel471'              },
  { fn:'lever',      company:'Flashpoint',              token:'flashpoint'            },
  { fn:'lever',      company:'ZeroFox',                 token:'zerofox'               },
  { fn:'lever',      company:'Nisos',                   token:'nisos'                 },

  // AppSec / DevSecOps
  { fn:'greenhouse', company:'Snyk',                    token:'snyk'                  },
  { fn:'greenhouse', company:'Checkmarx',               token:'checkmarx'             },
  { fn:'greenhouse', company:'Veracode',                token:'veracode'              },
  { fn:'greenhouse', company:'WhiteSource (Mend)',      token:'whitesource'           },
  { fn:'greenhouse', company:'Contrast Security',       token:'contrastsecurity'      },
  { fn:'greenhouse', company:'GitGuardian',             token:'gitguardian'           },
  { fn:'greenhouse', company:'Cycode',                  token:'cycode'                },
  { fn:'ashby',      company:'Semgrep',                 token:'semgrep'               },
  { fn:'ashby',      company:'Endor Labs',              token:'endorlabs'             },
  { fn:'ashby',      company:'Socket Security',         token:'socket'                },
  { fn:'ashby',      company:'Aikido Security',         token:'aikidosecurity'        },
  { fn:'ashby',      company:'Arnica',                  token:'arnica'                },

  // GRC / Compliance Automation
  { fn:'greenhouse', company:'Drata',                   token:'drata'                 },
  { fn:'greenhouse', company:'Vanta',                   token:'vanta'                 },
  { fn:'greenhouse', company:'Secureframe',             token:'secureframe'           },
  { fn:'greenhouse', company:'Tugboat Logic',           token:'tugboatlogic'          },
  { fn:'greenhouse', company:'Hyperproof',              token:'hyperproof'            },
  { fn:'greenhouse', company:'Thoropass',               token:'thoropass'             },
  { fn:'ashby',      company:'Sprinto',                 token:'sprinto'               },

  // MSSP / MDR
  { fn:'greenhouse', company:'Secureworks',             token:'secureworks'           },
  { fn:'greenhouse', company:'Arctic Wolf',             token:'arcticwolf'            },
  { fn:'lever',      company:'Kroll',                   token:'kroll'                 },
  { fn:'lever',      company:'Coalition Inc',           token:'coalitioninc'          },
  { fn:'lever',      company:'GuidePoint Security',     token:'guidepointsecurity'    },
  { fn:'lever',      company:'Optiv Security',          token:'optiv'                 },
  { fn:'lever',      company:'Trustwave',               token:'trustwave'             },
  { fn:'lever',      company:'BlueVoyant',              token:'bluevoyant'            },
  { fn:'lever',      company:'Nuspire',                 token:'nuspire'               },
  { fn:'lever',      company:'Herjavec Group',          token:'herjavecgroup'         },
  { fn:'lever',      company:'AHEAD',                   token:'thinkahead'            },

  // OT / ICS / IoT Security
  { fn:'greenhouse', company:'Dragos',                  token:'dragos'                },
  { fn:'greenhouse', company:'Claroty',                 token:'claroty'               },
  { fn:'greenhouse', company:'Nozomi Networks',         token:'nozominetworks'        },
  { fn:'greenhouse', company:'Armis Security',          token:'armissecurity'         },
  { fn:'greenhouse', company:'Axonius',                 token:'axoniusltd'            },
  { fn:'greenhouse', company:'Ordr',                    token:'ordr'                  },
  { fn:'lever',      company:'Phosphorus Cybersecurity',token:'phosphorus'            },
  { fn:'lever',      company:'Claroty',                 token:'claroty'               },

  // Data Security / DLP / DSPM
  { fn:'greenhouse', company:'Cyberhaven',              token:'cyberhaven'            },
  { fn:'greenhouse', company:'Varonis',                 token:'varonis'               },
  { fn:'greenhouse', company:'BigID',                   token:'bigid'                 },
  { fn:'greenhouse', company:'Cyware',                  token:'cyware'                },
  { fn:'greenhouse', company:'Symmetry Systems',        token:'symmetrysystems'       },
  { fn:'ashby',      company:'Open Raven',              token:'openraven'             },

  // Email & Phishing Security
  { fn:'greenhouse', company:'Abnormal Security',       token:'abnormalsecurity'      },
  { fn:'greenhouse', company:'Sublime Security',        token:'sublimesecurity'       },
  { fn:'lever',      company:'Cofense',                 token:'cofense'               },
  { fn:'lever',      company:'Ironscales',              token:'ironscales'            },
  { fn:'lever',      company:'GreatHorn',               token:'greathorn'             },

  // Cyber Insurance
  { fn:'lever',      company:'At-Bay',                  token:'at-bay'                },
  { fn:'lever',      company:'Cowbell Cyber',           token:'cowbell-cyber'         },
  { fn:'lever',      company:'Resilience Cyber',        token:'resiliencecyber'       },
  { fn:'lever',      company:'Corvus Insurance',        token:'corvusinsurance'       },
  { fn:'lever',      company:'BlackCloak',              token:'BlackCloak'            },

  // Browser & Zero Trust
  { fn:'greenhouse', company:'Island',                  token:'island'                },
  { fn:'greenhouse', company:'Talon Cyber Security',    token:'taloncyber'            },

  // PKI / Secrets / Cryptography
  { fn:'greenhouse', company:'Venafi',                  token:'venafi'                },
  { fn:'greenhouse', company:'Keyfactor',               token:'keyfactor'             },
  { fn:'ashby',      company:'Incode Technologies',     token:'incode'                },

  // Security Awareness
  { fn:'greenhouse', company:'KnowBe4',                 token:'knowbe4'               },
  { fn:'greenhouse', company:'Proofpoint Security Awareness', token:'proofpoint'      },
  { fn:'lever',      company:'Abnormal Security',       token:'abnormalsecurity'      },

  // ══════════════════════════════════════════════════════════
  // 💻 BIG TECH & CLOUD
  // ══════════════════════════════════════════════════════════
  { fn:'smartrecruiter', company:'Google',              token:'Google'                },
  { fn:'workday', company:'Microsoft',   tenant:'microsoftcorporation', ns:'External_Career_Site' },
  { fn:'workday', company:'Apple',       tenant:'apple',      ns:'apple'              },
  { fn:'workday', company:'Meta',        tenant:'meta4',      ns:'Meta_External_Jobs' },
  { fn:'workday', company:'Amazon',      tenant:'amazon',     ns:'External_Career_Site' },
  { fn:'workday', company:'IBM',         tenant:'ibm',        ns:'External'           },
  { fn:'workday', company:'Oracle',      tenant:'oracle',     ns:'External'           },
  { fn:'workday', company:'Salesforce',  tenant:'salesforce', ns:'External_Career_Site' },
  { fn:'workday', company:'SAP America', tenant:'sapamerica', ns:'External_Careers'   },
  { fn:'workday', company:'Cisco',       tenant:'cisco',      ns:'External'           },
  { fn:'workday', company:'Intel',       tenant:'intel',      ns:'External'           },
  { fn:'workday', company:'VMware',      tenant:'vmware',     ns:'External'           },
  { fn:'workday', company:'HP Inc',      tenant:'hp',         ns:'External'           },
  { fn:'workday', company:'Dell Technologies', tenant:'dell', ns:'External'           },
  { fn:'workday', company:'Qualcomm',    tenant:'qualcomm',   ns:'External'           },
  { fn:'workday', company:'NVIDIA',      tenant:'nvidia',     ns:'External'           },
  { fn:'workday', company:'Workday',     tenant:'workday',    ns:'workday'            },
  { fn:'greenhouse', company:'xAI',                    token:'xai'                   },
  { fn:'greenhouse', company:'Databricks',             token:'databricks'            },
  { fn:'greenhouse', company:'Snowflake',              token:'snowflake'             },
  { fn:'greenhouse', company:'HashiCorp',              token:'hashicorp'             },
  { fn:'greenhouse', company:'MongoDB',                token:'mongodb'               },
  { fn:'greenhouse', company:'Confluent',              token:'confluent'             },
  { fn:'greenhouse', company:'Elastic',                token:'elastic'               },
  { fn:'greenhouse', company:'Grafana Labs',           token:'grafanalabs'           },
  { fn:'greenhouse', company:'Cloudinary',             token:'cloudinary'            },
  { fn:'greenhouse', company:'Okta',                   token:'okta'                  },

  // ══════════════════════════════════════════════════════════
  // 🤖 AI / ML COMPANIES
  // ══════════════════════════════════════════════════════════
  { fn:'greenhouse', company:'OpenAI',                 token:'openai'                },
  { fn:'greenhouse', company:'Anthropic',              token:'anthropic'             },
  { fn:'greenhouse', company:'Scale AI',               token:'scaleai'               },
  { fn:'greenhouse', company:'Hugging Face',           token:'huggingface'           },
  { fn:'greenhouse', company:'Cohere',                 token:'cohere'                },
  { fn:'greenhouse', company:'Weights & Biases',       token:'wandb'                 },
  { fn:'greenhouse', company:'Runway ML',              token:'runwayml'              },
  { fn:'greenhouse', company:'Stability AI',           token:'stabilityai'           },
  { fn:'greenhouse', company:'Inflection AI',          token:'inflectionai'          },
  { fn:'ashby',      company:'Perplexity AI',          token:'perplexityai'          },
  { fn:'ashby',      company:'Character.AI',           token:'characterai'           },
  { fn:'ashby',      company:'Contextual AI',          token:'contextualai'          },
  { fn:'lever',      company:'Mistral AI',             token:'mistral-ai'            },
  { fn:'lever',      company:'Together AI',            token:'togetherai'            },
  { fn:'lever',      company:'Applied Intuition',      token:'appliedintuition'      },

  // ══════════════════════════════════════════════════════════
  // ☁️ SAAS / PLATFORM COMPANIES
  // ══════════════════════════════════════════════════════════
  { fn:'greenhouse', company:'Stripe',                 token:'stripe'                },
  { fn:'greenhouse', company:'Twilio',                 token:'twilio'                },
  { fn:'greenhouse', company:'Datadog',                token:'datadog'               },
  { fn:'greenhouse', company:'PagerDuty',              token:'pagerduty'             },
  { fn:'greenhouse', company:'Zendesk',                token:'zendesk'               },
  { fn:'greenhouse', company:'Asana',                  token:'asana'                 },
  { fn:'greenhouse', company:'Dropbox',                token:'dropbox'               },
  { fn:'greenhouse', company:'Box',                    token:'boxinc'                },
  { fn:'greenhouse', company:'Zoom',                   token:'zoom'                  },
  { fn:'greenhouse', company:'GitLab',                 token:'gitlab'                },
  { fn:'greenhouse', company:'GitHub',                 token:'github'                },
  { fn:'greenhouse', company:'Vercel',                 token:'vercel'                },
  { fn:'greenhouse', company:'Netlify',                token:'netlify'               },
  { fn:'greenhouse', company:'Checkr',                 token:'checkr'                },
  { fn:'greenhouse', company:'Glassdoor',              token:'glassdoor'             },
  { fn:'greenhouse', company:'Gusto',                  token:'gusto'                 },
  { fn:'greenhouse', company:'Twitch',                 token:'twitch'                },
  { fn:'greenhouse', company:'Reddit',                 token:'reddit'                },
  { fn:'greenhouse', company:'Duolingo',               token:'duolingo'              },
  { fn:'greenhouse', company:'Coursera',               token:'coursera'              },
  { fn:'greenhouse', company:'Udemy',                  token:'udemy'                 },
  { fn:'greenhouse', company:'Roblox',                 token:'roblox'                },
  { fn:'greenhouse', company:'Epic Games',             token:'epicgames'             },
  { fn:'greenhouse', company:'Unity Technologies',     token:'unity'                 },
  { fn:'greenhouse', company:'Zillow',                 token:'zillow'                },
  { fn:'greenhouse', company:'Opendoor',               token:'opendoor'              },
  { fn:'greenhouse', company:'Compass',                token:'compass'               },
  { fn:'greenhouse', company:'Olo',                    token:'olo'                   },
  { fn:'greenhouse', company:'Toast',                  token:'toasttab'              },
  { fn:'greenhouse', company:'Squarespace',            token:'squarespace'           },
  { fn:'greenhouse', company:'Wix',                    token:'wix'                   },
  { fn:'greenhouse', company:'Zendesk',                token:'zendesk'               },
  { fn:'lever',      company:'Atlassian',              token:'atlassian'             },
  { fn:'lever',      company:'HubSpot',                token:'hubspot'               },
  { fn:'lever',      company:'Intercom',               token:'intercom'              },
  { fn:'lever',      company:'Amplitude',              token:'amplitude'             },
  { fn:'lever',      company:'Notion',                 token:'notion'                },
  { fn:'lever',      company:'Figma',                  token:'figma'                 },
  { fn:'lever',      company:'Linear',                 token:'linear'                },
  { fn:'lever',      company:'Retool',                 token:'retool'                },
  { fn:'lever',      company:'Discord',                token:'discord'               },
  { fn:'lever',      company:'Snap Inc',               token:'snap'                  },
  { fn:'lever',      company:'Pinterest',              token:'pinterest'             },
  { fn:'lever',      company:'LinkedIn',               token:'linkedin'              },
  { fn:'lever',      company:'Brex',                   token:'brex'                  },
  { fn:'lever',      company:'Plaid',                  token:'plaid'                 },
  { fn:'lever',      company:'Robinhood',              token:'robinhood'             },
  { fn:'lever',      company:'Chime',                  token:'chime'                 },
  { fn:'lever',      company:'Affirm',                 token:'affirm'                },
  { fn:'lever',      company:'Marqeta',                token:'marqeta'               },
  { fn:'lever',      company:'Navan',                  token:'navan'                 },
  { fn:'lever',      company:'Deel',                   token:'deel'                  },
  { fn:'lever',      company:'Rippling',               token:'rippling'              },
  { fn:'lever',      company:'Lattice',                token:'lattice'               },
  { fn:'lever',      company:'Loom',                   token:'loom'                  },
  { fn:'lever',      company:'Miro',                   token:'miro'                  },
  { fn:'lever',      company:'Airtable',               token:'airtable'              },
  { fn:'lever',      company:'Coda',                   token:'coda'                  },
  { fn:'lever',      company:'Calendly',               token:'calendly'              },
  { fn:'lever',      company:'Carta',                  token:'carta'                 },
  { fn:'lever',      company:'Brainware',              token:'brainware'             },
  { fn:'lever',      company:'Sprinklr',               token:'sprinklr'              },
  { fn:'lever',      company:'Recurly',                token:'recurly'               },
  { fn:'lever',      company:'Zuora',                  token:'zuora'                 },
  { fn:'lever',      company:'Freshworks',             token:'freshworks'            },
  { fn:'lever',      company:'monday.com',             token:'monday'                },
  { fn:'lever',      company:'Clickup',                token:'clickup'               },
  { fn:'lever',      company:'Gong',                   token:'gong'                  },
  { fn:'lever',      company:'Outreach',               token:'outreach'              },
  { fn:'lever',      company:'Salesloft',              token:'salesloft'             },
  { fn:'lever',      company:'Seismic',                token:'seismic'               },
  { fn:'lever',      company:'Highspot',               token:'highspot'              },
  { fn:'ashby',      company:'Mercury',                token:'mercury'               },
  { fn:'ashby',      company:'Ramp',                   token:'ramp'                  },
  { fn:'ashby',      company:'Pilot',                  token:'pilot'                 },
  { fn:'ashby',      company:'Watershed',              token:'watershed'             },
  { fn:'ashby',      company:'Sourcegraph',            token:'sourcegraph'           },
  { fn:'ashby',      company:'Retool',                 token:'retool'                },
  { fn:'ashby',      company:'Hex',                    token:'hex'                   },
  { fn:'ashby',      company:'Dbt Labs',               token:'dbtlabs'               },

  // ══════════════════════════════════════════════════════════
  // 🏦 FINANCE, BANKING & FINTECH
  // ══════════════════════════════════════════════════════════
  { fn:'smartrecruiter', company:'JPMorgan Chase',     token:'JPMORGANCHASE'         },
  { fn:'workday', company:'Bank of America',  tenant:'bankofamerica',  ns:'External_Career_Site' },
  { fn:'workday', company:'Goldman Sachs',    tenant:'goldmansachs',   ns:'External_Career_Site' },
  { fn:'workday', company:'Wells Fargo',      tenant:'wellsfargo',     ns:'External_Career_Site' },
  { fn:'workday', company:'Citi',             tenant:'citi',           ns:'External'             },
  { fn:'workday', company:'Morgan Stanley',   tenant:'morganstanley',  ns:'External'             },
  { fn:'workday', company:'American Express', tenant:'amex',           ns:'External_Career_Site' },
  { fn:'workday', company:'Capital One',      tenant:'capitalone',     ns:'External_Career_Site' },
  { fn:'workday', company:'US Bancorp',       tenant:'usbank',         ns:'External'             },
  { fn:'workday', company:'Charles Schwab',   tenant:'schwab',         ns:'External'             },
  { fn:'workday', company:'Fidelity',         tenant:'fidelity',       ns:'External'             },
  { fn:'workday', company:'BlackRock',        tenant:'blackrock',      ns:'External'             },
  { fn:'workday', company:'Visa',             tenant:'visa',           ns:'External'             },
  { fn:'workday', company:'Mastercard',       tenant:'mastercard',     ns:'External'             },
  { fn:'workday', company:'PayPal',           tenant:'paypal',         ns:'External'             },
  { fn:'workday', company:'Synchrony',        tenant:'synchrony',      ns:'External'             },
  { fn:'workday', company:'Discover',         tenant:'discover',       ns:'External'             },
  { fn:'workday', company:'Ally Financial',   tenant:'ally',           ns:'External'             },
  { fn:'workday', company:'PNC Financial',    tenant:'pnc',            ns:'External'             },
  { fn:'workday', company:'Truist',           tenant:'truist',         ns:'External'             },
  { fn:'workday', company:'Citizens Bank',    tenant:'citizensbank',   ns:'External'             },
  { fn:'workday', company:'TD Bank',          tenant:'tdbank',         ns:'External'             },
  { fn:'workday', company:'Huntington',       tenant:'huntington',     ns:'External'             },
  { fn:'workday', company:'KeyCorp',          tenant:'key',            ns:'External'             },
  { fn:'workday', company:'Regions Bank',     tenant:'regions',        ns:'External'             },
  { fn:'workday', company:'Fifth Third',      tenant:'53',             ns:'External'             },
  { fn:'workday', company:'Raymond James',    tenant:'raymondjames',   ns:'External'             },
  { fn:'workday', company:'TIAA',             tenant:'tiaa',           ns:'External'             },
  { fn:'workday', company:'Vanguard',         tenant:'vanguard',       ns:'External'             },
  { fn:'workday', company:'T. Rowe Price',    tenant:'troweprice',     ns:'External'             },
  { fn:'workday', company:'State Street',     tenant:'statestreet',    ns:'External'             },
  { fn:'lever',   company:'Coinbase',         token:'coinbase'                                   },
  { fn:'lever',   company:'Kraken',           token:'krakenexchange'                             },
  { fn:'lever',   company:'Gemini',           token:'gemini'                                     },
  { fn:'lever',   company:'Block',            token:'block'                                      },
  { fn:'lever',   company:'Revolut',          token:'revolut'                                    },
  { fn:'lever',   company:'SoFi',             token:'sofi'                                       },
  { fn:'lever',   company:'Betterment',       token:'betterment'                                 },
  { fn:'lever',   company:'Wealthfront',      token:'wealthfront'                                },
  { fn:'lever',   company:'Acorns',           token:'acorns'                                     },
  { fn:'lever',   company:'Nerdwallet',       token:'nerdwallet'                                 },
  { fn:'lever',   company:'LendingClub',      token:'lendingclub'                                },
  { fn:'lever',   company:'Prosper',          token:'prosper'                                    },
  { fn:'lever',   company:'Avant',            token:'avant'                                      },

  // ══════════════════════════════════════════════════════════
  // 🏥 HEALTHCARE, PHARMA & INSURANCE
  // ══════════════════════════════════════════════════════════
  { fn:'workday', company:'UnitedHealth Group', tenant:'unitedhealthgroup', ns:'External_Career_Site' },
  { fn:'workday', company:'CVS Health',         tenant:'cvshealth',         ns:'External_Career_Site' },
  { fn:'workday', company:'Elevance Health',    tenant:'elevancehealth',    ns:'External'             },
  { fn:'workday', company:'Cigna',              tenant:'cigna',             ns:'External_Career_Site' },
  { fn:'workday', company:'Aetna',              tenant:'aetna',             ns:'External_Career_Site' },
  { fn:'workday', company:'Humana',             tenant:'humana',            ns:'External'             },
  { fn:'workday', company:'Centene',            tenant:'centene',           ns:'External'             },
  { fn:'workday', company:'Pfizer',             tenant:'pfizer',            ns:'External_Career_Site' },
  { fn:'workday', company:'Johnson & Johnson',  tenant:'jnj',               ns:'External_Career_Site' },
  { fn:'workday', company:'Moderna',            tenant:'modernatx',         ns:'External_Career_Site' },
  { fn:'workday', company:'Abbott',             tenant:'abbott',            ns:'External'             },
  { fn:'workday', company:'Medtronic',          tenant:'medtronic',         ns:'External'             },
  { fn:'workday', company:'Becton Dickinson',   tenant:'bd',                ns:'External'             },
  { fn:'workday', company:'Merck',              tenant:'merck',             ns:'External'             },
  { fn:'workday', company:'AbbVie',             tenant:'abbvie',            ns:'External'             },
  { fn:'workday', company:'Bristol Myers',      tenant:'bms',               ns:'External'             },
  { fn:'workday', company:'Amgen',              tenant:'amgen',             ns:'External'             },
  { fn:'workday', company:'Gilead',             tenant:'gilead',            ns:'External'             },
  { fn:'workday', company:'Biogen',             tenant:'biogen',            ns:'External'             },
  { fn:'workday', company:'Stryker',            tenant:'stryker',           ns:'External'             },
  { fn:'workday', company:'Zimmer Biomet',      tenant:'zimmerbiomet',      ns:'External'             },
  { fn:'workday', company:'Edwards Lifesciences',tenant:'edwards',          ns:'External'             },
  { fn:'workday', company:'Baxter',             tenant:'baxter',            ns:'External'             },
  { fn:'workday', company:'Hologic',            tenant:'hologic',           ns:'External'             },
  { fn:'workday', company:'Quest Diagnostics',  tenant:'questdiagnostics',  ns:'External'             },
  { fn:'workday', company:'Laboratory Corp',    tenant:'labcorp',           ns:'External'             },
  { fn:'workday', company:'McKesson',           tenant:'mckesson',          ns:'External'             },
  { fn:'workday', company:'Anthem',             tenant:'elevancehealth',    ns:'External'             },
  { fn:'workday', company:'Molina Healthcare',  tenant:'molina',            ns:'External'             },
  { fn:'workday', company:'DaVita',             tenant:'davita',            ns:'External'             },
  { fn:'greenhouse', company:'Veeva Systems',          token:'veeva'                 },
  { fn:'greenhouse', company:'Genentech',              token:'genentech'             },
  { fn:'greenhouse', company:'Illumina',               token:'illumina'              },
  { fn:'greenhouse', company:'23andMe',                token:'23andme'               },
  { fn:'greenhouse', company:'Included Health',        token:'includedhealth'        },
  { fn:'greenhouse', company:'Aledade',                token:'aledade'               },
  { fn:'greenhouse', company:'Nuna Health',            token:'nuna'                  },
  { fn:'lever',      company:'Oscar Health',           token:'oscar-health'          },
  { fn:'lever',      company:'Devoted Health',         token:'devoted-health'        },
  { fn:'ashby',      company:'Transcarent',            token:'transcarent'           },
  { fn:'ashby',      company:'Turquoise Health',       token:'turquoisehealth'       },

  // ══════════════════════════════════════════════════════════
  // 🛒 RETAIL, E-COMMERCE & CONSUMER
  // ══════════════════════════════════════════════════════════
  { fn:'workday', company:'Walmart',         tenant:'walmart',          ns:'External_Career_Site' },
  { fn:'workday', company:'Target',          tenant:'target',           ns:'careersevents'        },
  { fn:'workday', company:'Home Depot',      tenant:'homedepot',        ns:'External_Career_Site' },
  { fn:'workday', company:'Costco',          tenant:'costco',           ns:'External'             },
  { fn:'workday', company:'Kroger',          tenant:'kroger',           ns:'External'             },
  { fn:'workday', company:'Lowe\'s',         tenant:'lowes',            ns:'External_Career_Site' },
  { fn:'workday', company:'Best Buy',        tenant:'bestbuy',          ns:'External'             },
  { fn:'workday', company:'Nike',            tenant:'nike',             ns:'External'             },
  { fn:'workday', company:'Gap Inc',         tenant:'gap',              ns:'External'             },
  { fn:'workday', company:'TJX Companies',   tenant:'tjx',              ns:'External'             },
  { fn:'workday', company:'Ross Stores',     tenant:'rossstores',       ns:'External'             },
  { fn:'workday', company:'Dollar General',  tenant:'dollargeneral',    ns:'External'             },
  { fn:'workday', company:'Dollar Tree',     tenant:'dollartree',       ns:'External'             },
  { fn:'workday', company:'Nordstrom',       tenant:'nordstrom',        ns:'External'             },
  { fn:'workday', company:'Kohl\'s',         tenant:'kohls',            ns:'External'             },
  { fn:'workday', company:'Macy\'s',         tenant:'macys',            ns:'External'             },
  { fn:'workday', company:'AutoNation',      tenant:'autonation',       ns:'External'             },
  { fn:'workday', company:'Advance Auto',    tenant:'advanceautoparts', ns:'External'             },
  { fn:'greenhouse', company:'Shopify',              token:'shopify'               },
  { fn:'greenhouse', company:'BigCommerce',          token:'bigcommerce'           },
  { fn:'greenhouse', company:'Wayfair',              token:'wayfair'               },
  { fn:'greenhouse', company:'eBay',                 token:'ebay'                  },
  { fn:'greenhouse', company:'Poshmark',             token:'poshmark'              },
  { fn:'lever',      company:'Instacart',            token:'maplebear'             },
  { fn:'lever',      company:'DoorDash',             token:'doordash'              },
  { fn:'lever',      company:'Grubhub',              token:'grubhub'               },

  // ══════════════════════════════════════════════════════════
  // 📡 TELECOM, MEDIA & ENTERTAINMENT
  // ══════════════════════════════════════════════════════════
  { fn:'workday', company:'Verizon',          tenant:'verizon',         ns:'External_Career_Site' },
  { fn:'workday', company:'AT&T',             tenant:'att',             ns:'External_Career_Site' },
  { fn:'workday', company:'T-Mobile',         tenant:'tmobile',         ns:'External_Career_Site' },
  { fn:'workday', company:'Comcast',          tenant:'comcast',         ns:'External'             },
  { fn:'workday', company:'Charter',          tenant:'charter',         ns:'External_Career_Site' },
  { fn:'workday', company:'Disney',           tenant:'disney',          ns:'External'             },
  { fn:'workday', company:'Warner Bros',      tenant:'warnermedia',     ns:'External'             },
  { fn:'workday', company:'NBCUniversal',     tenant:'nbcuniversal',    ns:'External'             },
  { fn:'workday', company:'Paramount',        tenant:'paramount',       ns:'External'             },
  { fn:'workday', company:'Discovery',        tenant:'wbd',             ns:'External'             },
  { fn:'workday', company:'Sirius XM',        tenant:'siriusxm',        ns:'External'             },
  { fn:'workday', company:'iHeartMedia',      tenant:'iheartmedia',     ns:'External'             },
  { fn:'workday', company:'News Corp',        tenant:'newscorp',        ns:'External'             },
  { fn:'workday', company:'Activision',       tenant:'activision',      ns:'External'             },
  { fn:'workday', company:'Electronic Arts',  tenant:'ea',              ns:'External'             },
  { fn:'greenhouse', company:'Netflix',              token:'netflix'               },
  { fn:'greenhouse', company:'Spotify',              token:'spotify'               },
  { fn:'lever',      company:'Riot Games',           token:'riotgames'             },
  { fn:'lever',      company:'Scopely',              token:'scopely'               },
  { fn:'lever',      company:'Zynga',                token:'zynga'                 },

  // ══════════════════════════════════════════════════════════
  // 🔧 CONSULTING & PROFESSIONAL SERVICES
  // ══════════════════════════════════════════════════════════
  { fn:'smartrecruiter', company:'Deloitte',          token:'Deloitte'              },
  { fn:'smartrecruiter', company:'Accenture',         token:'Accenture'             },
  { fn:'smartrecruiter', company:'PwC',               token:'PricewaterhouseCoopers'},
  { fn:'workday', company:'KPMG',           tenant:'kpmg',          ns:'External_Career_Site' },
  { fn:'workday', company:'EY',             tenant:'ey',            ns:'External'             },
  { fn:'workday', company:'McKinsey',       tenant:'mckinsey',      ns:'External'             },
  { fn:'workday', company:'Booz Allen',     tenant:'boozallencsn',  ns:'External'             },
  { fn:'workday', company:'Leidos',         tenant:'leidos',        ns:'External'             },
  { fn:'workday', company:'SAIC',           tenant:'saic',          ns:'External'             },
  { fn:'workday', company:'Gartner',        tenant:'gartner',       ns:'External'             },
  { fn:'workday', company:'Cognizant',      tenant:'cognizant',     ns:'External'             },
  { fn:'workday', company:'Capgemini',      tenant:'capgemini',     ns:'External'             },
  { fn:'workday', company:'Infosys',        tenant:'infosys',       ns:'External'             },
  { fn:'workday', company:'Wipro',          tenant:'wipro',         ns:'External'             },
  { fn:'workday', company:'ManTech',        tenant:'mantech',       ns:'External'             },
  { fn:'workday', company:'CACI',           tenant:'caci',          ns:'External'             },
  { fn:'workday', company:'Peraton',        tenant:'peraton',       ns:'External'             },
  { fn:'workday', company:'Jacobs',         tenant:'jacobs',        ns:'External'             },
  { fn:'lever',   company:'Kroll',          token:'kroll'                                      },
  { fn:'lever',   company:'GuidePoint Security',token:'guidepointsecurity'                    },
  { fn:'lever',   company:'NetSPI',         token:'netspi'                                     },
  { fn:'lever',   company:'Optiv Security', token:'optiv'                                      },
  { fn:'lever',   company:'Palantir',       token:'palantir'                                   },
  { fn:'lever',   company:'Anduril',        token:'anduril'                                    },
  { fn:'lever',   company:'Shield AI',      token:'shieldai'                                   },

  // ══════════════════════════════════════════════════════════
  // 🚗 AUTOMOTIVE, MOBILITY & LOGISTICS
  // ══════════════════════════════════════════════════════════
  { fn:'workday', company:'Tesla',          tenant:'tesla',         ns:'External'             },
  { fn:'workday', company:'Ford',           tenant:'ford',          ns:'External_Career_Site' },
  { fn:'workday', company:'General Motors', tenant:'generalmotors', ns:'External_Career_Site' },
  { fn:'workday', company:'Stellantis',     tenant:'stellantis',    ns:'External'             },
  { fn:'workday', company:'Toyota',         tenant:'toyota',        ns:'External'             },
  { fn:'workday', company:'FedEx',          tenant:'fedex',         ns:'External'             },
  { fn:'workday', company:'UPS',            tenant:'ups',           ns:'External'             },
  { fn:'workday', company:'XPO Logistics',  tenant:'xpo',           ns:'External'             },
  { fn:'workday', company:'J.B. Hunt',      tenant:'jbhunt',        ns:'External'             },
  { fn:'greenhouse', company:'Rivian',               token:'rivian'                },
  { fn:'greenhouse', company:'Lucid Motors',         token:'lucidmotors'           },
  { fn:'greenhouse', company:'Zoox',                 token:'zoox'                  },
  { fn:'lever',      company:'Waymo',                token:'waymo'                 },
  { fn:'lever',      company:'Cruise',               token:'cruise'                },
  { fn:'lever',      company:'Lyft',                 token:'lyft'                  },
  { fn:'lever',      company:'Uber',                 token:'uber'                  },

  // ══════════════════════════════════════════════════════════
  // ✈️ AEROSPACE & DEFENSE (civilian/commercial roles)
  // ══════════════════════════════════════════════════════════
  { fn:'workday', company:'Boeing',          tenant:'boeing',        ns:'External_Career_Site' },
  { fn:'workday', company:'Raytheon',        tenant:'raytheon',      ns:'External_Career_Site' },
  { fn:'workday', company:'Lockheed Martin', tenant:'lmco',          ns:'External_Career_Site' },
  { fn:'workday', company:'Northrop Grumman',tenant:'northropgrumman',ns:'External'            },
  { fn:'workday', company:'General Dynamics',tenant:'gd',            ns:'External'             },
  { fn:'workday', company:'L3Harris',        tenant:'l3harris',      ns:'External'             },
  { fn:'workday', company:'BAE Systems',     tenant:'baesystems',    ns:'External'             },

  // ══════════════════════════════════════════════════════════
  // ⚡ ENERGY, UTILITIES & INFRASTRUCTURE
  // ══════════════════════════════════════════════════════════
  { fn:'workday', company:'ExxonMobil',     tenant:'exxonmobil',    ns:'External'             },
  { fn:'workday', company:'Chevron',        tenant:'chevron',       ns:'External'             },
  { fn:'workday', company:'ConocoPhillips', tenant:'conocophillips',ns:'External'             },
  { fn:'workday', company:'Duke Energy',    tenant:'dukeenergy',    ns:'External'             },
  { fn:'workday', company:'NextEra Energy', tenant:'nextera',       ns:'External'             },
  { fn:'workday', company:'Dominion Energy',tenant:'dominionenergy',ns:'External'             },
  { fn:'workday', company:'Southern Company',tenant:'southernco',   ns:'External'             },
  { fn:'workday', company:'Xcel Energy',    tenant:'xcelenergy',    ns:'External'             },
  { fn:'workday', company:'Entergy',        tenant:'entergy',       ns:'External'             },
  { fn:'workday', company:'Consolidated Edison',tenant:'coned',     ns:'External'             },
  { fn:'workday', company:'Sempra',         tenant:'sempra',        ns:'External'             },
  { fn:'workday', company:'WEC Energy',     tenant:'wecenergygroup',ns:'External'             },

  // ══════════════════════════════════════════════════════════
  // 🏭 MANUFACTURING & INDUSTRIAL
  // ══════════════════════════════════════════════════════════
  { fn:'workday', company:'General Electric',tenant:'ge',           ns:'External'             },
  { fn:'workday', company:'Honeywell',       tenant:'honeywell',    ns:'External'             },
  { fn:'workday', company:'3M',              tenant:'3m',           ns:'External'             },
  { fn:'workday', company:'Caterpillar',     tenant:'caterpillar',  ns:'External'             },
  { fn:'workday', company:'Deere & Company', tenant:'deere',        ns:'External'             },
  { fn:'workday', company:'Emerson',         tenant:'emerson',      ns:'External'             },
  { fn:'workday', company:'Parker Hannifin', tenant:'parker',       ns:'External'             },
  { fn:'workday', company:'Illinois Tool Works',tenant:'itw',       ns:'External'             },
  { fn:'workday', company:'Eaton',           tenant:'eaton',        ns:'External'             },
  { fn:'workday', company:'Rockwell Collins',tenant:'rockwellcollins',ns:'External'           },
  { fn:'workday', company:'Siemens US',      tenant:'siemens',      ns:'External'             },
  { fn:'workday', company:'ABB',             tenant:'abb',          ns:'External'             },
  { fn:'workday', company:'Schneider Electric',tenant:'schneider',  ns:'External'             },

  // ══════════════════════════════════════════════════════════
  // 🏗 REAL ESTATE, CONSTRUCTION & FACILITIES
  // ══════════════════════════════════════════════════════════
  { fn:'workday', company:'CBRE',            tenant:'cbre',         ns:'External'             },
  { fn:'workday', company:'JLL',             tenant:'jll',          ns:'External'             },
  { fn:'workday', company:'Cushman & Wakefield',tenant:'cushman',   ns:'External'             },
  { fn:'lever',   company:'Airbnb',          token:'airbnb'                                    },

  // ══════════════════════════════════════════════════════════
  // 🎓 EDUCATION & EDTECH
  // ══════════════════════════════════════════════════════════
  { fn:'greenhouse', company:'Coursera',             token:'coursera'              },
  { fn:'greenhouse', company:'Udemy',                token:'udemy'                 },
  { fn:'greenhouse', company:'Duolingo',             token:'duolingo'              },
  { fn:'greenhouse', company:'Chegg',                token:'chegg'                 },
  { fn:'lever',      company:'Instructure',          token:'instructure'           },
  { fn:'lever',      company:'PowerSchool',          token:'powerschool'           },

  // ══════════════════════════════════════════════════════════
  // 📊 DATA, ANALYTICS & MARTECH
  // ══════════════════════════════════════════════════════════
  { fn:'greenhouse', company:'Palantir',             token:'palantir'              },
  { fn:'greenhouse', company:'Domo',                 token:'domo'                  },
  { fn:'lever',      company:'Mixpanel',             token:'mixpanel'              },
  { fn:'lever',      company:'Amplitude',            token:'amplitude'             },
  { fn:'lever',      company:'Segment',              token:'segment'               },
  { fn:'lever',      company:'mParticle',            token:'mparticle'             },
  { fn:'lever',      company:'Braze',                token:'braze'                 },
  { fn:'lever',      company:'Iterable',             token:'iterable'              },

  // ══════════════════════════════════════════════════════════
  // 🌐 INTERNET INFRASTRUCTURE
  // ══════════════════════════════════════════════════════════
  { fn:'greenhouse', company:'Cloudinary',           token:'cloudinary'            },
  { fn:'lever',      company:'NS1 (IBM)',             token:'ns1'                   },
  { fn:'lever',      company:'Limelight Networks',   token:'limelightnetworks'     },
  { fn:'lever',      company:'Zayo',                 token:'zayo'                  },


  // ══════════════════════════════════════════════════════════
  // 🆕 iCIMS COMPANIES
  // ══════════════════════════════════════════════════════════
  { fn:'icims', company:'Uber',               customerId:'4090'   },
  { fn:'icims', company:'FedEx',              customerId:'5936'   },
  { fn:'icims', company:'Marriott',           customerId:'474'    },
  { fn:'icims', company:'Lockheed Martin',    customerId:'3027'   },
  { fn:'icims', company:'Nike',               customerId:'1099'   },
  { fn:'icims', company:'Humana',             customerId:'2063'   },
  { fn:'icims', company:'3M',                 customerId:'1271'   },
  { fn:'icims', company:'Hertz',              customerId:'6701'   },
  { fn:'icims', company:'Unum Group',         customerId:'1232'   },
  { fn:'icims', company:'Assurant',           customerId:'2043'   },
  { fn:'icims', company:'Danaher',            customerId:'4782'   },
  { fn:'icims', company:'Masco',              customerId:'1819'   },
  { fn:'icims', company:'DXC Technology',     customerId:'6543'   },

  // ══════════════════════════════════════════════════════════
  // 🆕 JOBVITE COMPANIES
  // ══════════════════════════════════════════════════════════
  { fn:'jobvite', company:'Starbucks',        token:'Starbucks'   },
  { fn:'jobvite', company:'Sony',             token:'Sony'        },
  { fn:'jobvite', company:'Pandora',          token:'Pandora'     },
  { fn:'jobvite', company:'SolarWinds',       token:'SolarWinds'  },
  { fn:'jobvite', company:'Palo Alto Networks',token:'PaloAltoNetworks'},
  { fn:'jobvite', company:'Lam Research',     token:'LamResearch' },
  { fn:'jobvite', company:'NCR',              token:'NCR'         },
  { fn:'jobvite', company:'Extreme Networks', token:'ExtremeNetworks'},
  { fn:'jobvite', company:'LogRhythm',        token:'LogRhythm'   },

  // ══════════════════════════════════════════════════════════
  // 🆕 RIPPLING COMPANIES
  // ══════════════════════════════════════════════════════════
  { fn:'rippling', company:'Scale AI',        token:'scaleai'     },
  { fn:'rippling', company:'Benchling',       token:'benchling'   },
  { fn:'rippling', company:'Ironclad',        token:'ironclad'    },
  { fn:'rippling', company:'Persona',         token:'persona'     },
  { fn:'rippling', company:'Verkada',         token:'verkada'     },
  { fn:'rippling', company:'Rippling',        token:'rippling'    },

  // ══════════════════════════════════════════════════════════
  // 🆕 WORKABLE COMPANIES
  // ══════════════════════════════════════════════════════════
  { fn:'workable', company:'ZipRecruiter',    subdomain:'ziprecruiter'    },
  { fn:'workable', company:'Samsara',         subdomain:'samsara'         },
  { fn:'workable', company:'Corelight',       subdomain:'corelight'       },
  { fn:'workable', company:'Nile',            subdomain:'nilesecurity'    },
  { fn:'workable', company:'Prelude',         subdomain:'preludesecurity' },
  { fn:'workable', company:'Blumira',         subdomain:'blumira'         },
  { fn:'workable', company:'Red Canary',      subdomain:'redcanary'       },
  { fn:'workable', company:'LookingGlass',    subdomain:'lookingglass'    },
  { fn:'workable', company:'Sotero',          subdomain:'sotero'          },

  // ══════════════════════════════════════════════════════════
  // 🆕 BAMBOOHR COMPANIES
  // ══════════════════════════════════════════════════════════
  { fn:'bamboohr', company:'SolarWinds',      subdomain:'solarwinds'      },
  { fn:'bamboohr', company:'Instructure',     subdomain:'instructure'     },
  { fn:'bamboohr', company:'FreshBooks',      subdomain:'freshbooks'      },
  { fn:'bamboohr', company:'EZ Texting',      subdomain:'eztexting'       },
  { fn:'bamboohr', company:'Lucid',           subdomain:'lucid'           },
  { fn:'bamboohr', company:'MX Technologies',subdomain:'mx'               },

];

// ─── Main scrape orchestrator ─────────────────────────────────────────────
async function scrapeAll() {
  if (store.isRunning) return;
  store.isRunning = true;
  console.log(`\n[${new Date().toISOString()}] 🔍 Starting full scrape (${COMPANIES.length} companies)...`);

  const allRaw = [];
  const errors = [];
  const existingIds = new Set(store.jobs.map(j => j.id));

  // Process in controlled batches of 6 concurrent requests
  const BATCH = 6;
  for (let i = 0; i < COMPANIES.length; i += BATCH) {
    const batch = COMPANIES.slice(i, i + BATCH);
    await Promise.all(batch.map(async src => {
      try {
        let results = [];
        if      (src.fn === 'greenhouse')     results = await scrapeGreenhouse(src.company, src.token);
        else if (src.fn === 'lever')          results = await scrapeLever(src.company, src.token);
        else if (src.fn === 'workday')        results = await scrapeWorkday(src.company, src.tenant, src.ns);
        else if (src.fn === 'ashby')          results = await scrapeAshby(src.company, src.token);
        else if (src.fn === 'smartrecruiter') results = await scrapeSmartRecruiter(src.company, src.token);
        else if (src.fn === 'icims')          results = await scrapeIcims(src.company, src.customerId);
        else if (src.fn === 'jobvite')        results = await scrapeJobvite(src.company, src.token);
        else if (src.fn === 'rippling')       results = await scrapeRippling(src.company, src.token);
        else if (src.fn === 'teamtailor')     results = await scrapeTeamtailor(src.company, src.token);
        else if (src.fn === 'bamboohr')       results = await scrapeBamboohr(src.company, src.subdomain);
        else if (src.fn === 'workable')       results = await scrapeWorkable(src.company, src.subdomain);
        else if (src.fn === 'paycom')         results = await scrapePaycom(src.company, src.companyId);

        let passed = 0, blocked = 0;
        results.forEach(job => {
          const combined = (job.title + ' ' + job.desc).toLowerCase();
          if (isClearanceJob(combined))         { blocked++; store.stats.clearanceBlocked++; return; }
          if (!isCyberJob(job.title, job.desc)) { return; }
          const level  = levelOf(job.title);
          const salary = salaryOf(level, job.company);
          allRaw.push({ ...job, level, ...salary, isNew: !existingIds.has(job.id) });
          passed++;
        });


        store.stats.sources[src.company] = { passed, blocked, total: results.length };
        if (passed > 0 || results.length > 0)
          console.log(`  ✓ ${src.company}: ${passed} cyber jobs (${blocked} blocked / ${results.length} total)`);

      } catch (err) {
        errors.push({ company: src.company, error: err.message });
        // Silently skip — many Workday tenants need exact namespace or return 404
      }
    }));
    // small throttle between batches
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Job boards: LinkedIn (free) + JSearch + Adzuna + Indeed ─────────────
  // Catches every company regardless of which ATS they use internally,
  // including SAP SuccessFactors, Oracle Taleo, ADP, Ceridian, UKG, etc.
  try {
    const boardJobs = await runJobBoards();
    boardJobs.forEach(j => {
      if (!existingIds.has(j.id)) {
        const level  = levelOf(j.title);
        const salary = salaryOf(level, j.company);
        allRaw.push({ ...j, level, ...salary, isNew: true });
      } else {
        allRaw.push({ ...j, level: levelOf(j.title), ...salaryOf(levelOf(j.title), j.company), isNew: false });
      }
    });
    console.log(`[Job Boards] Added ${boardJobs.length} jobs from LinkedIn/JSearch/Adzuna/Indeed`);
  } catch (err) {
    console.log(`[Job Boards] Error: ${err.message}`);
  }

  // Deduplicate
  const seen = new Set();
  const deduped = allRaw.filter(j => {
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  });

  // Sort newest first
  deduped.sort((a, b) => {
    const at = a.postedAt ? new Date(a.postedAt).getTime() : 0;
    const bt = b.postedAt ? new Date(b.postedAt).getTime() : 0;
    return bt - at;
  });

  // Track which IDs are brand new this cycle
  store.newJobIds   = deduped.filter(j => j.isNew).map(j => j.id);
  store.jobs        = deduped;
  store.lastUpdated = new Date().toISOString();
  store.stats.total = deduped.length;
  store.isRunning   = false;

  store.log.unshift({
    time:      store.lastUpdated,
    total:     deduped.length,
    newJobs:   deduped.filter(j => j.isNew).length,
    companies: Object.keys(store.stats.sources).length,
    errors:    errors.length
  });
  store.log = store.log.slice(0, 30);

  console.log(`[${new Date().toISOString()}] ✅ Done: ${deduped.length} jobs from ${Object.keys(store.stats.sources).length} companies, ${errors.length} errors\n`);
}

// ─── API ──────────────────────────────────────────────────────────────────

app.get('/api/jobs', (req, res) => {
  const { q, location, level, salary, company, remote, type, limit=100, offset=0, since } = req.query;
  let jobs = [...store.jobs];
  if (q)       { const ql=q.toLowerCase(); jobs=jobs.filter(j=>(j.title+j.company+(j.desc||'')+(j.tags||[]).join(' ')).toLowerCase().includes(ql)); }
  if (location){ jobs=jobs.filter(j=>j.location.toLowerCase().includes(location.toLowerCase())); }
  if (level)   { jobs=jobs.filter(j=>j.level===level); }
  if (salary)  { jobs=jobs.filter(j=>j.salaryMin>=parseInt(salary)); }
  if (company) { jobs=jobs.filter(j=>j.company===company); }
  if (remote==='true') { jobs=jobs.filter(j=>j.remote); }
  if (type)    { jobs=jobs.filter(j=>(j.type||'').toLowerCase()===type.toLowerCase()); }
  if (since)   { const ms=new Date(since).getTime(); jobs=jobs.filter(j=>j.postedAt&&new Date(j.postedAt).getTime()>ms); }
  res.json({ jobs: jobs.slice(+offset, +offset + +limit), total: jobs.length, newJobIds: store.newJobIds, lastUpdated: store.lastUpdated, isRunning: store.isRunning });
});

app.get('/api/status', (req, res) => {
  res.json({
    lastUpdated:    store.lastUpdated,
    totalJobs:      store.jobs.length,
    isRunning:      store.isRunning,
    companiesTotal: COMPANIES.length,
    companiesDone:  Object.keys(store.stats.sources).length,
    clearanceBlocked: store.stats.clearanceBlocked,
    sources:        store.stats.sources,
    log:            store.log
  });
});

app.get('/api/companies', (req, res) => {
  const counts = {};
  store.jobs.forEach(j => { counts[j.company]=(counts[j.company]||0)+1; });
  res.json(Object.entries(counts).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count));
});

app.post('/api/scrape', (req, res) => {
  if (store.isRunning) return res.json({ status:'already_running' });
  scrapeAll();
  res.json({ status:'started', companies: COMPANIES.length });
});

// ─── Live Apply Counter API ──────────────────────────────────────────────

// GET /api/apply/counts — all current apply counts
app.get('/api/apply/counts', (req, res) => {
  res.json(applyCounts);
});

// POST /api/apply/:jobId — record an apply click, broadcast to all SSE clients
app.post('/api/apply/:jobId', (req, res) => {
  const id = req.params.jobId;
  applyCounts[id] = (applyCounts[id] || 0) + 1;
  saveApplyCounts();
  broadcastApply(id, applyCounts[id]);
  console.log(`[APPLY] ${id} → ${applyCounts[id]} total applications`);
  res.json({ jobId: id, count: applyCounts[id], ok: true });
});

// GET /api/apply/stream — SSE stream for real-time apply updates
app.get('/api/apply/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send current snapshot on connect
  res.write(`data: ${JSON.stringify({ type: 'init', counts: applyCounts })}\n\n`);

  sseClients.push(res);
  console.log(`[SSE] Apply stream client connected (${sseClients.length} total)`);

  // Heartbeat every 25s
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch(e) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients = sseClients.filter(c => c !== res);
    console.log(`[SSE] Client disconnected (${sseClients.length} remaining)`);
  });
});

// GET /api/apply/admin — simple admin page showing all counts
app.get('/api/apply/admin', (req, res) => {
  const rows = Object.entries(applyCounts)
    .sort((a,b) => b[1]-a[1])
    .map(([id,n]) => {
      const job = store.jobs.find(j => j.id === id);
      const name = job ? `${job.title} @ ${job.company}` : id;
      return `<tr><td>${name}</td><td style="color:#00d4ff;font-weight:700">${n}</td></tr>`;
    }).join('');
  res.send(`<!DOCTYPE html><html><head><title>ClearPath Apply Stats</title>
  <meta http-equiv="refresh" content="5">
  <style>
    body{font-family:monospace;padding:24px;background:#0c0c0f;color:#e0e0f0;margin:0}
    h1{color:#8b5cf6;margin-bottom:8px}p{color:#666;font-size:12px;margin-bottom:20px}
    table{border-collapse:collapse;width:100%;max-width:640px}
    td{padding:10px 14px;border-bottom:1px solid #1a1a24;font-size:13px}
    tr:hover td{background:#13131a}
  </style>
  </head><body>
  <h1>🛡 ClearPath — Live Apply Counts</h1>
  <p>SSE clients connected: <b style="color:#10b981">${sseClients.length}</b> &nbsp;·&nbsp; Total jobs tracked: <b>${Object.keys(applyCounts).length}</b> &nbsp;·&nbsp; Auto-refreshes every 5s</p>
  <table>
    <tr><th style="text-align:left;color:#6b7591;font-size:11px;padding:8px 14px">JOB</th><th style="text-align:left;color:#6b7591;font-size:11px;padding:8px 14px">APPLICATIONS</th></tr>
    ${rows || '<tr><td colspan="2" style="color:#444">No applications recorded yet</td></tr>'}
  </table>
  </body></html>`);
});

// ─── Cron: every 5 minutes ────────────────────────────────────────────────
cron.schedule('*/5 * * * *', () => {
  console.log('[CRON] 5-min tick');
  scrapeAll();
});

// ─── Serve index.html for all non-API routes ─────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(require('path').join(__dirname, 'public', 'index.html'));
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          ClearPath Jobs v2 — Backend Server                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Web UI:     http://localhost:${PORT}                            ║
║  Jobs API:   http://localhost:${PORT}/api/jobs                   ║
║  Status:     http://localhost:${PORT}/api/status                 ║
║  Companies:  ${COMPANIES.length} configured across all US sectors      ║
║  Cron:       Every 5 minutes                                  ║
║  Apply API:  http://localhost:${PORT}/api/apply/counts          ║
║  Apply SSE:  http://localhost:${PORT}/api/apply/stream          ║
║  Admin:      http://localhost:${PORT}/api/apply/admin           ║
╚═══════════════════════════════════════════════════════════════╝
`);
  scrapeAll();
});
