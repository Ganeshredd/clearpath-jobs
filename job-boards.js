
'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');

// ─── Cyber search terms ───────────────────────────────────────────────────
const CYBER_TERMS = [
  'cybersecurity engineer', 'security analyst', 'security engineer',
  'penetration tester', 'cloud security engineer', 'threat intelligence analyst',
  'devsecops engineer', 'incident response analyst', 'application security engineer',
  'soc analyst', 'red team engineer', 'vulnerability researcher',
  'security architect', 'detection engineer', 'iam engineer',
  'malware analyst', 'dfir analyst', 'grc analyst',
  'network security engineer', 'information security analyst',
];

const CLEARANCE_DENY = ['security clearance','clearance required','top secret','ts/sci','secret clearance','active secret','public trust','polygraph','dod clearance','classified information','q clearance','sci eligible','sensitive compartmented','national security clearance','special access program','sap access'];
const CYBER_ALLOW = ['security engineer','security analyst','security architect','security researcher','security consultant','security specialist','security operations','security manager','security director','security officer','ciso','head of security','principal security','staff security','lead security','penetration test','pentesting','pen test','ethical hack','red team','blue team','threat intelligence','threat hunter','incident response','digital forensics','dfir','malware analyst','vulnerability','soc analyst','soc engineer','detection engineer','devsecops','appsec','application security','product security','platform security','cloud security','network security','infrastructure security','endpoint security','identity security','iam engineer','zero trust','information security','infosec','cybersecurity','cyber security','grc analyst','compliance engineer','privacy engineer','data security','container security','siem engineer'];
const TAG_POOL = ['SIEM','EDR','XDR','SOAR','Splunk','Elastic','CrowdStrike','SentinelOne','AWS Security','GCP Security','Azure Security','Kubernetes','Terraform','Python','Go','Rust','OWASP','Burp Suite','MITRE ATT&CK','Zero Trust','IAM','OAuth','SAML','DFIR','Malware Analysis','Threat Intel','OSINT','Pen Testing','Red Team','Detection Engineering','Sigma','YARA','KQL','ISO 27001','SOC 2','PCI-DSS','HIPAA','DevSecOps','CSPM','CNAPP','AppSec','Cloud Security'];

const clean = s => (s||'').replace(/\s+/g,' ').replace(/[\r\n\t]/g,' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const extractTags = text => TAG_POOL.filter(t=>(text||'').toLowerCase().includes(t.toLowerCase())).slice(0,7);
const isClearanceJob = t => CLEARANCE_DENY.some(k=>(t||'').toLowerCase().includes(k));
const isCyberJob = (title,desc) => CYBER_ALLOW.some(k=>((title||'')+' '+(desc||'')).toLowerCase().includes(k));

function timeAgo(dateStr) {
  if (!dateStr) return 'Recently';
  const d = Math.floor((Date.now()-new Date(dateStr).getTime())/1000);
  if (d<120) return 'just now';
  if (d<3600) return `${Math.floor(d/60)} minutes ago`;
  if (d<86400) return `${Math.floor(d/3600)} hours ago`;
  return `${Math.floor(d/86400)} days ago`;
}

function isUSJob(loc) {
  const l = (loc||'').toLowerCase();
  if (!l||/^remote$/.test(l)||l.includes('united states')||l.includes('usa')||l.includes(' us')) return true;
  if (/\b(india|canada|uk|united kingdom|germany|france|australia|singapore|israel|brazil|mexico|china|japan|south korea)\b/.test(l)) return false;
  if (/remote.*emea|remote.*apac|remote.*india|remote.*canada|remote.*uk/.test(l)) return false;
  return true;
}

// ─── SOURCE 1: LinkedIn (FREE) ────────────────────────────────────────────
async function scrapeLinkedIn(terms = CYBER_TERMS) {
  const jobs = [], seen = new Set();
  console.log(`  [LinkedIn] Searching ${terms.length} keywords (free)...`);

  for (const term of terms) {
    try {
      const { data } = await axios.get(
        'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search',
        {
          timeout: 12000,
          params: { keywords:term, location:'United States', f_TPR:'r86400', f_JT:'F,C', start:0, count:25 },
          headers: { 'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', 'Accept-Language':'en-US,en;q=0.9', 'Referer':'https://www.linkedin.com/jobs/search/' }
        }
      );
      const $ = cheerio.load(data);
      $('li').each((_, el) => {
        const $el = $(el);
        const href = $el.find('a.base-card__full-link, a.job-search-card__title-link').first().attr('href')||'';
        const idM = href.match(/view\/(\d+)/);
        const id = idM ? `li-${idM[1]}` : null;
        if (!id||seen.has(id)) return;
        const title   = clean($el.find('.base-search-card__title, .job-search-card__title').first().text());
        const company = clean($el.find('.base-search-card__subtitle a, .job-search-card__company-name a, .job-search-card__company-name').first().text());
        const loc     = clean($el.find('.job-search-card__location').first().text());
        const postedAt = $el.find('time').attr('datetime')||null;
        if (!title) return;
        seen.add(id);
        jobs.push({ id, title, company:company||'Unknown', location:loc||'United States', type:'Full-time', desc:'', applyUrl:href.split('?')[0]||`https://www.linkedin.com/jobs/view/${idM?.[1]}`, postedAt, postedAgo:timeAgo(postedAt), source:'LinkedIn', remote:/remote/i.test(loc), tags:extractTags(title) });
      });
      await sleep(1500);
    } catch(e) { console.log(`    [LinkedIn] "${term}": ${e.message.slice(0,60)}`); await sleep(3000); }
  }
  console.log(`  [LinkedIn] ${jobs.length} jobs`);
  return jobs;
}

// ─── SOURCE 2: JSearch via RapidAPI ($10/mo → Indeed+Glassdoor+ZipRecruiter) ─
async function scrapeJSearch(terms = CYBER_TERMS.slice(0,10)) {
  const key = process.env.JSEARCH_KEY;
  if (!key) { console.log('  [JSearch] Skipped — set JSEARCH_KEY'); return []; }
  const jobs = [], seen = new Set();
  console.log(`  [JSearch] Searching ${terms.length} keywords...`);
  for (const term of terms) {
    try {
      const { data } = await axios.get('https://jsearch.p.rapidapi.com/search', {
        timeout: 12000,
        params: { query:`${term} in United States`, page:'1', num_pages:'2', date_posted:'today', employment_types:'FULLTIME,CONTRACTOR' },
        headers: { 'X-RapidAPI-Key':key, 'X-RapidAPI-Host':'jsearch.p.rapidapi.com' }
      });
      (data.data||[]).forEach(j => {
        const id = `js-${j.job_id}`;
        if (seen.has(id)) return;
        seen.add(id);
        const loc = j.job_city ? `${j.job_city}${j.job_state?', '+j.job_state:''}` : (j.job_country||'United States');
        jobs.push({ id, title:clean(j.job_title), company:clean(j.employer_name), location:clean(loc), type:j.job_employment_type||'Full-time', desc:clean(j.job_description||'').slice(0,400), applyUrl:j.job_apply_link||j.job_google_link||'#', postedAt:j.job_posted_at_datetime_utc||null, postedAgo:timeAgo(j.job_posted_at_datetime_utc), source:`JSearch/${j.job_publisher||'Indeed'}`, remote:j.job_is_remote||false, tags:extractTags((j.job_title||'')+' '+(j.job_description||'')), salaryMin:j.job_min_salary?Math.round(j.job_min_salary/1000):null, salaryMax:j.job_max_salary?Math.round(j.job_max_salary/1000):null });
      });
      await sleep(600);
    } catch(e) { console.log(`    [JSearch] "${term}": ${e.message.slice(0,60)}`); }
  }
  console.log(`  [JSearch] ${jobs.length} jobs`);
  return jobs;
}

// ─── SOURCE 3: Adzuna (FREE — 250 req/day) ───────────────────────────────
async function scrapeAdzuna(terms = CYBER_TERMS.slice(0,8)) {
  const appId = process.env.ADZUNA_APP_ID, appKey = process.env.ADZUNA_APP_KEY;
  if (!appId||!appKey) { console.log('  [Adzuna] Skipped — set ADZUNA_APP_ID + ADZUNA_APP_KEY'); return []; }
  const jobs = [], seen = new Set();
  console.log(`  [Adzuna] Searching ${terms.length} keywords...`);
  for (const term of terms) {
    try {
      const { data } = await axios.get('https://api.adzuna.com/v1/api/jobs/us/search/1', {
        timeout: 12000,
        params: { app_id:appId, app_key:appKey, what:term, where:'united states', results_per_page:50, sort_by:'date', max_days_old:1 }
      });
      (data.results||[]).forEach(j => {
        const id = `az-${j.id}`;
        if (seen.has(id)) return; seen.add(id);
        jobs.push({ id, title:clean(j.title), company:clean(j.company?.display_name||'Unknown'), location:clean(j.location?.display_name||'United States'), type:clean(j.contract_time||'Full-time'), desc:clean(j.description||'').slice(0,400), applyUrl:j.redirect_url||'#', postedAt:j.created||null, postedAgo:timeAgo(j.created), source:'Adzuna', remote:/remote/i.test(j.location?.display_name||''), tags:extractTags((j.title||'')+' '+(j.description||'')), salaryMin:j.salary_min?Math.round(j.salary_min/1000):null, salaryMax:j.salary_max?Math.round(j.salary_max/1000):null });
      });
      await sleep(400);
    } catch(e) { console.log(`    [Adzuna] "${term}": ${e.message.slice(0,60)}`); }
  }
  console.log(`  [Adzuna] ${jobs.length} jobs`);
  return jobs;
}

// ─── SOURCE 4: Indeed Publisher API (FREE) ────────────────────────────────
async function scrapeIndeed(terms = CYBER_TERMS.slice(0,8)) {
  const key = process.env.INDEED_KEY;
  if (!key) { console.log('  [Indeed] Skipped — set INDEED_KEY'); return []; }
  const jobs = [], seen = new Set();
  console.log(`  [Indeed] Searching ${terms.length} keywords...`);
  for (const term of terms) {
    try {
      const { data } = await axios.get('https://api.indeed.com/ads/apisearch', {
        timeout: 12000,
        params: { publisher:key, q:term, l:'United States', sort:'date', jt:'fulltime', start:0, limit:25, fromage:1, filter:1, co:'us', v:'2', format:'json', userip:'1.2.3.4', useragent:'ClearPathOS/3.0' }
      });
      (data.results||[]).forEach(j => {
        const id = `ind-${j.jobkey}`;
        if (seen.has(id)) return; seen.add(id);
        jobs.push({ id, title:clean(j.jobtitle), company:clean(j.company), location:clean(j.formattedLocation||j.city||'United States'), type:'Full-time', desc:clean(j.snippet||'').slice(0,400), applyUrl:j.url||'#', postedAt:j.date||null, postedAgo:timeAgo(j.date), source:'Indeed', remote:/remote/i.test(j.formattedLocation||''), tags:extractTags((j.jobtitle||'')+' '+(j.snippet||'')) });
      });
      await sleep(400);
    } catch(e) { console.log(`    [Indeed] "${term}": ${e.message.slice(0,60)}`); }
  }
  console.log(`  [Indeed] ${jobs.length} jobs`);
  return jobs;
}

// ─── SOURCE 5: Jobicy (FREE — remote cyber jobs API) ─────────────────────
// https://jobicy.com/jobs-rss-feed — completely free, no key needed
async function scrapeJobicy() {
  const jobs = [], seen = new Set();
  const searches = ['cybersecurity', 'security-engineer', 'information-security'];
  console.log('  [Jobicy] Fetching remote cyber jobs (free)...');
  for (const tag of searches) {
    try {
      const { data } = await axios.get(`https://jobicy.com/api/v2/remote-jobs?count=50&geo=usa&industry=it-security&tag=${tag}`, { timeout:10000 });
      (data.jobs||[]).forEach(j => {
        const id = `jcy-${j.id}`;
        if (seen.has(id)) return; seen.add(id);
        jobs.push({ id, title:clean(j.jobTitle), company:clean(j.companyName), location:clean(j.jobGeo||'Remote, US'), type:clean(j.jobType||'Full-time'), desc:clean(j.jobExcerpt||'').slice(0,400), applyUrl:j.url||'#', postedAt:j.pubDate||null, postedAgo:timeAgo(j.pubDate), source:'Jobicy', remote:true, tags:extractTags((j.jobTitle||'')+' '+(j.jobExcerpt||'')) });
      });
      await sleep(500);
    } catch(e) { console.log(`    [Jobicy] ${e.message.slice(0,60)}`); }
  }
  console.log(`  [Jobicy] ${jobs.length} jobs`);
  return jobs;
}

// ─── SOURCE 6: RemoteOK (FREE — remote security jobs) ────────────────────
// https://remoteok.com/api — free, no key needed
async function scrapeRemoteOK() {
  const jobs = [], seen = new Set();
  console.log('  [RemoteOK] Fetching remote security jobs (free)...');
  try {
    const { data } = await axios.get('https://remoteok.com/api?tag=security', {
      timeout: 12000,
      headers: { 'User-Agent':'Mozilla/5.0', 'Accept':'application/json' }
    });
    // First element is a legal notice, skip it
    (Array.isArray(data)?data.slice(1):[]).forEach(j => {
      if (!j.id||!j.position) return;
      const id = `rok-${j.id}`;
      if (seen.has(id)) return; seen.add(id);
      jobs.push({ id, title:clean(j.position), company:clean(j.company||'Unknown'), location:'Remote, US', type:'Full-time', desc:clean(j.description||'').replace(/<[^>]+>/g,'').slice(0,400), applyUrl:j.url||j.apply_url||'#', postedAt:j.date||null, postedAgo:timeAgo(j.date), source:'RemoteOK', remote:true, tags:extractTags((j.position||'')+' '+(j.tags||[]).join(' ')+' '+(j.description||'')) });
    });
  } catch(e) { console.log(`    [RemoteOK] ${e.message.slice(0,60)}`); }
  console.log(`  [RemoteOK] ${jobs.length} jobs`);
  return jobs;
}

// ─── SOURCE 7: USAJobs (FREE — official US gov jobs API) ─────────────────
// https://developer.usajobs.gov — free, register for key
// Covers DHS, NSA, FBI, CISA, DoD cyber roles WITHOUT clearance requirement
async function scrapeUSAJobs() {
  const key  = process.env.USAJOBS_KEY;   // register free: developer.usajobs.gov
  const email = process.env.USAJOBS_EMAIL;
  if (!key||!email) { console.log('  [USAJobs] Skipped — set USAJOBS_KEY + USAJOBS_EMAIL (free at developer.usajobs.gov)'); return []; }

  const jobs = [], seen = new Set();
  const keywords = ['cybersecurity', 'information security', 'cloud security', 'network security'];
  console.log('  [USAJobs] Fetching federal cyber jobs (free)...');

  for (const kw of keywords) {
    try {
      const { data } = await axios.get('https://data.usajobs.gov/api/search', {
        timeout: 12000,
        params: { Keyword:kw, JobCategoryCode:'2210', NumberOfResults:50, SortField:'OpenDate', SortDirection:'Desc', DatePosted:7 },
        headers: { 'Host':'data.usajobs.gov', 'User-Agent':email, 'Authorization-Key':key }
      });
      const results = data?.SearchResult?.SearchResultItems||[];
      results.forEach(item => {
        const j = item.MatchedObjectDescriptor;
        const id = `usa-${j.PositionID}`;
        if (seen.has(id)) return; seen.add(id);
        const desc = (j.UserArea?.Details?.JobSummary||j.PositionFormattedDescription?.[0]?.Content||'');
        // Skip clearance-required roles
        if (isClearanceJob(desc+' '+(j.PositionTitle||''))) return;
        jobs.push({ id, title:clean(j.PositionTitle), company:clean(j.OrganizationName||j.DepartmentName), location:clean(j.PositionLocation?.[0]?.LocationName||'United States'), type:clean(j.PositionSchedule?.[0]?.Name||'Full-time'), desc:clean(desc.replace(/<[^>]+>/g,'')).slice(0,400), applyUrl:j.ApplyURI?.[0]||j.PositionURI||'#', postedAt:j.PublicationStartDate||null, postedAgo:timeAgo(j.PublicationStartDate), source:'USAJobs', remote:/remote|telework/i.test(j.PositionLocation?.[0]?.LocationName||desc), tags:extractTags((j.PositionTitle||'')+' '+desc) });
      });
      await sleep(500);
    } catch(e) { console.log(`    [USAJobs] "${kw}": ${e.message.slice(0,60)}`); }
  }
  console.log(`  [USAJobs] ${jobs.length} jobs`);
  return jobs;
}

// ─── SOURCE 8: Himalayas (FREE — remote-first tech companies) ────────────
// https://himalayas.app/jobs/api — free, no key needed
async function scrapeHimalayas() {
  const jobs = [], seen = new Set();
  console.log('  [Himalayas] Fetching remote security jobs (free)...');
  try {
    const { data } = await axios.get('https://himalayas.app/jobs/api?q=security&limit=50', {
      timeout: 12000,
      headers: { 'Accept':'application/json' }
    });
    (data.jobs||[]).forEach(j => {
      const id = `hm-${j.id||j.slug}`;
      if (seen.has(id)) return; seen.add(id);
      jobs.push({ id, title:clean(j.title), company:clean(j.company?.name||'Unknown'), location:clean(j.locationRestrictions?.join(', ')||'Remote, US'), type:clean(j.jobType||'Full-time'), desc:clean(j.description||'').replace(/<[^>]+>/g,'').slice(0,400), applyUrl:j.applicationLink||`https://himalayas.app/jobs/${j.slug}`, postedAt:j.publishedAt||null, postedAgo:timeAgo(j.publishedAt), source:'Himalayas', remote:true, tags:extractTags((j.title||'')+' '+(j.description||'')) });
    });
  } catch(e) { console.log(`    [Himalayas] ${e.message.slice(0,60)}`); }
  console.log(`  [Himalayas] ${jobs.length} jobs`);
  return jobs;
}

// ─── SOURCE 9: JobsPikr (PAID — DT's likely provider, ~$200-500/mo) ──────
// Sign up: jobspikr.com — their "Live Jobs" feed
// This is how DT gets "150K+ live jobs, ≤5 min detection"
async function scrapeJobsPikr() {
  const user = process.env.JOBSPIKR_USER, pass = process.env.JOBSPIKR_PASS;
  if (!user||!pass) { console.log('  [JobsPikr] Skipped — set JOBSPIKR_USER + JOBSPIKR_PASS (paid, jobspikr.com)'); return []; }

  const jobs = [], seen = new Set();
  const queries = ['cybersecurity', 'security engineer', 'information security', 'cloud security', 'soc analyst'];
  console.log('  [JobsPikr] Fetching from real-time data feed...');

  for (const q of queries) {
    try {
      const { data } = await axios.get('https://api.jobspikr.com/v2/data', {
        timeout: 15000,
        auth: { username:user, password:pass },
        params: {
          job_title: q, job_country:'US', job_type:'fulltime',
          size: 100, date_range: '1d',
          fields: 'job_title,company_name,job_location,job_description,apply_url,post_date,is_remote,inferred_salary_currency,inferred_salary_time_unit,inferred_salary_from,inferred_salary_to'
        }
      });
      (data.job_data||data.hits||[]).forEach(j => {
        const id = `jp-${j.uniq_id||j._id||Math.random().toString(36).slice(2,10)}`;
        if (seen.has(id)) return; seen.add(id);
        jobs.push({ id, title:clean(j.job_title), company:clean(j.company_name), location:clean(j.job_location||'United States'), type:'Full-time', desc:clean(j.job_description||'').slice(0,400), applyUrl:j.apply_url||'#', postedAt:j.post_date||null, postedAgo:timeAgo(j.post_date), source:'JobsPikr', remote:j.is_remote||/remote/i.test(j.job_location||''), tags:extractTags((j.job_title||'')+' '+(j.job_description||'')), salaryMin:j.inferred_salary_from?Math.round(j.inferred_salary_from/1000):null, salaryMax:j.inferred_salary_to?Math.round(j.inferred_salary_to/1000):null });
      });
      await sleep(300);
    } catch(e) { console.log(`    [JobsPikr] "${q}": ${e.message.slice(0,60)}`); }
  }
  console.log(`  [JobsPikr] ${jobs.length} jobs`);
  return jobs;
}

// ─── SOURCE 10: Fantastic.jobs (PAID ~$99/mo — 54 ATS platforms) ─────────
// Covers SAP SuccessFactors, Oracle Taleo, ADP, Ceridian Dayforce, UKG,
// iCIMS, Bullhorn, Phenom People — every ATS your direct scraper misses
async function scrapeFantasticJobs() {
  const key = process.env.FANTASTIC_KEY;
  if (!key) { console.log('  [Fantastic.jobs] Skipped — set FANTASTIC_KEY (paid, fantastic.jobs/api)'); return []; }

  const jobs = [], seen = new Set();
  const queries = ['security engineer', 'cybersecurity', 'soc analyst', 'cloud security', 'devsecops', 'incident response', 'penetration test', 'threat intelligence'];
  console.log('  [Fantastic.jobs] Fetching from 54 ATS platforms...');

  for (const q of queries) {
    try {
      const { data } = await axios.get('https://fantastic.jobs/api/v2/jobs', {
        timeout: 15000,
        headers: { 'Authorization':`Bearer ${key}`, 'Content-Type':'application/json' },
        params: { q, country:'US', limit:100, datePostedAfter: new Date(Date.now()-86400000).toISOString().split('T')[0] }
      });
      (data.jobs||data.results||[]).forEach(j => {
        const id = `fj-${j.id||j.job_id}`;
        if (seen.has(id)) return; seen.add(id);
        jobs.push({ id, title:clean(j.title||j.job_title||''), company:clean(j.company||j.employer||''), location:clean(j.location||j.city||'United States'), type:j.employment_type||j.job_type||'Full-time', desc:clean(j.description||'').slice(0,400), applyUrl:j.apply_url||j.url||j.job_url||'#', postedAt:j.date_posted||j.published_at||j.created_at||null, postedAgo:timeAgo(j.date_posted||j.published_at), source:j.ats||j.source||'Fantastic.jobs', remote:j.remote||/remote/i.test(j.location||''), tags:extractTags((j.title||'')+' '+(j.description||'')), salaryMin:j.salary_min?Math.round(j.salary_min/1000):null, salaryMax:j.salary_max?Math.round(j.salary_max/1000):null });
      });
      await sleep(500);
    } catch(e) { console.log(`    [Fantastic.jobs] "${q}": ${e.message.slice(0,60)}`); }
  }
  console.log(`  [Fantastic.jobs] ${jobs.length} jobs`);
  return jobs;
}

// ─── SOURCE 11: Apify ATS Scrapers (PAY PER RUN — SAP/Oracle/ADP etc.) ───
// Covers ATS platforms that no direct API exists for:
//   SAP SuccessFactors, Oracle Taleo, ADP Workforce Now, Ceridian Dayforce
// Sign up: apify.com — $5 free credit/month covers ~500 job runs
async function scrapeApifyATS() {
  const token = process.env.APIFY_TOKEN;
  if (!token) { console.log('  [Apify] Skipped — set APIFY_TOKEN (apify.com, $5 free/mo)'); return []; }

  const jobs = [], seen = new Set();

  // Apify actors for ATS platforms DT covers that you can't scrape directly
  const actors = [
    { id:'apify~successfactors-jobs-scraper', name:'SuccessFactors', companies:['SAP','Boeing Internal','Cisco Internal'] },
    { id:'apify~oracle-recruiting-jobs-scraper', name:'Oracle Taleo', companies:['Oracle HCM customers'] },
  ];

  console.log('  [Apify] Running ATS scrapers...');
  for (const actor of actors) {
    try {
      // Start the actor run
      const run = await axios.post(
        `https://api.apify.com/v2/acts/${actor.id}/runs`,
        { query:'security', country:'US', maxJobs:200 },
        { headers:{'Authorization':`Bearer ${token}`}, timeout:10000 }
      );
      const runId = run.data?.data?.id;
      if (!runId) continue;

      // Wait for completion (poll every 5s, max 60s)
      let status = 'RUNNING';
      for (let i=0; i<12&&status==='RUNNING'; i++) {
        await sleep(5000);
        const s = await axios.get(`https://api.apify.com/v2/acts/${actor.id}/runs/${runId}`, { headers:{'Authorization':`Bearer ${token}`} });
        status = s.data?.data?.status;
      }

      // Fetch results
      const results = await axios.get(
        `https://api.apify.com/v2/acts/${actor.id}/runs/${runId}/dataset/items`,
        { headers:{'Authorization':`Bearer ${token}`}, params:{ limit:200 } }
      );
      (results.data||[]).forEach(j => {
        const id = `apify-${actor.name.replace(/\s/,'-').toLowerCase()}-${j.id||j.jobId||Math.random().toString(36).slice(2,8)}`;
        if (seen.has(id)) return; seen.add(id);
        jobs.push({ id, title:clean(j.title||j.jobTitle||''), company:clean(j.company||j.companyName||''), location:clean(j.location||'United States'), type:j.jobType||'Full-time', desc:clean(j.description||j.jobDescription||'').slice(0,400), applyUrl:j.applyUrl||j.url||'#', postedAt:j.datePosted||j.postedAt||null, postedAgo:timeAgo(j.datePosted||j.postedAt), source:actor.name, remote:j.remote||/remote/i.test(j.location||''), tags:extractTags((j.title||'')+' '+(j.description||'')) });
      });
      console.log(`    [Apify/${actor.name}] ${jobs.length} jobs`);
    } catch(e) { console.log(`    [Apify/${actor.name}] ${e.message.slice(0,60)}`); }
  }
  return jobs;
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────
async function runJobBoards() {
  console.log('\n[Job Boards] Starting parallel scrape across all sources...');
  const t0 = Date.now();

  // Run all free sources in parallel, paid sources separately
  const [liJobs, jsJobs, azJobs, inJobs, jcyJobs, rokJobs, usaJobs, hmJobs] = await Promise.all([
    scrapeLinkedIn().catch(e => { console.log('[LinkedIn] Error:', e.message); return []; }),
    scrapeJSearch().catch(e => { console.log('[JSearch] Error:', e.message); return []; }),
    scrapeAdzuna().catch(e => { console.log('[Adzuna] Error:', e.message); return []; }),
    scrapeIndeed().catch(e => { console.log('[Indeed] Error:', e.message); return []; }),
    scrapeJobicy().catch(e => { console.log('[Jobicy] Error:', e.message); return []; }),
    scrapeRemoteOK().catch(e => { console.log('[RemoteOK] Error:', e.message); return []; }),
    scrapeUSAJobs().catch(e => { console.log('[USAJobs] Error:', e.message); return []; }),
    scrapeHimalayas().catch(e => { console.log('[Himalayas] Error:', e.message); return []; }),
  ]);

  // Paid sources (sequential to manage rate limits)
  const jpJobs  = await scrapeJobsPikr().catch(e => { console.log('[JobsPikr] Error:', e.message); return []; });
  const fjJobs  = await scrapeFantasticJobs().catch(e => { console.log('[Fantastic] Error:', e.message); return []; });
  const apJobs  = await scrapeApifyATS().catch(e => { console.log('[Apify] Error:', e.message); return []; });

  const all = [...liJobs,...jsJobs,...azJobs,...inJobs,...jcyJobs,...rokJobs,...usaJobs,...hmJobs,...jpJobs,...fjJobs,...apJobs];

  // Deduplicate
  const seen = new Set();
  const deduped = all.filter(j => { if (seen.has(j.id)) return false; seen.add(j.id); return true; });

  // Filter: no clearance, US only, Jan 2026+
  const JAN_2026 = new Date('2026-01-01T00:00:00.000Z').getTime();
  const filtered = deduped.filter(j => {
    if (!isUSJob(j.location)) return false;
    const combined = (j.title+' '+j.desc).toLowerCase();
    if (isClearanceJob(combined)) return false;
    if (j.postedAt && new Date(j.postedAt).getTime() < JAN_2026) return false;
    return true;
  });

  const elapsed = ((Date.now()-t0)/1000).toFixed(1);
  console.log(
    `[Job Boards] Done in ${elapsed}s:\n` +
    `  LinkedIn:${liJobs.length} JSearch:${jsJobs.length} Adzuna:${azJobs.length} Indeed:${inJobs.length}\n` +
    `  Jobicy:${jcyJobs.length} RemoteOK:${rokJobs.length} USAJobs:${usaJobs.length} Himalayas:${hmJobs.length}\n` +
    `  JobsPikr:${jpJobs.length} Fantastic:${fjJobs.length} Apify:${apJobs.length}\n` +
    `  → ${filtered.length} cyber jobs after filtering\n`
  );

  return filtered;
}

module.exports = {
  runJobBoards, scrapeLinkedIn, scrapeJSearch, scrapeAdzuna, scrapeIndeed,
  scrapeJobicy, scrapeRemoteOK, scrapeUSAJobs, scrapeHimalayas,
  scrapeJobsPikr, scrapeFantasticJobs, scrapeApifyATS,
  isCyberJob, isClearanceJob, CYBER_TERMS
};
