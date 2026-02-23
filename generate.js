const crypto = require('crypto');

const mercId = "792811";
const password = "fb1489ed";
const prodId = "SYSCON";

const hashRequestKey = "2a63f76ede75f9a022";
const aesSalt = "1CFAC0C7097BD6FAA950892F87B45960";

const txnid = "TEST123456";
const amount = "10.00";
const email = "test@example.com";
const mobile = "9999999999";

// login|password|txnid|amount|prodid|udf1|udf2|udf3|udf4|udf5|email|mobile
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

const key = crypto.createHash('sha256').update(hashRequestKey).digest();
const iv = Buffer.from(aesSalt.substring(0, 32), 'hex');

const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
const encData = cipher.update(plainText, 'utf8', 'base64') + cipher.final('base64');

console.log("encData:");
console.log(encData);