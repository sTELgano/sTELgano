import { parsePhoneNumberFromString } from "libphonenumber-js";

console.log("--- Testing libphonenumber-js behavior ---");

// Case 1: digits-only, matches country dialing code + national number
const p1 = parsePhoneNumberFromString("254712345678", "KE");
console.log('p1 (digits only "254...", country "KE"):', p1?.isValid(), p1?.number);

// Case 2: national format with leading zero
const p2 = parsePhoneNumberFromString("0712345678", "KE");
console.log('p2 (national with "0...", country "KE"):', p2?.isValid(), p2?.number);

// Case 3: E.164 (correct format)
const p3 = parsePhoneNumberFromString("+254712345678", "KE");
console.log('p3 (E.164 "+254...", country "KE"):', p3?.isValid(), p3?.number);

// Case 4: E.164 without country context (globally unique)
const p4 = parsePhoneNumberFromString("+254712345678");
console.log('p4 (E.164 "+254...", no country context):', p4?.isValid(), p4?.number);

// Case 5: Digits only without country context (usually ambiguous/invalid)
const p5 = parsePhoneNumberFromString("254712345678");
console.log('p5 (digits only "254...", no country context):', p5?.isValid(), p5?.number);

// Case 6: Prepending + to digits-only (the logic used in my fix)
const p6 = parsePhoneNumberFromString("+" + "254712345678");
console.log('p6 ("+" prepended to "254..."):', p6?.isValid(), p6?.number);

// Case 7: Prepending dial code to national number with leading zero
const p7 = parsePhoneNumberFromString("+254" + "0712345678");
console.log('p7 ("+254" prepended to "0712345678"):', p7?.isValid(), p7?.number);
