// Cloudflare Worker: ah-proxy + KV cloud sync
// Bindings required:
//   RECEPTEN_KV  — KV namespace "recepten-state"
//   SYNC_SECRET  — Secret text variable

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function checkSecret(url, env) {
  return url.searchParams.get('secret') === env.SYNC_SECRET;
}

// ── KV cloud sync ─────────────────────────────────────────────────────────────

async function handleLoad(env) {
  const data = await env.RECEPTEN_KV.get('state');
  if (!data) return json({ empty: true });
  return new Response(data, {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function handleSave(request, env) {
  const body = await request.text();
  try { JSON.parse(body); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
  await env.RECEPTEN_KV.put('state', body);
  return json({ ok: true });
}

// ── AH product search ─────────────────────────────────────────────────────────

function parseUnitSize(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  const patterns = [
    /(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg|cl)/i,
    /(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l)\b/i,
    /(\d+)\s*stuks?\b/i,
    /(\d+)\s*rollen?\b/i,
    /(\d+)\s*zakjes?\b/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return m[0].trim();
  }
  return null;
}

function findProducts(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return [];
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj[0] && typeof obj[0] === 'object' && 'webshopId' in obj[0]) {
      return obj;
    }
    for (const item of obj) {
      const found = findProducts(item, depth + 1);
      if (found.length > 0) return found;
    }
    return [];
  }
  for (const val of Object.values(obj)) {
    const found = findProducts(val, depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

async function handleSearch(query) {
  const searchUrl = `https://www.ah.nl/zoeken?query=${encodeURIComponent(query)}&sortBy=RELEVANCE`;
  let html;
  try {
    const resp = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'nl-NL,nl;q=0.9',
        'Referer': 'https://www.ah.nl/',
      },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    html = await resp.text();
  } catch (e) {
    return json({ error: 'AH niet bereikbaar: ' + e.message });
  }

  // Try __NEXT_DATA__
  const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const nextData = JSON.parse(nextMatch[1]);
      const products = findProducts(nextData);
      if (products.length > 0) {
        const results = products.slice(0, 20).map(p => {
          let image = null;
          if (p.images && p.images[0]) {
            image = p.images[0].url || p.images[0];
          } else if (p.image) {
            image = p.image.url || p.image;
          }
          let price = null;
          if (p.priceBeforeBonus != null) price = (p.priceBeforeBonus / 100).toFixed(2);
          else if (p.currentPrice != null) price = (p.currentPrice / 100).toFixed(2);
          else if (p.price != null) price = typeof p.price === 'object' ? (p.price.now / 100).toFixed(2) : (p.price / 100).toFixed(2);

          const unitSize = p.unitSize || p.salesUnitSize || p.contentUnit || parseUnitSize(p.title);

          return {
            id: p.webshopId || p.id,
            name: p.title,
            image,
            price,
            unitSize,
            url: p.webshopId ? `https://www.ah.nl/producten/product/wi${p.webshopId}` : null,
          };
        }).filter(p => p.id && p.title);
        return json({ results });
      }
    } catch (e) {}
  }

  // Fallback: scrape wi-links from raw HTML
  const wiPattern = /href="\/producten\/product\/(wi\d+)/g;
  const ids = [...new Set([...html.matchAll(wiPattern)].map(m => m[1]))].slice(0, 12);
  if (ids.length > 0) {
    return json({ results: ids.map(wiId => ({
      id: wiId.replace(/^wi/, ''),
      name: wiId,
      url: `https://www.ah.nl/producten/product/${wiId}`
    })) });
  }

  return json({ results: [] });
}

// ── Proxy individual product pages ────────────────────────────────────────────

async function handleProxy(targetUrl) {
  const allowed = ['www.ah.nl', 'ah.nl', 'static.ah.nl'];
  let parsed;
  try { parsed = new URL(targetUrl); } catch (e) { return json({ error: 'invalid url' }, 400); }
  if (!allowed.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
    return json({ error: 'domain not allowed' }, 403);
  }
  try {
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'nl-NL,nl;q=0.9',
        'Referer': 'https://www.ah.nl/',
      },
    });
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: {
        ...CORS,
        'Content-Type': resp.headers.get('content-type') || 'text/html',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (e) {
    return json({ error: e.message });
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const query = url.searchParams.get('query');
    const proxyUrl = url.searchParams.get('url');

    // Cloud sync endpoints (require secret)
    if (action === 'load') {
      if (!checkSecret(url, env)) return json({ error: 'unauthorized' }, 401);
      return handleLoad(env);
    }
    if (action === 'save' && request.method === 'POST') {
      if (!checkSecret(url, env)) return json({ error: 'unauthorized' }, 401);
      return handleSave(request, env);
    }

    // AH search
    if (query) return handleSearch(query);

    // AH proxy
    if (proxyUrl) return handleProxy(proxyUrl);

    return new Response('ah-proxy + cloud sync worker v6', { headers: CORS });
  },
};
