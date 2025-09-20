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

// YENİ ve GELİŞMİŞ HESAPLAMA KATMANI: Önce işlem bazında, bulamazsa ürünün geneline bakarak maliyet bulur.
const KARLILIK_HESAPLAMA_CTE = `
WITH IslemBazindaMaliyet AS (
    -- 1. Adım: Her bir işlem grubu (Tarih, Firma, Stok) için ortalama maliyeti hesapla.
    SELECT 
        TARIH,
        FIRMAADI,
        STOK_KODU,
        (CASE 
            WHEN SUM(MIKTAR) > 0 THEN SUM(MIKTAR * COALESCE(MALIYET, ALISFIYATI, 0)) / SUM(MIKTAR)
            ELSE 0 
        END) AS IslemOrtalamaMaliyeti
    FROM YC_SATIS_DETAY
    GROUP BY TARIH, FIRMAADI, STOK_KODU
),
GenelUrunMaliyeti AS (
    -- 2. Adım: Her bir ürün için bilinen son (en yüksek) geçerli maliyeti bul (fallback için).
    SELECT
        STOK_KODU,
        MAX(COALESCE(MALIYET, ALISFIYATI, 0)) as GenelGecerliMaliyet
    FROM YC_SATIS_DETAY
    WHERE COALESCE(MALIYET, ALISFIYATI, 0) > 0
    GROUP BY STOK_KODU
),
AnaVeri AS (
    -- 3. Adım: Ana tabloyu bu iki yardımcı tablo ile birleştir ve nihai maliyeti belirle.
    SELECT
        s.*,
        COALESCE(
            NULLIF(ibm.IslemOrtalamaMaliyeti, 0), -- Önce işlem bazındaki maliyeti kullanmayı dene
            güm.GenelGecerliMaliyet,             -- Eğer işlemde maliyet yoksa, ürünün genel geçerli maliyetini kullan
            0                                    -- O da yoksa son çare 0 kullan
        ) AS DogruBirimMaliyet
    FROM 
        YC_SATIS_DETAY s
    LEFT JOIN 
        IslemBazindaMaliyet ibm ON s.TARIH = ibm.TARIH AND s.FIRMAADI = ibm.FIRMAADI AND s.STOK_KODU = ibm.STOK_KODU
    LEFT JOIN
        GenelUrunMaliyeti güm ON s.STOK_KODU = güm.STOK_KODU
)
`;


const BASE_WHERE_CLAUSE_SIMPLE = `
    YIL IN (2024, 2025) 
    AND STOK_ADI <> 'HİZMET' 
    AND TEDARIKCI <> 'GENEL HARCAMA'
`;

const BASE_WHERE_CLAUSE_PREFIXED = `
    s.YIL IN (2024, 2025) 
    AND s.STOK_ADI <> 'HİZMET' 
    AND s.TEDARIKCI <> 'GENEL HARCAMA'
`;

const GUNCEL_URUNLER_SUBQUERY = `
    (
        SELECT STOK_KODU, STOK_ADI FROM (
            SELECT 
                STOK_KODU, 
                STOK_ADI, 
                ROW_NUMBER() OVER(PARTITION BY STOK_KODU ORDER BY TARIH DESC) as rn
            FROM YC_SATIS_DETAY 
            WHERE STOK_KODU IS NOT NULL AND STOK_KODU <> ''
        ) AS UrunMaster WHERE rn = 1
    )
`;


const getDateRange = (period) => {
    const now = new Date(); 
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

// Merkezi Veri Çekme Fonksiyonu
const getFilterData = async (options = []) => {
    const pool = await poolPromise;
    const data = {};
    const queries = {
        temsilciler: `SELECT DISTINCT SATISTEMSILCI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE_SIMPLE} AND SATISTEMSILCI IS NOT NULL ORDER BY SATISTEMSILCI`,
        musteriler: `SELECT DISTINCT FIRMAADI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE_SIMPLE} ORDER BY FIRMAADI`,
        tedarikciler: `SELECT DISTINCT TEDARIKCI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE_SIMPLE} AND TEDARIKCI IS NOT NULL ORDER BY TEDARIKCI`,
        kategoriler: `SELECT DISTINCT KATEGORI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE_SIMPLE} AND KATEGORI IS NOT NULL ORDER BY KATEGORI`,
        urunGruplari: `SELECT DISTINCT URUN_GRUBU FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE_SIMPLE} AND URUN_GRUBU IS NOT NULL ORDER BY URUN_GRUBU`,
        urunler: `SELECT STOK_ADI FROM ${GUNCEL_URUNLER_SUBQUERY} AS gu ORDER BY STOK_ADI`
    };

    const promises = options.map(async (key) => {
        if (queries[key]) {
            const result = await pool.request().query(queries[key]);
            data[key] = result.recordset;
        }
    });

    await Promise.all(promises);
    return data;
};


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// === ANA SAYFA ===
app.get('/', (req, res) => {
    res.render('index', { sayfaBasligi: 'Ana Sayfa', icerik: 'Rapor Uygulamasına Hoş Geldiniz!' });
});

// === SATIŞ RAPORLARI ===
app.get('/temsilci-performans', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { yil, ay, temsilci, musteri, tedarikci } = req.query;

        const { temsilciler, tedarikciler } = await getFilterData(['temsilciler', 'tedarikciler']);

        let musteriQuery = `SELECT DISTINCT FIRMAADI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE_SIMPLE}`;
        const musteriRequest = pool.request();
        if (yil) { musteriQuery += ` AND YIL = @yilParam`; musteriRequest.input('yilParam', sql.Int, yil); }
        if (ay) { musteriQuery += ` AND AY = @ayParam`; musteriRequest.input('ayParam', sql.Int, ay); }
        if (temsilci) { musteriQuery += ` AND SATISTEMSILCI = @temsilciParam`; musteriRequest.input('temsilciParam', sql.NVarChar, temsilci); }
        musteriQuery += ` ORDER BY FIRMAADI`;
        const musteriler = (await musteriRequest.query(musteriQuery)).recordset;

        let query = `
            ${KARLILIK_HESAPLAMA_CTE}
            SELECT 
                ISNULL(SUM(TUTAR), 0) AS ToplamCiro, 
                ISNULL(SUM(TUTAR - (MIKTAR * DogruBirimMaliyet)), 0) AS ToplamKar, 
                COUNT(DISTINCT FIRMAADI) AS MusteriSayisi 
            FROM AnaVeri 
            WHERE ${BASE_WHERE_CLAUSE_SIMPLE}
        `;
        const request = pool.request();
        if (yil) { query += ` AND YIL = @yilParam`; request.input('yilParam', sql.Int, yil); }
        if (ay) { query += ` AND AY = @ayParam`; request.input('ayParam', sql.Int, ay); }
        if (temsilci) { query += ` AND SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }
        if (musteri) { query += ` AND FIRMAADI = @musteriParam`; request.input('musteriParam', sql.NVarChar, musteri); }
        if (tedarikci) { query += ` AND TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
        
        const result = await request.query(query);

        res.render('temsilci-performans', { 
            sayfaBasligi: 'Temsilci Performans Raporu', 
            temsilciler, 
            musteriler, 
            tedarikciler,
            sonuc: result.recordset[0], 
            filtreler: { yil, ay, temsilci, musteri, tedarikci } 
        });
    } catch (err) { console.error(err); res.status(500).send('Hata oluştu'); }
});


// === KARLILIK RAPORLARI ===
app.get('/urun-karlilik', async (req, res) => {
    try {
        const pool = await poolPromise;
        let { urun, kategori, urun_grubu, tedarikci, baslangicTarihi, bitisTarihi, zamanAraligi } = req.query;
        if (zamanAraligi && zamanAraligi !== 'manuel') {
            const range = getDateRange(zamanAraligi);
            if (range) {
                baslangicTarihi = range.startDate;
                bitisTarihi = range.endDate;
            }
        }
        const { urunler, kategoriler, urunGruplari, tedarikciler: tedarikcilerDB } = await getFilterData(['urunler', 'kategoriler', 'urunGruplari', 'tedarikciler']);
        
        let query = `
            ${KARLILIK_HESAPLAMA_CTE}
            SELECT 
                s.STOK_ADI, 
                SUM(s.TUTAR) AS ToplamCiro, 
                SUM(s.TUTAR - (s.MIKTAR * s.DogruBirimMaliyet)) AS ToplamKar
            FROM AnaVeri s
            WHERE ${BASE_WHERE_CLAUSE_PREFIXED} AND s.TUTAR >= 0 
        `;
        const request = pool.request();
        if (urun) { query += ` AND s.STOK_ADI = @urunParam`; request.input('urunParam', sql.NVarChar, urun); }
        if (kategori) { query += ` AND s.KATEGORI = @kategoriParam`; request.input('kategoriParam', sql.NVarChar, kategori); }
        if (urun_grubu) { query += ` AND s.URUN_GRUBU = @urunGrubuParam`; request.input('urunGrubuParam', sql.NVarChar, urun_grubu); }
        if (tedarikci) { query += ` AND s.TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
        if (baslangicTarihi) { query += ` AND s.TARIH >= @baslangicParam`; request.input('baslangicParam', sql.Date, baslangicTarihi); }
        if (bitisTarihi) { query += ` AND s.TARIH <= @bitisParam`; request.input('bitisParam', sql.Date, bitisTarihi); }
        query += ` GROUP BY s.STOK_ADI ORDER BY ToplamKar DESC`;
        
        const result = await request.query(query);
        const sonuclar = result.recordset;

        let kpis = {
            toplamCiro: 0,
            toplamKar: 0,
            ortalamaKarlilik: 0,
            urunSayisi: 0
        };

        if (sonuclar.length > 0) {
            kpis.toplamCiro = sonuclar.reduce((sum, s) => sum + s.ToplamCiro, 0);
            kpis.toplamKar = sonuclar.reduce((sum, s) => sum + s.ToplamKar, 0);
            kpis.urunSayisi = sonuclar.length;
            if (kpis.toplamCiro > 0) {
                kpis.ortalamaKarlilik = (kpis.toplamKar / kpis.toplamCiro) * 100;
            }
        }

        res.render('urun-karlilik', { 
            sayfaBasligi: 'Ürün Karlılık Analizi', 
            sonuclar: sonuclar, 
            kpis: kpis, 
            urunler, 
            kategoriler, 
            urunGruplari, 
            tedarikciler: tedarikcilerDB,
            filtreler: { urun, kategori, urun_grubu, tedarikci, baslangicTarihi, bitisTarihi, zamanAraligi }
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
        const { temsilciler, tedarikciler, kategoriler } = await getFilterData(['temsilciler', 'tedarikciler', 'kategoriler']);

        let sonuc1 = null, sonuc2 = null;
        const getTemsilciData = async (temsilciAdi) => {
            if (!temsilciAdi) return null;
            let query = `
                ${KARLILIK_HESAPLAMA_CTE}
                SELECT 
                    ISNULL(SUM(TUTAR), 0) AS ToplamCiro, 
                    ISNULL(SUM(TUTAR - (MIKTAR * DogruBirimMaliyet)), 0) AS ToplamKar, 
                    COUNT(DISTINCT FIRMAADI) AS MusteriSayisi, 
                    ISNULL(SUM(MIKTAR), 0) AS ToplamMiktar, 
                    ISNULL(SUM(SATIS_MIKTAR_LITRE), 0) AS ToplamLitre
                FROM AnaVeri 
                WHERE ${BASE_WHERE_CLAUSE_SIMPLE} AND SATISTEMSILCI = @temsilciParam
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

        const { temsilciler, tedarikciler } = await getFilterData(['temsilciler', 'tedarikciler']);

        let urunlerQuery = `
            SELECT DISTINCT gu.STOK_ADI 
            FROM YC_SATIS_DETAY s
            JOIN ${GUNCEL_URUNLER_SUBQUERY} gu ON s.STOK_KODU = gu.STOK_KODU
            WHERE ${BASE_WHERE_CLAUSE_PREFIXED}
        `;
        const request = pool.request();
        if (temsilci) { urunlerQuery += ` AND s.SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }
        if (tedarikci) { urunlerQuery += ` AND s.TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
        urunlerQuery += ` ORDER BY gu.STOK_ADI`;
        const urunler = (await request.query(urunlerQuery)).recordset;
        
        let sonuclar = [];
        if (urun) {
            const request2 = pool.request();
            let query2 = `
                SELECT
                    s.AY,
                    SUM(CASE WHEN s.YIL = 2024 THEN s.MIKTAR ELSE 0 END) as Miktar2024,
                    SUM(CASE WHEN s.YIL = 2025 THEN s.MIKTAR ELSE 0 END) as Miktar2025
                FROM YC_SATIS_DETAY s
                WHERE ${BASE_WHERE_CLAUSE_PREFIXED} AND s.STOK_KODU IN (
                    SELECT STOK_KODU FROM ${GUNCEL_URUNLER_SUBQUERY} AS gu WHERE gu.STOK_ADI = @urunParam
                )
            `;
            request2.input('urunParam', sql.NVarChar, urun);
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
    } catch (err) {
        console.error(err);
        res.status(500).send('Hata oluştu');
    }
});


// === DÖNEM RAPORLARI ===
app.get('/aylik-trend', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            ${KARLILIK_HESAPLAMA_CTE}
            SELECT YIL, AY, 
                SUM(TUTAR) as ToplamCiro, 
                SUM(TUTAR - (MIKTAR * DogruBirimMaliyet)) as ToplamKar
            FROM AnaVeri 
            WHERE ${BASE_WHERE_CLAUSE_SIMPLE}
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
        const { musteriler, temsilciler, tedarikciler: tedarikcilerDB, kategoriler } = await getFilterData(['musteriler', 'temsilciler', 'tedarikciler', 'kategoriler']);
        
        let sonuclar = { satinAlinan: [], potansiyel: [] };
        if (musteri) {
            let allProductsQuery = `
                SELECT DISTINCT gu.STOK_ADI 
                FROM YC_SATIS_DETAY s
                JOIN ${GUNCEL_URUNLER_SUBQUERY} gu ON s.STOK_KODU = gu.STOK_KODU
                WHERE ${BASE_WHERE_CLAUSE_PREFIXED}
            `;
            const request = pool.request();
            if (temsilci) { allProductsQuery += ` AND s.SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }
            if (tedarikci) { allProductsQuery += ` AND s.TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
            if (kategori) { allProductsQuery += ` AND s.KATEGORI = @kategoriParam`; request.input('kategoriParam', sql.NVarChar, kategori); }
            
            const allProductsResult = await request.query(allProductsQuery);
            const allProducts = allProductsResult.recordset.map(p => p.STOK_ADI);
            
            const customerProductsResult = await pool.request()
                .input('musteriParam', sql.NVarChar, musteri)
                .query(`
                    SELECT DISTINCT gu.STOK_ADI 
                    FROM YC_SATIS_DETAY s
                    JOIN ${GUNCEL_URUNLER_SUBQUERY} gu ON s.STOK_KODU = gu.STOK_KODU
                    WHERE ${BASE_WHERE_CLAUSE_PREFIXED} AND s.FIRMAADI = @musteriParam
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
            musteriler, temsilciler, tedarikciler: tedarikcilerDB, kategoriler,
            sonuclar,
            filtreler: { musteri, temsilci, tedarikci, kategori }
        });
    } catch (err) { console.error(err); res.status(500).send('Hata oluştu'); }
});

app.get('/musteri-potansiyeli', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { urun, temsilci } = req.query;
        const { urunler, temsilciler } = await getFilterData(['urunler', 'temsilciler']);

        let sonuclar = { satinAlan: [], potansiyel: [] };
        if (urun) {
            let allCustomersQuery = `SELECT DISTINCT s.FIRMAADI FROM YC_SATIS_DETAY s WHERE ${BASE_WHERE_CLAUSE_PREFIXED}`;
            const request1 = pool.request();
            if (temsilci) { allCustomersQuery += ` AND s.SATISTEMSILCI = @temsilciParam`; request1.input('temsilciParam', sql.NVarChar, temsilci); }
            const allCustomersResult = await request1.query(allCustomersQuery);
            const allCustomers = allCustomersResult.recordset.map(c => c.FIRMAADI);
            
            let productBuyersQuery = `
                SELECT DISTINCT s.FIRMAADI 
                FROM YC_SATIS_DETAY s
                WHERE ${BASE_WHERE_CLAUSE_PREFIXED} AND s.STOK_KODU IN (
                    SELECT STOK_KODU FROM ${GUNCEL_URUNLER_SUBQUERY} AS gu WHERE gu.STOK_ADI = @urunParam
                )
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

// === API ROTALARI ===
app.get('/api/urunler', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { temsilci, tedarikci } = req.query;

        let urunlerQuery = `
            SELECT DISTINCT gu.STOK_ADI 
            FROM YC_SATIS_DETAY s
            JOIN ${GUNCEL_URUNLER_SUBQUERY} gu ON s.STOK_KODU = gu.STOK_KODU
            WHERE ${BASE_WHERE_CLAUSE_PREFIXED}
        `;
        const request = pool.request();
        if (temsilci) { urunlerQuery += ` AND s.SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }
        if (tedarikci) { urunlerQuery += ` AND s.TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
        
        urunlerQuery += ` ORDER BY gu.STOK_ADI`;
        const urunler = (await request.query(urunlerQuery)).recordset;
        res.json(urunler);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ürünler getirilemedi' });
    }
});

app.get('/api/musteriler', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { yil, ay, temsilci } = req.query;

        let musteriQuery = `SELECT DISTINCT FIRMAADI FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE_SIMPLE}`;
        const request = pool.request();
        if (yil) { musteriQuery += ` AND YIL = @yilParam`; request.input('yilParam', sql.Int, yil); }
        if (ay) { musteriQuery += ` AND AY = @ayParam`; request.input('ayParam', sql.Int, ay); }
        if (temsilci) { musteriQuery += ` AND SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }
        musteriQuery += ` ORDER BY FIRMAADI`;
        
        const musteriler = (await request.query(musteriQuery)).recordset;
        res.json(musteriler);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Müşteriler getirilemedi' });
    }
});


app.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor...`);
});