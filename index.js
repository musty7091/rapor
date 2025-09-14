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

        let query = `SELECT TOP 100 FIRMAADI, STOK_ADI, MIKTAR, TUTAR FROM YC_SATIS_DETAY WHERE ${BASE_WHERE_CLAUSE}`;
        const request = pool.request();
        if (musteriFiltre) {
            query += ` AND FIRMAADI = @musteriParam`;
            request.input('musteriParam', sql.NVarChar, musteriFiltre);
        }
        query += ` ORDER BY TUTAR DESC`;
        
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

// === KARLILIK RAPORLARI (GÜNCELLENDİ) ===
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
            SELECT 
                STOK_ADI,
                SUM(TUTAR) AS ToplamCiro,
                SUM(TUTAR - (MIKTAR * COALESCE(MALIYET, ALISFIYATI, 0))) AS ToplamKar
            FROM YC_SATIS_DETAY 
            WHERE ${BASE_WHERE_CLAUSE} AND TUTAR > 0
        `;
        const request = pool.request();
        if (kategori) { query += ` AND KATEGORI = @kategoriParam`; request.input('kategoriParam', sql.NVarChar, kategori); }
        if (urun_grubu) { query += ` AND URUN_GRUBU = @urunGrubuParam`; request.input('urunGrubuParam', sql.NVarChar, urun_grubu); }
        if (tedarikci) { query += ` AND TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
        if (baslangicTarihi) { query += ` AND TARIH >= @baslangicParam`; request.input('baslangicParam', sql.Date, baslangicTarihi); }
        if (bitisTarihi) { query += ` AND TARIH <= @bitisParam`; request.input('bitisParam', sql.Date, bitisTarihi); }
        query += ` GROUP BY STOK_ADI ORDER BY ToplamKar DESC`;

        const result = await request.query(query);
        res.render('urun-karlilik', { 
            sayfaBasligi: 'Ürün Karlılık Analizi', 
            sonuclar: result.recordset, 
            kategoriler, 
            urunGruplari, 
            tedarikciler,
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
                    ISNULL(SUM(TUTAR), 0) AS ToplamCiro, 
                    ISNULL(SUM(TUTAR - (MIKTAR * COALESCE(MALIYET, ALISFIYATI, 0))), 0) AS ToplamKar, 
                    COUNT(DISTINCT FIRMAADI) AS MusteriSayisi,
                    ISNULL(SUM(MIKTAR), 0) AS ToplamMiktar,
                    ISNULL(SUM(SATIS_MIKTAR_LITRE), 0) AS ToplamLitre
                FROM YC_SATIS_DETAY 
                WHERE ${BASE_WHERE_CLAUSE} AND SATISTEMSILCI = @temsilciParam
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

// === DÖNEM RAPORLARI ===
app.get('/aylik-trend', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT 
                YIL, AY,
                SUM(TUTAR) as ToplamCiro,
                SUM(TUTAR - (MIKTAR * COALESCE(MALIYET, ALISFIYATI, 0))) as ToplamKar
            FROM YC_SATIS_DETAY
            WHERE ${BASE_WHERE_CLAUSE}
            GROUP BY YIL, AY
            ORDER BY YIL, AY
        `);
        res.render('aylik-trend', { sayfaBasligi: 'Aylık Ciro ve Kârlılık Trendi', sonuclar: result.recordset });
    } catch (err) { console.error(err); res.status(500).send('Hata oluştu'); }
});


app.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor...`);
});

