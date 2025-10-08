// db.js
const sql = require('mssql');

// .env içeriğini okumak için (istersen)
require('dotenv').config();

const config = {
  user: process.env.DB_USER || 'yasemin',
  password: process.env.DB_PASSWORD || 'YC%2024!',
  server: process.env.DB_SERVER || '192.168.1.155',
  database: process.env.DB_DATABASE || 'REPORTDB',
  options: {
    encrypt: false, // yerel ağ bağlantısı için false
    trustServerCertificate: true // self-signed sertifika için
  }
};

// Tek bir connection pool oluşturuyoruz
const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then(pool => {
    console.log('✅ MSSQL bağlantısı başarılı:', config.server);
    return pool;
  })
  .catch(err => {
    console.error('❌ MSSQL bağlantı hatası:', err);
  });

module.exports = { sql, poolPromise };
