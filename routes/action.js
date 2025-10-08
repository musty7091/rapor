// routes/action.js
// Mustafa - Nihai sürüm (NLU -> Aksiyon Köprüsü)

const express = require('express');
const router = express.Router();

// MSSQL bağlantısı: db.js proje kökünde ise bu yol DOĞRU.
// (Eğer action.js kökteyse '../db' yerine './db' yazın.)
const { poolPromise, sql } = require('../db');

// =========================
// Yardımcı Fonksiyonlar
// =========================
function normYil(y) {
  const m = String(y || '').match(/20\d{2}/);
  return m ? m[0] : '2025'; // yıl yoksa en güncel yılı varsay
}
function normKanal(k) {
  const v = (k || '').toString().toLowerCase();
  if (v.includes('toptan')) return 'toptan';
  if (v.includes('online')) return 'online';
  return 'market'; // varsayılan
}
function normUrun(u) {
  const M = (u || '').toString().toUpperCase();
  const allow = ['WHISKY', 'VODKA', 'GIN', 'RAKI', 'LIKOR'];
  if (allow.includes(M)) return M;
  if (M.includes('VISKI') || M.includes('WHIS')) return 'WHISKY';
  if (M.includes('VOD')) return 'VODKA';
  if (M.includes('GIN')) return 'GIN';
  if (M.includes('RAK')) return 'RAKI';
  if (M.includes('LIK')) return 'LIKOR';
  return null; // null -> tüm ürün grupları
}
function kanalFisClause(kanal) {
  if (kanal === 'toptan') return ' AND FIS_TURU IN (21,23) ';
  if (kanal === 'market') return ' AND FIS_TURU IN (101,102) ';
  if (kanal === 'online') return " AND KANAL='ONLINE' ";
  return '';
}

// NOT: Gerekirse bu kolon adını kendi tablona göre değiştir.
// Örn: 'MIKTAR_LITRE' ise LITRE_KOLON'u ona çevir.
const LITRE_KOLON = 'SATIS_MIKTAR_LITRE';

// Tek satırlık DB query yardımcıları
async function runQuery(build, bind = () => {}) {
  const pool = await poolPromise;
  const req = pool.request();
  bind(req);
  const rs = await req.query(build);
  return rs;
}

// =========================
// Aksiyon Sorguları
// =========================
async function qToplamLitre({ yil, urun, kanal }) {
  let q = `
    SELECT SUM(${LITRE_KOLON}) AS ToplamLitre
    FROM YC_SATIS_DETAY_TUMU
    WHERE YIL = @yil
  `;
  const bind = (req) => req.input('yil', sql.Int, Number(yil));
  if (urun) { q += ' AND URUN_GRUBU = @ug '; bind.toString; }
  const rs = await runQuery(q + kanalFisClause(kanal), (req) => {
    req.input('yil', sql.Int, Number(yil));
    if (urun) req.input('ug', sql.NVarChar, urun);
  });
  return rs.recordset[0]?.ToplamLitre || 0;
}

async function qToplamCiro({ yil, urun, kanal }) {
  // 1) SQL metnini KOŞULLARIYLA birlikte kur
  let sqlText = `
    SELECT SUM(TUTAR) AS ToplamTutar
    FROM YC_SATIS_DETAY_TUMU
    WHERE YIL = @yil
  `;
  if (urun) sqlText += ' AND URUN_GRUBU = @ug ';
  sqlText += kanalFisClause(kanal);   // market/toptan/online koşulu

  // 2) Parametreleri bağla
  const rs = await runQuery(sqlText, (req) => {
    req.input('yil', sql.Int, Number(yil));
    if (urun) req.input('ug', sql.NVarChar, urun);
  });

  // 3) Sonucu döndür
  return rs.recordset[0]?.ToplamTutar || 0;
}

async function qAylikLitre({ yil, urun, kanal }) {
  let q = `
    SELECT AY, SUM(${LITRE_KOLON}) AS Litre
    FROM YC_SATIS_DETAY_TUMU
    WHERE YIL = @yil
  `;
  if (urun) q += ' AND URUN_GRUBU = @ug ';
  q += kanalFisClause(kanal);
  q += ' GROUP BY AY ORDER BY AY;';
  const rs = await runQuery(q, (req) => {
    req.input('yil', sql.Int, Number(yil));
    if (urun) req.input('ug', sql.NVarChar, urun);
  });
  return rs.recordset || [];
}

async function qKanalDagilimi({ yil, urun }) {
  let q = `
    SELECT 
      CASE 
        WHEN FIS_TURU IN (21,23) THEN 'toptan'
        WHEN FIS_TURU IN (101,102) THEN 'market'
        ELSE 'diger'
      END AS Kanal,
      SUM(${LITRE_KOLON}) AS Litre
    FROM YC_SATIS_DETAY_TUMU
    WHERE YIL = @yil
  `;
  if (urun) q += ' AND URUN_GRUBU = @ug ';
  q += `
    GROUP BY CASE 
      WHEN FIS_TURU IN (21,23) THEN 'toptan'
      WHEN FIS_TURU IN (101,102) THEN 'market'
      ELSE 'diger'
    END
  `;
  const rs = await runQuery(q, (req) => {
    req.input('yil', sql.Int, Number(yil));
    if (urun) req.input('ug', sql.NVarChar, urun);
  });
  return rs.recordset || [];
}

async function qKarsilastirYilLitre({ kanal, urun }) {
  let q = `
    SELECT YIL, SUM(${LITRE_KOLON}) AS Litre
    FROM YC_SATIS_DETAY_TUMU
    WHERE YIL IN (2024, 2025)
  `;
  if (urun) q += ' AND URUN_GRUBU = @ug ';
  q += kanalFisClause(kanal);
  q += ' GROUP BY YIL ORDER BY YIL;';
  const rs = await runQuery(q, (req) => {
    if (urun) req.input('ug', sql.NVarChar, urun);
  });
  return rs.recordset || [];
}

async function qTopUrunLitre({ yil, kanal, urun }) {
  let q = `
    SELECT TOP 5 STOK_ADI, SUM(${LITRE_KOLON}) AS Litre
    FROM YC_SATIS_DETAY_TUMU
    WHERE YIL = @yil
  `;
  if (urun) q += ' AND URUN_GRUBU = @ug ';
  q += kanalFisClause(kanal);
  q += ' GROUP BY STOK_ADI ORDER BY Litre DESC;';
  const rs = await runQuery(q, (req) => {
    req.input('yil', sql.Int, Number(yil));
    if (urun) req.input('ug', sql.NVarChar, urun);
  });
  return rs.recordset || [];
}

// =========================
// Router
// =========================
router.post('/', async (req, res) => {
  try {
    const { intent, slots } = req.body || {};
    if (!intent) return res.status(400).json({ ok: false, error: 'intent gerekli' });

    // NLU'dan gelmeyen değerleri akıllı varsayılanlarla doldur
    const yil   = normYil(slots?.yil || slots?.YIL);
    const kanal = normKanal(slots?.kanal || slots?.KANAL);
    const urun  = normUrun(slots?.urun || slots?.URUN);

    switch (intent) {
      // 1) Toplam litre
      case 'rapor.satis_hacmi_litre': {
        const toplam = await qToplamLitre({ yil, urun, kanal });
        return res.json({
          ok: true, intent, yil, kanal, urun: urun || 'TÜM',
          sonuc: `${yil} yılında ${kanal} kanalında ${urun || 'tüm ürünlerde'} toplam ${Number(toplam || 0).toLocaleString('tr-TR')} litre satış.`
        });
      }

      // 2) Toplam ciro (TL)
      case 'rapor.satis_tutar_ciro': {
        const toplam = await qToplamCiro({ yil, urun, kanal });
        return res.json({
          ok: true, intent, yil, kanal, urun: urun || 'TÜM',
          sonuc: `${yil} yılında ${kanal} kanalında ${urun || 'tüm ürünlerde'} toplam ${Number(toplam || 0).toLocaleString('tr-TR')} TL ciro.`
        });
      }

      // 3) Aylık kırılım (litre)
      case 'rapor.aylik_kirilim_litre': {
        const aylik = await qAylikLitre({ yil, urun, kanal });
        return res.json({ ok: true, intent, yil, kanal, urun: urun || 'TÜM', aylik });
      }

      // 4) Kanal dağılımı (litre)
      case 'rapor.kanal_dagilimi_litre': {
        const dagilim = await qKanalDagilimi({ yil, urun });
        return res.json({ ok: true, intent, yil, urun: urun || 'TÜM', dagilim });
      }

      // 5) 2024 vs 2025 karşılaştırma (litre)
      case 'rapor.karsilastir_yil_litre': {
        const yillar = await qKarsilastirYilLitre({ kanal, urun });
        return res.json({ ok: true, intent, kanal, urun: urun || 'TÜM', yillar });
      }

      // 6) Top ürünler (litre)
      case 'rapor.top_urun_litre': {
        const top = await qTopUrunLitre({ yil, kanal, urun });
        return res.json({ ok: true, intent, yil, kanal, urun: urun || 'TÜM', top });
      }

      // Yardım
      case 'yardim.ne_yapabilir':
        return res.json({
          ok: true,
          intent,
          komutlar: [
            "2024 market rakı litre",
            "2025 toptan viski ciro",
            "2024 vodka market aylık litre",
            "2024 rakı için kanal dağılımı litre",
            "market viski 2024 ve 2025 litre karşılaştır",
            "2024 markette en çok satılan viski ürünleri litre"
          ]
        });

      default:
        return res.status(400).json({ ok: false, error: `Bilinmeyen intent: ${intent}` });
    }
  } catch (e) {
    console.error('💥 ACTION ERROR:', e);
    res.status(500).json({ ok: false, error: 'action-failed' });
  }
});

module.exports = router;
