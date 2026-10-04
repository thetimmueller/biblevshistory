// Fetches biblical archaeology RSS feeds and writes news.json for the site.
// Runs on a schedule via .github/workflows/news.yml (no dependencies; Node 18+).
import { writeFile } from 'node:fs/promises';

const FEEDS = [
  { url: 'https://biblearchaeologyreport.com/feed/', source: 'Bible Archaeology Report', max: 4 },
  { url: 'https://www.biblicalarchaeology.org/feed/', source: 'Biblical Archaeology Society', max: 4 },
  {
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent(
      '"biblical archaeology" OR "Noah\'s Ark" OR "Dead Sea Scrolls" OR "Bible archaeology"'
    ) + '&hl=en-US&gl=US&ceid=US:en',
    source: 'Google News',
    max: 8
  }
];

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]).trim() : '';
};
const attr = (xml, name, a) => {
  const m = xml.match(new RegExp(`<${name}[^>]*\\s${a}=["']([^"']+)["']`));
  return m ? decode(m[1]) : '';
};
const stripHtml = s => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

async function fetchFeed(feed) {
  const resp = await fetch(feed.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; biblevshistory-news/1.0; +https://biblevshistory.com)' },
    signal: AbortSignal.timeout(20000)
  });
  const xml = await resp.text();
  if (!resp.ok || !xml.includes('<item')) throw new Error(`HTTP ${resp.status}, no RSS items`);

  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].slice(0, feed.max).map(([item]) => {
    let title = tag(item, 'title');
    // Google News items carry the publisher in <source> and append " - Publisher" to the title
    const publisher = feed.source === 'Google News' ? tag(item, 'source') : '';
    if (publisher && title.endsWith(' - ' + publisher)) title = title.slice(0, -(publisher.length + 3));
    const encoded = tag(item, 'content:encoded') || tag(item, 'description');
    const img = encoded.match(/<img[^>]+src=["']([^"']+)["']/);
    const excerpt = publisher ? '' : stripHtml(tag(item, 'description')).slice(0, 160);
    return {
      title,
      link: tag(item, 'link'),
      pubDate: new Date(tag(item, 'pubDate') || Date.now()).toISOString(),
      excerpt: excerpt ? excerpt + '…' : '',
      thumb: attr(item, 'media:thumbnail', 'url') || attr(item, 'media:content', 'url') || (img ? img[1] : ''),
      source: publisher || feed.source
    };
  });
}

const results = await Promise.allSettled(FEEDS.map(fetchFeed));
const articles = [];
results.forEach((r, i) => {
  if (r.status === 'fulfilled') articles.push(...r.value);
  else console.warn(`Skipped ${FEEDS[i].source}: ${r.reason.message}`);
});

// Dedupe by title, newest first
const seen = new Set();
const deduped = articles
  .filter(a => a.title && a.link && !seen.has(a.title.toLowerCase()) && seen.add(a.title.toLowerCase()))
  .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
  .slice(0, 12);

if (deduped.length === 0) {
  console.error('No articles fetched — leaving existing news.json untouched.');
  process.exit(0);
}
await writeFile('news.json', JSON.stringify({ updated: new Date().toISOString(), articles: deduped }, null, 2) + '\n');
console.log(`Wrote ${deduped.length} articles to news.json`);
