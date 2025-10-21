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
    port: parseInt(process.env.DB_PORT, 10),
    options: {
        encrypt: false,
        trustServerCertificate: true
    },
    requestTimeout: 60000 
};

// NET HESAPLAMA SABİTLERİ
const NET_TUTAR = "(CASE WHEN s.FIS_TURU IN (23, 102) THEN -s.TUTAR ELSE s.TUTAR END)";
const NET_MIKTAR = "(CASE WHEN s.FIS_TURU IN (23, 102) THEN -s.MIKTAR ELSE s.MIKTAR END)";
const NET_LITRE = "(CASE WHEN s.FIS_TURU IN (23, 102) THEN -s.SATIS_MIKTAR_LITRE ELSE s.SATIS_MIKTAR_LITRE END)";
const NET_TUTAR_ANAVERI = "(CASE WHEN AnaVeri.FIS_TURU IN (23, 102) THEN -AnaVeri.TUTAR ELSE AnaVeri.TUTAR END)";
const NET_MIKTAR_ANAVERI = "(CASE WHEN AnaVeri.FIS_TURU IN (23, 102) THEN -AnaVeri.MIKTAR ELSE AnaVeri.MIKTAR END)";
const NET_LITRE_ANAVERI = "(CASE WHEN AnaVeri.FIS_TURU IN (23, 102) THEN -AnaVeri.SATIS_MIKTAR_LITRE ELSE AnaVeri.SATIS_MIKTAR_LITRE END)";

const KARLILIK_HESAPLAMA_CTE = `
WITH IslemBazindaMaliyet AS (
    SELECT 
        TARIH,
        FIRMAADI,
        STOK_KODU,
        (CASE 
            WHEN SUM(CASE WHEN FIS_TURU IN (23, 102) THEN -MIKTAR ELSE MIKTAR END) > 0 
            THEN SUM((CASE WHEN FIS_TURU IN (23, 102) THEN -MIKTAR ELSE MIKTAR END) * COALESCE(MALIYET, ALISFIYATI, 0)) / SUM(CASE WHEN FIS_TURU IN (23, 102) THEN -MIKTAR ELSE MIKTAR END)
            ELSE 0 
        END) AS IslemOrtalamaMaliyeti
    FROM YC_SATIS_DETAY_TUMU
    GROUP BY TARIH, FIRMAADI, STOK_KODU
),
GenelUrunMaliyeti AS (
    SELECT
        STOK_KODU,
        MAX(COALESCE(MALIYET, ALISFIYATI, 0)) as GenelGecerliMaliyet
    FROM YC_SATIS_DETAY_TUMU
    WHERE COALESCE(MALIYET, ALISFIYATI, 0) > 0
    GROUP BY STOK_KODU
),
AnaVeri AS (
    SELECT
        s.*,
        COALESCE(
            NULLIF(ibm.IslemOrtalamaMaliyeti, 0),
            güm.GenelGecerliMaliyet,
            0
        ) AS DogruBirimMaliyet
    FROM 
        YC_SATIS_DETAY_TUMU s
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
            FROM YC_SATIS_DETAY_TUMU 
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

const getFilterData = async (options = []) => {
    const pool = await poolPromise;
    const data = {};
    const queries = {
        temsilciler: `SELECT DISTINCT SATISTEMSILCI FROM YC_SATIS_DETAY_TUMU WHERE ${BASE_WHERE_CLAUSE_SIMPLE} AND SATISTEMSILCI IS NOT NULL ORDER BY SATISTEMSILCI`,
        musteriler: `SELECT DISTINCT FIRMAADI FROM YC_SATIS_DETAY_TUMU WHERE ${BASE_WHERE_CLAUSE_SIMPLE} ORDER BY FIRMAADI`,
        tedarikciler: `SELECT DISTINCT TEDARIKCI FROM YC_SATIS_DETAY_TUMU WHERE ${BASE_WHERE_CLAUSE_SIMPLE} AND TEDARIKCI IS NOT NULL ORDER BY TEDARIKCI`,
        kategoriler: `SELECT DISTINCT KATEGORI FROM YC_SATIS_DETAY_TUMU WHERE ${BASE_WHERE_CLAUSE_SIMPLE} AND KATEGORI IS NOT NULL ORDER BY KATEGORI`,
        urunGruplari: `SELECT DISTINCT URUN_GRUBU FROM YC_SATIS_DETAY_TUMU WHERE ${BASE_WHERE_CLAUSE_SIMPLE} AND URUN_GRUBU IS NOT NULL ORDER BY URUN_GRUBU`,
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


// === ANA SAYFA VE SORGULAMA ROTASI ===
app.get('/', (req, res) => {
    res.render('index', { sayfaBasligi: 'Ana Sayfa', icerik: 'Rapor Uygulamasına Hoş Geldiniz!' });
});

app.get('/sorgula', async (req, res) => {
    try {
        const { prompt } = req.query;
        if (!prompt) {
            return res.redirect('/');
        }

        const lowerPrompt = prompt.toLowerCase();
        let params = {};

        if (lowerPrompt.includes('litre')) params.metrik = 'litre';
        else if (lowerPrompt.includes('tutar') || lowerPrompt.includes('ciro')) params.metrik = 'tutar';
        else params.metrik = 'adet';

        if (lowerPrompt.includes('market')) params.fis_turu = 'market';
        else if (lowerPrompt.includes('toptan')) params.fis_turu = 'toptan';

        if (lowerPrompt.includes('rakı')) params.urun_grubu = 'RAKI';

        const yearMatch = lowerPrompt.match(/\b(2024|2025)\b/);
        if (yearMatch) {
            const year = yearMatch[0];
            params.zamanAraligi = 'manuel';
            params.baslangicTarihi = `${year}-01-01`;
            params.bitisTarihi = `${year}-12-31`;
        }

        const queryString = new URLSearchParams(params).toString();
        
        res.redirect(`/urun-kiyaslama?${queryString}`);

    } catch (err) {
        console.error("Hata - Sorgulama: ", err);
        res.status(500).send('Sorgu işlenirken bir hata oluştu.');
    }
});


// === SATIŞ RAPORLARI ===
app.get('/temsilci-performans', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { yil, ay, temsilci, musteri, tedarikci, fis_turu } = req.query;
        const { temsilciler, tedarikciler } = await getFilterData(['temsilciler', 'tedarikciler']);

        let musteriQuery = `SELECT DISTINCT FIRMAADI FROM YC_SATIS_DETAY_TUMU WHERE ${BASE_WHERE_CLAUSE_SIMPLE}`;
        const musteriRequest = pool.request();
        if (yil) { musteriQuery += ` AND YIL = @yilParam`; musteriRequest.input('yilParam', sql.Int, yil); }
        if (ay) { musteriQuery += ` AND AY = @ayParam`; musteriRequest.input('ayParam', sql.Int, ay); }
        if (temsilci) { musteriQuery += ` AND SATISTEMSILCI = @temsilciParam`; musteriRequest.input('temsilciParam', sql.NVarChar, temsilci); }
        if (fis_turu === 'toptan') {
            musteriQuery += ` AND FIS_TURU IN (21, 23)`;
        } else if (fis_turu === 'market') {
            musteriQuery += ` AND FIS_TURU IN (101, 102)`;
        }
        musteriQuery += ` ORDER BY FIRMAADI`;
        const musteriler = (await musteriRequest.query(musteriQuery)).recordset;

        let query = `
            ${KARLILIK_HESAPLAMA_CTE}
            SELECT 
                ISNULL(SUM(${NET_TUTAR_ANAVERI}), 0) AS ToplamCiro, 
                ISNULL(SUM((${NET_TUTAR_ANAVERI}) - ((${NET_MIKTAR_ANAVERI}) * DogruBirimMaliyet)), 0) AS ToplamKar, 
                COUNT(DISTINCT AnaVeri.FIRMAADI) AS MusteriSayisi 
            FROM AnaVeri 
            WHERE YIL IN (2024, 2025) AND STOK_ADI <> 'HİZMET' AND TEDARIKCI <> 'GENEL HARCAMA'
        `;
        const request = pool.request();
        if (yil) { query += ` AND YIL = @yilParam`; request.input('yilParam', sql.Int, yil); }
        if (ay) { query += ` AND AY = @ayParam`; request.input('ayParam', sql.Int, ay); }
        if (temsilci) { query += ` AND SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }
        if (musteri) { query += ` AND FIRMAADI = @musteriParam`; request.input('musteriParam', sql.NVarChar, musteri); }
        if (tedarikci) { query += ` AND TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
        if (fis_turu === 'toptan') {
            query += ` AND FIS_TURU IN (21, 23)`;
        } else if (fis_turu === 'market') {
            query += ` AND FIS_TURU IN (101, 102)`;
        }
        
        const result = await request.query(query);

        res.render('temsilci-performans', { 
            sayfaBasligi: 'Temsilci Performans Raporu', 
            temsilciler, 
            musteriler, 
            tedarikciler,
            sonuc: result.recordset[0], 
            filtreler: { yil, ay, temsilci, musteri, tedarikci, fis_turu } 
        });
    } catch (err) { console.error("Hata - Temsilci Performansı: ", err); res.status(500).send('Hata oluştu'); }
});

const getTopNProducts = async (n, filtreler) => {
    const pool = await poolPromise;
    const { tedarikci, urun_grubu, baslangicTarihi, bitisTarihi, fis_turu } = filtreler;

    const request = pool.request();
    let whereClauses = `WHERE ${BASE_WHERE_CLAUSE_PREFIXED}`;
    if (tedarikci) { whereClauses += ' AND s.TEDARIKCI = @tedarikciParam'; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
    if (urun_grubu) { whereClauses += ' AND s.URUN_GRUBU = @urunGrubuParam'; request.input('urunGrubuParam', sql.NVarChar, urun_grubu); }
    if (baslangicTarihi) { whereClauses += ' AND s.TARIH >= @baslangicParam'; request.input('baslangicParam', sql.Date, baslangicTarihi); }
    if (bitisTarihi) { whereClauses += ' AND s.TARIH <= @bitisParam'; request.input('bitisParam', sql.Date, bitisTarihi); }
    
    if (fis_turu === 'toptan') {
        whereClauses += ` AND s.FIS_TURU IN (21, 23)`;
    } else if (fis_turu === 'market') {
        whereClauses += ` AND s.FIS_TURU IN (101, 102)`;
    }
    
    const query = `
        SELECT TOP ${n}
            s.STOK_ADI,
            ISNULL(SUM(${NET_TUTAR}), 0) as ToplamTutar,
            ISNULL(SUM(${NET_MIKTAR}), 0) as ToplamAdet,
            ISNULL(SUM(${NET_LITRE}), 0) as ToplamLitre
        FROM YC_SATIS_DETAY_TUMU s
        ${whereClauses}
        GROUP BY s.STOK_ADI
        ORDER BY ToplamTutar DESC;
    `;
    const result = await request.query(query);
    return result.recordset;
};

app.get('/top-5-satis', async (req, res) => {
    try {
        const { tedarikciler } = await getFilterData(['tedarikciler']);
        const sonuclar = await getTopNProducts(5, req.query);
        
        const pool = await poolPromise;
        let urunGruplariQuery = 'SELECT DISTINCT URUN_GRUBU FROM YC_SATIS_DETAY_TUMU WHERE URUN_GRUBU IS NOT NULL';
        const ugRequest = pool.request();
        if (req.query.tedarikci) {
            urunGruplariQuery += ' AND TEDARIKCI = @tedarikciParam';
            ugRequest.input('tedarikciParam', sql.NVarChar, req.query.tedarikci);
        }
        if (req.query.fis_turu === 'toptan') {
            urunGruplariQuery += ` AND FIS_TURU IN (21, 23)`;
        } else if (req.query.fis_turu === 'market') {
            urunGruplariQuery += ` AND FIS_TURU IN (101, 102)`;
        }
        urunGruplariQuery += ' ORDER BY URUN_GRUBU';
        const urunGruplari = (await ugRequest.query(urunGruplariQuery)).recordset;

        res.render('top-satis', {
            sayfaBasligi: 'Top 5 Satış Analizi',
            sonuclar,
            tedarikciler,
            urunGruplari,
            filtreler: req.query
        });
    } catch(err) {
        console.error("Hata - Top 5 Satış: ", err);
        res.status(500).send('Hata oluştu');
    }
});

app.get('/top-10-satis', async (req, res) => {
    try {
        const { tedarikciler } = await getFilterData(['tedarikciler']);
        const sonuclar = await getTopNProducts(10, req.query);
        
        const pool = await poolPromise;
        let urunGruplariQuery = 'SELECT DISTINCT URUN_GRUBU FROM YC_SATIS_DETAY_TUMU WHERE URUN_GRUBU IS NOT NULL';
        const ugRequest = pool.request();
        if (req.query.tedarikci) {
            urunGruplariQuery += ' AND TEDARIKCI = @tedarikciParam';
            ugRequest.input('tedarikciParam', sql.NVarChar, req.query.tedarikci);
        }
        if (req.query.fis_turu === 'toptan') {
            urunGruplariQuery += ` AND FIS_TURU IN (21, 23)`;
        } else if (req.query.fis_turu === 'market') {
            urunGruplariQuery += ` AND FIS_TURU IN (101, 102)`;
        }
        urunGruplariQuery += ' ORDER BY URUN_GRUBU';
        const urunGruplari = (await ugRequest.query(urunGruplariQuery)).recordset;

        res.render('top-satis', {
            sayfaBasligi: 'Top 10 Satış Analizi',
            sonuclar,
            tedarikciler,
            urunGruplari,
            filtreler: req.query
        });
    } catch(err) {
        console.error("Hata - Top 10 Satış: ", err);
        res.status(500).send('Hata oluştu');
    }
});


// === KARLILIK RAPORLARI ===
app.get('/urun-karlilik', async (req, res) => {
    try {
        const pool = await poolPromise;
        const query = `
            ${KARLILIK_HESAPLAMA_CTE}
            SELECT 
                s.STOK_ADI, 
                SUM(${NET_TUTAR}) AS ToplamCiro, 
                SUM((${NET_TUTAR}) - ((${NET_MIKTAR}) * s.DogruBirimMaliyet)) AS ToplamKar
            FROM AnaVeri s
            WHERE 
                s.YIL = 2025 
                AND s.TEDARIKCI = 'ALİ ERTAN CO LTD'
                AND s.STOK_ADI <> 'HİZMET' 
            GROUP BY s.STOK_ADI 
            ORDER BY ToplamKar DESC
        `;
        
        const result = await pool.request().query(query);
        const sonuclar = result.recordset;

        let kpis = { toplamCiro: 0, toplamKar: 0, ortalamaKarlilik: 0, urunSayisi: 0 };
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
            kpis: kpis
        });
    } catch (err) { console.error("Hata - Ürün Karlılığı: ", err); res.status(500).send('Hata oluştu'); }
});

app.get('/karlilik-marji-analizi', async (req, res) => {
    try {
        const pool = await poolPromise;
        let { gruplama, baslangicTarihi, bitisTarihi, zamanAraligi } = req.query;

        if (!gruplama) gruplama = 'temsilci';

        if (zamanAraligi && zamanAraligi !== 'manuel') {
            const range = getDateRange(zamanAraligi);
            if (range) {
                baslangicTarihi = range.startDate;
                bitisTarihi = range.endDate;
            }
        }
        
        let groupByColumn = '';
        switch(gruplama) {
            case 'musteri': groupByColumn = 'FIRMAADI'; break;
            case 'kategori': groupByColumn = 'KATEGORI'; break;
            default: groupByColumn = 'SATISTEMSILCI';
        }

        const request = pool.request();
        let whereClauses = `WHERE ${BASE_WHERE_CLAUSE_SIMPLE.replace('YIL IN (2024, 2025)', '1=1')}`;
        if (baslangicTarihi) { whereClauses += ` AND TARIH >= @baslangicParam`; request.input('baslangicParam', sql.Date, baslangicTarihi); }
        if (bitisTarihi) { whereClauses += ` AND TARIH <= @bitisParam`; request.input('bitisParam', sql.Date, bitisTarihi); }

        const marginQuery = `
            ${KARLILIK_HESAPLAMA_CTE}
            SELECT
                ${groupByColumn},
                SUM(${NET_TUTAR_ANAVERI}) as ToplamCiro,
                SUM((${NET_TUTAR_ANAVERI}) - ((${NET_MIKTAR_ANAVERI}) * DogruBirimMaliyet)) as ToplamKar,
                CASE 
                    WHEN SUM(${NET_TUTAR_ANAVERI}) = 0 THEN 0
                    ELSE (SUM((${NET_TUTAR_ANAVERI}) - ((${NET_MIKTAR_ANAVERI}) * DogruBirimMaliyet)) * 100.0) / SUM(${NET_TUTAR_ANAVERI})
                END as KarMarji
            FROM AnaVeri
            ${whereClauses}
            GROUP BY ${groupByColumn}
            HAVING ${groupByColumn} IS NOT NULL AND SUM(${NET_TUTAR_ANAVERI}) > 0
            ORDER BY KarMarji DESC;
        `;

        const result = await request.query(marginQuery);
        
        res.render('karlilik-marji-analizi', {
            sayfaBasligi: 'Kârlılık Marjı Analizi',
            sonuclar: result.recordset,
            filtreler: { gruplama, baslangicTarihi, bitisTarihi, zamanAraligi },
            groupByColumn: groupByColumn
        });

    } catch (err) {
        console.error("Hata - Kârlılık Marjı Analizi: ", err);
        res.status(500).send('Hata oluştu');
    }
});


// === KARŞILAŞTIRMALI RAPORLAR ===
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

        const getTemsilciData = async (temsilciAdi) => {
            if (!temsilciAdi) return null;
            let query = `
                ${KARLILIK_HESAPLAMA_CTE}
                SELECT 
                    ISNULL(SUM(${NET_TUTAR_ANAVERI}), 0) AS ToplamCiro, 
                    ISNULL(SUM((${NET_TUTAR_ANAVERI}) - ((${NET_MIKTAR_ANAVERI}) * DogruBirimMaliyet)), 0) AS ToplamKar, 
                    COUNT(DISTINCT AnaVeri.FIRMAADI) AS MusteriSayisi, 
                    ISNULL(SUM(${NET_MIKTAR_ANAVERI}), 0) AS ToplamMiktar, 
                    ISNULL(SUM(${NET_LITRE_ANAVERI}), 0) AS ToplamLitre
                FROM AnaVeri 
                WHERE YIL IN (2024, 2025) AND STOK_ADI <> 'HİZMET' AND TEDARIKCI <> 'GENEL HARCAMA'
                AND SATISTEMSILCI = @temsilciParam
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
        const [sonuc1, sonuc2] = await Promise.all([getTemsilciData(temsilci1), getTemsilciData(temsilci2)]);

        res.render('temsilci-kiyaslama', { 
            sayfaBasligi: 'Temsilci Kıyaslama Paneli', 
            temsilciler, tedarikciler, kategoriler,
            sonuc1, sonuc2, 
            filtreler: { temsilci1, temsilci2, baslangicTarihi, bitisTarihi, tedarikci, kategori, zamanAraligi } 
        });
    } catch (err) { console.error("Hata - Temsilci Kıyaslama: ", err); res.status(500).send('Hata oluştu'); }
});

app.get('/urun-kiyaslama', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { urun_grubu, urun, temsilci, tedarikci, metrik = 'adet', fis_turu } = req.query;

        const { temsilciler, tedarikciler } = await getFilterData(['temsilciler', 'tedarikciler']);
        
        let urunGruplariQuery = `SELECT DISTINCT URUN_GRUBU FROM YC_SATIS_DETAY_TUMU WHERE URUN_GRUBU IS NOT NULL`;
        const urunGruplariRequest = pool.request();
        if (temsilci) { urunGruplariQuery += ` AND SATISTEMSILCI = @temsilciParam`; urunGruplariRequest.input('temsilciParam', sql.NVarChar, temsilci); }
        if (tedarikci) { urunGruplariQuery += ` AND TEDARIKCI = @tedarikciParam`; urunGruplariRequest.input('tedarikciParam', sql.NVarChar, tedarikci); }
        urunGruplariQuery += ` ORDER BY URUN_GRUBU`;
        const urunGruplari = (await urunGruplariRequest.query(urunGruplariQuery)).recordset;

        let urunlerQuery = `SELECT DISTINCT STOK_ADI FROM YC_SATIS_DETAY_TUMU WHERE STOK_ADI IS NOT NULL`;
        const urunlerRequest = pool.request();
        if (temsilci) { urunlerQuery += ` AND SATISTEMSILCI = @temsilciParam`; urunlerRequest.input('temsilciParam', sql.NVarChar, temsilci); }
        if (tedarikci) { urunlerQuery += ` AND TEDARIKCI = @tedarikciParam`; urunlerRequest.input('tedarikciParam', sql.NVarChar, tedarikci); }
        if (urun_grubu) { urunlerQuery += ` AND URUN_GRUBU = @urunGrubuParam`; urunlerRequest.input('urunGrubuParam', sql.NVarChar, urun_grubu); }
        urunlerQuery += ` ORDER BY STOK_ADI`;
        const urunler = (await urunlerRequest.query(urunlerQuery)).recordset;
        
        let sonuclar = [];
        if (urun_grubu || urun) {
            let aggregationColumn;
            if (metrik === 'litre') {
                aggregationColumn = NET_LITRE;
            } else if (metrik === 'tutar') {
                aggregationColumn = NET_TUTAR;
            } else {
                aggregationColumn = NET_MIKTAR;
            }

            const request = pool.request();
            let query = `
                SELECT
                    s.AY,
                    SUM(CASE WHEN s.YIL = 2024 THEN ${aggregationColumn} ELSE 0 END) as miktar2024,
                    SUM(CASE WHEN s.YIL = 2025 THEN ${aggregationColumn} ELSE 0 END) as miktar2025
                FROM YC_SATIS_DETAY_TUMU s
                WHERE ${BASE_WHERE_CLAUSE_PREFIXED} 
            `;
            
            if (urun) {
                query += ` AND s.STOK_ADI = @urunParam`;
                request.input('urunParam', sql.NVarChar, urun);
            } else if (urun_grubu) {
                query += ` AND s.URUN_GRUBU = @urunGrubuParam`;
                request.input('urunGrubuParam', sql.NVarChar, urun_grubu);
            }
            
            if (temsilci) { query += ` AND s.SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }
            if (tedarikci) { query += ` AND s.TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
            
            if (fis_turu === 'toptan') {
                query += ` AND s.FIS_TURU IN (21, 23)`;
            } else if (fis_turu === 'market') {
                query += ` AND s.FIS_TURU IN (101, 102)`;
            }

            query += ` GROUP BY s.AY ORDER BY s.AY`;
            
            const result = await request.query(query);
            
            const resultData = result.recordset;
            const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
            for (let i = 1; i <= 12; i++) {
                const monthData = resultData.find(r => r.AY === i);
                sonuclar.push({
                    ay: ayIsimleri[i - 1],
                    miktar2024: monthData ? monthData.miktar2024 : 0,
                    miktar2025: monthData ? monthData.miktar2025 : 0,
                });
            }
        }
        res.render('urun-kiyaslama', {
            sayfaBasligi: 'Yıllık Kıyaslama Raporu',
            urunGruplari,
            urunler,
            temsilciler, 
            tedarikciler,
            sonuclar,
            filtreler: { urun_grubu, urun, temsilci, tedarikci, metrik, fis_turu } 
        });
    } catch (err) {
        console.error("Hata - Ürün Kıyaslama: ", err);
        res.status(500).send('Hata oluştu');
    }
});

// YENİ EKLENEN RAPOR: TEDARİKCİ KATEGORİ KIYASLAMA
app.get('/tedarikci-kategori-kiyaslama', async (req, res) => {
    try {
        const { tedarikci, metrik = 'tutar' } = req.query; // Metrik filtresi eklendi
        const { tedarikciler } = await getFilterData(['tedarikciler']);
        
        let sonuclar = [];
        if (tedarikci) {
            const pool = await poolPromise;
            const request = pool.request();
            request.input('tedarikciParam', sql.NVarChar, tedarikci);
            
            let aggregationColumn2024;
            let aggregationColumn2025;

            if (metrik === 'adet') {
                aggregationColumn2024 = `ISNULL(SUM(CASE WHEN s.YIL = 2024 THEN ${NET_MIKTAR} ELSE 0 END), 0) as Metrik2024`;
                aggregationColumn2025 = `ISNULL(SUM(CASE WHEN s.YIL = 2025 THEN ${NET_MIKTAR} ELSE 0 END), 0) as Metrik2025`;
            } else if (metrik === 'litre') {
                aggregationColumn2024 = `ISNULL(SUM(CASE WHEN s.YIL = 2024 THEN ${NET_LITRE} ELSE 0 END), 0) as Metrik2024`;
                aggregationColumn2025 = `ISNULL(SUM(CASE WHEN s.YIL = 2025 THEN ${NET_LITRE} ELSE 0 END), 0) as Metrik2025`;
            } else { // Tutar varsayılan
                aggregationColumn2024 = `ISNULL(SUM(CASE WHEN s.YIL = 2024 THEN ${NET_TUTAR} ELSE 0 END), 0) as Metrik2024`;
                aggregationColumn2025 = `ISNULL(SUM(CASE WHEN s.YIL = 2025 THEN ${NET_TUTAR} ELSE 0 END), 0) as Metrik2025`;
            }
            
            const query = `
                SELECT
                    s.KATEGORI,
                    s.URUN_GRUBU,
                    s.AY,
                    ${aggregationColumn2024},
                    ${aggregationColumn2025}
                FROM YC_SATIS_DETAY_TUMU s
                WHERE 
                    s.TEDARIKCI = @tedarikciParam
                    AND s.YIL IN (2024, 2025)
                    AND s.FIS_TURU IN (101, 102) -- Sadece Market Satışları
                    AND s.KATEGORI IS NOT NULL
                    AND s.URUN_GRUBU IS NOT NULL
                GROUP BY s.KATEGORI, s.URUN_GRUBU, s.AY
                ORDER BY s.KATEGORI, s.URUN_GRUBU, s.AY;
            `;
            
            const result = await request.query(query);
            
            const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
            const kategoriMap = new Map();

            for (const satir of result.recordset) {
                if (!kategoriMap.has(satir.KATEGORI)) {
                    kategoriMap.set(satir.KATEGORI, {
                        KATEGORI: satir.KATEGORI,
                        Toplam2024: 0,
                        Toplam2025: 0,
                        urunGrubuMap: new Map()
                    });
                }
                const kategori = kategoriMap.get(satir.KATEGORI);

                if (!kategori.urunGrubuMap.has(satir.URUN_GRUBU)) {
                    const aylikData = Array(12).fill(null).map((_, i) => ({
                        ay: ayIsimleri[i],
                        Metrik2024: 0,
                        Metrik2025: 0
                    }));
                    
                    kategori.urunGrubuMap.set(satir.URUN_GRUBU, {
                        URUN_GRUBU: satir.URUN_GRUBU,
                        Toplam2024: 0,
                        Toplam2025: 0,
                        aylikData: aylikData
                    });
                }
                const grup = kategori.urunGrubuMap.get(satir.URUN_GRUBU);

                const ayIndex = satir.AY - 1;
                grup.aylikData[ayIndex].Metrik2024 = satir.Metrik2024;
                grup.aylikData[ayIndex].Metrik2025 = satir.Metrik2025;

                grup.Toplam2024 += satir.Metrik2024;
                grup.Toplam2025 += satir.Metrik2025;
                kategori.Toplam2024 += satir.Metrik2024;
                kategori.Toplam2025 += satir.Metrik2025;
            }

            sonuclar = Array.from(kategoriMap.values()).map(kategori => {
                kategori.urunGruplari = Array.from(kategori.urunGrubuMap.values());
                delete kategori.urunGrubuMap;
                return kategori;
            });
        }

        res.render('tedarikci-kategori-kiyaslama', {
            sayfaBasligi: 'Tedarikçi Kategori Kıyaslama',
            tedarikciler,
            sonuclar,
            filtreler: { tedarikci, metrik }
        });

    } catch (err) {
        console.error("Hata - Tedarikçi Kategori Kıyaslama: ", err);
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
                SUM(${NET_TUTAR_ANAVERI}) as ToplamCiro, 
                SUM((${NET_TUTAR_ANAVERI}) - ((${NET_MIKTAR_ANAVERI}) * DogruBirimMaliyet)) as ToplamKar
            FROM AnaVeri 
            WHERE ${BASE_WHERE_CLAUSE_SIMPLE.replace('s.', 'AnaVeri.')}
            GROUP BY YIL, AY ORDER BY YIL, AY
        `);
        res.render('aylik-trend', { sayfaBasligi: 'Aylık Ciro ve Kârlılık Trendi', sonuclar: result.recordset });
    } catch (err) { console.error("Hata - Aylık Trend: ", err); res.status(500).send('Hata oluştu'); }
});

// === STRATEJİK RAPORLAR ===
app.get('/urun-potansiyeli', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { musteri, temsilci, tedarikci, kategori } = req.query;
        const { musteriler, temsilciler, tedarikciler: tedarikcilerDB, kategoriler } = await getFilterData(['musteriler', 'temsilciler', 'tedarikciler', 'kategoriler']);
        
        let sonuclar = { satinAlinan: [], potansiyel: [] };
        if (musteri) {
            let allProductsQuery = `
                SELECT DISTINCT gu.STOK_ADI 
                FROM YC_SATIS_DETAY_TUMU s
                JOIN ${GUNCEL_URUNLER_SUBQUERY} gu ON s.STOK_KODU = gu.STOK_KODU
                WHERE ${BASE_WHERE_CLAUSE_PREFIXED} AND (${NET_TUTAR}) > 0
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
                    FROM YC_SATIS_DETAY_TUMU s
                    JOIN ${GUNCEL_URUNLER_SUBQUERY} gu ON s.STOK_KODU = gu.STOK_KODU
                    WHERE ${BASE_WHERE_CLAUSE_PREFIXED} AND s.FIRMAADI = @musteriParam AND (${NET_TUTAR}) > 0
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
    } catch (err) { console.error("Hata - Ürün Potansiyeli: ", err); res.status(500).send('Hata oluştu'); }
});

app.get('/musteri-potansiyeli', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { urun, temsilci } = req.query;
        const { urunler, temsilciler } = await getFilterData(['urunler', 'temsilciler']);

        let sonuclar = { satinAlan: [], potansiyel: [] };
        if (urun) {
            let allCustomersQuery = `SELECT DISTINCT s.FIRMAADI FROM YC_SATIS_DETAY_TUMU s WHERE ${BASE_WHERE_CLAUSE_PREFIXED} AND (${NET_TUTAR}) > 0`;
            const request1 = pool.request();
            if (temsilci) { allCustomersQuery += ` AND s.SATISTEMSILCI = @temsilciParam`; request1.input('temsilciParam', sql.NVarChar, temsilci); }
            const allCustomersResult = await request1.query(allCustomersQuery);
            const allCustomers = allCustomersResult.recordset.map(c => c.FIRMAADI);
            
            let productBuyersQuery = `
                SELECT DISTINCT s.FIRMAADI 
                FROM YC_SATIS_DETAY_TUMU s
                WHERE ${BASE_WHERE_CLAUSE_PREFIXED} AND (${NET_TUTAR}) > 0 AND s.STOK_KODU IN (
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
    } catch (err) { console.error("Hata - Müşteri Potansiyeli: ", err); res.status(500).send('Hata oluştu'); }
});

app.get('/musteri-kayip-urun', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { musteri, temsilci, tedarikci } = req.query;
        const { temsilciler, tedarikciler } = await getFilterData(['temsilciler', 'tedarikciler']);

        let musterilerQuery = `SELECT DISTINCT FIRMAADI FROM YC_SATIS_DETAY_TUMU WHERE ${BASE_WHERE_CLAUSE_SIMPLE}`;
        const musteriRequest = pool.request();
        if (temsilci) {
            musterilerQuery += ' AND SATISTEMSILCI = @temsilciParam';
            musteriRequest.input('temsilciParam', sql.NVarChar, temsilci);
        }
        musterilerQuery += ' ORDER BY FIRMAADI';
        const musteriler = (await musteriRequest.query(musterilerQuery)).recordset;

        let sonuclar = { kayipUrunler: [], yeniUrunler: [] };

        if (musteri) {
            const createFilteredQueryForCodes = (year) => {
                let baseQuery = `
                    SELECT DISTINCT STOK_KODU FROM YC_SATIS_DETAY_TUMU 
                    WHERE FIRMAADI = @musteriParam AND YIL = ${year} AND STOK_KODU IS NOT NULL AND STOK_KODU <> ''
                    AND FIS_TURU IN (21, 101)
                `;
                if (temsilci) baseQuery += ` AND SATISTEMSILCI = @temsilciParam`;
                if (tedarikci) baseQuery += ` AND TEDARIKCI = @tedarikciParam`;
                return baseQuery;
            };

            const request = pool.request();
            request.input('musteriParam', sql.NVarChar, musteri);
            if (temsilci) request.input('temsilciParam', sql.NVarChar, temsilci);
            if (tedarikci) request.input('tedarikciParam', sql.NVarChar, tedarikci);
            
            const kayipUrunlerQuery = `
                SELECT gu.STOK_ADI 
                FROM ${GUNCEL_URUNLER_SUBQUERY} gu 
                WHERE gu.STOK_KODU IN (
                    SELECT T.STOK_KODU FROM (${createFilteredQueryForCodes(2024)}) AS T
                    EXCEPT
                    SELECT T.STOK_KODU FROM (${createFilteredQueryForCodes(2025)}) AS T
                )
            `;
            
            const yeniUrunlerQuery = `
                SELECT gu.STOK_ADI 
                FROM ${GUNCEL_URUNLER_SUBQUERY} gu 
                WHERE gu.STOK_KODU IN (
                    SELECT T.STOK_KODU FROM (${createFilteredQueryForCodes(2025)}) AS T
                    EXCEPT
                    SELECT T.STOK_KODU FROM (${createFilteredQueryForCodes(2024)}) AS T
                )
            `;
            
            const [kayipResult, yeniResult] = await Promise.all([
                request.query(kayipUrunlerQuery),
                request.query(yeniUrunlerQuery)
            ]);
            
            sonuclar.kayipUrunler = kayipResult.recordset;
            sonuclar.yeniUrunler = yeniResult.recordset;
        }

        res.render('musteri-kayip-urun', {
            sayfaBasligi: 'Müşteri Kayıp/Yeni Ürün Analizi',
            musteriler,
            temsilciler,
            tedarikciler,
            sonuclar,
            filtreler: { musteri, temsilci, tedarikci }
        });

    } catch (err) {
        console.error("Hata - Müşteri Kayıp/Yeni Ürün: ", err);
        res.status(500).send('Hata oluştu');
    }
});

app.get('/musteri-deger-analizi', async (req, res) => {
     try {
        const pool = await poolPromise;
        let { temsilci, tedarikci, baslangicTarihi, bitisTarihi, zamanAraligi } = req.query;

        const { temsilciler, tedarikciler } = await getFilterData(['temsilciler', 'tedarikciler']);

        if (!zamanAraligi) zamanAraligi = 'bu_yil';
        if (zamanAraligi && zamanAraligi !== 'manuel') {
            const range = getDateRange(zamanAraligi);
            if (range) {
                baslangicTarihi = range.startDate;
                bitisTarihi = range.endDate;
            }
        }
        
        let kpis = { toplamCiro: 0, sayiA: 0, sayiB: 0, sayiC: 0 };
        
        const request = pool.request();
        let whereClauses = `WHERE ${BASE_WHERE_CLAUSE_SIMPLE.replace('YIL IN (2024, 2025)', '1=1')}`;
        if (temsilci) { whereClauses += ` AND SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }
        if (tedarikci) { whereClauses += ` AND TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
        if (baslangicTarihi) { whereClauses += ` AND TARIH >= @baslangicParam`; request.input('baslangicParam', sql.Date, baslangicTarihi); }
        if (bitisTarihi) { whereClauses += ` AND TARIH <= @bitisParam`; request.input('bitisParam', sql.Date, bitisTarihi); }

        const abcQuery = `
            ${KARLILIK_HESAPLAMA_CTE},
            MusteriCiroKar AS (
                SELECT
                    FIRMAADI,
                    SUM(${NET_TUTAR_ANAVERI}) as ToplamCiro,
                    SUM((${NET_TUTAR_ANAVERI}) - ((${NET_MIKTAR_ANAVERI}) * DogruBirimMaliyet)) as ToplamKar
                FROM AnaVeri
                ${whereClauses}
                GROUP BY FIRMAADI
            ),
            GenelToplam AS (
                SELECT SUM(ToplamCiro) as GenelToplamCiro FROM MusteriCiroKar WHERE ToplamCiro > 0
            ),
            KumulatifCiro AS (
                SELECT
                    FIRMAADI,
                    ToplamCiro,
                    ToplamKar,
                    (ToplamCiro * 100.0) / GenelToplamCiro AS CiroPayiYuzdesi,
                    (SUM(ToplamCiro) OVER (ORDER BY ToplamCiro DESC, FIRMAADI) * 100.0) / GenelToplamCiro AS KumulatifCiroYuzdesi
                FROM MusteriCiroKar, GenelToplam
                WHERE ToplamCiro > 0
            )
            SELECT
                FIRMAADI,
                ToplamCiro,
                ToplamKar,
                CiroPayiYuzdesi,
                KumulatifCiroYuzdesi,
                CASE
                    WHEN KumulatifCiroYuzdesi <= 80 THEN 'A'
                    WHEN KumulatifCiroYuzdesi > 80 AND KumulatifCiroYuzdesi <= 95 THEN 'B'
                    ELSE 'C'
                END as Sinif
            FROM KumulatifCiro
            ORDER BY ToplamCiro DESC;
        `;

        const result = await request.query(abcQuery);
        const sonuclar = result.recordset;

        if (sonuclar.length > 0) {
            kpis.toplamCiro = sonuclar.reduce((sum, s) => sum + s.ToplamCiro, 0);
            sonuclar.forEach(s => {
                if (s.Sinif === 'A') kpis.sayiA++;
                else if (s.Sinif === 'B') kpis.sayiB++;
                else kpis.sayiC++;
            });
        }
        
        res.render('musteri-deger-analizi', {
            sayfaBasligi: 'Müşteri Değer Analizi (ABC)',
            sonuclar,
            kpis,
            temsilciler,
            tedarikciler,
            filtreler: { temsilci, tedarikci, baslangicTarihi, bitisTarihi, zamanAraligi }
        });

    } catch (err) {
        console.error("Hata - Müşteri Değer Analizi: ", err);
        res.status(500).send('Hata oluştu');
    }
});

app.get('/kayip-musteri-analizi', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { temsilci, tedarikci } = req.query;

        const { temsilciler, tedarikciler } = await getFilterData(['temsilciler', 'tedarikciler']);

        let sonuclar = [];
        let kpis = { toplamKayipMusteri: 0, toplamKayipCiro: 0 };

        const request = pool.request();
        
        let subQueryFilter = 'AND FIS_TURU IN (21, 101)';
        if (temsilci) {
            subQueryFilter += ' AND SATISTEMSILCI = @temsilciParam';
            request.input('temsilciParam', sql.NVarChar, temsilci);
        }
        if (tedarikci) {
            subQueryFilter += ' AND TEDARIKCI = @tedarikciParam';
            request.input('tedarikciParam', sql.NVarChar, tedarikci);
        }

        const churnQuery = `
            WITH Musteriler2024 AS (
                SELECT DISTINCT FIRMAADI 
                FROM YC_SATIS_DETAY_TUMU 
                WHERE YIL = 2024 ${subQueryFilter}
            ),
            Musteriler2025 AS (
                SELECT DISTINCT FIRMAADI 
                FROM YC_SATIS_DETAY_TUMU 
                WHERE YIL = 2025 ${subQueryFilter}
            ),
            KayipMusteriler AS (
                SELECT FIRMAADI FROM Musteriler2024
                EXCEPT
                SELECT FIRMAADI FROM Musteriler2025
            )
            SELECT 
                km.FIRMAADI,
                ISNULL(SUM(${NET_TUTAR}), 0) AS KaybedilenCiro2024,
                MAX(s.TARIH) AS SonSiparisTarihi2024,
                MAX(s.SATISTEMSILCI) AS SorumluTemsilci
            FROM YC_SATIS_DETAY_TUMU s
            JOIN KayipMusteriler km ON s.FIRMAADI = km.FIRMAADI
            WHERE s.YIL = 2024
            GROUP BY km.FIRMAADI
            ORDER BY KaybedilenCiro2024 DESC;
        `;
        
        const result = await request.query(churnQuery);
        sonuclar = result.recordset;

        if (sonuclar.length > 0) {
            kpis.toplamKayipMusteri = sonuclar.length;
            kpis.toplamKayipCiro = sonuclar.reduce((sum, s) => sum + s.KaybedilenCiro2024, 0);
        }

        res.render('kayip-musteri-analizi', {
            sayfaBasligi: 'Kayıp Müşteri Analizi (Churn)',
            sonuclar,
            kpis,
            temsilciler,
            tedarikciler,
            filtreler: { temsilci, tedarikci }
        });

    } catch (err) {
        console.error("Hata - Kayıp Müşteri Analizi: ", err);
        res.status(500).send('Hata oluştu');
    }
});

app.get('/temsilci-etkinlik-karnesi', async (req, res) => {
    try {
        const pool = await poolPromise;

        const scorecardQuery = `
            ${KARLILIK_HESAPLAMA_CTE},
            TemsilciCiroKar2025 AS (
                SELECT
                    SATISTEMSILCI,
                    SUM(${NET_TUTAR_ANAVERI}) as ToplamCiro,
                    CASE 
                        WHEN SUM(${NET_TUTAR_ANAVERI}) = 0 THEN 0
                        ELSE (SUM((${NET_TUTAR_ANAVERI}) - ((${NET_MIKTAR_ANAVERI}) * DogruBirimMaliyet)) * 100.0) / SUM(${NET_TUTAR_ANAVERI})
                    END as KarMarji
                FROM AnaVeri
                WHERE YIL = 2025 AND SATISTEMSILCI IS NOT NULL
                GROUP BY SATISTEMSILCI
            ),
            TemsilciMusterileri2024 AS (
                SELECT SATISTEMSILCI, FIRMAADI FROM YC_SATIS_DETAY_TUMU WHERE YIL = 2024 AND SATISTEMSILCI IS NOT NULL AND FIS_TURU IN (21, 101) GROUP BY SATISTEMSILCI, FIRMAADI
            ),
            TemsilciMusterileri2025 AS (
                SELECT SATISTEMSILCI, FIRMAADI FROM YC_SATIS_DETAY_TUMU WHERE YIL = 2025 AND SATISTEMSILCI IS NOT NULL AND FIS_TURU IN (21, 101) GROUP BY SATISTEMSILCI, FIRMAADI
            ),
            MusteriTutma AS (
                SELECT
                    t24.SATISTEMSILCI,
                    (COUNT(t25.FIRMAADI) * 100.0) / COUNT(t24.FIRMAADI) as MusteriTutmaOrani
                FROM TemsilciMusterileri2024 t24
                LEFT JOIN TemsilciMusterileri2025 t25 ON t24.SATISTEMSILCI = t25.SATISTEMSILCI AND t24.FIRMAADI = t25.FIRMAADI
                GROUP BY t24.SATISTEMSILCI
            ),
            YeniMusteriler AS (
                SELECT SATISTEMSILCI, COUNT(*) as YeniMusteriSayisi FROM (
                    SELECT SATISTEMSILCI, FIRMAADI FROM TemsilciMusterileri2025
                    EXCEPT
                    SELECT SATISTEMSILCI, FIRMAADI FROM TemsilciMusterileri2024
                ) AS T
                GROUP BY SATISTEMSILCI
            ),
            MusteriCiro2025 AS (
                SELECT FIRMAADI, SUM(${NET_TUTAR}) as ToplamCiro
                FROM YC_SATIS_DETAY_TUMU s WHERE YIL = 2025 GROUP BY FIRMAADI
            ),
            GenelToplam2025 AS (
                SELECT SUM(ToplamCiro) as GenelToplamCiro FROM MusteriCiro2025 WHERE ToplamCiro > 0
            ),
            MusteriSiniflari AS (
                SELECT
                    FIRMAADI,
                    CASE WHEN (SUM(ToplamCiro) OVER (ORDER BY ToplamCiro DESC, FIRMAADI) * 100.0) / GenelToplamCiro <= 80 THEN 'A' ELSE 'B' END as Sinif
                FROM MusteriCiro2025, GenelToplam2025
                WHERE ToplamCiro > 0
            ),
            A_SinifiSayisi AS (
                SELECT s.SATISTEMSILCI, COUNT(DISTINCT s.FIRMAADI) AS A_SinifiMusteriSayisi
                FROM YC_SATIS_DETAY_TUMU s
                JOIN MusteriSiniflari ms ON s.FIRMAADI = ms.FIRMAADI
                WHERE s.YIL = 2025 AND ms.Sinif = 'A' AND s.SATISTEMSILCI IS NOT NULL
                GROUP BY s.SATISTEMSILCI
            )
            SELECT 
                t.SATISTEMSILCI,
                ISNULL(ck.ToplamCiro, 0) as ToplamCiro,
                ISNULL(ck.KarMarji, 0) as KarMarji,
                ISNULL(mt.MusteriTutmaOrani, 0) as MusteriTutmaOrani,
                ISNULL(ym.YeniMusteriSayisi, 0) as YeniMusteriSayisi,
                ISNULL(a.A_SinifiMusteriSayisi, 0) as A_SinifiMusteriSayisi
            FROM (SELECT DISTINCT SATISTEMSILCI FROM YC_SATIS_DETAY_TUMU WHERE SATISTEMSILCI IS NOT NULL) t
            LEFT JOIN TemsilciCiroKar2025 ck ON t.SATISTEMSILCI = ck.SATISTEMSILCI
            LEFT JOIN MusteriTutma mt ON t.SATISTEMSILCI = mt.SATISTEMSILCI
            LEFT JOIN YeniMusteriler ym ON t.SATISTEMSILCI = ym.SATISTEMSILCI
            LEFT JOIN A_SinifiSayisi a ON t.SATISTEMSILCI = a.SATISTEMSILCI
            ORDER BY ck.ToplamCiro DESC;
        `;

        const result = await pool.request().query(scorecardQuery);
        
        res.render('temsilci-etkinlik-karnesi', {
            sayfaBasligi: 'Temsilci Etkinlik Karnesi',
            sonuclar: result.recordset
        });

    } catch (err) {
        console.error("Hata - Temsilci Etkinlik Karnesi: ", err);
        res.status(500).send('Hata oluştu');
    }
});

app.get('/musteri-siparis-riski', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { temsilci } = req.query;

        const { temsilciler } = await getFilterData(['temsilciler']);

        let sonuclar = [];
        let kpis = { toplamMusteri: 0, guvenliSayisi: 0, riskliSayisi: 0, cokRiskliSayisi: 0 };

        const request = pool.request();
        
        let whereClauses = 'WHERE YIL IN (2024, 2025) AND FIS_TURU IN (21, 101)';
        if (temsilci) {
            whereClauses += ' AND SATISTEMSILCI = @temsilciParam';
            request.input('temsilciParam', sql.NVarChar, temsilci);
        }

        const riskQuery = `
            WITH SiparisGunleri AS (
                SELECT FIRMAADI, TARIH
                FROM YC_SATIS_DETAY_TUMU
                ${whereClauses}
                GROUP BY FIRMAADI, TARIH
            ),
            SiparisAraliklari AS (
                SELECT
                    FIRMAADI,
                    TARIH,
                    DATEDIFF(day, LAG(TARIH, 1) OVER (PARTITION BY FIRMAADI ORDER BY TARIH), TARIH) as SiparisAraligi
                FROM SiparisGunleri
            ),
            MusteriIstatistikleri AS (
                SELECT
                    FIRMAADI,
                    AVG(CAST(SiparisAraligi AS FLOAT)) AS OrtalamaSiparisAraligi,
                    MAX(TARIH) AS SonSiparisTarihi,
                    COUNT(TARIH) AS ToplamSiparisGunuSayisi
                FROM SiparisAraliklari
                GROUP BY FIRMAADI
            )
            SELECT
                FIRMAADI,
                ISNULL(OrtalamaSiparisAraligi, 0) AS OrtalamaSiparisAraligi,
                SonSiparisTarihi,
                DATEDIFF(day, SonSiparisTarihi, GETDATE()) AS SonSiparistenGecenSure,
                CASE
                    WHEN DATEDIFF(day, SonSiparisTarihi, GETDATE()) > (ISNULL(OrtalamaSiparisAraligi, 365) * 2) THEN 'Cok Riskli'
                    WHEN DATEDIFF(day, SonSiparisTarihi, GETDATE()) > (ISNULL(OrtalamaSiparisAraligi, 365) * 1.5) THEN 'Riskli'
                    ELSE 'Guvenli'
                END AS RiskDurumu
            FROM MusteriIstatistikleri
            WHERE ToplamSiparisGunuSayisi > 1
            ORDER BY RiskDurumu, SonSiparistenGecenSure DESC;
        `;
        
        const result = await request.query(riskQuery);
        sonuclar = result.recordset;

        if (sonuclar.length > 0) {
            kpis.toplamMusteri = sonuclar.length;
            sonuclar.forEach(s => {
                if (s.RiskDurumu === 'Guvenli') kpis.guvenliSayisi++;
                else if (s.RiskDurumu === 'Riskli') kpis.riskliSayisi++;
                else kpis.cokRiskliSayisi++;
            });
        }

        res.render('musteri-siparis-riski', {
            sayfaBasligi: 'Müşteri Sipariş Riski Analizi',
            sonuclar,
            kpis,
            temsilciler,
            filtreler: { temsilci }
        });

    } catch (err) {
        console.error("Hata - Müşteri Sipariş Riski: ", err);
        res.status(500).send('Hata oluştu');
    }
});

app.get('/fiyat-esnekligi', async (req, res) => {
    try {
        const { urun } = req.query;
        const { urunler } = await getFilterData(['urunler']);

        let sonuclar = [];
        if (urun) {
            const pool = await poolPromise;
            const request = pool.request();
            request.input('urunParam', sql.NVarChar, urun);
            const query = `
                SELECT
                    YIL,
                    AY,
                    AVG(${NET_TUTAR} / NULLIF(${NET_MIKTAR}, 0)) as OrtalamaBirimFiyat,
                    SUM(${NET_MIKTAR}) as ToplamMiktar
                FROM YC_SATIS_DETAY_TUMU s
                WHERE STOK_ADI = @urunParam AND ${NET_MIKTAR} > 0 AND ${NET_TUTAR} > 0
                GROUP BY YIL, AY
                ORDER BY YIL, AY;
            `;
            const result = await request.query(query);
            sonuclar = result.recordset;
        }

        res.render('fiyat-esnekligi', {
            sayfaBasligi: 'Fiyat Esnekliği Analizi',
            urunler,
            sonuclar,
            filtreler: { urun }
        });
    } catch (err) {
        console.error("Hata - Fiyat Esnekliği: ", err);
        res.status(500).send('Hata oluştu');
    }
});

app.get('/musteri-bagimliligi', async (req, res) => {
     try {
        const pool = await poolPromise;
        let { temsilci, baslangicTarihi, bitisTarihi, zamanAraligi } = req.query;

        const { temsilciler } = await getFilterData(['temsilciler']);

        if (!zamanAraligi) zamanAraligi = 'bu_yil';
        if (zamanAraligi && zamanAraligi !== 'manuel') {
            const range = getDateRange(zamanAraligi);
            if (range) {
                baslangicTarihi = range.startDate;
                bitisTarihi = range.endDate;
            }
        }

        const request = pool.request();
        let whereClauses = `WHERE ${BASE_WHERE_CLAUSE_SIMPLE.replace('s.YIL', 'YIL').replace('s.STOK_ADI', 'STOK_ADI').replace('s.TEDARIKCI', 'TEDARIKCI')}`;
        
        if (baslangicTarihi) { whereClauses += ` AND TARIH >= @baslangicParam`; request.input('baslangicParam', sql.Date, baslangicTarihi); }
        if (bitisTarihi) { whereClauses += ` AND TARIH <= @bitisParam`; request.input('bitisParam', sql.Date, bitisTarihi); }
        if (temsilci) { whereClauses += ` AND SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }

        const query = `
            WITH MusteriCiro AS (
                SELECT
                    FIRMAADI,
                    SUM(CASE WHEN FIS_TURU IN (23, 102) THEN -TUTAR ELSE TUTAR END) as ToplamCiro,
                    ROW_NUMBER() OVER (ORDER BY SUM(CASE WHEN FIS_TURU IN (23, 102) THEN -TUTAR ELSE TUTAR END) DESC) as Sira
                FROM YC_SATIS_DETAY_TUMU
                ${whereClauses}
                GROUP BY FIRMAADI
            )
            SELECT 
                FIRMAADI,
                ToplamCiro,
                Sira
            FROM MusteriCiro 
            WHERE Sira <= 10 AND ToplamCiro > 0
            ORDER BY Sira;
        `;
        const top10Result = await request.query(query);
        const genelToplamResult = await request.query(`SELECT SUM(CASE WHEN FIS_TURU IN (23, 102) THEN -TUTAR ELSE TUTAR END) as GenelToplamCiro FROM YC_SATIS_DETAY_TUMU ${whereClauses}`);
        
        const sonuclar = top10Result.recordset;
        const toplamCiro = genelToplamResult.recordset[0].GenelToplamCiro || 0;

        let kpis = { toplamCiro: toplamCiro, top1Payi: 0, top5Payi: 0, top10Payi: 0 };
        if (toplamCiro > 0 && sonuclar.length > 0) {
            let top1Ciro = 0, top5Ciro = 0, top10Ciro = 0;
            sonuclar.forEach(s => {
                if(parseInt(s.Sira) === 1) top1Ciro += s.ToplamCiro;
                if(parseInt(s.Sira) <= 5) top5Ciro += s.ToplamCiro;
                if(parseInt(s.Sira) <= 10) top10Ciro += s.ToplamCiro;
            });
            kpis.top1Payi = (top1Ciro / toplamCiro) * 100;
            kpis.top5Payi = (top5Ciro / toplamCiro) * 100;
            kpis.top10Payi = (top10Ciro / toplamCiro) * 100;
        }

        res.render('musteri-bagimliligi', {
            sayfaBasligi: 'Müşteri Bağımlılığı Riski',
            sonuclar,
            kpis,
            temsilciler,
            filtreler: { temsilci, baslangicTarihi, bitisTarihi, zamanAraligi }
        });

    } catch (err) {
        console.error("Hata - Müşteri Bağımlılığı: ", err);
        res.status(500).send('Hata oluştu');
    }
});

app.get('/urun-kanibalizasyon', async (req, res) => {
    try {
        const { eski_urun, yeni_urun } = req.query;
        const { urunler } = await getFilterData(['urunler']);

        let chartData = null;
        if (eski_urun && yeni_urun) {
            const pool = await poolPromise;
            const request = pool.request();
            request.input('eskiUrun', sql.NVarChar, eski_urun);
            request.input('yeniUrun', sql.NVarChar, yeni_urun);

            const lansmanResult = await pool.request().input('yeniUrun', sql.NVarChar, yeni_urun).query('SELECT MIN(TARIH) as LansmanTarihi FROM YC_SATIS_DETAY_TUMU WHERE STOK_ADI = @yeniUrun AND FIS_TURU IN (21, 101)');
            const lansmanTarihi = lansmanResult.recordset[0].LansmanTarihi;
            
            const salesQuery = `
                SELECT 
                    STOK_ADI, 
                    YIL, 
                    AY, 
                    SUM(${NET_MIKTAR.replace('s.','')}) as ToplamMiktar
                FROM YC_SATIS_DETAY_TUMU s
                WHERE STOK_ADI IN (@eskiUrun, @yeniUrun)
                GROUP BY STOK_ADI, YIL, AY
                ORDER BY YIL, AY;
            `;
            const salesResult = await request.query(salesQuery);

            if (salesResult.recordset.length > 0) {
                const labels = [];
                const eskiUrunData = [];
                const yeniUrunData = [];
                const salesMap = new Map();
                salesResult.recordset.forEach(r => {
                    const key = `${r.YIL}-${String(r.AY).padStart(2, '0')}`;
                    if(!salesMap.has(key)) salesMap.set(key, {});
                    salesMap.get(key)[r.STOK_ADI] = r.ToplamMiktar;
                });

                for (let y = 2024; y <= 2025; y++) {
                    for (let m = 1; m <= 12; m++) {
                        const key = `${y}-${String(m).padStart(2, '0')}`;
                        labels.push(`${key}-01`);
                        eskiUrunData.push(salesMap.get(key)?.[eski_urun] || 0);
                        yeniUrunData.push(salesMap.get(key)?.[yeni_urun] || 0);
                    }
                }
                chartData = { labels, eskiUrunData, yeniUrunData, lansmanTarihi };
            }
        }
        
        res.render('urun-kanibalizasyon', {
            sayfaBasligi: 'Ürün Kanibalizasyon Analizi',
            urunler,
            chartData,
            filtreler: { eski_urun, yeni_urun }
        });
    } catch (err) {
        console.error("Hata - Ürün Kanibalizasyon: ", err);
        res.status(500).send('Hata oluştu');
    }
});

// YENİ EKLENEN RAPOR: TEDARİKCİ KATEGORİ KIYASLAMA
app.get('/tedarikci-kategori-kiyaslama', async (req, res) => {
    try {
        const { tedarikci, metrik = 'tutar' } = req.query;
        const { tedarikciler } = await getFilterData(['tedarikciler']);
        
        let sonuclar = [];
        if (tedarikci) {
            const pool = await poolPromise;
            const request = pool.request();
            request.input('tedarikciParam', sql.NVarChar, tedarikci);
            
            let aggregationColumn2024;
            let aggregationColumn2025;
            let aggregationColumnName; // EJS'de kullanılacak

            if (metrik === 'adet') {
                aggregationColumn2024 = `ISNULL(SUM(CASE WHEN s.YIL = 2024 THEN ${NET_MIKTAR} ELSE 0 END), 0) as Metrik2024`;
                aggregationColumn2025 = `ISNULL(SUM(CASE WHEN s.YIL = 2025 THEN ${NET_MIKTAR} ELSE 0 END), 0) as Metrik2025`;
                aggregationColumnName = 'Miktar';
            } else if (metrik === 'litre') {
                aggregationColumn2024 = `ISNULL(SUM(CASE WHEN s.YIL = 2024 THEN ${NET_LITRE} ELSE 0 END), 0) as Metrik2024`;
                aggregationColumn2025 = `ISNULL(SUM(CASE WHEN s.YIL = 2025 THEN ${NET_LITRE} ELSE 0 END), 0) as Metrik2025`;
                aggregationColumnName = 'Litre';
            } else { // Tutar varsayılan
                aggregationColumn2024 = `ISNULL(SUM(CASE WHEN s.YIL = 2024 THEN ${NET_TUTAR} ELSE 0 END), 0) as Metrik2024`;
                aggregationColumn2025 = `ISNULL(SUM(CASE WHEN s.YIL = 2025 THEN ${NET_TUTAR} ELSE 0 END), 0) as Metrik2025`;
                aggregationColumnName = 'Tutar';
            }
            
            const query = `
                SELECT
                    s.KATEGORI,
                    s.URUN_GRUBU,
                    s.AY,
                    ${aggregationColumn2024},
                    ${aggregationColumn2025}
                FROM YC_SATIS_DETAY_TUMU s
                WHERE 
                    s.TEDARIKCI = @tedarikciParam
                    AND s.YIL IN (2024, 2025)
                    AND s.FIS_TURU IN (101, 102) -- Sadece Market Satışları
                    AND s.KATEGORI IS NOT NULL
                    AND s.URUN_GRUBU IS NOT NULL
                GROUP BY s.KATEGORI, s.URUN_GRUBU, s.AY
                ORDER BY s.KATEGORI, s.URUN_GRUBU, s.AY;
            `;
            
            const result = await request.query(query);
            
            const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
            const kategoriMap = new Map();

            for (const satir of result.recordset) {
                if (!kategoriMap.has(satir.KATEGORI)) {
                    kategoriMap.set(satir.KATEGORI, {
                        KATEGORI: satir.KATEGORI,
                        Toplam2024: 0,
                        Toplam2025: 0,
                        urunGrubuMap: new Map()
                    });
                }
                const kategori = kategoriMap.get(satir.KATEGORI);

                if (!kategori.urunGrubuMap.has(satir.URUN_GRUBU)) {
                    const aylikData = Array(12).fill(null).map((_, i) => ({
                        ay: ayIsimleri[i],
                        Metrik2024: 0,
                        Metrik2025: 0
                    }));
                    
                    kategori.urunGrubuMap.set(satir.URUN_GRUBU, {
                        URUN_GRUBU: satir.URUN_GRUBU,
                        Toplam2024: 0,
                        Toplam2025: 0,
                        aylikData: aylikData
                    });
                }
                const grup = kategori.urunGrubuMap.get(satir.URUN_GRUBU);

                const ayIndex = satir.AY - 1;
                grup.aylikData[ayIndex].Metrik2024 = satir.Metrik2024;
                grup.aylikData[ayIndex].Metrik2025 = satir.Metrik2025;

                grup.Toplam2024 += satir.Metrik2024;
                grup.Toplam2025 += satir.Metrik2025;
                kategori.Toplam2024 += satir.Metrik2024;
                kategori.Toplam2025 += satir.Metrik2025;
            }

            sonuclar = Array.from(kategoriMap.values()).map(kategori => {
                kategori.urunGruplari = Array.from(kategori.urunGrubuMap.values());
                delete kategori.urunGrubuMap;
                return kategori;
            });
        }

        res.render('tedarikci-kategori-kiyaslama', {
            sayfaBasligi: 'Tedarikçi Kategori Kıyaslama',
            tedarikciler,
            sonuclar,
            filtreler: { tedarikci, metrik }
        });

    } catch (err) {
        console.error("Hata - Tedarikçi Kategori Kıyaslama: ", err);
        res.status(500).send('Hata oluştu');
    }
});


// === GELİŞTİRİCİ ARAÇLARI ===
app.get('/ham-veri', async (req, res) => {
    try {
        const pool = await poolPromise;
        const query = `SELECT TOP 10 * FROM YC_SATIS_DETAY_TUMU`;
        const result = await pool.request().query(query);

        let sutunlar = [];
        if (result.recordset.length > 0) {
            sutunlar = Object.keys(result.recordset[0]);
        }

        res.render('ham-veri', {
            sayfaBasligi: 'Ham Veri',
            sutunlar: sutunlar,
            veriler: result.recordset
        });

    } catch (err) {
        console.error("Hata - Ham Veri Görüntüleyici: ", err);
        res.status(500).send('Hata oluştu');
    }
});


// === API ROTALARI ===
app.get('/api/kategoriler-by-tedarikci', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { tedarikci } = req.query;

        let query = `SELECT DISTINCT KATEGORI FROM YC_SATIS_DETAY_TUMU WHERE KATEGORI IS NOT NULL`;
        const request = pool.request();
        if (tedarikci) {
             query += ` AND TEDARIKCI = @tedarikciParam`;
             request.input('tedarikciParam', sql.NVarChar, tedarikci);
        }
        query += ` ORDER BY KATEGORI`;
        
        const result = (await request.query(query)).recordset;
        res.json(result);
    } catch (err) {
        console.error("Hata - API/kategoriler-by-tedarikci: ", err);
        res.status(500).json({ error: 'Kategoriler getirilemedi' });
    }
});

app.get('/api/urun-gruplari-by-tedarikci', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { tedarikci, fis_turu } = req.query;

        let query = `SELECT DISTINCT URUN_GRUBU FROM YC_SATIS_DETAY_TUMU WHERE URUN_GRUBU IS NOT NULL`;
        const request = pool.request();
        if (tedarikci) {
             query += ` AND TEDARIKCI = @tedarikciParam`;
             request.input('tedarikciParam', sql.NVarChar, tedarikci);
        }
        if (fis_turu === 'toptan') {
            query += ` AND FIS_TURU IN (21, 23)`;
        } else if (fis_turu === 'market') {
            query += ` AND FIS_TURU IN (101, 102)`;
        }
        query += ` ORDER BY URUN_GRUBU`;
        
        const result = (await request.query(query)).recordset;
        res.json(result);
    } catch (err) {
        console.error("Hata - API/urun-gruplari-by-tedarikci: ", err);
        res.status(500).json({ error: 'Ürün Grupları getirilemedi' });
    }
});

app.get('/api/urunler', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { temsilci, tedarikci, urun_grubu } = req.query;
        let query = `
            SELECT DISTINCT gu.STOK_ADI 
            FROM YC_SATIS_DETAY_TUMU s
            JOIN ${GUNCEL_URUNLER_SUBQUERY} gu ON s.STOK_KODU = gu.STOK_KODU
            WHERE ${BASE_WHERE_CLAUSE_PREFIXED}
        `;
        const request = pool.request();
        if (temsilci) { query += ` AND s.SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }
        if (tedarikci) { query += ` AND s.TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
        if (urun_grubu) { query += ` AND s.URUN_GRUBU = @urunGrubuParam`; request.input('urunGrubuParam', sql.NVarChar, urun_grubu); }
        
        query += ` ORDER BY gu.STOK_ADI`;
        const result = (await request.query(query)).recordset;
        res.json(result);
    } catch (err) {
        console.error("Hata - API/urunler: ", err);
        res.status(500).json({ error: 'Ürünler getirilemedi' });
    }
});

app.get('/api/musteriler', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { yil, ay, temsilci, fis_turu } = req.query;

        let query = `SELECT DISTINCT FIRMAADI FROM YC_SATIS_DETAY_TUMU WHERE ${BASE_WHERE_CLAUSE_SIMPLE}`;
        const request = pool.request();
        if (yil) { query += ` AND YIL = @yilParam`; request.input('yilParam', sql.Int, yil); }
        if (ay) { query += ` AND AY = @ayParam`; request.input('ayParam', sql.Int, ay); }
        if (temsilci) { query += ` AND SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }
        if (fis_turu === 'toptan') {
            query += ` AND FIS_TURU IN (21, 23)`;
        } else if (fis_turu === 'market') {
            query += ` AND FIS_TURU IN (101, 102)`;
        }
        query += ` ORDER BY FIRMAADI`;
        
        const result = (await request.query(query)).recordset;
        res.json(result);
    } catch (err) {
        console.error("Hata - API/musteriler: ", err);
        res.status(500).json({ error: 'Müşteriler getirilemedi' });
    }
});

app.get('/api/musteriler-by-temsilci', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { temsilci } = req.query;

        let query = `SELECT DISTINCT FIRMAADI FROM YC_SATIS_DETAY_TUMU WHERE ${BASE_WHERE_CLAUSE_SIMPLE}`;
        const request = pool.request();
        if (temsilci) {
             query += ` AND SATISTEMSILCI = @temsilciParam`;
             request.input('temsilciParam', sql.NVarChar, temsilci);
        }
        query += ` ORDER BY FIRMAADI`;
        
        const result = (await request.query(query)).recordset;
        res.json(result);
    } catch (err) {
        console.error("Hata - API/musteriler-by-temsilci: ", err);
        res.status(500).json({ error: 'Müşteriler getirilemedi' });
    }
});

app.get('/api/urun-gruplari', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { temsilci, tedarikci } = req.query;

        let query = `SELECT DISTINCT URUN_GRUBU FROM YC_SATIS_DETAY_TUMU WHERE URUN_GRUBU IS NOT NULL`;
        const request = pool.request();
        if (temsilci) { query += ` AND SATISTEMSILCI = @temsilciParam`; request.input('temsilciParam', sql.NVarChar, temsilci); }
        if (tedarikci) { query += ` AND TEDARIKCI = @tedarikciParam`; request.input('tedarikciParam', sql.NVarChar, tedarikci); }
        
        query += ` ORDER BY URUN_GRUBU`;
        const result = (await request.query(query)).recordset;
        res.json(result);
    } catch (err) {
        console.error("Hata - API/urun-gruplari: ", err);
        res.status(500).json({ error: 'Ürün grupları getirilemedi' });
    }
});


app.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor...`);
});