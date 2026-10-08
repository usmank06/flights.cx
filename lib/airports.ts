/**
 * Static airport data for the intake resolver ("Chicago" → ORD), nearby-airport variants, the route guard and the notes under intake
 * answers. `tier` breaks ties when a city has several airports.
 */

export type Airport = {
  code: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  /** Standard UTC offset in hours. */
  tz: number;
  /** 1 = global hub, 2 = major, 3 = regional/secondary. */
  tier: 1 | 2 | 3;
  region: Region;
  /** Carriers based here. First entry is the dominant one. */
  carriers: string[];
};

export type Region =
  | "us-east" | "us-west" | "us-south" | "us-mid" | "canada" | "mexico" | "carib"
  | "eu-west" | "eu-south" | "eu-north" | "eu-east"
  | "me" | "africa" | "asia-s" | "asia-se" | "asia-e" | "oceania" | "sa";

// code|city|country|lat|lon|tz|tier|region|carriers
const TABLE = `
JFK|New York|US|40.64|-73.78|-5|1|us-east|DL,AA,B6
EWR|Newark|US|40.69|-74.17|-5|2|us-east|UA,B6
LGA|New York|US|40.78|-73.87|-5|2|us-east|DL,AA
BOS|Boston|US|42.36|-71.01|-5|2|us-east|B6,DL,AA
PHL|Philadelphia|US|39.87|-75.24|-5|2|us-east|AA,F9
DCA|Washington|US|38.85|-77.04|-5|2|us-east|AA,DL
IAD|Washington|US|38.95|-77.46|-5|2|us-east|UA
BWI|Baltimore|US|39.18|-76.67|-5|3|us-east|WN
ATL|Atlanta|US|33.64|-84.43|-5|1|us-south|DL,WN
MIA|Miami|US|25.79|-80.29|-5|1|us-south|AA
FLL|Fort Lauderdale|US|26.07|-80.15|-5|3|us-south|B6,NK
MCO|Orlando|US|28.43|-81.31|-5|2|us-south|WN,B6
PBI|West Palm Beach|US|26.68|-80.10|-5|3|us-south|B6,WN
TPA|Tampa|US|27.98|-82.53|-5|3|us-south|WN
CLT|Charlotte|US|35.21|-80.94|-5|2|us-south|AA
DFW|Dallas|US|32.90|-97.04|-6|1|us-south|AA
DAL|Dallas|US|32.85|-96.85|-6|3|us-south|WN
IAH|Houston|US|29.98|-95.34|-6|1|us-south|UA
HOU|Houston|US|29.65|-95.28|-6|3|us-south|WN
AUS|Austin|US|30.19|-97.67|-6|3|us-south|WN,AA
SAT|San Antonio|US|29.53|-98.47|-6|3|us-south|WN
NAS|Nassau|BS|25.04|-77.47|-5|3|carib|BW
SJU|San Juan|PR|18.44|-66.00|-4|3|carib|B6
MBJ|Montego Bay|JM|18.50|-77.91|-5|3|carib|B6,AA
PUJ|Punta Cana|DO|18.57|-68.36|-4|3|carib|B6,DL
CUN|Cancun|MX|21.04|-86.87|-5|2|mexico|AM,Y4
MEX|Mexico City|MX|19.44|-99.07|-6|2|mexico|AM,Y4
SJD|Los Cabos|MX|23.15|-109.72|-7|3|mexico|AM,AA
ORD|Chicago|US|41.98|-87.90|-6|1|us-mid|UA,AA
MDW|Chicago|US|41.79|-87.75|-6|3|us-mid|WN
MSP|Minneapolis|US|44.88|-93.22|-6|2|us-mid|DL
DTW|Detroit|US|42.21|-83.35|-5|2|us-mid|DL
DEN|Denver|US|39.86|-104.67|-7|1|us-mid|UA,WN,F9
LAX|Los Angeles|US|33.94|-118.41|-8|1|us-west|AA,DL,UA
SFO|San Francisco|US|37.62|-122.38|-8|1|us-west|UA,AA
OAK|Oakland|US|37.72|-122.22|-8|3|us-west|WN,AS
SJC|San Jose|US|37.36|-121.93|-8|3|us-west|WN,AS
SAN|San Diego|US|32.73|-117.19|-8|3|us-west|WN,AA
BUR|Burbank|US|34.20|-118.36|-8|3|us-west|WN,AS
SNA|Santa Ana|US|33.68|-117.87|-8|3|us-west|WN,AA
ONT|Ontario|US|34.06|-117.60|-8|3|us-west|WN,F9
LAS|Las Vegas|US|36.08|-115.15|-8|2|us-west|WN,NK
PHX|Phoenix|US|33.43|-112.01|-7|2|us-west|AA,WN
SEA|Seattle|US|47.45|-122.31|-8|2|us-west|AS,DL
PDX|Portland|US|45.59|-122.60|-8|3|us-west|AS
SLC|Salt Lake City|US|40.79|-111.98|-7|3|us-west|DL
HNL|Honolulu|US|21.32|-157.92|-10|2|us-west|HA,UA
YYZ|Toronto|CA|43.68|-79.63|-5|1|canada|AC,WS
YTZ|Toronto|CA|43.63|-79.40|-5|3|canada|PD
YUL|Montreal|CA|45.47|-73.74|-5|2|canada|AC
YVR|Vancouver|CA|49.19|-123.18|-8|2|canada|AC,WS
YYC|Calgary|CA|51.13|-114.01|-7|3|canada|WS,AC
YOW|Ottawa|CA|45.32|-75.67|-5|3|canada|AC
BUF|Buffalo|US|42.94|-78.73|-5|3|us-east|WN,F9
LHR|London|GB|51.47|-0.45|0|1|eu-west|BA,VS
LGW|London|GB|51.15|-0.19|0|2|eu-west|BA,U2
STN|London|GB|51.89|0.24|0|3|eu-west|FR
LTN|London|GB|51.87|-0.37|0|3|eu-west|W6,U2
LCY|London|GB|51.51|0.05|0|3|eu-west|BA
MAN|Manchester|GB|53.35|-2.28|0|3|eu-west|BA,U2
DUB|Dublin|IE|53.42|-6.27|0|2|eu-west|EI,FR
CDG|Paris|FR|49.01|2.55|1|1|eu-west|AF
ORY|Paris|FR|48.73|2.38|1|3|eu-west|TO,AF
AMS|Amsterdam|NL|52.31|4.76|1|1|eu-west|KL
BVA|Paris|FR|49.45|2.11|1|3|eu-west|FR
NCE|Nice|FR|43.66|7.21|1|2|eu-south|AF,U2
BRU|Brussels|BE|50.90|4.48|1|3|eu-west|SN
FRA|Frankfurt|DE|50.03|8.56|1|1|eu-west|LH
MUC|Munich|DE|48.35|11.79|1|2|eu-west|LH
BER|Berlin|DE|52.36|13.50|1|3|eu-west|LH,U2
CGN|Cologne|DE|50.87|7.14|1|3|eu-west|EW,FR
ZRH|Zurich|CH|47.46|8.55|1|2|eu-west|LX
VIE|Vienna|AT|48.11|16.57|1|2|eu-east|OS,W6
LIS|Lisbon|PT|38.77|-9.13|0|2|eu-south|TP,FR
OPO|Porto|PT|41.24|-8.68|0|3|eu-south|TP,FR
MAD|Madrid|ES|40.47|-3.56|1|1|eu-south|IB
BCN|Barcelona|ES|41.30|2.08|1|2|eu-south|VY,IB
AGP|Malaga|ES|36.68|-4.49|1|3|eu-south|FR,VY
PMI|Palma|ES|39.55|2.74|1|3|eu-south|VY,FR
FCO|Rome|IT|41.80|12.25|1|2|eu-south|AZ
MXP|Milan|IT|45.63|8.72|1|2|eu-south|AZ,FR
NAP|Naples|IT|40.88|14.29|1|3|eu-south|FR,AZ
CIA|Rome|IT|41.80|12.59|1|3|eu-south|FR,W6
BGY|Milan|IT|45.67|9.70|1|3|eu-south|FR,W6
ATH|Athens|GR|37.94|23.95|2|2|eu-south|A3
IST|Istanbul|TR|41.26|28.74|3|1|eu-east|TK
CPH|Copenhagen|DK|55.62|12.66|1|2|eu-north|SK
ARN|Stockholm|SE|59.65|17.92|1|2|eu-north|SK
OSL|Oslo|NO|60.20|11.08|1|2|eu-north|DY,SK
HEL|Helsinki|FI|60.32|24.96|2|3|eu-north|AY
KEF|Reykjavik|IS|63.99|-22.61|0|3|eu-north|FI
WAW|Warsaw|PL|52.17|20.97|1|3|eu-east|LO,W6
PRG|Prague|CZ|50.10|14.26|1|3|eu-east|W6,FR
BUD|Budapest|HU|47.44|19.26|1|3|eu-east|W6
KRK|Krakow|PL|50.08|19.79|1|3|eu-east|W6,FR
DXB|Dubai|AE|25.25|55.36|4|1|me|EK
AUH|Abu Dhabi|AE|24.43|54.65|4|2|me|EY
DWC|Dubai|AE|24.90|55.16|4|3|me|FZ,EK
SHJ|Sharjah|AE|25.33|55.52|4|3|me|G9
DOH|Doha|QA|25.27|51.61|3|1|me|QR
DMM|Dammam|SA|26.47|49.80|3|3|me|SV,XY
RUH|Riyadh|SA|24.96|46.70|3|2|me|SV
JED|Jeddah|SA|21.68|39.16|3|2|me|SV,XY
KWI|Kuwait|KW|29.23|47.98|3|3|me|KU
CAI|Cairo|EG|30.11|31.41|2|2|africa|MS
NBO|Nairobi|KE|-1.32|36.93|3|2|africa|KQ
JNB|Johannesburg|ZA|-26.13|28.24|2|2|africa|SA
CMN|Casablanca|MA|33.37|-7.59|1|3|africa|AT
DEL|Delhi|IN|28.56|77.10|5.5|1|asia-s|AI,6E
BOM|Mumbai|IN|19.09|72.87|5.5|1|asia-s|AI,6E
BLR|Bengaluru|IN|13.20|77.71|5.5|2|asia-s|6E,AI
MAA|Chennai|IN|12.99|80.17|5.5|3|asia-s|6E,AI
CMB|Colombo|LK|7.18|79.88|5.5|3|asia-s|UL
KTM|Kathmandu|NP|27.70|85.36|5.75|3|asia-s|RA
BKK|Bangkok|TH|13.69|100.75|7|1|asia-se|TG,FD
SIN|Singapore|SG|1.36|103.99|8|1|asia-se|SQ,TR
KUL|Kuala Lumpur|MY|2.75|101.71|8|2|asia-se|MH,AK
CGK|Jakarta|ID|-6.13|106.66|7|2|asia-se|GA
MNL|Manila|PH|14.51|121.02|8|2|asia-se|PR,5J
HAN|Hanoi|VN|21.22|105.81|7|3|asia-se|VN,VJ
SGN|Ho Chi Minh City|VN|10.82|106.66|7|3|asia-se|VN,VJ
DPS|Bali|ID|-8.75|115.17|8|3|asia-se|GA,QZ
HKG|Hong Kong|HK|22.31|113.91|8|1|asia-e|CX
NRT|Tokyo|JP|35.77|140.39|9|1|asia-e|NH,JL,ZG
HND|Tokyo|JP|35.55|139.78|9|1|asia-e|NH,JL
KIX|Osaka|JP|34.43|135.23|9|2|asia-e|NH,JL
CTS|Sapporo|JP|42.78|141.69|9|3|asia-e|NH,JL,MM
ITM|Osaka|JP|34.79|135.44|9|3|asia-e|NH,JL
ICN|Seoul|KR|37.46|126.44|9|1|asia-e|KE,OZ
PVG|Shanghai|CN|31.14|121.81|8|1|asia-e|MU,CA
GMP|Seoul|KR|37.56|126.79|9|3|asia-e|KE,OZ
PEK|Beijing|CN|40.08|116.58|8|1|asia-e|CA
CAN|Guangzhou|CN|23.39|113.30|8|1|asia-e|CZ
SHA|Shanghai|CN|31.20|121.34|8|3|asia-e|MU,CA
TPE|Taipei|TW|25.08|121.23|8|2|asia-e|BR,CI
SYD|Sydney|AU|-33.94|151.18|10|1|oceania|QF,JQ
MEL|Melbourne|AU|-37.67|144.84|10|2|oceania|QF,JQ
PER|Perth|AU|-31.94|115.97|8|3|oceania|QF,JQ
BNE|Brisbane|AU|-27.38|153.12|10|3|oceania|QF,JQ
AKL|Auckland|NZ|-37.01|174.79|12|2|oceania|NZ
GRU|Sao Paulo|BR|-23.43|-46.47|-3|1|sa|JJ,G3
GIG|Rio de Janeiro|BR|-22.81|-43.25|-3|2|sa|JJ,G3
EZE|Buenos Aires|AR|-34.82|-58.54|-3|2|sa|AR
SDU|Rio de Janeiro|BR|-22.91|-43.16|-3|3|sa|G3,JJ
SCL|Santiago|CL|-33.39|-70.79|-4|2|sa|LA
BOG|Bogota|CO|4.70|-74.15|-5|2|sa|AV
LIM|Lima|PE|-12.02|-77.11|-5|2|sa|LA
`.trim();

export const AIRPORTS: Record<string, Airport> = Object.fromEntries(
  TABLE.split("\n").map((line) => {
    const [code, city, country, lat, lon, tz, tier, region, carriers] = line.split("|");
    return [
      code,
      {
        code,
        city,
        country,
        lat: Number(lat),
        lon: Number(lon),
        tz: Number(tz),
        tier: Number(tier) as 1 | 2 | 3,
        region: region as Region,
        carriers: carriers.split(","),
      },
    ];
  })
);

export const AIRPORT_LIST = Object.values(AIRPORTS);

export const AIRLINE_NAMES: Record<string, string> = {
  AA: "American", DL: "Delta", UA: "United", B6: "JetBlue", WN: "Southwest", AS: "Alaska",
  NK: "Spirit", F9: "Frontier", HA: "Hawaiian", AC: "Air Canada", WS: "WestJet", PD: "Porter",
  BA: "British Airways", VS: "Virgin Atlantic", U2: "easyJet", FR: "Ryanair", W6: "Wizz Air",
  EI: "Aer Lingus", AF: "Air France", KL: "KLM", TO: "Transavia", SN: "Brussels Airlines",
  LH: "Lufthansa", EW: "Eurowings", LX: "SWISS", OS: "Austrian", TP: "TAP Portugal", IB: "Iberia", VY: "Vueling",
  AZ: "ITA Airways", A3: "Aegean", TK: "Turkish Airlines", SK: "SAS", DY: "Norwegian",
  AY: "Finnair", FI: "Icelandair", LO: "LOT", EK: "Emirates", EY: "Etihad", QR: "Qatar Airways",
  SV: "Saudia", XY: "flynas", KU: "Kuwait Airways", MS: "EgyptAir", KQ: "Kenya Airways",
  SA: "South African", AT: "Royal Air Maroc", AI: "Air India", "6E": "IndiGo", UL: "SriLankan",
  RA: "Nepal Airlines", TG: "Thai Airways", FD: "Thai AirAsia", SQ: "Singapore Airlines",
  TR: "Scoot", MH: "Malaysia Airlines", AK: "AirAsia", GA: "Garuda", QZ: "Indonesia AirAsia",
  PR: "Philippine Airlines", "5J": "Cebu Pacific", VN: "Vietnam Airlines", VJ: "VietJet",
  CX: "Cathay Pacific", NH: "ANA", JL: "Japan Airlines", ZG: "Zipair", MM: "Peach",
  KE: "Korean Air", OZ: "Asiana", MU: "China Eastern", CA: "Air China", BR: "EVA Air",
  CI: "China Airlines", QF: "Qantas", JQ: "Jetstar", NZ: "Air New Zealand", JJ: "LATAM Brasil",
  G3: "GOL", AR: "Aerolineas Argentinas", LA: "LATAM", AV: "Avianca", AM: "Aeromexico",
  Y4: "Volaris", BW: "Caribbean Airlines", FZ: "flydubai", G9: "Air Arabia",
};

export const airlineName = (code: string) => AIRLINE_NAMES[code] ?? code;

/** Other airports serving the same place, busiest first: the same city's airports plus any within `km`. */
export function nearbyAirports(code: string, km = 120): Airport[] {
  const a = AIRPORTS[code];
  if (!a) return [];
  return AIRPORT_LIST.filter((b) => b.code !== code && (b.city === a.city || distanceKm(a, b) <= km)).sort(
    (x, y) => x.tier - y.tier
  );
}

/** Great-circle distance in km. */
export function distanceKm(a: Airport, b: Airport): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
