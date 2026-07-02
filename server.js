const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(cors());
app.use(express.json());

// Same anon-key, no-auth-bridge trust model as the frontend's existing
// Supabase writes to `generations` -- there is no Clerk<->Supabase JWT
// integration, so user_id is a client-supplied value, not verified here.
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;
if (!supabase) console.warn('SUPABASE_URL/SUPABASE_ANON_KEY not set — snapshot features disabled');

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return isFinite(n) ? n : null;
}

function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Approximate text-similarity match for AI-generated recommendation strings.
// There's no stable per-recommendation ID from the LLM across separate runs,
// so this is a normalized-word Jaccard-overlap heuristic (v1) used to guess
// "still open" vs "resolved" -- not exact tracking, don't treat it as one.
function textSimilar(a, b) {
  const na = normalizeText(a), nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = new Set(na.split(' ').filter(Boolean));
  const wb = new Set(nb.split(' ').filter(Boolean));
  let overlap = 0;
  wa.forEach(w => { if (wb.has(w)) overlap++; });
  const union = new Set([...wa, ...wb]).size;
  return union > 0 && overlap / union > 0.6;
}

async function insertSnapshot({ user_id, tool_name, stable_key, metrics, recommendations }) {
  if (!supabase || !user_id || !stable_key) return;
  try {
    const { error } = await supabase.from('audit_snapshots').insert({
      user_id, tool_name, stable_key, metrics, recommendations, generation_id: null,
    });
    if (error) console.error(`audit_snapshots insert failed (${tool_name}):`, error.message);
  } catch (e) {
    console.error(`audit_snapshots insert threw (${tool_name}):`, e.message);
  }
}

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
const DETAIL_FIELDS = 'id,displayName,rating,userRatingCount,formattedAddress,nationalPhoneNumber,websiteUri,regularOpeningHours,types,primaryType,reviews,photos,location,googleMapsUri,priceLevel,businessStatus';
const SEARCH_FIELD_MASK = DETAIL_FIELDS.split(',').map(f => `places.${f}`).join(',');

function formatPlace(place) {
  return {
    placeId: place.id,
    name: place.displayName?.text ?? place.displayName,
    rating: place.rating,
    userRatingCount: place.userRatingCount,
    formattedAddress: place.formattedAddress,
    nationalPhoneNumber: place.nationalPhoneNumber,
    websiteUri: place.websiteUri,
    regularOpeningHours: place.regularOpeningHours,
    types: place.types,
    primaryType: place.primaryType || null,
    photoName: place.photos?.[0]?.name || null,
    location: place.location ? { lat: place.location.latitude, lng: place.location.longitude } : null,
    googleMapsUri: place.googleMapsUri || null,
    priceLevel: place.priceLevel || null,
    businessStatus: place.businessStatus || null,
    // Only these fields are ever forwarded to the client -- do not widen
    // this without checking Google's Places API attribution/ToS terms.
    reviews: (place.reviews || []).slice(0, 5).map(r => ({
      author: r.authorAttribution?.displayName || null,
      authorPhotoUri: r.authorAttribution?.photoUri || null,
      rating: r.rating ?? null,
      text: r.text?.text || null,
      relativeTime: r.relativePublishTimeDescription || null,
      publishTime: r.publishTime || null,
    })),
  };
}

async function fetchPlaceById(placeId) {
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { 'X-Goog-Api-Key': GOOGLE_PLACES_KEY, 'X-Goog-FieldMask': DETAIL_FIELDS },
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || 'Google Places API error');
  return d;
}

async function textSearchPlace(query) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_KEY,
      'X-Goog-FieldMask': SEARCH_FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || 'Google Places API error');
  return d.places?.[0] ?? null;
}

async function resolveMapsUrl(url) {
  if (url.includes('goo.gl') || url.includes('maps.app')) {
    const r = await fetch(url, { redirect: 'follow' });
    return r.url;
  }
  return url;
}

function extractQueryFromUrl(url) {
  const placeIdMatch = url.match(/!1s(ChIJ[^!&]+)/);
  if (placeIdMatch) return { type: 'id', value: decodeURIComponent(placeIdMatch[1]) };

  const nameMatch = url.match(/\/maps\/place\/([^/@?#]+)/);
  if (nameMatch) return { type: 'query', value: decodeURIComponent(nameMatch[1].replace(/\+/g, ' ')) };

  try {
    const u = new URL(url);
    const q = u.searchParams.get('q') || u.searchParams.get('query');
    if (q) return { type: 'query', value: q };
  } catch {}

  return null;
}

app.post('/generate', async (req, res) => {
  try {
    let prompt = req.body.prompt;
    const { placeData } = req.body;
    if (placeData) {
      prompt = `Here is REAL data for this business from Google: name=${placeData.name}, rating=${placeData.rating}, reviews=${placeData.userRatingCount}, address=${placeData.formattedAddress}. Use this real data in your analysis.\n\n${prompt}`;
    }
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    res.json({ text: data.choices?.[0]?.message?.content || '' });
  } catch(e) { res.json({ text: 'Error: ' + e.message }); }
});

// Structured JSON sibling of /generate, used only by the Business Audit tool
// (ToolPage.js tool.id === 'audit') so the other 5 free-text tools sharing
// /generate are untouched. Mirrors /analyze-instagram's Groq call shape.
app.post('/generate-audit', async (req, res) => {
  try {
    let prompt = req.body.prompt;
    const { placeData, business, user_id } = req.body;
    if (placeData) {
      prompt = `Here is REAL data for this business from Google: name=${placeData.name}, rating=${placeData.rating}, reviews=${placeData.userRatingCount}, address=${placeData.formattedAddress}. Use this real data in your analysis.\n\n${prompt}`;
    }
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a JSON-only API. Always respond with a single valid JSON object and nothing else.' },
          { role: 'user',   content: prompt },
        ],
      }),
    });
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    let result;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(match ? match[0] : raw);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse audit JSON', raw });
    }

    // Stable key: prefer the real Google Place ID; fall back to a slug of the
    // typed business name when the user skipped the Google lookup entirely.
    // The slug fallback won't reliably match re-entries with typos/renames —
    // that's a known, accepted v1 limitation, not an oversight.
    const stableKey = placeData?.placeId || (business ? `manual-${slugify(business)}` : null);

    await insertSnapshot({
      user_id,
      tool_name: 'business_audit',
      stable_key: stableKey,
      metrics: {
        overallScore: toNumber(result.overallScore),
        rating: placeData?.rating != null ? toNumber(placeData.rating) : null,
        userRatingCount: placeData?.userRatingCount != null ? toNumber(placeData.userRatingCount) : null,
      },
      recommendations: [
        ...(result.criticalIssues || []).map(c => ({ id: c.id, text: c.text, category: 'critical' })),
        ...(result.quickWins || []).map(q => ({ id: q.id, text: q.text, category: 'quickwin' })),
      ],
    });

    // _stableKey is server-added metadata (not part of the AI schema) so the
    // frontend knows what key to pass to /snapshot-delta next.
    res.json({ ...result, _stableKey: stableKey });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Structured JSON sibling of /generate, used only by the SEO Keywords tool
// (ToolPage.js tool.id === 'keywords'). Builds the prompt server-side (unlike
// /generate, which takes a prebuilt prompt) so the schema/rules live in one
// place and stay in sync with the retry/parse logic below.
function buildSeoKeywordsPrompt({ business, type, city, country }) {
  const location = [city, country].filter(Boolean).join(', ');
  const system = `You are a local SEO keyword research API. Respond ONLY with a single valid JSON object matching the schema below. No markdown code fences, no preamble, no commentary, no assumptions or caveats about missing inputs — business, type and city are always provided.

Schema:
{
  "clusters": [
    { "id": "primary" | "longtail" | "questions" | "local_language",
      "name": string,
      "keywords": [ { "keyword": string, "intent": "transactional" | "informational" | "navigational", "competition": "low" | "medium" | "high", "tip": string } ]
    }
  ],
  "gbp_categories": [string],
  "summary": string
}

Rules:
- Include ALL FOUR clusters, always, in this order: "primary" (5-8 keywords), "longtail" (6-10 keywords), "questions" (5-8 keywords), "local_language" (5-8 keywords).
- The "local_language" cluster's "name" and every one of its "keyword" values must be written in the primary local language spoken in ${country || 'the business location'} (e.g. Romanian for Romania, French for France). Every other cluster's "name" and keywords stay in English.
- "name" is a short display name, e.g. "Primary Keywords", "Long-Tail Keywords", "Question Keywords", or the local-language cluster's name translated into that same local language.
- Each keyword's "tip" is a single sentence, max 90 characters, explaining how to use that keyword.
- "gbp_categories" has at most 3 real, valid Google Business Profile category names relevant to this business.
- "summary" is at most 2 sentences.
- Never include search volume numbers or numeric difficulty scores anywhere — competition is qualitative only (low/medium/high), nothing else.`;

  const user = `Business: "${business}"\nBusiness type: ${type}\nLocation: ${location}\n\nGenerate the full local SEO keyword research JSON for this business per the system schema.`;
  return { system, user };
}

function parseSeoKeywordsJson(raw) {
  const stripped = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : stripped);
}

app.post('/generate-seo-keywords', async (req, res) => {
  const { business, type, city, country } = req.body;
  if (!business || !type || !city) {
    return res.status(400).json({ error: 'business, type and city are required' });
  }
  const { system, user } = buildSeoKeywordsPrompt({ business, type, city, country });

  const callGroq = async () => {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user },
        ],
      }),
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  };

  try {
    let raw = await callGroq();
    try {
      return res.json(parseSeoKeywordsJson(raw));
    } catch {
      // One retry — Groq occasionally wraps JSON in commentary despite
      // response_format: json_object; a second call usually self-corrects.
      raw = await callGroq();
      try {
        return res.json(parseSeoKeywordsJson(raw));
      } catch {
        return res.status(502).json({ error: 'Could not generate keywords right now — please try again.' });
      }
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function calculatePostingConsistency(posts) {
  const timestamps = posts.map(p => p.timestamp ? new Date(p.timestamp).getTime() : null).filter(Boolean).sort((a, b) => a - b);
  if (timestamps.length < 2) return null;

  const daysSpan = (timestamps[timestamps.length - 1] - timestamps[0]) / 86400000;
  const gaps = [];
  for (let i = 1; i < timestamps.length; i++) gaps.push((timestamps[i] - timestamps[i - 1]) / 86400000);
  const avgGapDays = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const meanGap = avgGapDays;
  const variance = gaps.reduce((sum, g) => sum + (g - meanGap) ** 2, 0) / gaps.length;
  const stdGap = Math.sqrt(variance);
  const cv = meanGap > 0 ? stdGap / meanGap : 0; // coefficient of variation — lower = more regular timing

  // Frequency: posting roughly daily scores highest, tapering off as the gap widens.
  const frequencyScore = Math.max(0, Math.min(100, 100 - (avgGapDays - 1) * 8));
  // Regularity: low variance between gaps scores highest.
  const regularityScore = Math.max(0, Math.min(100, 100 - cv * 60));
  const score = Math.round(frequencyScore * 0.6 + regularityScore * 0.4);

  const regularityLabel = cv < 0.4 ? 'fairly consistent timing' : cv < 0.8 ? 'somewhat irregular timing' : 'highly irregular timing';
  const label = `Posted ${timestamps.length} times in the last ${Math.round(daysSpan)} days — averaging once every ${avgGapDays.toFixed(1)} days, ${regularityLabel}`;

  return { score, label, postsAnalyzed: timestamps.length, daysSpan: Math.round(daysSpan), avgGapDays: Number(avgGapDays.toFixed(1)) };
}

async function fetchInstagramData(handle) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  try {
    const r = await fetch(
      `https://api.apify.com/v2/acts/shu8hvrXbJbY3Eb9W/run-sync-get-dataset-items?token=${process.env.APIFY_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directUrls: [`https://www.instagram.com/${handle}/`],
          resultsType: 'details',
          resultsLimit: 1,
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);
    const items = await r.json();
    if (!Array.isArray(items) || !items.length) return null;
    const p = items[0];
    const followersCount = p.followersCount || 0;
    const posts = p.latestPosts || p.posts || [];
    const likesArr = posts.map(post => post.likesCount || 0).filter(n => n > 0);
    const avgLikes = likesArr.length
      ? Math.round(likesArr.reduce((a, b) => a + b, 0) / likesArr.length)
      : null;
    const commentsArr = posts.map(post => post.commentsCount || 0).filter(n => n > 0);
    const avgComments = commentsArr.length
      ? Math.round(commentsArr.reduce((a, b) => a + b, 0) / commentsArr.length)
      : null;
    const viewsArr = posts.map(post => post.videoViewCount || 0).filter(n => n > 0);
    const avgViews = viewsArr.length
      ? Math.round(viewsArr.reduce((a, b) => a + b, 0) / viewsArr.length)
      : null;
    // Engagement rate = (avg likes + avg comments) / followers. Apify's instagram-scraper
    // actor never exposes save/share counts on a post — Instagram only surfaces those to
    // the account owner via native Insights — so they're excluded here, not omitted by mistake.
    const engagementRateRaw = followersCount && avgLikes
      ? ((avgLikes + (avgComments || 0)) / followersCount) * 100
      : null;
    const engagementRate = engagementRateRaw != null ? engagementRateRaw.toFixed(2) + '%' : null;
    // Real-world Instagram ER rarely exceeds ~15%, even for tiny, highly-engaged accounts.
    // Anything above that is flagged so the UI can show the result isn't being presented
    // as a typical/reproducible number.
    const ENGAGEMENT_OUTLIER_THRESHOLD = 15;
    const engagementOutlier = engagementRateRaw != null && engagementRateRaw > ENGAGEMENT_OUTLIER_THRESHOLD;
    const engagementOutlierNote = engagementOutlier
      ? 'This engagement rate is unusually high — results may reflect a small, highly engaged audience or unusual post timing. Treat as informational, not a guarantee of broader appeal.'
      : null;
    const postingConsistency = calculatePostingConsistency(posts);
    return {
      username: p.username,
      fullName: p.fullName,
      biography: p.biography,
      followersCount: p.followersCount,
      followingCount: p.followingCount,
      postsCount: p.postsCount,
      profilePicUrl: p.profilePicUrlHD || p.profilePicUrl,
      isVerified: p.verified || p.isVerified || false,
      avgLikes,
      avgComments,
      avgViews,
      engagementRate,
      engagementRateRaw,
      postingConsistency,
      engagementOutlier,
      engagementOutlierNote,
    };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

app.post('/instagram-real-data', async (req, res) => {
  const { handle } = req.body;
  if (!handle) return res.status(400).json({ error: 'handle is required' });
  const clean = handle.replace(/^@/, '').trim();
  try {
    const profile = await fetchInstagramData(clean);
    if (!profile) return res.status(404).json({ error: 'Could not fetch profile data from Apify' });
    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/analyze-instagram', async (req, res) => {
  const { handle, niche, realData, user_id } = req.body;
  if (!handle) return res.status(400).json({ error: 'handle is required' });
  if (!niche) return res.status(400).json({ error: 'niche is required' });
  const clean = handle.replace(/^@/, '').trim();

  let profile = realData || null;
  if (!profile) {
    profile = await fetchInstagramData(clean);
  }

  const followers    = profile?.followersCount ?? null;
  const avgLikes     = profile?.avgLikes       ?? null;
  const bio          = profile?.biography      ?? null;
  const isVerified   = profile?.isVerified     ?? false;
  const postsCount   = profile?.postsCount     ?? null;
  const engRate      = profile?.engagementRate ?? null;
  const dataNote     = profile ? 'REAL scraped data from Apify' : 'estimated — Apify unavailable';

  const followersLine  = followers  ? `- Followers: ${followers.toLocaleString()} (${dataNote})` : `- Followers: not available — do not invent a specific number, use general guidance instead`;
  const avgLikesLine   = avgLikes && followers
    ? `- Avg likes per post: ${avgLikes} (engagement rate: ${engRate || ((avgLikes / followers) * 100).toFixed(2) + '%'}) (${dataNote})`
    : `- Avg likes per post: not available — do not invent a specific number, use general guidance instead`;
  const bioLine        = bio        ? `- Bio/description: ${bio} (${dataNote})` : `- Bio/description: not provided`;
  const verifiedLine   = isVerified ? `- Account is VERIFIED (blue checkmark — factor this into monetization potential)` : '';
  const postsLine      = postsCount ? `- Total posts published: ${postsCount}` : '';

  const prompt = `You are an elite Instagram growth strategist in 2026 with deep knowledge of current trends, algorithm changes, and what's actually going viral RIGHT NOW. You specialize in the ${niche} niche.

Real profile data:
- Handle: @${clean}
${followersLine}
${postsLine}
${avgLikesLine}
${bioLine}
${isVerified ? '- Verified: Yes (blue checkmark — factor into monetization and credibility)' : '- Verified: No'}
- Niche: ${niche}

Generate a hyper-specific, actionable growth strategy for 2026. Return ONLY a JSON object:

{
  "overallScore": <realistic 0-100 score based on their real data>,
  "scoreReason": "<one sentence explaining exactly why they got this score based on their real numbers>",
  "accountType": "<specific account type for the ${niche} niche>",
  "growthRate": "<realistic monthly follower estimate based on their actual engagement rate>",
  "engagementRate": "${engRate || (avgLikes && followers ? ((avgLikes / followers) * 100).toFixed(2) + '%' : 'unknown')}",
  "viralContentIdeas": [
    {
      "title": "<VERY specific to ${niche} niche and 2026 trends, not generic>",
      "format": "<Reel|Carousel|Story|Live>",
      "hook": "<authentic 2026-style hook, NOT clickbait — feels natural and real>",
      "whyItWorks": "<specific reason tied to current algorithm behavior>"
    }
  ],
  "thirtyDayPlan": [
    {"week": 1, "focus": "<specific theme>", "actions": ["<exact action with numbers e.g. Post 3 Reels under 30s using trending audio>", "<specific action>", "<specific action>"]},
    {"week": 2, "focus": "<specific theme>", "actions": ["<specific action>", "<specific action>", "<specific action>"]},
    {"week": 3, "focus": "<specific theme>", "actions": ["<specific action>", "<specific action>", "<specific action>"]},
    {"week": 4, "focus": "<specific theme>", "actions": ["<specific action>", "<specific action>", "<specific action>"]}
  ],
  "viralHooks": ["<10 authentic, natural-sounding hooks specific to ${niche} in 2026 — NOT clickbait, should feel like real captions people actually use>"],
  "hashtagPack": {
    "large": ["<5 hashtags with 1M+ posts specific to ${niche}>"],
    "medium": ["<10 hashtags 100K-1M posts specific to ${niche}>"],
    "niche": ["<15 hashtags under 100K specific to their exact content style>"]
  },
  "bestPostingTimes": "<specific days and times based on ${niche} audience behavior in 2026>",
  "todayAction": "<ONE very specific thing they can do TODAY — not vague, tied to their real data and follower count>",
  "stats": [
    {"label": "Engagement Rate", "value": "${engRate || 'calculated'}", "score": <0-100>, "insight": "<specific insight based on their real engagement number — do not cite a specific niche-average percentage>"},
    {"label": "Growth Potential", "value": "<string>", "score": <0-100>, "insight": "<specific to their current follower count and niche>"},
    {"label": "Content Score", "value": "<string>", "score": <0-100>, "insight": "<specific to ${niche} content standards>"},
    {"label": "Posting Consistency", "value": "<string>", "score": <0-100>, "insight": "<based on their real post count of ${postsCount || 'unknown'} posts>"}
  ],
  "strengths": ["<3-4 specific strengths drawn from their REAL follower count, engagement, bio, and verified status>"],
  "quickWins": ["<3 specific things to do THIS WEEK with exact actions and numbers, not vague advice>"]
}

Rules: viralContentIdeas must have exactly 5 items, each specific to ${niche}. viralHooks must have exactly 10 strings. hashtagPack.large must have 5, medium must have 10, niche must have 15. All hashtags must include the # symbol. Every insight must reference their actual data, not generic advice. Never state a specific niche-average engagement rate percentage (e.g. "DJ accounts average 3-5% ER") anywhere in your response — that figure is not real data, it's a recalled approximation. If you need to characterize an engagement rate as good or bad, use general, defensible framing such as "engagement rates above 3% are generally considered strong for most account sizes" instead of a niche-specific number.`;
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a JSON-only API. Always respond with a single valid JSON object and nothing else.' },
          { role: 'user',   content: prompt },
        ],
      }),
    });
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const result = JSON.parse(match ? match[0] : raw);
      // Posting Consistency must reflect real post timestamps, not an LLM guess — overwrite
      // whatever the model produced with the backend-computed value, or drop it entirely if
      // we don't have enough timestamp data to compute one honestly.
      if (Array.isArray(result.stats)) {
        const idx = result.stats.findIndex(s => s.label === 'Posting Consistency');
        if (profile?.postingConsistency) {
          const pc = profile.postingConsistency;
          const entry = { label: 'Posting Consistency', value: `${pc.avgGapDays}d avg gap`, score: pc.score, insight: pc.label };
          if (idx >= 0) result.stats[idx] = entry; else result.stats.push(entry);
        } else if (idx >= 0) {
          result.stats.splice(idx, 1);
        }
      }
      // Snapshot for delta tracking — awaited (it's a single fast insert) so the
      // very next /snapshot-delta call from the frontend sees this run's row,
      // but wrapped so a Supabase failure never breaks the analysis response.
      await insertSnapshot({
        user_id,
        tool_name: 'instagram',
        stable_key: clean,
        metrics: {
          followersCount:  toNumber(profile?.followersCount),
          followingCount:  toNumber(profile?.followingCount),
          postsCount:      toNumber(profile?.postsCount),
          engagementRate:  toNumber(profile?.engagementRateRaw ?? result.engagementRate),
          avgLikes:        toNumber(profile?.avgLikes),
          avgComments:     toNumber(profile?.avgComments),
          avgViews:        toNumber(profile?.avgViews),
          growthRate:      toNumber(result.growthRate),
        },
        recommendations: [
          ...(result.strengths || []).map((text, i) => ({ id: `strength-${i}`, text, category: 'strength' })),
          ...(result.quickWins || []).map((text, i) => ({ id: `quickwin-${i}`, text, category: 'quickwin' })),
        ],
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse analysis JSON', raw });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generic across tools by (user_id, tool_name, stable_key) — used by both
// Instagram and Business Audit; TikTok/YouTube can reuse it later unchanged.
app.get('/snapshot-delta', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { stable_key, tool_name, user_id } = req.query;
  if (!stable_key || !tool_name || !user_id) {
    return res.status(400).json({ error: 'stable_key, tool_name and user_id are required' });
  }
  try {
    const { data: rows, error } = await supabase
      .from('audit_snapshots')
      .select('created_at, metrics, recommendations')
      .eq('user_id', user_id)
      .eq('tool_name', tool_name)
      .eq('stable_key', stable_key)
      .order('created_at', { ascending: false })
      .limit(2);
    if (error) throw new Error(error.message);

    const current = rows?.[0] || null;
    const previous = rows?.[1] || null;

    let metricDeltas = [];
    if (current && previous) {
      const keys = new Set([...Object.keys(current.metrics || {}), ...Object.keys(previous.metrics || {})]);
      metricDeltas = [...keys].map(key => {
        const currentValue = toNumber(current.metrics?.[key]);
        const previousValue = toNumber(previous.metrics?.[key]);
        const hasBoth = currentValue != null && previousValue != null;
        const change = hasBoth ? currentValue - previousValue : null;
        const changePercent = hasBoth && previousValue !== 0 ? (change / previousValue) * 100 : null;
        return { key, previousValue, currentValue, change, changePercent };
      });
    }

    const recommendationChanges = { stillOpen: [], resolved: [] };
    if (current && previous) {
      const currentRecs = current.recommendations || [];
      const previousRecs = previous.recommendations || [];
      recommendationChanges.stillOpen = currentRecs.filter(c =>
        previousRecs.some(p => p.category === c.category && textSimilar(p.text, c.text))
      );
      recommendationChanges.resolved = previousRecs.filter(p =>
        !currentRecs.some(c => c.category === p.category && textSimilar(c.text, p.text))
      );
    }

    res.json({
      hasPrevious: !!previous,
      previous: previous ? { created_at: previous.created_at, metrics: previous.metrics } : null,
      current: current ? { created_at: current.created_at, metrics: current.metrics } : null,
      metricDeltas,
      recommendationChanges,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/analyze-tiktok', async (req, res) => {
  const { handle } = req.body;
  if (!handle) return res.status(400).json({ error: 'handle is required' });
  const clean = handle.replace(/^@/, '').trim();
  const prompt = `You are an elite TikTok growth strategist and social media expert with 10+ years analyzing thousands of creator accounts. Analyze the TikTok account @${clean} with extreme depth and precision.

Return ONLY a JSON object with these exact fields:

{
  "overallScore": <0-100, be precise and realistic>,
  "accountType": "<e.g. Local Business, Personal Brand, Entertainment, Education, E-commerce>",
  "profileStrength": <0-100>,
  "monetizationPotential": <0-100>,
  "stats": [
    {"label": "Est. Followers",       "value": "<human-readable>", "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Avg. Views / Video",   "value": "<human-readable>", "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Engagement Rate",      "value": "<e.g. 4.1%>",      "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Posting Frequency",    "value": "<e.g. 5x/week>",   "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Viral Rate",           "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Sound Strategy",       "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Trend Adoption",       "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Creator Fund Fit",     "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"}
  ],
  "sections": [
    {"title": "Content & Viral Strategy",        "content": "<3-4 sentences>"},
    {"title": "Audience & Engagement Quality",   "content": "<3-4 sentences>"},
    {"title": "Sound & Trend Strategy",          "content": "<3-4 sentences>"},
    {"title": "Growth Opportunities",            "content": "<3-4 sentences>"},
    {"title": "Monetization Roadmap",            "content": "<3-4 sentences>"},
    {"title": "Competitor Positioning",          "content": "<3-4 sentences>"}
  ],
  "strengths":              ["<5-6 specific items>"],
  "warnings":               ["<3-5 specific items>"],
  "criticalGaps":           ["<2-4 critical gaps>"],
  "quickWins":              ["<3-5 actionable things they can do this week>"],
  "contentPillars":         ["<4-5 suggested content pillars for their niche>"],
  "bestPostingTimes":       "<specific recommendation>",
  "hashtagStrategy":        "<specific TikTok hashtag recommendation>",
  "estimatedMonthlyReach":  "<string estimate of monthly video views>"
}`;
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 3000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a JSON-only API. Always respond with a single valid JSON object and nothing else.' },
          { role: 'user',   content: prompt },
        ],
      }),
    });
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const result = JSON.parse(match ? match[0] : raw);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse analysis JSON', raw });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/analyze-youtube', async (req, res) => {
  const { handle } = req.body;
  if (!handle) return res.status(400).json({ error: 'handle is required' });
  const clean = handle.replace(/^@/, '').trim();
  const prompt = `You are an elite YouTube growth strategist. Analyze the YouTube channel @${clean} with extreme depth.

Return ONLY a JSON object with these exact fields:

{
  "overallScore": <0-100, be precise and realistic>,
  "accountType": "<e.g. Local Business, Personal Brand, Education, Entertainment, E-commerce>",
  "profileStrength": <0-100>,
  "monetizationPotential": <0-100>,
  "stats": [
    {"label": "Est. Subscribers",   "value": "<human-readable>", "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Avg. Views / Video", "value": "<human-readable>", "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Upload Frequency",   "value": "<e.g. 2x/week>",   "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Content Quality",    "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"},
    {"label": "SEO Score",          "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Audience Retention", "value": "<e.g. 48%>",       "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Monetization Score", "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Growth Velocity",    "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"}
  ],
  "sections": [
    {"title": "Content Strategy",       "content": "<3-4 sentences>"},
    {"title": "Audience & Engagement",  "content": "<3-4 sentences>"},
    {"title": "YouTube SEO",            "content": "<3-4 sentences>"},
    {"title": "Growth Opportunities",   "content": "<3-4 sentences>"},
    {"title": "Monetization Roadmap",   "content": "<3-4 sentences>"},
    {"title": "Competitor Positioning", "content": "<3-4 sentences>"}
  ],
  "strengths":              ["<5-6 specific items>"],
  "warnings":               ["<3-5 specific items>"],
  "criticalGaps":           ["<2-4 critical gaps>"],
  "quickWins":              ["<3-5 actionable things they can do this week>"],
  "contentPillars":         ["<4-5 suggested content pillars for their niche>"],
  "bestPostingTimes":       "<specific recommendation>",
  "hashtagStrategy":        "<specific YouTube tags and keyword recommendation>",
  "estimatedMonthlyReach":  "<string estimate of monthly views>"
}`;
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 3000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a JSON-only API. Always respond with a single valid JSON object and nothing else.' },
          { role: 'user',   content: prompt },
        ],
      }),
    });
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const result = JSON.parse(match ? match[0] : raw);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse analysis JSON', raw });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/place-details', async (req, res) => {
  const { mapsUrl } = req.body;
  if (!mapsUrl) return res.status(400).json({ error: 'mapsUrl is required' });
  try {
    const resolved = await resolveMapsUrl(mapsUrl);
    const extracted = extractQueryFromUrl(resolved);
    if (!extracted) return res.status(400).json({ error: 'Could not extract place info from URL' });

    let place;
    if (extracted.type === 'id') {
      place = await fetchPlaceById(extracted.value);
    } else {
      place = await textSearchPlace(extracted.value);
    }

    if (!place) return res.status(404).json({ error: 'Place not found' });
    res.json(formatPlace(place));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/find-place', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  try {
    const place = await textSearchPlace(query);
    if (!place) return res.status(404).json({ error: 'No places found for that query' });
    res.json(formatPlace(place));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/autocomplete-cities', async (req, res) => {
  const { input, countryCode } = req.body;
  if (!input) return res.status(400).json({ error: 'input is required' });
  try {
    const body = { input, includedPrimaryTypes: ['locality'] };
    if (countryCode) body.includedRegionCodes = [countryCode.toLowerCase()];
    const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_PLACES_KEY },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.error) return res.status(500).json({ error: d.error.message || 'Places API error' });
    const suggestions = (d.suggestions || []).map(s => ({
      placeId: s.placePrediction?.placeId,
      text: s.placePrediction?.text?.text,
      mainText: s.placePrediction?.structuredFormat?.mainText?.text,
      secondaryText: s.placePrediction?.structuredFormat?.secondaryText?.text,
    })).filter(s => s.text);
    res.json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/static-map', async (req, res) => {
  const { lat, lng, zoom = '15', size = '300x150' } = req.query;
  if (!lat || !lng) return res.status(400).send('lat and lng are required');
  try {
    const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=${size}&markers=color:0x00E5C4|${lat},${lng}&key=${GOOGLE_PLACES_KEY}`;
    const r = await fetch(mapUrl);
    if (!r.ok) return res.status(r.status).send('Map fetch failed');
    res.set('Content-Type', r.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.post('/place-photo', async (req, res) => {
  const { photoName } = req.body;
  if (!photoName) return res.status(400).json({ error: 'photoName is required' });
  try {
    const r = await fetch(
      `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=600&skipHttpRedirect=true&key=${GOOGLE_PLACES_KEY}`
    );
    const d = await r.json();
    if (d.error) return res.status(500).json({ error: d.error.message || 'Photo API error' });
    res.json({ photoUri: d.photoUri || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));