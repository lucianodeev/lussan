'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {rootCertificates} = require('node:tls');

module.exports = function databaseConfig(connectionString) {
 const url = new URL(connectionString);
 // pg's URL SSL options otherwise replace the explicit verified TLS config.
 for (const key of ['sslmode','sslcert','sslkey','sslrootcert','ssl']) url.searchParams.delete(key);
 const isSupabase = /(^|\.)(supabase\.co|supabase\.com)$/.test(url.hostname);
 const ssl = {rejectUnauthorized:true,minVersion:'TLSv1.2'};
 if (isSupabase) ssl.ca = [...rootCertificates,fs.readFileSync(path.join(__dirname,'certs/supabase-root-2021.crt'),'utf8')];
 return {connectionString:url.toString(),ssl,connectionTimeoutMillis:10000};
};
