require('dotenv').config();
const express = require('express');
const path = require('path');
const sql = require('mssql');

const app = express();
const PORT = process.env.PORT || 3000;

const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
};

const BASE_WHERE_CLAUSE = `
    YIL IN (2024, 2025) 
    AND STOK_ADI <> 'HİZMET' 
    AND TEDARIKCI <> 'GENEL HARCAMA'
`;

const getDateRange = (period) => {
    const now = new Date('2025-09-15T12:00:00'); 
    let startDate, endDate;
    switch (period) {
        case 'bu_ay':
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            break;
        case 'gecen_ay':
            startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            endDate = new Date(now.getFullYear(), now.getMonth(), 0);
            break;
        case 'bu_yil':
            startDate = new Date(now.getFullYear(), 0, 1);
            endDate = new Date(now.getFullYear(), 11, 31);
            break;
        default:
            return null;
    }
    const toYYYYMMDD = (d) => d.toISOString().split('T')[0];
    return { startDate: toYYYYMMDD(startDate), endDate: toYYYYMMDD(endDate) };
};

const poolPromise = new sql.ConnectionPool(dbConfig)
    .connect()
    .then(pool => {
        console.log('✅ Veritabanı bağlantısı başarılı!');
        return pool;
    })
    .catch(err => console.error('❌ Veritabanı bağlantı hatası:', err));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// === ANA SAYFA ===
app.get('/', (req, res) => {
    res.render('index', { sayfaBasligi: 'Ana Sayfa', icerik: 'Rapor Uygulamasına Hoş Geldiniz!' });
});

// === SATIŞ RAPORLARI ===
app.get('/satislar', async (req, res) => {
    try {
        const pool = await poolPromise;
        const musteriFiltre = req.query.musteri || '';
        const musteriler = (await pool.request().query(`
            SELECT DISTINCT FIRMAADI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} ORDER BY FIRMAADI
        `)).recordset;
        let query = `
            ;WITH UrunMaster AS (
                SELECT STOK_KODU, STOK_ADI, ROW_NUMBER() OVER(PARTITION BY STOK_KODU ORDER BY TARIH DESC) as rn
                FROM YC_SATIS_DETAY WHERE STOK_KODU IS NOT NULL AND STOK_KODU <> ''
            ), GuncelUrunler AS (
                SELECT STOK_KODU, STOK_ADI as GUNCEL_STOK_ADI FROM UrunMaster WHERE rn = 1
            )
            SELECT TOP 100 s.FIRMAADI, gu.GUNCEL_STOK_ADI as STOK_ADI, s.MIKTAR, s.TUTAR 
            FROM YC_SATIS_DETAY s
            JOIN GuncelUrunler gu ON s.STOK_KODU = gu.STOK_KODU
            WHERE ${BASE_WHERE_CLAUSE}
        `;
        const request = pool.request();
        if (musteriFiltre) {
            query += ` AND s.FIRMAADI = @musteriParam`;
            request.input('musteriParam', sql.NVarChar, musteriFiltre);
        }
        query += ` ORDER BY s.TUTAR DESC`;
        const result = await request.query(query);
        res.render('satislar', { sayfaBasligi: 'Detaylı Satış Raporu', satislar: result.recordset, musteriler, seciliMusteri: musteriFiltre });
    } catch (err) { console.error(err); res.status(500).send('Hata oluştu'); }
});

app.get('/temsilci-performans', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { yil, ay, temsilci } = req.query;
        const temsilciler = (await pool.request().query(`
            SELECT DISTINCT SATISTEMSILCI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND SATISTEMSILCI IS NOT NULL ORDER BY SATISTEMSILCI
        `)).recordset;
        let query = `SELECT ISNULL(SUM(TUTAR), 0) AS ToplamCiro, ISNULL(SUM(TUTAR - (MIKTAR * COALESCE(MALIYET, ALISFIYATI, 0))), 0) AS ToplamKar, COUNT(DISTINCT FIRMAADI) AS MusteriSayisi FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE}`;
        const request = pool.request();
        if (yil) { query += ` AND YIL = @yilParam`; request.input('yilParam', sql.Int, yil); }
        if (ay) { query += ` AND AY = @ayParam`; request.input('ayParam', sql.Int, ay); }
        if (temsilci) { query += ` AND SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }
        const result = await request.query(query);
        res.render('temsilci-performans', { sayfaBasligi: 'Temsilci Performans Raporu', temsilciler, sonuc: result.recordset[0], filtreler: { yil, ay, temsilci } });
    } catch (err) { console.error(err); res.status(500).send('Hata oluştu'); }
});

// === KARLILIK RAPORLARI ===
app.get('/urun-karlilik', async (req, res) => {
    try {
        const pool = await poolPromise;
        let { kategori, urun_grubu, tedarikci, baslangicTarihi, bitisTarihi, zamanAraligi } = req.query;
        if (zamanAraligi && zamanAraligi !== 'manuel') {
            const range = getDateRange(zamanAraligi);
            if (range) {
                baslangicTarihi = range.startDate;
                bitisTarihi = range.endDate;
            }
        }
        const kategoriler = (await pool.request().query(`SELECT DISTINCT KATEGORI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND KATEGORI IS NOT NULL ORDER BY KATEGORI`)).recordset;
        const urunGruplari = (await pool.request().query(`SELECT DISTINCT URUN_GRUBU FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND URUN_GRUBU IS NOT NULL ORDER BY URUN_GRUBU`)).recordset;
        const tedarikciler = (await pool.request().query(`SELECT DISTINCT TEDARIKCI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND TEDARIKCI IS NOT NULL ORDER BY TEDARIKCI`)).recordset;
        let query = `
            ;WITH UrunMaster AS (
                SELECT STOK_KODU, STOK_ADI, ROW_NUMBER() OVER(PARTITION BY STOK_KODU ORDER BY TARIH DESC) as rn
                FROM YC_SATIS_DETAY WHERE STOK_KODU IS NOT NULL AND STOK_KODU <> ''
            ), GuncelUrunler AS (
                SELECT STOK_KODU, STOK_ADI as GUNCEL_STOK_ADI FROM UrunMaster WHERE rn = 1
            )
            SELECT 
                gu.GUNCEL_STOK_ADI AS STOK_ADI, 
                SUM(s.TUTAR) AS ToplamCiro, 
                SUM(s.TUTAR - (s.MIKTAR * COALESCE(s.MALIYET, s.ALISFIYATI, 0))) AS ToplamKar
            FROM YC_SATIS_DETAY s
            JOIN GuncelUrunler gu ON s.STOK_KODU = gu.STOK_KODU
            WHERE ${BASE_WHERE_CLAUSE} AND s.TUTAR > 0
        `;
        const request = pool.request();
        if (kategori) { query += ` AND s.KATEGORI = @kategoriParam`; request.input('kategoriParam', sql.NVarChar, kategori); }
        if (urun_grubu) { query += ` AND s.URUN_GRUBU = @urunGrubuParam`; request.input('urunGrubuParam', sql.NVarChar, urun_grubu); }
        if (tedarikci) { query += ` AND s.TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
        if (baslangicTarihi) { query += ` AND s.TARIH >= @baslangicParam`; request.input('baslangicParam', sql.Date, baslangicTarihi); }
        if (bitisTarihi) { query += ` AND s.TARIH <= @bitisParam`; request.input('bitisParam', sql.Date, bitisTarihi); }
        query += ` GROUP BY gu.GUNCEL_STOK_ADI ORDER BY ToplamKar DESC`;
        const result = await request.query(query);
        res.render('urun-karlilik', { 
            sayfaBasligi: 'Ürün Karlılık Analizi', 
            sonuclar: result.recordset, kategoriler, urunGruplari, tedarikciler,
            filtreler: { kategori, urun_grubu, tedarikci, baslangicTarihi, bitisTarihi, zamanAraligi }
        });
    } catch (err) { console.error(err); res.status(500).send('Hata oluştu'); }
});

// === KARŞILAŞTIRMALI RAPORLARI ===
app.get('/temsilci-kiyaslama', async (req, res) => {
    try {
        const pool = await poolPromise;
        let { temsilci1, temsilci2, baslangicTarihi, bitisTarihi, tedarikci, kategori, zamanAraligi } = req.query;
        if (zamanAraligi && zamanAraligi !== 'manuel') {
            const range = getDateRange(zamanAraligi);
            if (range) {
                baslangicTarihi = range.startDate;
                bitisTarihi = range.endDate;
            }
        }
        const temsilciler = (await pool.request().query(`SELECT DISTINCT SATISTEMSILCI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND SATISTEMSILCI IS NOT NULL ORDER BY SATISTEMSILCI`)).recordset;
        const tedarikciler = (await pool.request().query(`SELECT DISTINCT TEDARIKCI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND TEDARIKCI IS NOT NULL ORDER BY TEDARIKCI`)).recordset;
        const kategoriler = (await pool.request().query(`SELECT DISTINCT KATEGORI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND KATEGORI IS NOT NULL ORDER BY KATEGORI`)).recordset;
        let sonuc1 = null, sonuc2 = null;
        const getTemsilciData = async (temsilciAdi) => {
            if (!temsilciAdi) return null;
            let query = `
                SELECT 
                    ISNULL(SUM(TUTAR), 0) AS ToplamCiro, ISNULL(SUM(TUTAR - (MIKTAR * COALESCE(MALIYET, ALISFIYATI, 0))), 0) AS ToplamKar, 
                    COUNT(DISTINCT FIRMAADI) AS MusteriSayisi, ISNULL(SUM(MIKTAR), 0) AS ToplamMiktar, ISNULL(SUM(SATIS_MIKTAR_LITRE), 0) AS ToplamLitre
                FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND SATISTEMSILCI = @temsilciParam
            `;
            const request = pool.request();
            request.input('temsilciParam', sql.NVarChar, temsilciAdi);
            if (baslangicTarihi) { query += ` AND TARIH >= @baslangicParam`; request.input('baslangicParam', sql.Date, baslangicTarihi); }
            if (bitisTarihi) { query += ` AND TARIH <= @bitisParam`; request.input('bitisParam', sql.Date, bitisTarihi); }
            if (tedarikci) { query += ` AND TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
            if (kategori) { query += ` AND KATEGORI = @kategoriParam`; request.input('kategoriParam', sql.NVarChar, kategori); }
            const result = await request.query(query);
            return result.recordset[0];
        };
        sonuc1 = await getTemsilciData(temsilci1);
        sonuc2 = await getTemsilciData(temsilci2);
        res.render('temsilci-kiyaslama', { 
            sayfaBasligi: 'Temsilci Kıyaslama Paneli', 
            temsilciler, tedarikciler, kategoriler,
            sonuc1, sonuc2, 
            filtreler: { temsilci1, temsilci2, baslangicTarihi, bitisTarihi, tedarikci, kategori, zamanAraligi } 
        });
    } catch (err) { console.error(err); res.status(500).send('Hata oluştu'); }
});

app.get('/urun-kiyaslama', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { urun, temsilci, tedarikci } = req.query;

        const temsilciler = (await pool.request().query(`SELECT DISTINCT SATISTEMSILCI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND SATISTEMSILCI IS NOT NULL ORDER BY SATISTEMSILCI`)).recordset;
        const tedarikciler = (await pool.request().query(`SELECT DISTINCT TEDARIKCI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND TEDARIKCI IS NOT NULL ORDER BY TEDARIKCI`)).recordset;

        let urunlerQuery = `
            ;WITH UrunMaster AS (
                SELECT STOK_KODU, STOK_ADI, ROW_NUMBER() OVER(PARTITION BY STOK_KODU ORDER BY TARIH DESC) as rn
                FROM YC_SATIS_DETAY s 
                WHERE STOK_KODU IS NOT NULL AND STOK_KODU <> '' AND ${BASE_WHERE_CLAUSE}
        `;
        const request = pool.request();
        let conditions = [];
        if (temsilci) { conditions.push(`s.SATISTEMSILCI = @temsilciParam`); request.input('temsilciParam', sql.NVarChar, temsilci); }
        if (tedarikci) { conditions.push(`s.TEDARIKCI = @tedarikciParam`); request.input('tedarikciParam', sql.NVarChar, tedarikci); }
        if (conditions.length > 0) { urunlerQuery += ` AND ${conditions.join(' AND ')}`; }
        urunlerQuery += `) SELECT STOK_ADI FROM UrunMaster WHERE rn = 1 ORDER BY STOK_ADI`;
        const urunler = (await request.query(urunlerQuery)).recordset;
        
        let sonuclar = [];
        if (urun) {
            const request2 = pool.request(); // Yeni request objesi
            let query2 = `
                ;WITH UrunMaster AS (
                    SELECT STOK_KODU, STOK_ADI, ROW_NUMBER() OVER(PARTITION BY STOK_KODU ORDER BY TARIH DESC) as rn
                    FROM YC_SATIS_DETAY WHERE STOK_KODU IS NOT NULL AND STOK_KODU <> ''
                ), SecilenUrun AS (
                    SELECT STOK_KODU FROM UrunMaster WHERE rn = 1 AND STOK_ADI = @urunParam
                )
                SELECT
                    s.AY,
                    SUM(CASE WHEN s.YIL = 2024 THEN s.MIKTAR ELSE 0 END) as Miktar2024,
                    SUM(CASE WHEN s.YIL = 2025 THEN s.MIKTAR ELSE 0 END) as Miktar2025
                FROM YC_SATIS_DETAY s
                WHERE ${BASE_WHERE_CLAUSE} AND s.STOK_KODU IN (SELECT STOK_KODU FROM SecilenUrun)
            `;
            request2.input('urunParam', sql.NVarChar, urun);
            // HATA DÜZELTMESİ: Filtreleri ana sorguya da ekliyoruz
            if (temsilci) { query2 += ` AND s.SATISTEMSILCI = @temsilciParam`; request2.input('temsilciParam', sql.NVarChar, temsilci); }
            if (tedarikci) { query2 += ` AND s.TEDARIKCI = @tedarikciParam`; request2.input('tedarikciParam', sql.NVarChar, tedarikci); }
            query2 += ` GROUP BY s.AY ORDER BY s.AY`;
            
            const result = await request2.query(query2);
            
            const resultData = result.recordset;
            const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
            for (let i = 1; i <= 12; i++) {
                const monthData = resultData.find(r => r.AY === i);
                sonuclar.push({
                    ay: ayIsimleri[i - 1],
                    miktar2024: monthData ? monthData.Miktar2024 : 0,
                    miktar2025: monthData ? monthData.Miktar2025 : 0,
                });
            }
        }
        res.render('urun-kiyaslama', {
            sayfaBasligi: 'Yıllık Ürün Kıyaslama',
            urunler, temsilciler, tedarikciler,
            sonuclar,
            filtreler: { urun, temsilci, tedarikci }
        });
    } catch (err) { console.error(err); res.status(500).send('Hata oluştu'); }
});

// === DÖNEM RAPORLARI ===
app.get('/aylik-trend', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT YIL, AY, SUM(TUTAR) as ToplamCiro, SUM(TUTAR - (MIKTAR * COALESCE(MALIYET, ALISFIYATI, 0))) as ToplamKar
            FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE}
            GROUP BY YIL, AY ORDER BY YIL, AY
        `);
        res.render('aylik-trend', { sayfaBasligi: 'Aylık Ciro ve Kârlılık Trendi', sonuclar: result.recordset });
    } catch (err) { console.error(err); res.status(500).send('Hata oluştu'); }
});

// === STRATEJİK RAPORLARI ===
app.get('/urun-potansiyeli', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { musteri, temsilci, tedarikci, kategori } = req.query;
        const musteriler = (await pool.request().query(`SELECT DISTINCT FIRMAADI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} ORDER BY FIRMAADI`)).recordset;
        const temsilciler = (await pool.request().query(`SELECT DISTINCT SATISTEMSILCI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND SATISTEMSILCI IS NOT NULL ORDER BY SATISTEMSILCI`)).recordset;
        const tedarikciler = (await pool.request().query(`SELECT DISTINCT TEDARIKCI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND TEDARIKCI IS NOT NULL ORDER BY TEDARIKCI`)).recordset;
        const kategoriler = (await pool.request().query(`SELECT DISTINCT KATEGORI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND KATEGORI IS NOT NULL ORDER BY KATEGORI`)).recordset;
        let sonuclar = { satinAlinan: [], potansiyel: [] };
        if (musteri) {
            let allProductsQuery = `
                ;WITH UrunMaster AS (
                    SELECT STOK_KODU, STOK_ADI, ROW_NUMBER() OVER(PARTITION BY STOK_KODU ORDER BY TARIH DESC) as rn
                    FROM YC_SATIS_DETAY s WHERE STOK_KODU IS NOT NULL AND STOK_KODU <> '' AND ${BASE_WHERE_CLAUSE}
            `;
            const request = pool.request();
            let conditions = [];
            if (temsilci) { conditions.push(`s.SATISTEMSILCI = @temsilciParam`); request.input('temsilciParam', sql.NVarChar, temsilci); }
            if (tedarikci) { conditions.push(`s.TEDARIKCI = @tedarikciParam`); request.input('tedarikciParam', sql.NVarChar, tedarikci); }
            if (kategori) { conditions.push(`s.KATEGORI = @kategoriParam`); request.input('kategoriParam', sql.NVarChar, kategori); }
            if (conditions.length > 0) { allProductsQuery += ` AND ${conditions.join(' AND ')}`; }
            allProductsQuery += `) SELECT STOK_ADI FROM UrunMaster WHERE rn = 1`;
            const allProductsResult = await request.query(allProductsQuery);
            const allProducts = [...new Set(allProductsResult.recordset.map(p => p.STOK_ADI))];
            const customerProductsResult = await pool.request()
                .input('musteriParam', sql.NVarChar, musteri)
                .query(`
                    ;WITH UrunMaster AS (
                        SELECT STOK_KODU, STOK_ADI, ROW_NUMBER() OVER(PARTITION BY STOK_KODU ORDER BY TARIH DESC) as rn
                        FROM YC_SATIS_DETAY WHERE STOK_KODU IS NOT NULL AND STOK_KODU <> ''
                    )
                    SELECT DISTINCT gu.STOK_ADI 
                    FROM YC_SATIS_DETAY s
                    JOIN UrunMaster gu ON s.STOK_KODU = gu.STOK_KODU
                    WHERE gu.rn = 1 AND ${BASE_WHERE_CLAUSE} AND s.FIRMAADI = @musteriParam
                `);
            const customerProductsSet = new Set(customerProductsResult.recordset.map(p => p.STOK_ADI));
            allProducts.forEach(productName => {
                if (customerProductsSet.has(productName)) {
                    sonuclar.satinAlinan.push(productName);
                } else {
                    sonuclar.potansiyel.push(productName);
                }
            });
        }
        res.render('urun-potansiyeli', {
            sayfaBasligi: 'Müşteri Ürün Potansiyeli',
            musteriler, temsilciler, tedarikciler, kategoriler,
            sonuclar,
            filtreler: { musteri, temsilci, tedarikci, kategori }
        });
    } catch (err) { console.error(err); res.status(500).send('Hata oluştu'); }
});

app.get('/musteri-potansiyeli', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { urun, temsilci } = req.query;
        const urunler = (await pool.request().query(`
             ;WITH UrunMaster AS (
                SELECT STOK_KODU, STOK_ADI, ROW_NUMBER() OVER(PARTITION BY STOK_KODU ORDER BY TARIH DESC) as rn
                FROM YC_SATIS_DETAY WHERE STOK_KODU IS NOT NULL AND STOK_KODU <> '' AND ${BASE_WHERE_CLAUSE}
            )
            SELECT STOK_ADI FROM UrunMaster WHERE rn = 1 ORDER BY STOK_ADI
        `)).recordset;
        const temsilciler = (await pool.request().query(`SELECT DISTINCT SATISTEMSILCI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE} AND SATISTEMSILCI IS NOT NULL ORDER BY SATISTEMSILCI`)).recordset;
        let sonuclar = { satinAlan: [], potansiyel: [] };
        if (urun) {
            let allCustomersQuery = `SELECT DISTINCT FIRMAADI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE}`;
            const request1 = pool.request();
            if (temsilci) { allCustomersQuery += ` AND SATISTEMSILCI = @temsilciParam`; request1.input('temsilciParam', sql.NVarChar, temsilci); }
            const allCustomersResult = await request1.query(allCustomersQuery);
            const allCustomers = allCustomersResult.recordset.map(c => c.FIRMAADI);
            let productBuyersQuery = `
                ;WITH UrunMaster AS (
                    SELECT STOK_KODU, STOK_ADI, ROW_NUMBER() OVER(PARTITION BY STOK_KODU ORDER BY TARIH DESC) as rn
                    FROM YC_SATIS_DETAY WHERE STOK_KODU IS NOT NULL AND STOK_KODU <> ''
                ), SecilenUrun AS (
                    SELECT STOK_KODU FROM UrunMaster WHERE rn = 1 AND STOK_ADI = @urunParam
                )
                SELECT DISTINCT s.FIRMAADI 
                FROM YC_SATIS_DETAY s
                WHERE ${BASE_WHERE_CLAUSE} AND s.STOK_KODU IN (SELECT STOK_KODU FROM SecilenUrun)
            `;
            const request2 = pool.request();
            request2.input('urunParam', sql.NVarChar, urun);
            if (temsilci) { productBuyersQuery += ` AND s.SATISTEMSILCI = @temsilciParam`; request2.input('temsilciParam', sql.NVarChar, temsilci); }
            const productBuyersResult = await request2.query(productBuyersQuery);
            const productBuyersSet = new Set(productBuyersResult.recordset.map(c => c.FIRMAADI));
            allCustomers.forEach(customerName => {
                if (productBuyersSet.has(customerName)) {
                    sonuclar.satinAlan.push(customerName);
                } else {
                    sonuclar.potansiyel.push(customerName);
                }
            });
        }
        res.render('musteri-potansiyeli', {
            sayfaBasligi: 'Ürün Satış Potansiyeli',
            urunler, temsilciler,
            sonuclar,
            filtreler: { urun, temsilci }
        });
    } catch (err) { console.error(err); res.status(500).send('Hata oluştu'); }
});

app.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor...`);
});