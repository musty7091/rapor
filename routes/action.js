// routes/action.js — Nihai & sağlam sürüm
// Tablo ve kolonlar senin şeman: YC_SATIS_DETAY_TUMU, YIL, URUN_GRUBU, SATIS_MIKTAR_LITRE, TUTAR, FIS_TURU

const express = require('express');
const router = express.Router();
const { poolPromise, sql } = require('../db');

// FIS_TURU -> kanal ayrımı
function kanalWhere(kanal) {
  if (kanal === 'market') return ' AND FIS_TURU IN (101,102) ';
  if (kanal === 'toptan') return ' AND FIS_TURU IN (21,23) ';
  if (kanal === 'online') return " AND FIS_TURU = 9999 "; // yoksa kaldır
  return '';
}

// --- çok sağlam, regexsiz çıkarım ---
function fallbackExtract(text) {
  const t = (text || '').toString();
  const low = t.toLowerCase('tr');

  // yıl
  const yil = (t.match(/(?:19|20)\d{2}/) || [])[0] || null;

  // ürün
  let urun = null;
  if (low.includes('rakı') || low.includes('raki')) urun = 'RAKI';
  else if (low.includes('viski') || low.includes('whisky') || low.includes('whiskey')) urun = 'WHISKY';
  else if (low.includes('vodka') || low.includes('votka')) urun = 'VODKA';
  else if (low.includes('gin') || low.includes('cin')) urun = 'GIN';
  else if (low.includes('likör') || low.includes('likor')) urun = 'LIKOR';

  // kanal
  let kanal = null;
  if (low.includes('toptan')) kanal = 'toptan';
  else if (low.includes('market') || low.includes('markette') || low.includes('perakende')) kanal = 'market';
  else if (low.includes('online') || low.includes('e-ticaret') || low.includes('eticaret')) kanal = 'online';

  return { yil, urun, kanal };
}

function normYil(y) {
  if (!y) return null;
  const m = String(y).match(/(19|20)\d{2}/);
  return m ? parseInt(m[0], 10) : null;
}
function normKanal(k) {
  if (!k) return null;
  const v = String(k).toLowerCase();
  if (v.includes('toptan')) return 'toptan';
  if (v.includes('market') || v.includes('perakende')) return 'market';
  if (v.includes('online') || v.includes('e-ticaret') || v.includes('eticaret')) return 'online';
  return null;
}
function normUrun(u) {
  if (!u) return null;
  const M = String(u).toUpperCase();
  if (M.includes('WHISKY') || M.includes('VISKI')) return 'WHISKY';
  if (M.includes('RAKI')) return 'RAKI';
  if (M.includes('VODKA') || M.includes('VOTKA')) return 'VODKA';
  if (M.includes('GIN') || M.includes('CIN')) return 'GIN';
  if (M.includes('LIKOR') || M.includes('LİKÖR')) return 'LIKOR';
  return M;
}

// log’lu query
async function runQueryWithLog(sqlText, bindFn) {
  const pool = await poolPromise;
  const req = pool.request();
  const params = [];
  if (bindFn) bindFn(req, params);
  console.log('🟦 SQL:\n' + sqlText.trim());
  console.log('🟨 PARAMS:', params);
  const rs = await req.query(sqlText);
  return rs.recordset || [];
}

router.post('/', async (req, res) => {
  try {
    const { intent, slots = {}, text = '' } = req.body || {};
    if (!intent) return res.status(400).json({ ok:false, error:'intent gerekli' });

    // 1) NLU slotları
    let yil   = normYil(slots.yil || slots.YIL);
    let kanal = normKanal(slots.kanal || slots.KANAL);
    let urun  = normUrun(slots.urun || slots.URUN);

    // 2) eksikleri ham metinden tamamla
    const fb = fallbackExtract(text);
    if (!yil && fb.yil)   yil   = normYil(fb.yil);
    if (!kanal && fb.kanal) kanal = normKanal(fb.kanal);
    if (!urun && fb.urun)  urun  = normUrun(fb.urun);

    console.log('🧩 RESOLVED SLOTS =>', { yil, kanal, urun, intent, text });

    if (!yil) return res.status(422).json({ ok:false, error:'yil bulunamadı' });

    // ---- INTENTLER ----
    if (intent === 'rapor.satis_hacmi_litre') {
      let q = `
        SELECT SUM(SATIS_MIKTAR_LITRE) AS Toplam
        FROM YC_SATIS_DETAY_TUMU
        WHERE YIL = @yil
      `;
      const rows = await runQueryWithLog(
        q + (urun ? ' AND URUN_GRUBU = @ug ' : '') + kanalWhere(kanal),
        (req, P) => {
          req.input('yil', sql.Int, yil); P.push(['yil', yil]);
          if (urun) { req.input('ug', sql.NVarChar, urun); P.push(['ug', urun]); }
        }
      );
      const toplam = rows[0]?.Toplam || 0;
      return res.json({
        ok:true, intent, yil, kanal: kanal || 'tüm', urun: urun || 'tüm',
        sonuc: `${yil} yılı ${kanal || 'tüm kanallar'} ${urun || 'tüm ürünler'} toplam ${Number(toplam).toLocaleString('tr-TR')} litre.`
      });
    }

    if (intent === 'rapor.satis_tutar_ciro') {
      let q = `
        SELECT SUM(TUTAR) AS Toplam
        FROM YC_SATIS_DETAY_TUMU
        WHERE YIL = @yil
      `;
      const rows = await runQueryWithLog(
        q + (urun ? ' AND URUN_GRUBU = @ug ' : '') + kanalWhere(kanal),
        (req, P) => {
          req.input('yil', sql.Int, yil); P.push(['yil', yil]);
          if (urun) { req.input('ug', sql.NVarChar, urun); P.push(['ug', urun]); }
        }
      );
      const toplam = rows[0]?.Toplam || 0;
      return res.json({
        ok:true, intent, yil, kanal: kanal || 'tüm', urun: urun || 'tüm',
        sonuc: `${yil} yılı ${kanal || 'tüm kanallar'} ${urun || 'tüm ürünler'} toplam ${Number(toplam).toLocaleString('tr-TR')} TL ciro.`
      });
    }

    return res.status(400).json({ ok:false, error:`Bilinmeyen intent: ${intent}` });

  } catch (e) {
    console.error('💥 ACTION ERROR:', e);
    res.status(500).json({ ok:false, error:'action-failed', detail: String(e?.message || e) });
  }
});

module.exports = router;
