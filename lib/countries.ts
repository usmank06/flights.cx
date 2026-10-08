/**
 * Country names and ISO 3166-1 alpha-2 codes, for a flag next to a place. The provider names countries in words ("United States",
 * "Türkiye"), so names that differ from the ISO short name are listed as aliases. An unknown name gets no flag.
 */
const TABLE = `
AD|Andorra
AE|United Arab Emirates|UAE
AF|Afghanistan
AG|Antigua and Barbuda|Antigua & Barbuda
AI|Anguilla
AL|Albania
AM|Armenia
AO|Angola
AR|Argentina
AT|Austria
AU|Australia
AW|Aruba
AZ|Azerbaijan
BA|Bosnia and Herzegovina|Bosnia & Herzegovina
BB|Barbados
BD|Bangladesh
BE|Belgium
BF|Burkina Faso
BG|Bulgaria
BH|Bahrain
BJ|Benin
BM|Bermuda
BN|Brunei
BO|Bolivia
BR|Brazil
BS|Bahamas|The Bahamas
BT|Bhutan
BW|Botswana
BY|Belarus
BZ|Belize
CA|Canada
CD|DR Congo|Democratic Republic of the Congo|Congo - Kinshasa
CG|Congo|Republic of the Congo|Congo - Brazzaville
CH|Switzerland
CI|Côte d'Ivoire|Ivory Coast|Cote d'Ivoire
CL|Chile
CM|Cameroon
CN|China
CO|Colombia
CR|Costa Rica
CU|Cuba
CV|Cape Verde|Cabo Verde
CW|Curaçao|Curacao
CY|Cyprus
CZ|Czechia|Czech Republic
DE|Germany
DK|Denmark
DM|Dominica
DO|Dominican Republic
DZ|Algeria
EC|Ecuador
EE|Estonia
EG|Egypt
ES|Spain
ET|Ethiopia
FI|Finland
FJ|Fiji
FO|Faroe Islands
FR|France
GA|Gabon
GB|United Kingdom|UK|Great Britain|England|Scotland|Wales|Northern Ireland
GD|Grenada
GE|Georgia
GF|French Guiana
GH|Ghana
GI|Gibraltar
GL|Greenland
GM|Gambia|The Gambia
GP|Guadeloupe
GR|Greece
GT|Guatemala
GU|Guam
GY|Guyana
HK|Hong Kong|Hong Kong SAR China
HN|Honduras
HR|Croatia
HT|Haiti
HU|Hungary
ID|Indonesia
IE|Ireland
IL|Israel
IN|India
IQ|Iraq
IR|Iran
IS|Iceland
IT|Italy
JM|Jamaica
JO|Jordan
JP|Japan
KE|Kenya
KG|Kyrgyzstan
KH|Cambodia
KR|South Korea|Korea|Republic of Korea
KW|Kuwait
KY|Cayman Islands
KZ|Kazakhstan
LA|Laos
LB|Lebanon
LC|St. Lucia|Saint Lucia
LK|Sri Lanka
LT|Lithuania
LU|Luxembourg
LV|Latvia
LY|Libya
MA|Morocco
MC|Monaco
MD|Moldova
ME|Montenegro
MG|Madagascar
MK|North Macedonia|Macedonia
ML|Mali
MM|Myanmar|Myanmar (Burma)|Burma
MN|Mongolia
MO|Macao|Macau|Macao SAR China
MQ|Martinique
MT|Malta
MU|Mauritius
MV|Maldives
MW|Malawi
MX|Mexico
MY|Malaysia
MZ|Mozambique
NA|Namibia
NC|New Caledonia
NG|Nigeria
NI|Nicaragua
NL|Netherlands|The Netherlands
NO|Norway
NP|Nepal
NZ|New Zealand
OM|Oman
PA|Panama
PE|Peru
PF|French Polynesia|Tahiti
PG|Papua New Guinea
PH|Philippines
PK|Pakistan
PL|Poland
PR|Puerto Rico
PT|Portugal
PY|Paraguay
QA|Qatar
RE|Réunion|Reunion
RO|Romania
RS|Serbia
RU|Russia
RW|Rwanda
SA|Saudi Arabia
SC|Seychelles
SE|Sweden
SG|Singapore
SI|Slovenia
SK|Slovakia
SN|Senegal
SR|Suriname
SV|El Salvador
SX|Sint Maarten|St. Maarten
TC|Turks and Caicos Islands|Turks & Caicos Islands
TH|Thailand
TN|Tunisia
TR|Türkiye|Turkey
TT|Trinidad and Tobago|Trinidad & Tobago
TW|Taiwan
TZ|Tanzania
UA|Ukraine
UG|Uganda
US|United States|USA|United States of America
UY|Uruguay
UZ|Uzbekistan
VC|St. Vincent and the Grenadines|St. Vincent & Grenadines
VE|Venezuela
VG|British Virgin Islands
VI|U.S. Virgin Islands|US Virgin Islands
VN|Vietnam
VU|Vanuatu
WS|Samoa
XK|Kosovo
ZA|South Africa
ZM|Zambia
ZW|Zimbabwe
`;

const BY_NAME = new Map<string, string>();
const NAME_BY_CODE = new Map<string, string>();
for (const line of TABLE.trim().split("\n")) {
  const [code, ...names] = line.split("|");
  NAME_BY_CODE.set(code, names[0]);
  for (const n of names) BY_NAME.set(n.toLowerCase(), code);
}

/** The ISO 3166-1 alpha-2 code for a country name or alias, or null. */
export function countryCode(name: string | null | undefined): string | null {
  if (!name) return null;
  return BY_NAME.get(name.trim().toLowerCase()) ?? null;
}

export const countryName = (code: string | null | undefined): string | null => (code ? (NAME_BY_CODE.get(code.toUpperCase()) ?? null) : null);

/** The flag emoji for an alpha-2 code: two regional-indicator symbols. Kosovo has none that renders everywhere, so it gets none. */
export function flagEmoji(code: string | null | undefined): string | null {
  if (!code || !/^[A-Za-z]{2}$/.test(code) || code.toUpperCase() === "XK") return null;
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
