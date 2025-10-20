// handlers.js
const poolPromise = require('./db');
const { processNlu } = require('./nlu'); // NLU işlemcimizi import ediyoruz
const sql = require('mssql');

// --- YENİ: DİNAMİK SORGU OLUŞTURUCU (KÖPRÜ) ---
function buildDynamicQuery(nlpResult) {
    let baseQuery = "SELECT TOP 1000 * FROM Satislar"; // Güvenlik için bir limit koymak iyidir
    let whereClauses = [];
    let params = {}; // SQL Injection'ı önlemek için parametreleri kullanacağız
    let paramCounter = 1;

    const { entities } = nlpResult;

    if (!entities || entities.length === 0) {
        return { query: baseQuery, params: {} };
    }

    for (const entity of entities) {
        if (entity.entity === 'bolge') {
            const paramName = `p${paramCounter++}`;
            whereClauses.push(`BOLGE = @${paramName}`);
            params[paramName] = { type: sql.VarChar, value: entity.option };
        }
        
        if (entity.entity === 'satis_kanali') {
            const islemTipiEntity = entities.find(e => e.entity === 'islem_tipi');
            const islemTipi = islemTipiEntity ? islemTipiEntity.option : 'satis';

            let fisTurleri = [];
            if (entity.option === 'market') {
                fisTurleri = (islemTipi === 'satis') ? [101] : [102];
            } else if (entity.option === 'toptan') {
                fisTurleri = (islemTipi === 'satis') ? [21] : [23];
            }
            
            if(fisTurleri.length > 0){
                const paramNames = fisTurleri.map(() => `@p${paramCounter++}`);
                whereClauses.push(`FIS_TURU IN (${paramNames.join(', ')})`);
                fisTurleri.forEach((val, index) => {
                    params[paramNames[index].substring(1)] = { type: sql.Int, value: val };
                });
            }
        }
        
        if(entity.entity === 'zaman_araligi') {
            const { startDate, endDate } = getDateRangeFromEntity(entity.option);
            if(startDate && endDate) {
                const startParam = `p${paramCounter++}`;
                const endParam = `p${paramCounter++}`;
                whereClauses.push(`TARIH BETWEEN @${startParam} AND @${endParam}`);
                params[startParam] = { type: sql.Date, value: startDate };
                params[endParam] = { type: sql.Date, value: endDate };
            }
        }
    }

    if (whereClauses.length > 0) {
        baseQuery += " WHERE " + whereClauses.join(" AND ");
    }
    
    baseQuery += " ORDER BY TARIH DESC";

    return { query: baseQuery, params };
}

// --- YENİ: ZAMAN ARALIĞI YARDIMCI FONKSİYONU ---
function getDateRangeFromEntity(zamanEntity) {
    const now = new Date();
    let startDate, endDate;

    if (zamanEntity === 'bu_ay') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    } else if (zamanEntity === 'geçen_ay') {
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        endDate = new Date(now.getFullYear(), now.getMonth(), 0);
    } else if (zamanEntity === 'bu_yıl') {
        startDate = new Date(now.getFullYear(), 0, 1);
        endDate = new Date(now.getFullYear(), 11, 31);
    }
    
    return { startDate, endDate };
}


// --- YENİ: MERKEZİ SORGULAMA HANDLER'I ---
async function handleNluQuery(req, res) {
    const { nluQuery } = req.body;
    if (!nluQuery) { return res.redirect('/'); }

    try {
        const nlpResult = await processNlu(nluQuery);
        const { query, params } = buildDynamicQuery(nlpResult);
        
        const pool = await poolPromise;
        const request = pool.request();

        for (const key in params) {
            request.input(key, params[key].type, params[key].value);
        }

        const result = await request.query(query);

        res.render('sonuclar', {
            title: 'Sorgu Sonuçları',
            sorguMetni: nluQuery,
            sonuclar: result.recordset,
            kayitSayisi: result.recordset.length,
            kolonlar: result.recordset.length > 0 ? Object.keys(result.recordset[0]) : []
        });

    } catch (error) {
        console.error('Sorgu işlenirken hata oluştu:', error);
        res.status(500).send("Sorgu işlenirken bir hata oluştu.");
    }
}

// --- SİZİN MEVCUT HANDLER'LARINIZ (İÇERİĞİ DOLDURULDU) ---
async function getHamVeri(req, res) {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query('SELECT TOP (1000) * FROM Satislar ORDER BY TARIH DESC');
        res.render('ham-veri', { title: 'Ham Veri', data: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).send('Veri çekilirken bir hata oluştu.');
    }
}

async function getSatislar(req, res) {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query('SELECT * FROM Satislar');
        res.render('satislar', { title: 'Satışlar', satislar: result.recordset });
    } catch (err) {
        console.error('Satış verileri çekilirken hata:', err);
        res.status(500).send('Sunucu Hatası');
    }
}


// Tüm fonksiyonları export ediyoruz
module.exports = {
    getHamVeri,
    getSatislar,
    handleNluQuery // Yeni fonksiyonumuz
};