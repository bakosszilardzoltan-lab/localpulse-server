const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
const DETAIL_FIELDS = 'id,displayName,rating,userRatingCount,formattedAddress,nationalPhoneNumber,websiteUri,regularOpeningHours,types,reviews';
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
    reviews: (place.reviews || []).slice(0, 5).map(r => ({
      author: r.authorAttribution?.displayName,
      rating: r.rating,
      text: r.text?.text,
      relativeTime: r.relativePublishTimeDescription,
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
  const { handle, niche, realData } = req.body;
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
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse analysis JSON', raw });
    }
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));