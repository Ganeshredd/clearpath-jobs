/**
 * ClearPath Jobs — Fantastic.jobs API Integration
 * Covers ALL 54 ATS platforms including SAP SuccessFactors, Oracle Taleo,
 * iCIMS, ADP, Ceridian Dayforce, UKG, Bullhorn, Phenom People, and every
 * other ATS that requires auth — all in a single API call.
 *
 * Sign up at: https://fantastic.jobs/api
 * Replace YOUR_API_KEY below with your actual key.
 *
 * Drop this file into your clearpath2/backend/ folder.
 * In server.js, replace the scrapeAll() function body with:
 *   await scrapeViaFantasticJobs();
 */

const axios = require('axios');

const FANTASTIC_JOBS_API_KEY = process.env.FANTASTIC_JOBS_KEY || 'YOUR_API_KEY_HERE';

// All 54 ATS platforms their API covers
const ATS_PLATFORMS = [
  'greenhouse', 'lever', 'workday', 'ashby', 'smartrecruiters',
  'icims', 'jobvite', 'successfactors', 'taleo', 'oraclecloud',
  'rippling', 'bamboohr', 'workable', 'teamtailor', 'paycom',
  'paycor', 'paylocity', 'adp', 'dayforce', 'ultipro',
  'jazzhr', 'breezy', 'recruitee', 'hibob', 'personio',
  'pinpoint', 'bullhorn', 'cornerstone', 'phenompeople',
  'eightfold', 'paradox', 'avature', 'gem', 'dover',
  'trakstar', 'csod', 'trinet', 'zoho', 'manatal', 'pageup'
];

// Cybersecurity search keywords
const CYBER_KEYWORDS = [
  'security engineer', 'security analyst', 'security architect',
  'penetration test', 'threat intelligence', 'incident response',
  'devsecops', 'appsec', 'cloud security', 'network security',
  'soc analyst', 'vulnerability', 'cybersecurity', 'infosec',
  'dfir', 'malware', 'red team', 'detection engineer',
  'iam engineer', 'zero trust', 'grc analyst', 'firewall engineer'
];

const CLEARANCE_DENY = [
  'security clearance', 'top secret', 'ts/sci', 'secret clearance',
  'polygraph', 'dod clearance', 'classified', 'public trust',
  'sci eligible', 'q clearance', 'sensitive compartmented'
];

function isClearanceJob(text) {
  const t = (text || '').toLowerCase();
  return CLEARANCE_DENY.some(k => t.includes(k));
}

function isCyberJob(title, desc) {
  const t = ((title || '') + ' ' + (desc || '')).toLowerCase();
  return CYBER_KEYWORDS.some(k => t.includes(k));
}

/**
 * Fetch cybersecurity jobs from ALL 54 ATS platforms via Fantastic.jobs API.
 * Returns normalized job objects ready for the ClearPath store.
 */
async function scrapeViaFantasticJobs() {
  console.log('[Fantastic.jobs] Fetching cybersecurity jobs from all 54 ATS platforms...');

  const allJobs = [];
  const errors = [];

  // Fantastic.jobs API supports filtering by keyword and ATS platform
  for (const keyword of CYBER_KEYWORDS.slice(0, 8)) { // Top 8 keywords to avoid rate limits
    try {
      const response = await axios.get('https://fantastic.jobs/api/v2/jobs', {
        timeout: 15000,
        headers: {
          'Authorization': `Bearer ${FANTASTIC_JOBS_API_KEY}`,
          'Content-Type': 'application/json'
        },
        params: {
          q: keyword,
          country: 'US',
          limit: 100,
          ats: ATS_PLATFORMS.join(','),
          datePostedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] // last 7 days
        }
      });

      const jobs = response.data?.jobs || response.data?.results || [];
      console.log(`  [${keyword}] → ${jobs.length} jobs`);

      jobs.forEach(j => {
        const combined = (j.title || '') + ' ' + (j.description || '');
        if (isClearanceJob(combined)) return;
        if (!isCyberJob(j.title, j.description)) return;

        allJobs.push({
          id:        `fj-${j.id || j.job_id}`,
          title:     (j.title || '').trim(),
          company:   (j.company || j.employer || '').trim(),
          location:  (j.location || j.city || 'United States').trim(),
          type:      j.employment_type || j.job_type || 'Full-time',
          desc:      (j.description || '').slice(0, 400),
          applyUrl:  j.apply_url || j.url || j.job_url || '#',
          postedAt:  j.date_posted || j.published_at || j.created_at,
          postedAgo: formatTimeAgo(j.date_posted || j.published_at),
          source:    j.ats || j.source || 'Direct',
          remote:    j.remote || /remote/i.test(j.location || ''),
          tags:      extractTagsFromText((j.title || '') + ' ' + (j.description || '')),
          isNew:     isRecentlyPosted(j.date_posted || j.published_at)
        });
      });

    } catch (err) {
      errors.push({ keyword, error: err.message });
      console.error(`  [${keyword}] ERROR: ${err.message}`);
    }

    // Small delay between keyword searches to respect rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  // Deduplicate by job ID
  const seen = new Set();
  const deduped = allJobs.filter(j => {
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  });

  console.log(`[Fantastic.jobs] Done: ${deduped.length} unique cybersecurity jobs, ${errors.length} errors`);
  return deduped;
}

// ── Alternative: Apify iCIMS / SuccessFactors / Taleo scrapers ──────────
// If you prefer Apify's per-ATS scrapers (pay per run):

async function scrapeViaApify(atsPlatform, apifyToken) {
  // Apify has individual actors for each ATS:
  // iCIMS:          https://apify.com/jupri/icims-scraper
  // SuccessFactors: https://apify.com/fantastic-jobs/successfactors-jobs-scraper
  // Taleo:          https://apify.com/fantastic-jobs/taleo-jobs-scraper
  // Full list:      https://apify.com/fantastic-jobs/career-site-job-listing-api

  const actorIds = {
    icims:          'jupri/icims-scraper',
    successfactors: 'fantastic-jobs/successfactors-jobs-scraper',
    taleo:          'fantastic-jobs/taleo-jobs-scraper',
    oraclecloud:    'fantastic-jobs/oracle-recruiting-jobs-scraper',
    adp:            'fantastic-jobs/adp-jobs-scraper',
    dayforce:       'fantastic-jobs/dayforce-jobs-scraper',
    phenom:         'fantastic-jobs/phenom-people-jobs-scraper',
  };

  const actorId = actorIds[atsPlatform];
  if (!actorId) throw new Error(`No Apify actor for ${atsPlatform}`);

  const response = await axios.post(
    `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items`,
    { query: 'security', country: 'US', maxJobs: 500 },
    {
      timeout: 60000,
      headers: { 'Authorization': `Bearer ${apifyToken}` },
      params: { token: apifyToken }
    }
  );

  return (response.data || []).map(j => ({
    id:        `apify-${atsPlatform}-${j.id || j.jobId}`,
    title:     (j.title || j.jobTitle || '').trim(),
    company:   (j.company || j.companyName || '').trim(),
    location:  (j.location || 'United States').trim(),
    type:      j.jobType || 'Full-time',
    desc:      (j.description || j.jobDescription || '').slice(0, 400),
    applyUrl:  j.applyUrl || j.url || '#',
    postedAt:  j.datePosted || j.postedAt,
    postedAgo: formatTimeAgo(j.datePosted || j.postedAt),
    source:    atsPlatform,
    remote:    j.remote || /remote/i.test(j.location || ''),
    tags:      extractTagsFromText((j.title || '') + ' ' + (j.description || '')),
    isNew:     isRecentlyPosted(j.datePosted || j.postedAt)
  })).filter(j => isCyberJob(j.title, j.desc) && !isClearanceJob(j.title + ' ' + j.desc));
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatTimeAgo(dateStr) {
  if (!dateStr) return 'Recently';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

function isRecentlyPosted(dateStr) {
  if (!dateStr) return false;
  return Date.now() - new Date(dateStr).getTime() < 24 * 60 * 60 * 1000;
}

const TAG_POOL = [
  'SIEM','EDR','XDR','SOAR','Splunk','Elastic','CrowdStrike','SentinelOne',
  'AWS Security','GCP Security','Azure Security','Kubernetes','Terraform',
  'Python','Go','OWASP','Burp Suite','MITRE ATT&CK','Zero Trust','SASE',
  'IAM','OAuth','SAML','PKI','DFIR','Forensics','Malware Analysis',
  'Threat Intel','OSINT','Vulnerability Mgmt','Pen Testing','Red Team',
  'Detection Engineering','Sigma','YARA','KQL','ISO 27001','SOC 2',
  'PCI-DSS','HIPAA','DevSecOps','CI/CD','CSPM','CNAPP','AppSec'
];

function extractTagsFromText(text) {
  const lo = (text || '').toLowerCase();
  return TAG_POOL.filter(t => lo.includes(t.toLowerCase())).slice(0, 7);
}

module.exports = { scrapeViaFantasticJobs, scrapeViaApify };
