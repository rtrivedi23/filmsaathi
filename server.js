// FilmSaathi — Bollywood Movie Suggester for Couples
// Requires Node.js 18+ (for native fetch)

require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TMDB_BASE = 'https://api.themoviedb.org/3';

// ─── Groq: Suggest 5 movies ───────────────────────────────────────────────────
app.post('/api/suggest', async (req, res) => {
  try {
    const { person1, person2 } = req.body;

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY is not set in .env' });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const prompt = `You are a Bollywood film expert recommending movies for a couple with different tastes.

Person 1 preferences:
- Genre: ${person1.genre}
- Mood: ${person1.mood}
- Era: ${person1.era}
- Language: ${person1.language}
- Runtime: ${person1.runtime}

Person 2 preferences:
- Genre: ${person2.genre}
- Mood: ${person2.mood}
- Era: ${person2.era}
- Language: ${person2.language}
- Runtime: ${person2.runtime}

Find 5 Bollywood movies that BOTH people would genuinely enjoy. Prioritise real common ground over compromise. Be specific — use exact, well-known film titles.

Return ONLY valid JSON in this exact structure:
{"recommendations":[{"title":"Exact Movie Title","year":2019,"score":92,"reason":"Short reason under 12 words"},{"title":"Exact Movie Title","year":2015,"score":85,"reason":"Short reason under 12 words"},{"title":"Exact Movie Title","year":2010,"score":80,"reason":"Short reason under 12 words"},{"title":"Exact Movie Title","year":2017,"score":75,"reason":"Short reason under 12 words"},{"title":"Exact Movie Title","year":2008,"score":68,"reason":"Short reason under 12 words"}]}

Rules:
- First item = TOP PICK (highest score)
- Scores range 60-100
- Only real, widely-known Bollywood films
- Keep each reason under 12 words, no special characters or quotes inside reason`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You are a Bollywood film expert. You always respond with valid JSON only — no markdown, no extra text, no explanation.'
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2048,
      temperature: 0.7,
      response_format: { type: 'json_object' }
    });

    const text = completion.choices[0].message.content.trim();
    console.log('📦 Groq raw response:', text.slice(0, 200));

    const data = JSON.parse(text);
    res.json(data);
  } catch (err) {
    console.error('❌ /api/suggest error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── TMDB + Wikipedia: Enrich movies with poster, details, streaming ──────────
app.post('/api/movies', async (req, res) => {
  try {
    const { movies } = req.body;

    if (!process.env.TMDB_API_KEY) {
      return res.status(500).json({ error: 'TMDB_API_KEY is not set in .env' });
    }

    const results = await Promise.all(
      movies.map(m => fetchMovieDetails(m, process.env.TMDB_API_KEY))
    );
    res.json({ movies: results });
  } catch (err) {
    console.error('❌ /api/movies error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function fetchMovieDetails(movie, apiKey) {
  try {
    const query = encodeURIComponent(movie.title);

    const safeJson = async (url) => {
      try {
        const r = await fetch(url);
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) return null;
        return await r.json();
      } catch (e) {
        return null;
      }
    };

    // Search TMDB
    let searchUrl = `${TMDB_BASE}/search/movie?api_key=${apiKey}&query=${query}&language=en-US`;
    if (movie.year) searchUrl += `&year=${movie.year}`;

    let searchData = await safeJson(searchUrl);

    // TMDB blocked — use Wikipedia only
    if (!searchData) {
      const poster = await fetchWikipediaPoster(movie.title, movie.year);
      return { ...movie, poster, overview: '', rating: null, runtime: null, genres: [], streaming: [] };
    }

    if (!searchData.results?.length && movie.year) {
      const retryUrl = `${TMDB_BASE}/search/movie?api_key=${apiKey}&query=${query}&language=en-US`;
      searchData = await safeJson(retryUrl) || searchData;
    }

    const found = searchData.results?.[0];
    if (!found) {
      const poster = await fetchWikipediaPoster(movie.title, movie.year);
      return { ...movie, poster, overview: '', rating: null, runtime: null, genres: [], streaming: [] };
    }

    const [details, providers] = await Promise.all([
      safeJson(`${TMDB_BASE}/movie/${found.id}?api_key=${apiKey}`),
      safeJson(`${TMDB_BASE}/movie/${found.id}/watch/providers?api_key=${apiKey}`)
    ]);

    const tmdbPoster = details?.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null;
    const poster = tmdbPoster || await fetchWikipediaPoster(movie.title, movie.year);
    const streaming = providers?.results?.IN?.flatrate?.map(p => p.provider_name) || [];

    return {
      ...movie,
      id: found.id,
      poster,
      overview: details?.overview || '',
      rating: details?.vote_average > 0 ? details.vote_average.toFixed(1) : null,
      runtime: details?.runtime || null,
      genres: details?.genres?.map(g => g.name) || [],
      streaming
    };
  } catch (err) {
    console.error(`⚠️  Could not fetch details for "${movie.title}":`, err.message);
    return { ...movie, notFound: true };
  }
}

// ─── Wikipedia poster fallback (4 strategies) ─────────────────────────────────
async function fetchWikipediaPoster(title, year) {
  const getImageFromSlug = async (slug) => {
    try {
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`);
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return null;
      const data = await r.json();
      return data?.originalimage?.source || data?.thumbnail?.source || null;
    } catch (e) {
      return null;
    }
  };

  const base = title.replace(/ /g, '_');

  // Strategy 1: "Title_(year_film)" e.g. War_(2019_film)
  if (year) {
    const img = await getImageFromSlug(`${base}_(${year}_film)`);
    if (img) { console.log(`📸 "${title}" ✅ via year+film`); return img; }
  }

  // Strategy 2: "Title_(film)" e.g. Gunday_(film)
  const img2 = await getImageFromSlug(`${base}_(film)`);
  if (img2) { console.log(`📸 "${title}" ✅ via (film)`); return img2; }

  // Strategy 3: exact title slug
  const img3 = await getImageFromSlug(base);
  if (img3) { console.log(`📸 "${title}" ✅ via exact`); return img3; }

  // Strategy 4: Wikipedia OpenSearch — find the closest matching article
  try {
    const searchR = await fetch(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(title + ' film')}&limit=3&format=json`);
    const ct = searchR.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    const searchData = await searchR.json();
    const candidates = searchData[1] || [];
    for (const candidate of candidates) {
      const img = await getImageFromSlug(candidate.replace(/ /g, '_'));
      if (img) { console.log(`📸 "${title}" ✅ via search → "${candidate}"`); return img; }
    }
  } catch (e) { /* ignore */ }

  console.log(`📸 "${title}" ❌ no poster found`);
  return null;
}

// Local dev server
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🎬  FilmSaathi is running!`);
    console.log(`    Open → http://localhost:${PORT}\n`);
  });
}

module.exports = app;
