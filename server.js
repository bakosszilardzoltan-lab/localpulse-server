const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
app.post('/generate', async (req, res) => {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 1000, messages: [{ role: 'user', content: req.body.prompt }] })
    });
    const data = await response.json();
    res.json({ text: data.choices?.[0]?.message?.content || '' });
  } catch(e) { res.json({ text: 'Error: ' + e.message }); }
});
app.post('/analyze-instagram', async (req, res) => {
  const { handle, followers, niche, avg_likes, frequency, bio } = req.body;
  if (!handle) return res.status(400).json({ error: 'handle is required' });
  if (!followers) return res.status(400).json({ error: 'followers is required' });
  if (!niche) return res.status(400).json({ error: 'niche is required' });
  const clean = handle.replace(/^@/, '').trim();
  const avgLikesLine = avg_likes ? `- Avg likes per post: ${avg_likes} (engagement rate: ${((avg_likes / followers) * 100).toFixed(2)}%)` : `- Avg likes per post: not provided (estimate based on niche averages)`;
  const freqLine = frequency ? `- Posting frequency: ${frequency}` : `- Posting frequency: unknown`;
  const bioLine = bio ? `- Bio/description: ${bio}` : `- Bio/description: not provided`;
  const prompt = `You are an elite social media growth strategist. Based on this account data:
- Handle: @${clean}
- Followers: ${followers}
- Niche: ${niche}
${avgLikesLine}
${freqLine}
${bioLine}

Generate a highly personalized growth strategy. Be specific to their niche, follower count, and engagement level. Return ONLY a JSON object:

{
  "overallScore": <0-100 based on their real data — be honest and precise>,
  "accountType": "<specific account type based on their niche>",
  "growthRate": "<estimated monthly follower growth number if they follow the plan, e.g. '200-400'>",
  "engagementRate": "<calculated from likes/followers if available, otherwise estimate for their niche>",
  "viralContentIdeas": [
    {"title": "<specific post idea>", "format": "<Reel|Carousel|Story>", "hook": "<exact opening line to use>", "whyItWorks": "<one sentence>"}
  ],
  "thirtyDayPlan": [
    {"week": 1, "focus": "<theme>", "actions": ["<action1>", "<action2>", "<action3>"]},
    {"week": 2, "focus": "<theme>", "actions": ["<action1>", "<action2>", "<action3>"]},
    {"week": 3, "focus": "<theme>", "actions": ["<action1>", "<action2>", "<action3>"]},
    {"week": 4, "focus": "<theme>", "actions": ["<action1>", "<action2>", "<action3>"]}
  ],
  "viralHooks": ["<10 specific viral caption hooks for their niche>"],
  "hashtagPack": {
    "large": ["<5 hashtags with 1M+ posts>"],
    "medium": ["<10 hashtags with 100K-1M posts>"],
    "niche": ["<15 hashtags under 100K posts specific to their content>"]
  },
  "bestPostingTimes": "<specific days and times for their niche with reasoning>",
  "todayAction": "<one very specific actionable thing they should do TODAY to start growing>",
  "stats": [
    {"label": "Engagement Rate", "value": "<string>", "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Growth Potential", "value": "<string>", "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Content Score", "value": "<string>", "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Posting Consistency", "value": "<string>", "score": <0-100>, "insight": "<one sentence>"}
  ],
  "strengths": ["<3-4 specific strengths based on their data>"],
  "quickWins": ["<3 specific things to do this week for immediate growth>"]
}

Rules: viralContentIdeas must have exactly 5 items. viralHooks must have exactly 10 strings. hashtagPack.large must have 5, medium must have 10, niche must have 15. All hashtags must include the # symbol.`;
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));