import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Récupère les stats d'un match via API-Football
async function getMatchStats(homeTeam, awayTeam) {
  try {
    // Cherche la Coupe du Monde 2026 (league id 1)
    const url = `https://v3.football.api-sports.io/fixtures?league=1&season=2026&team_home=${encodeURIComponent(homeTeam)}&team_away=${encodeURIComponent(awayTeam)}`;
    const res = await fetch(url, {
      headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY }
    });
    const data = await res.json();
    const fixture = data.response?.[0];
    if (!fixture) return null;

    const fixtureId = fixture.fixture.id;

    // Récupère les stats détaillées du match
    const [statsRes, injuriesRes] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/teams/statistics?league=1&season=2026&team=${fixture.teams.home.id}`, {
        headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY }
      }),
      fetch(`https://v3.football.api-sports.io/injuries?fixture=${fixtureId}`, {
        headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY }
      })
    ]);

    const statsData = await statsRes.json();
    const injuriesData = await injuriesRes.json();

    const stats = statsData.response;
    const injuries = injuriesData.response || [];

    return {
      home: {
        name: fixture.teams.home.name,
        form: stats?.fixtures?.wins?.total || 0,
        goalsFor: stats?.goals?.for?.total?.total || 0,
        goalsAgainst: stats?.goals?.against?.total?.total || 0,
      },
      injuries: injuries.map(i => `${i.player.name} (${i.team.name})`).slice(0, 5)
    };
  } catch(e) {
    console.error('API-Football error:', e);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, matchId, homeTeam, awayTeam, mode } = req.body;

  // Mode analyse complète avec cache Supabase
  if (mode === 'oracle' && matchId) {
    // 1. Vérifier le cache Supabase
    const { data: cached } = await supabase
      .from('ai_predictions')
      .select('*')
      .eq('match_id', matchId)
      .single();

    if (cached) {
      return res.status(200).json({
        result: cached.analysis,
        prediction: cached.result,
        confidence: cached.confidence,
        fromCache: true
      });
    }

    // 2. Récupérer les stats API-Football
    const stats = await getMatchStats(homeTeam, awayTeam);
    const statsText = stats
      ? `Statistiques réelles : ${stats.home.name} — ${stats.home.goalsFor} buts marqués, ${stats.home.goalsAgainst} encaissés. Blessés : ${stats.injuries.join(', ') || 'aucun connu'}.`
      : '';

    // 3. Appel Claude avec les stats
    const enrichedPrompt = prompt + (statsText ? `\n\n${statsText}` : '');

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 1024,
          messages: [{ role: 'user', content: enrichedPrompt }]
        })
      });

      const data = await response.json();
      const result = data.content?.[0]?.text || '';

      // 4. Parser le JSON retourné par Claude
      let prediction = null, confidence = null, analysis = result;
      try {
        const clean = result.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        prediction = parsed.prediction || null;
        confidence = parsed.confidence || null;
        analysis = parsed.reason || result;
      } catch(e) {}

      // 5. Stocker dans Supabase
      await supabase.from('ai_predictions').insert({
        match_id: matchId,
        result: prediction,
        confidence: confidence,
        analysis: analysis
      });

      return res.status(200).json({ result: analysis, prediction, confidence });

    } catch(error) {
      console.error('Oracle error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Mode simple — prompt direct sans cache (pour Daily Drop, post-match, etc.)
  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const result = data.content?.[0]?.text || '';
    return res.status(200).json({ result });

  } catch (error) {
    console.error('Oracle error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
