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
  const prompt = `You are a social media and local SEO expert. Analyze the Instagram account @${clean} based on your knowledge of this account or similar accounts in its niche. Return ONLY a valid JSON object — no markdown, no code blocks, no explanation. Use exactly this structure:
{
  "overallScore": <number 0-100>,
  "accountType": "<e.g. Local Business, Personal Brand, E-commerce, Creator>",
  "stats": [
    {"label": "Estimated Followers", "value": "<human-readable number>", "score": <0-100>},
    {"label": "Engagement Rate",      "value": "<e.g. 3.2%>",            "score": <0-100>},
    {"label": "Posting Frequency",    "value": "<e.g. 3x/week>",         "score": <0-100>},
    {"label": "Content Score",        "value": "<Good/Average/Poor>",     "score": <0-100>},
    {"label": "Local SEO Fit",        "value": "<Strong/Moderate/Weak>",  "score": <0-100>},
    {"label": "Growth Potential",     "value": "<High/Medium/Low>",       "score": <0-100>}
  ],
  "sections": [
    {"title": "Content Strategy",       "content": "<2-3 sentences>"},
    {"title": "Engagement & Audience",  "content": "<2-3 sentences>"},
    {"title": "Local SEO Connection",   "content": "<2-3 sentences>"},
    {"title": "Growth Opportunities",   "content": "<2-3 sentences>"}
  ],
  "strengths":     ["<strength 1>", "<strength 2>", "<strength 3>"],
  "warnings":      ["<warning 1>", "<warning 2>"],
  "criticalGaps":  ["<gap 1>", "<gap 2>"]
}`;
  try {
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