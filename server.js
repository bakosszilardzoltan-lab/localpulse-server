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
  const { handle } = req.body;
  if (!handle) return res.status(400).json({ error: 'handle is required' });
  const clean = handle.replace(/^@/, '').trim();
  const prompt = `You are an elite social media strategist and Instagram growth expert with 10+ years analyzing thousands of accounts. Analyze the Instagram account @${clean} with extreme depth and precision.

Return ONLY a JSON object with these exact fields:

{
  "overallScore": <0-100, be precise and realistic>,
  "accountType": "<e.g. Local Restaurant, Personal Brand, E-commerce, Service Business>",
  "profileStrength": <0-100>,
  "monetizationPotential": <0-100>,
  "stats": [
    {"label": "Est. Followers",       "value": "<human-readable>", "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Engagement Rate",      "value": "<e.g. 3.2%>",      "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Posting Frequency",    "value": "<e.g. 3x/week>",   "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Content Quality",      "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Local SEO Fit",        "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Growth Potential",     "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Brand Consistency",    "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"},
    {"label": "Monetization Score",   "value": "<rating>",         "score": <0-100>, "insight": "<one sentence>"}
  ],
  "sections": [
    {"title": "Content Strategy Analysis",      "content": "<3-4 sentences>"},
    {"title": "Engagement & Audience Quality",  "content": "<3-4 sentences>"},
    {"title": "Local SEO & Discoverability",    "content": "<3-4 sentences>"},
    {"title": "Growth Opportunities",           "content": "<3-4 sentences>"},
    {"title": "Monetization Roadmap",           "content": "<3-4 sentences>"},
    {"title": "Competitor Positioning",         "content": "<3-4 sentences>"}
  ],
  "strengths":              ["<5-6 specific items>"],
  "warnings":               ["<3-5 specific items>"],
  "criticalGaps":           ["<2-4 critical gaps>"],
  "quickWins":              ["<3-5 actionable things they can do this week>"],
  "contentPillars":         ["<4-5 suggested content pillars for their niche>"],
  "bestPostingTimes":       "<specific recommendation>",
  "hashtagStrategy":        "<specific recommendation>",
  "estimatedMonthlyReach":  "<string estimate>"
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