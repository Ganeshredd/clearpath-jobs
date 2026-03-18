/**
 * ClearPath Jobs — job-boards.js
 * ─────────────────────────────────────────────────────────────────────────
 * Scrapes LinkedIn (free, no key), JSearch, Adzuna, and Indeed.
 * Catches every company regardless of which ATS they use internally —
 * SAP SuccessFactors, Oracle Taleo, ADP, Ceridian, UKG, Kenexa, etc.
 *
 * API Keys (add to a .env file or set as environment variables):
 *
 *   JSEARCH_KEY=xxx         RapidAPI key for JSearch  →  rapidapi.com/jsearch
 *                           Free: 200 req/month  Paid: $10–50/mo
 *                           Covers Indeed + LinkedIn + Glassdoor + ZipRecruiter
 *
 *   ADZUNA_APP_ID=xxx       Adzuna App ID   →  developer.adzuna.com  (free tier)
 *   ADZUNA_APP_KEY=xxx      Adzuna App Key
 *
 *   INDEED_KEY=xxx          Indeed Publisher ID  →  indeed.com/publisher  (free)
 *                           Note: Indeed is phasing out new Publisher signups.
 *                           Use JSearch if you can't get a key — it includes Indeed.
 *
 * LinkedIn works with ZERO API keys — uses their public guest endpoint.
 * All other boards are optional and additive.
 */

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');

// ─── Cyber search keywords ────────────────────────────────────────────────
const CYBER_TERMS = [
  'cybersecurity engineer',
  'security analyst',
  'security engineer',
  'penetration tester',
  'cloud security engineer',
  'threat intelligence analyst',
  'devsecops engineer',
  'incident response analyst',
  'application security engineer',
  'soc analyst',
  'red team engineer',
  'vulnerability researcher',
  'security architect',
  'detection engineer',
  'iam engineer',
  'malware analyst',
  'dfir analyst',
  'grc analyst',
  'network security engineer',
  'information security analyst',
];

// ─── Clearance deny list ──────────────────────────────────────────────────
const CLEARANCE_DENY = [
  'security clearance','clearance required','clearance preferred',
  'top secret','ts/sci','ts/sci eligible','secret clearance','active secret',
  'public trust','polygraph','dod clearance','dod secret','dod top secret',
  'cia ','nsa ','dhs clearance','government clearance','federal clearance',
  'classified information','q clearance','l clearance','nato secret',
  'sci eligible','sci eligibility','sensitive compartmented',
  'collateral clearance','national security clearance','must hold clearance',
  'obtain a clearance','ability to obtain a secret','interim clearance',
  'clearance sponsorship','special access program','sap access',
];

// ─── Cyber allow list ─────────────────────────────────────────────────────
const CYBER_ALLOW = [
  'security engineer','security analyst','security architect','security researcher',
  'security consultant','security specialist','security operations','security manager',
  'security director','security officer','ciso','head of security','principal security',
  'staff security','lead security','penetration test','pentesting','pen test',
  'ethical hack','red team','blue team','purple team','offensive security',
  'defensive security','threat intelligence','threat hunter','threat detection',
  'incident response','digital forensics','dfir','malware analyst','malware analysis',
  'vulnerability','soc analyst','soc engineer','detection engineer',
  'devsecops','appsec','application security','product security','platform security',
  'cloud security','network security','infrastructure security','endpoint security',
  'identity security','iam engineer','identity and access','zero trust',
  'information security','infosec','cybersecurity','cyber security',
  'grc analyst','governance risk','compliance engineer',
  'container security','kubernetes security','runtime security',
  'cryptography engineer','security data scientist','trust and safety',
  'bug bounty','privacy engineer','data security',
];

const TAG_POOL = [
  'SIEM','EDR','XDR','SOAR','Splunk','Elastic','CrowdStrike','SentinelOne',
  'AWS Security','GCP Security','Azure Security','Kubernetes','Terraform',
  'Python','Go','Rust','OWASP','Burp Suite','Metasploit','MITRE ATT&CK',
  'Zero Trust','SASE','ZTNA','IAM','OAuth','SAML','PKI','TLS','DFIR',
  'Forensics','Malware Analysis','Threat Intel','OSINT','Vulnerability Mgmt',
  'Pen Testing','Red Team','Detection Engineering','Sigma','YARA','KQL',
  'ISO 27001','SOC 2','PCI-DSS','HIPAA','FedRAMP','DevSecOps','CI/CD',
  'CSPM','CNAPP','IDS/IPS','Firewall','VPN','Incident Response','AppSec',
];

// ─── Helpers ──────────────────────────────────────────────────────────────
function isClearanceJob(text) {
  const t = (text || '').toLowerCase();
  return CLEARANCE_DENY.some(k => t.includes(k));
}

function isCyberJob(title, desc) {
  const t = ((title || '') + ' ' + (desc || '')).toLowerCase();
  return CYBER_ALLOW.some(k => t.includes(k));
}

function extractTags(text) {
  const lo = (text || '').toLowerCase();
  return TAG_POOL.filter(t => lo.includes(t.toLowerCase())).slice(0, 7);
}

function timeAgo(dateStr) {
  if (!dateStr) return 'Recently';
  const d = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (d < 120)   return `${d} seconds ago`;
  if (d < 3600)  return `${Math.floor(d / 60)} minutes ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} hours ago`;
  return `${Math.floor(d / 86400)} days ago`;
}

function isNewJob(dateStr) {
  if (!dateStr) return false;
  return Date.now() - new Date(dateStr).getTime() < 24 * 60 * 60 * 1000;
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').replace(/[\r\n\t]/g, ' ').trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────
// SCRAPER 1 — LinkedIn  (FREE — no API key needed)
// Uses LinkedIn's public guest job search endpoint.
// Covers every company that posts on LinkedIn — 95% of US employers.
// ─────────────────────────────────────────────────────────────────────────
async function scrapeLinkedIn(terms = CYBER_TERMS) {
  const jobs = [];
  const seen = new Set();

  console.log(`  [LinkedIn] Searching ${terms.length} keywords (free, no key)...`);

  for (const term of terms) {
    try {
      const { data } = await axios.get(
        'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search',
        {
          timeout: 12000,
          params: {
            keywords:  term,
            location:  'United States',
            f_TPR:     'r86400',    // last 24 hours
            f_JT:      'F,C',       // full-time + contract
            start:     0,
            count:     25,
          },
          headers: {
            'User-Agent':      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer':         'https://www.linkedin.com/jobs/search/',
          },
        }
      );

      const $ = cheerio.load(data);

      $('li').each((_, el) => {
        const $el   = $(el);
        const link  = $el.find('a.base-card__full-link, a.job-search-card__title-link').first();
        const href  = link.attr('href') || '';
        const idM   = href.match(/view\/(\d+)/);
        const id    = idM ? `li-${idM[1]}` : null;
        if (!id || seen.has(id)) return;

        const title    = clean($el.find('.base-search-card__title, .job-search-card__title').first().text());
        const company  = clean($el.find('.base-search-card__subtitle a, .job-search-card__company-name a, .job-search-card__company-name').first().text());
        const location = clean($el.find('.job-search-card__location').first().text());
        const postedAt = $el.find('time').attr('datetime') || null;

        if (!title) return;
        seen.add(id);

        jobs.push({
          id,
          title,
          company:   company || 'Unknown Company',
          location:  location || 'United States',
          type:      'Full-time',
          desc:      '',
          applyUrl:  href.split('?')[0] || `https://www.linkedin.com/jobs/view/${idM?.[1]}`,
          postedAt,
          postedAgo: timeAgo(postedAt),
          source:    'LinkedIn',
          remote:    /remote/i.test(location),
          tags:      extractTags(title),
          isNew:     isNewJob(postedAt),
        });
      });

      console.log(`    "${term}" → ${$('li').length} results`);
      await sleep(1500);   // polite delay

    } catch (err) {
      console.log(`    [LinkedIn] "${term}": ${err.message.slice(0, 60)}`);
      await sleep(3000);
    }
  }

  console.log(`  [LinkedIn] Collected ${jobs.length} raw jobs`);
  return jobs;
}

// ─────────────────────────────────────────────────────────────────────────
// SCRAPER 2 — JSearch via RapidAPI
// Aggregates Indeed + LinkedIn + Glassdoor + ZipRecruiter + 30+ sources.
// Free tier: 200 req/month.  Paid: $10–$50/mo.
// Sign up:  https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
// Set env:  JSEARCH_KEY=your_rapidapi_key
// ─────────────────────────────────────────────────────────────────────────
async function scrapeJSearch(terms = CYBER_TERMS.slice(0, 10)) {
  const key = process.env.JSEARCH_KEY;
  if (!key) {
    console.log('  [JSearch] Skipped — set JSEARCH_KEY env var to enable');
    return [];
  }

  const jobs = [];
  const seen = new Set();
  console.log(`  [JSearch] Searching ${terms.length} keywords...`);

  for (const term of terms) {
    try {
      const { data } = await axios.get('https://jsearch.p.rapidapi.com/search', {
        timeout: 12000,
        params: {
          query:            `${term} in United States no clearance`,
          page:             '1',
          num_pages:        '2',
          date_posted:      'today',
          employment_types: 'FULLTIME,CONTRACTOR',
        },
        headers: {
          'X-RapidAPI-Key':  key,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        },
      });

      (data.data || []).forEach(j => {
        const id = `js-${j.job_id}`;
        if (seen.has(id)) return;
        seen.add(id);

        const loc = j.job_city
          ? `${j.job_city}${j.job_state ? ', ' + j.job_state : ''}`
          : (j.job_country || 'United States');

        jobs.push({
          id,
          title:     clean(j.job_title),
          company:   clean(j.employer_name),
          location:  clean(loc),
          type:      j.job_employment_type || 'Full-time',
          desc:      clean(j.job_description || '').slice(0, 400),
          applyUrl:  j.job_apply_link || j.job_google_link || '#',
          postedAt:  j.job_posted_at_datetime_utc || null,
          postedAgo: timeAgo(j.job_posted_at_datetime_utc),
          source:    `JSearch / ${j.job_publisher || 'Indeed'}`,
          remote:    j.job_is_remote || false,
          tags:      extractTags((j.job_title || '') + ' ' + (j.job_description || '')),
          isNew:     isNewJob(j.job_posted_at_datetime_utc),
          salaryMin: j.job_min_salary ? Math.round(j.job_min_salary / 1000) : null,
          salaryMax: j.job_max_salary ? Math.round(j.job_max_salary / 1000) : null,
        });
      });

      await sleep(600);

    } catch (err) {
      console.log(`    [JSearch] "${term}": ${err.message.slice(0, 60)}`);
    }
  }

  console.log(`  [JSearch] Collected ${jobs.length} raw jobs`);
  return jobs;
}

// ─────────────────────────────────────────────────────────────────────────
// SCRAPER 3 — Adzuna  (free tier: 250 req/day)
// Sign up:  https://developer.adzuna.com
// Set env:  ADZUNA_APP_ID=xxx  ADZUNA_APP_KEY=xxx
// ─────────────────────────────────────────────────────────────────────────
async function scrapeAdzuna(terms = CYBER_TERMS.slice(0, 8)) {
  const appId  = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    console.log('  [Adzuna] Skipped — set ADZUNA_APP_ID + ADZUNA_APP_KEY env vars to enable');
    return [];
  }

  const jobs = [];
  const seen = new Set();
  console.log(`  [Adzuna] Searching ${terms.length} keywords...`);

  for (const term of terms) {
    try {
      const { data } = await axios.get(
        'https://api.adzuna.com/v1/api/jobs/us/search/1',
        {
          timeout: 12000,
          params: {
            app_id:           appId,
            app_key:          appKey,
            what:             term,
            where:            'united states',
            results_per_page: 50,
            sort_by:          'date',
            max_days_old:     1,
          },
        }
      );

      (data.results || []).forEach(j => {
        const id = `az-${j.id}`;
        if (seen.has(id)) return;
        seen.add(id);

        jobs.push({
          id,
          title:     clean(j.title),
          company:   clean(j.company?.display_name || 'Unknown Company'),
          location:  clean(j.location?.display_name || 'United States'),
          type:      clean(j.contract_time || 'Full-time'),
          desc:      clean(j.description || '').slice(0, 400),
          applyUrl:  j.redirect_url || '#',
          postedAt:  j.created || null,
          postedAgo: timeAgo(j.created),
          source:    'Adzuna',
          remote:    /remote/i.test(j.location?.display_name || ''),
          tags:      extractTags((j.title || '') + ' ' + (j.description || '')),
          isNew:     isNewJob(j.created),
          salaryMin: j.salary_min ? Math.round(j.salary_min / 1000) : null,
          salaryMax: j.salary_max ? Math.round(j.salary_max / 1000) : null,
        });
      });

      await sleep(400);

    } catch (err) {
      console.log(`    [Adzuna] "${term}": ${err.message.slice(0, 60)}`);
    }
  }

  console.log(`  [Adzuna] Collected ${jobs.length} raw jobs`);
  return jobs;
}

// ─────────────────────────────────────────────────────────────────────────
// SCRAPER 4 — Indeed Publisher API  (free — apply at indeed.com/publisher)
// Set env:  INDEED_KEY=your_publisher_id
// Note: Indeed is phasing out new Publisher API registrations.
//       JSearch (above) includes Indeed jobs if you can't get a key.
// ─────────────────────────────────────────────────────────────────────────
async function scrapeIndeed(terms = CYBER_TERMS.slice(0, 8)) {
  const key = process.env.INDEED_KEY;
  if (!key) {
    console.log('  [Indeed] Skipped — set INDEED_KEY env var to enable');
    return [];
  }

  const jobs = [];
  const seen = new Set();
  console.log(`  [Indeed] Searching ${terms.length} keywords...`);

  for (const term of terms) {
    try {
      const { data } = await axios.get('https://api.indeed.com/ads/apisearch', {
        timeout: 12000,
        params: {
          publisher:  key,
          q:          term,
          l:          'United States',
          sort:       'date',
          jt:         'fulltime',
          start:      0,
          limit:      25,
          fromage:    1,
          filter:     1,
          co:         'us',
          v:          '2',
          format:     'json',
          userip:     '1.2.3.4',
          useragent:  'ClearPathJobs/2.0',
        },
      });

      (data.results || []).forEach(j => {
        const id = `ind-${j.jobkey}`;
        if (seen.has(id)) return;
        seen.add(id);

        jobs.push({
          id,
          title:     clean(j.jobtitle),
          company:   clean(j.company),
          location:  clean(j.formattedLocation || j.city || 'United States'),
          type:      'Full-time',
          desc:      clean(j.snippet || '').slice(0, 400),
          applyUrl:  j.url || '#',
          postedAt:  j.date || null,
          postedAgo: timeAgo(j.date),
          source:    'Indeed',
          remote:    /remote/i.test(j.formattedLocation || ''),
          tags:      extractTags((j.jobtitle || '') + ' ' + (j.snippet || '')),
          isNew:     isNewJob(j.date),
        });
      });

      await sleep(400);

    } catch (err) {
      console.log(`    [Indeed] "${term}": ${err.message.slice(0, 60)}`);
    }
  }

  console.log(`  [Indeed] Collected ${jobs.length} raw jobs`);
  return jobs;
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN EXPORT — runJobBoards()
// Called automatically by server.js inside scrapeAll().
// Runs all four scrapers in parallel, merges, deduplicates, filters.
// ─────────────────────────────────────────────────────────────────────────
async function runJobBoards() {
  console.log('\n[Job Boards] Starting parallel job board scrape...');
  const t0 = Date.now();

  const results = await Promise.allSettled([
    scrapeLinkedIn(),
    scrapeJSearch(),
    scrapeAdzuna(),
    scrapeIndeed(),
  ]);

  const [liJobs, jsJobs, azJobs, inJobs] = results.map(r =>
    r.status === 'fulfilled' ? r.value : []
  );

  const all = [...liJobs, ...jsJobs, ...azJobs, ...inJobs];

  // Deduplicate by id
  const seen = new Set();
  const deduped = all.filter(j => {
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  });

  // Cyber-only, no clearance
  const filtered = deduped.filter(j => {
    const combined = (j.title + ' ' + j.desc).toLowerCase();
    return isCyberJob(j.title, j.desc) && !isClearanceJob(combined);
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[Job Boards] Done in ${elapsed}s — ` +
    `LinkedIn: ${liJobs.length} | JSearch: ${jsJobs.length} | Adzuna: ${azJobs.length} | Indeed: ${inJobs.length} ` +
    `→ ${filtered.length} cyber jobs after filtering\n`
  );

  return filtered;
}

module.exports = {
  runJobBoards,
  scrapeLinkedIn,
  scrapeJSearch,
  scrapeAdzuna,
  scrapeIndeed,
  isCyberJob,
  isClearanceJob,
  CYBER_TERMS,
};
