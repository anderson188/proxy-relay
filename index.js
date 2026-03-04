const http = require('http');
const https = require('https');
const { URL } = require('url');

const API_KEY = process.env.RELAY_API_KEY || 'change-me-to-a-secret-key';
const PORT = process.env.PORT || 3100;

const NON_TRACKING_PARAMS = new Set(['page', 'lang', 'locale', 'country', 'ref']);

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  if (req.method !== 'POST' || !req.url.startsWith('/visit')) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'Not found' }));
  }

  const auth = req.headers['x-api-key'];
  if (auth !== API_KEY) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: 'Invalid API key' }));
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }

  const { affiliateUrl, proxyUrl } = parsed;
  if (!affiliateUrl || !proxyUrl) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Missing affiliateUrl or proxyUrl' }));
  }

  try {
    const result = await visitViaProxy(affiliateUrl, proxyUrl);
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
});

async function visitViaProxy(affiliateUrl, proxyUrl) {
  const { HttpsProxyAgent } = await import('https-proxy-agent');

  const proxyParsed = parseProxyUrl(proxyUrl);
  const agent = new HttpsProxyAgent(proxyParsed);

  let outboundIp = '';
  try {
    outboundIp = await checkIp(agent);
  } catch (e) {
    outboundIp = '检测失败: ' + e.message;
  }

  const affiliateHost = new URL(affiliateUrl).hostname;
  const NETWORK_HOSTS = ['awin1.com', 'awin.com', 'shareasale.com', 'prf.hn', 'pjtra.com', 'anrdoezrs.net', 'jdoqocy.com', 'tkqlhce.com', 'dpbolvw.net', 'kqzyfj.com'];

  let currentUrl = affiliateUrl;
  const hops = [];
  let lastLocation = '';
  const maxHops = 6;

  for (let i = 0; i < maxHops; i++) {
    const result = await doRequest(currentUrl, agent);
    hops.push(`[${i + 1}] HTTP ${result.statusCode} → ${currentUrl.substring(0, 150)}`);

    const loc = result.location;
    if (!loc || (result.statusCode >= 200 && result.statusCode < 300)) break;

    lastLocation = loc;

    try {
      const resolved = new URL(loc, currentUrl);
      const locHost = resolved.hostname;
      const isAffiliate = locHost === affiliateHost || NETWORK_HOSTS.some(d => locHost.endsWith(d));

      if (!isAffiliate && resolved.search.length > 1) {
        hops.push(`[停止] 已获取目标站参数，不再跟踪后续跳转（节省流量）`);
        break;
      }

      currentUrl = resolved.href;
    } catch {
      break;
    }
  }

  let params = '';
  if (lastLocation) {
    try {
      const url = new URL(lastLocation);
      const sp = new URLSearchParams(url.search);
      for (const key of NON_TRACKING_PARAMS) sp.delete(key);
      params = sp.toString();
    } catch {}
  }

  return { outboundIp, statusCode: hops.length > 0 ? parseInt(hops[hops.length - 1].match(/HTTP (\d+)/)?.[1] || '0') : 0, location: lastLocation, params, hops };
}

function parseProxyUrl(proxyUrl) {
  const match = proxyUrl.match(/^(.+):(.+)@(.+):(\d+)$/);
  if (!match) throw new Error('Invalid proxy format. Expected: user:pass@host:port');
  return `http://${match[1]}:${match[2]}@${match[3]}:${match[4]}`;
}

function checkIp(agent) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://ipinfo.io/json', { agent, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          resolve(`${info.ip} (${info.city || '?'}, ${info.region || '?'}, ${info.country || '?'})`);
        } catch {
          resolve(data.trim());
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function doRequest(url, agent) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      agent,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      res.destroy();
      resolve({
        statusCode: res.statusCode,
        location: res.headers['location'] || '',
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

server.listen(PORT, () => {
  console.log(`Proxy relay running on port ${PORT}`);
  console.log(`API Key: ${API_KEY.substring(0, 4)}****`);
});
