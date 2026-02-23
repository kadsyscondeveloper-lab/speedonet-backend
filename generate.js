const crypto = require('crypto');

const mercId = "792811";
const password = "fb1489ed";
const prodId = "SYSCON";

const hashRequestKey = "2a63f76ede75f9a022";   // DO NOT SHA256 THIS
const aesSalt = "1CFAC0C7097BD6FAA950892F87B45960";

const txnid = "TEST123456";
const amount = "10.00";
const email = "test@example.com";
const mobile = "9999999999";

const plainText = [
  mercId,
  password,
  txnid,
  amount,
  prodId,
  "", "", "", "", "",
  email,
  mobile
].join("|");

console.log("Plain Text:\n", plainText);

// 🔥 FIX HERE
const key = Buffer.from(hashRequestKey.padEnd(32, '0'));
const iv  = Buffer.from(aesSalt.substring(0, 16));

const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
let encData = cipher.update(plainText, "utf8", "base64");
encData += cipher.final("base64");

console.log("\nencData:\n", encData);