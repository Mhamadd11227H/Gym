/* Forge Gym: shared helpers for member codes and encrypted portal records.
   A member code is turned into (id, key) with PBKDF2. The id is public (it names the record in portal.json),
   the key decrypts the record. Without the code, portal.json shows nothing readable. */
(function (g) {
  var ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; /* 32 symbols, no 0/O/1/I */
  var SALT = 'forge-gym-v1';
  var ITER_OLD = 100000;    /* records published before v2 */
  var ITER_NEW = 300000;    /* current: 3x harder to guess offline; portal.json says which one it used (field i) */

  function toB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    var s = atob(b64), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function hex(bytes) {
    var h = '';
    for (var i = 0; i < bytes.length; i++) h += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return h;
  }

  function genCode() {
    var b = new Uint8Array(10), s = '';
    g.crypto.getRandomValues(b);
    for (var i = 0; i < 10; i++) s += ALPHA[b[i] & 31];
    return s.slice(0, 5) + '-' + s.slice(5);
  }
  function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  async function derive(code, iter) {
    var enc = new TextEncoder();
    var km = await g.crypto.subtle.importKey('raw', enc.encode(normCode(code)), 'PBKDF2', false, ['deriveBits']);
    var bits = new Uint8Array(await g.crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(SALT), iterations: iter || ITER_OLD, hash: 'SHA-256' }, km, 512));
    var key = await g.crypto.subtle.importKey('raw', bits.slice(32, 64), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { id: hex(bits.slice(0, 16)), key: key };
  }

  async function encrypt(obj, key) {
    var iv = g.crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await g.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
    return { iv: toB64(iv), d: toB64(ct) };
  }
  async function decrypt(rec, key) {
    var pt = await g.crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(rec.iv) }, key, fromB64(rec.d));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  /* password-based encryption, used for the encrypted backup file (forge-backup.json) */
  async function passKey(pass, salt) {
    var enc = new TextEncoder();
    var km = await g.crypto.subtle.importKey('raw', enc.encode(String(pass)), 'PBKDF2', false, ['deriveKey']);
    return g.crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: 310000, hash: 'SHA-256' }, km,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptPass(obj, pass) {
    var salt = g.crypto.getRandomValues(new Uint8Array(16)), iv = g.crypto.getRandomValues(new Uint8Array(12));
    var key = await passKey(pass, salt);
    var ct = new Uint8Array(await g.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
    return { s: toB64(salt), iv: toB64(iv), d: toB64(ct) };
  }
  async function decryptPass(rec, pass) {
    var key = await passKey(pass, fromB64(rec.s));
    var pt = await g.crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(rec.iv) }, key, fromB64(rec.d));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  g.FG = { ITER: ITER_NEW, encryptPass: encryptPass, decryptPass: decryptPass, genCode: genCode, normCode: normCode, derive: derive, encrypt: encrypt, decrypt: decrypt };
})(typeof window !== 'undefined' ? window : globalThis);
