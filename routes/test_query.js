const { poolPromise } = require('./db');

(async () => {
  try {
    const pool = await poolPromise;
    console.log('✅ Bağlantı başarılı, sorgular çalışıyor...');

    // ÜRÜN GRUBU değerleri
    const urunler = await pool.request().query('SELECT DISTINCT URUN_GRUBU FROM YC_SATIS_DETAY_TUMU');
    console.log('🔸 URUN_GRUBU örnekleri:');
    console.log(urunler.recordset.slice(0, 50)); // ilk 15 satırı göster

    // FİŞ TÜRÜ değerleri
    const fisler = await pool.request().query('SELECT DISTINCT FIS_TURU FROM YC_SATIS_DETAY_TUMU');
    console.log('🔹 FIS_TURU örnekleri:');
    console.log(fisler.recordset.slice(0, 50));

    process.exit(0);
  } catch (err) {
    console.error('❌ Hata:', err);
    process.exit(1);
  }
})();
