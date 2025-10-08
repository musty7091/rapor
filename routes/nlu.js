// routes/nlu.js
const express = require('express');
const router = express.Router();
const { dockStart } = require('@nlpjs/basic');
const path = require('path');

let nlp;

async function ensureNlp() {
  if (!nlp) {
    const dock = await dockStart({
      settings: { nlp: { languages: ['tr'] } },
      use: ['Basic', 'LangTr']
    });
    nlp = dock.get('nlp');
    await nlp.load(path.join(__dirname, '..', 'models', 'nlp.model.nlp'));
  }
}

// 🔎 basit metin tabanlı yedek çıkarım
function fallbackExtract(text) {
  const t = (text || '').toString();
  const low = t.toLowerCase('tr-TR');

  const yil = (t.match(/(19|20)\d{2}/) || [])[0] || null;

  let urun = null;
  if (/\b(whisky|whiskey|viski)\b/i.test(t)) urun = 'WHISKY';
  else if (/\b(rakı|raki)\b/i.test(t)) urun = 'RAKI';
  else if (/\b(vodka|votka)\b/i.test(t)) urun = 'VODKA';
  else if (/\b(gin|cin)\b/i.test(t)) urun = 'GIN';
  else if (/\b(likör|likor)\b/i.test(t)) urun = 'LIKOR';

  let kanal = null;
  if (/\b(toptan)\b/i.test(low)) kanal = 'toptan';
  else if (/\b(market|markette|perakende)\b/i.test(low)) kanal = 'market';
  else if (/\b(online|e-?ticaret|eticaret)\b/i.test(low)) kanal = 'online';

  return { yil, urun, kanal };
}

router.post('/parse', async (req, res) => {
  try {
    await ensureNlp();
    const text = (req.body?.text || req.query?.text || '').toString();
    if (!text.trim()) return res.status(400).json({ error: 'text required' });

    const result = await nlp.process('tr', text);
    const confidence = result.intent ? result.score : 0;
    const threshold = 0.45; // biraz esnek

    if (confidence < threshold) {
      return res.json({
        ok: true,
        intent: 'fallback',
        confidence,
        suggestions: [
          "2024 market rakı litre",
          "2025 toptan viski ciro"
        ]
      });
    }

    // 1) NLU'dan gelenler
    const slots = {};
    for (const e of (result.entities || [])) {
      slots[e.entity] = e.sourceText;
    }

    // 2) Yedek metin çıkarımı (boş olanları doldur)
    const fb = fallbackExtract(text);
    if (!slots.yil && fb.yil)   slots.yil = fb.yil;
    if (!slots.kanal && fb.kanal) slots.kanal = fb.kanal;
    if (!slots.urun && fb.urun) slots.urun = fb.urun;

    // Normalize
    if (slots.yil) slots.yil = (String(slots.yil).match(/(19|20)\d{2}/) || [])[0];
    if (slots.kanal) slots.kanal = String(slots.kanal).toLowerCase();
    if (slots.urun)  slots.urun  = String(slots.urun).toUpperCase();

    // Görmek istersen konsola bas
    console.log('🧠 intent:', result.intent, 'score:', confidence, 'slots:', slots);

    return res.json({ ok: true, intent: result.intent, confidence, slots });
  } catch (err) {
    console.error('💥 NLU ERROR:', err);
    res.status(500).json({ ok: false, error: 'parse-failed' });
  }
});

module.exports = router;
