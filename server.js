const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const FH_TOKEN = process.env.FIREHOSE_TAP_TOKEN || 'fh_L9Y936WRE7Hq0CjcO9eQemYhgr3lYDnA1eJ55xD0';

app.use(express.static(path.join(__dirname, 'public')));

// Tag to category mapping
const TAG_MAP = {
  'real-estate': 'عقارات',
  'food-vegetables': 'غذاء و خضر',
  'fuel': 'وقود',
  'services': 'خدمات',
  'algerian-sources': 'مصادر جزائرية'
};

// Price extraction from Arabic and French text
function extractPrices(text) {
  if (!text) return [];
  const prices = [];
  const patterns = [
    // Arabic: 1,500 دج | 1500 DA | 15.000.000 دينار | 850,000 DZD
    /(\d[\d.,\s]*\d)\s*(دج|د\.ج|دينار|جزائري|DA|DZD)/gi,
    // Arabic millions/billions: 2 مليون | 15 مليار
    /(\d[\d.,]*)\s*(مليون|مليار|ملايين)\s*(سنتيم|دج|دينار)?/gi,
    // French: 1.500 DA | 2 500 000 DZD | 15,000 dinars
    /(\d[\d\s.,]*\d)\s*(DA|DZD|dinars?|millions?)\b/gi,
    // French price labels: prix: 1500 | tarif: 2000 | coût: 850
    /(prix|tarif|co[uû]t|montant)\s*[:=]\s*(\d[\d\s.,]*)\s*(DA|DZD|dinars?)?/gi,
    // Arabic price labels: سعر: 1500 | ثمن 2000
    /(سعر|ثمن|تكلفة|بسعر)\s*[:]*\s*(\d[\d\s.,]*)\s*(دج|DA|DZD|دينار)?/gi,
    // Standalone large numbers near currency context (e.g. "15 000 000")
    /\b(\d{1,3}(?:[\s.,]\d{3}){1,4})\s*(دج|DA|DZD)\b/gi,
    // Euro/USD amounts (some Algerian sites list in EUR)
    /(\d[\d\s.,]*)\s*(€|EUR|euros?)\b/gi
  ];

  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      const start = Math.max(0, m.index - 80);
      const end = Math.min(text.length, m.index + m[0].length + 80);
      const ctx = text.substring(start, end).replace(/\n/g, ' ').trim();
      prices.push({ value: m[0].trim(), context: ctx });
    }
  }
  // Deduplicate by value
  const seen = new Set();
  return prices.filter(p => {
    const key = p.value.replace(/\s/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10); // max 10 prices per page
}

// SSE endpoint that proxies Firehose and extracts prices
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('event: connected\ndata: {}\n\n');

  const since = req.query.since || '24h';
  const url = `https://api.firehose.com/v1/stream?timeout=300&since=${since}`;

  const options = {
    headers: { 'Authorization': `Bearer ${FH_TOKEN}` }
  };

  let buffer = '';
  let currentEvent = '';
  let currentId = '';

  const request = https.get(url, options, (upstream) => {
    upstream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (line.startsWith('id: ')) {
          currentId = line.slice(4).trim();
        } else if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const rawData = line.slice(6);

          if (currentEvent === 'update') {
            try {
              const parsed = JSON.parse(rawData);
              const doc = parsed.document || {};
              const tag = parsed.tag || findTag(parsed.query_id);
              const category = TAG_MAP[tag] || tag || 'عام';

              // Extract prices from markdown and title
              const allText = (doc.title || '') + ' ' + (doc.markdown || '');
              const prices = extractPrices(allText);

              const item = {
                id: currentId,
                category: category,
                tag: tag,
                title: doc.title || '',
                url: doc.url || '',
                time: parsed.matched_at || new Date().toISOString(),
                publishTime: doc.publish_time || '',
                language: doc.language || '',
                prices: prices,
                snippet: (doc.markdown || '').substring(0, 300)
              };

              res.write(`id: ${currentId}\nevent: price\ndata: ${JSON.stringify(item)}\n\n`);
            } catch (e) {
              // skip malformed
            }
          } else if (currentEvent === 'end') {
            res.write('event: end\ndata: {}\n\n');
          }
          currentEvent = '';
          currentId = '';
        }
      }
    });

    upstream.on('end', () => {
      res.write('event: end\ndata: {}\n\n');
      // Auto-reconnect after a brief pause
      setTimeout(() => {
        if (!res.destroyed) {
          res.write('event: reconnecting\ndata: {}\n\n');
        }
      }, 2000);
    });

    upstream.on('error', (err) => {
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    });
  });

  request.on('error', (err) => {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
  });

  req.on('close', () => {
    request.destroy();
  });
});

// Serve rules info
app.get('/api/rules', async (req, res) => {
  const options = {
    hostname: 'api.firehose.com',
    path: '/v1/rules',
    headers: { 'Authorization': `Bearer ${FH_TOKEN}` }
  };

  https.get(options, (upstream) => {
    let data = '';
    upstream.on('data', c => data += c);
    upstream.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch(e) { res.json({ error: 'Failed to fetch rules' }); }
    });
  }).on('error', (e) => res.json({ error: e.message }));
});

function findTag(queryId) {
  return ''; // tag comes from the stream data
}

app.listen(PORT, () => {
  console.log(`Algeria Price Tracker running on port ${PORT}`);
});
