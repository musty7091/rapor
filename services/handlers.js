// services/handlers.js
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

function loadData() {
  const p = path.join(__dirname, '..', 'data', 'satis_ornek.json');
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function toNumberSafe(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function litreSatis({ yil, urun, kanal }) {
  const data = loadData();

  const start = dayjs(`${yil}-01-01`);
  const end = start.add(1, 'year');

  // Eşleştirmeler
  const urunGrubu = (urun || '').toLowerCase().includes('raki') ? 'RAKI' : null;
  const kanalKod  = kanal ? kanal.toUpperCase() : null;

  const toplam = data
    .filter(row => {
      const t = dayjs(row.tarih);
      if (!(t.isSame(start) || (t.isAfter(start) && t.isBefore(end)) || t.isSame(end))) return false;
      if (urunGrubu && row.urun_grubu !== urunGrubu) return false;
      if (kanalKod && row.kanal !== kanalKod) return false;
      return true;
    })
    .reduce((sum, r) => sum + toNumberSafe(r.satis_litre), 0);

  return {
    soru_ozeti: `Yıl=${yil} | Kanal=${kanalKod || 'HEPSİ'} | Ürün=${urunGrubu || 'HEPSİ'}`,
    sonuc: `${yil} yılında ${kanal || 'tüm kanallarda'} ${urun || 'tüm ürünlerde'} toplam ${toplam.toLocaleString('tr-TR')} L`
  };
}

module.exports = { litreSatis };
