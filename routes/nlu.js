// routes/nlu.js
const { NlpManager } = require('node-nlp');
const path = require('path');
const fs = require('fs');

const modelPath = path.join(__dirname, 'nlp.model.nlp');
const manager = new NlpManager({ languages: ['tr'], nlu: { log: false } });

let nlp;
async function ensureNlp() {
  if (!nlp) {
    const dock = await dockStart({ settings: { nlp: { languages: ['tr'] } }, use: ['Basic', 'LangTr'] });
    nlp = dock.get('nlp');
    await nlp.load(path.join(__dirname, '..', 'models', 'nlp.model.nlp'));
  }
}

function fallbackExtract(text) {
  const t = (text || '').toString();
  const low = t.toLowerCase('tr');
  const yil = (t.match(/(?:19|20)\d{2}/) || [])[0] || null;

  let urun = null;
  if (/(whisky|whiskey|viski)/iu.test(t)) urun = 'WHISKY';
  else if (/(rakı|raki)/iu.test(t)) urun = 'RAKI';
  else if (/(vodka|votka)/iu.test(t)) urun = 'VODKA';
  else if (/(gin|cin)/iu.test(t)) urun = 'GIN';
  else if (/(likör|likor)/iu.test(t)) urun = 'LIKOR';

  let kanal = null;
  if (/\btoptan\b/iu.test(low)) kanal = 'toptan';
  else if (/\b(market|markette|perakende)\b/iu.test(low)) kanal = 'market';
  else if (/\b(online|e-?ticaret|eticaret)\b/iu.test(low)) kanal = 'online';

  return { yil, urun, kanal };
}

router.post('/parse', async (req, res) => {
  try {
    await ensureNlp();
    const text = (req.body?.text || '').toString();
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'text required' });

    const result = await nlp.process('tr', text);
    const slots = {};
    for (const e of (result.entities || [])) slots[e.entity] = e.sourceText;

    // ➕ metinden eksik olanları tamamla
    const fb = fallbackExtract(text);
    if (!slots.yil && fb.yil) slots.yil = fb.yil;
    if (!slots.kanal && fb.kanal) slots.kanal = fb.kanal;
    if (!slots.urun && fb.urun) slots.urun = fb.urun;

    // normalize
    if (slots.yil) slots.yil = (String(slots.yil).match(/(19|20)\d{2}/) || [])[0];
    if (slots.kanal) slots.kanal = String(slots.kanal).toLowerCase();
    if (slots.urun) slots.urun = String(slots.urun).toUpperCase();

    return res.json({ ok: true, intent: result.intent || 'rapor.satis_hacmi_litre', confidence: result.score || 0, slots });
  } catch (err) {
    console.error('💥 NLU ERROR:', err);
    res.status(500).json({ ok: false, error: 'parse-failed' });
  }
});

module.exports = router;