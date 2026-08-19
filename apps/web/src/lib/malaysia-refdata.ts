// Malaysia-focused reference lists for party forms.
//
// Stored values are canonical identifiers (e.g. "NRIC", "MY", "maybank") so
// downstream filters and reports stay stable. Labels are user-facing strings.
// When you need to render a dropdown whose persisted value might be outside
// these lists (legacy data), pass the current value through `withExistingOption`.

export type RefOption = { value: string; label: string };

// ── ID types ───────────────────────────────────────────────────────────────
// Source: National Registration Department (JPN) document types + common
// foreign/entity identifiers encountered in Malaysian property operations.

// For individual parties (agents, tenants, owner-individuals).
export const INDIVIDUAL_ID_TYPES: RefOption[] = [
  { value: "NRIC",            label: "NRIC / MyKad (Malaysian citizen)" },
  { value: "MyPR",            label: "MyPR (Permanent Resident)" },
  { value: "MyKAS",           label: "MyKAS (Temporary Resident)" },
  { value: "MyTentera",       label: "MyTentera (Armed Forces)" },
  { value: "MyPolis",         label: "MyPolis (Royal Malaysia Police)" },
  { value: "MyDiplomatik",    label: "MyDiplomatik (Diplomatic Pass)" },
  { value: "Passport",        label: "Passport (foreigner)" },
  { value: "BirthCert",       label: "Birth Certificate (under 12)" },
];

// Entity identifiers used for corporate owners/landlords.
// SSM = Suruhanjaya Syarikat Malaysia (Companies Commission). ROS =
// Registrar of Societies. LLP and Enterprise are both SSM-issued but numbered
// differently, so we expose them separately for clarity.
export const ENTITY_ID_TYPES: RefOption[] = [
  { value: "SSM_SdnBhd",      label: "SSM — Sdn. Bhd. / Bhd." },
  { value: "SSM_Enterprise",  label: "SSM — Sole Proprietor / Enterprise" },
  { value: "SSM_LLP",         label: "SSM — LLP (PLT)" },
  { value: "ROS",             label: "ROS — Society / Association" },
  { value: "Cooperative",     label: "Cooperative (SKM)" },
  { value: "ForeignCoReg",    label: "Foreign company registration" },
];

// Combined list for pages where the party may be either an individual or an
// entity (owners). Entity options appear first since corporate owners are the
// common case in Malaysian property management.
export const OWNER_ID_TYPES: RefOption[] = [
  ...ENTITY_ID_TYPES,
  ...INDIVIDUAL_ID_TYPES,
];

// ── Nationality ────────────────────────────────────────────────────────────
// Full ISO 3166-1 alpha-2 list (sovereign states + commonly needed territories
// such as Hong Kong, Taiwan, Macau, Palestine). Demonyms follow Unicode CLDR
// / Wikipedia "List of demonyms by country" usage.
//
// Source: https://www.iso.org/iso-3166-country-codes.html
// Malaysia is pinned first; remainder alphabetical by demonym. "Other" at end
// covers stateless or unusual cases.

const NATIONALITY_REST: RefOption[] = [
  { value: "AF", label: "Afghan" },
  { value: "AL", label: "Albanian" },
  { value: "DZ", label: "Algerian" },
  { value: "AD", label: "Andorran" },
  { value: "AO", label: "Angolan" },
  { value: "AG", label: "Antiguan" },
  { value: "AR", label: "Argentine" },
  { value: "AM", label: "Armenian" },
  { value: "AU", label: "Australian" },
  { value: "AT", label: "Austrian" },
  { value: "AZ", label: "Azerbaijani" },
  { value: "BS", label: "Bahamian" },
  { value: "BH", label: "Bahraini" },
  { value: "BD", label: "Bangladeshi" },
  { value: "BB", label: "Barbadian" },
  { value: "BY", label: "Belarusian" },
  { value: "BE", label: "Belgian" },
  { value: "BZ", label: "Belizean" },
  { value: "BJ", label: "Beninese" },
  { value: "BT", label: "Bhutanese" },
  { value: "BO", label: "Bolivian" },
  { value: "BA", label: "Bosnian" },
  { value: "BW", label: "Botswanan" },
  { value: "BR", label: "Brazilian" },
  { value: "GB", label: "British" },
  { value: "BN", label: "Bruneian" },
  { value: "BG", label: "Bulgarian" },
  { value: "BF", label: "Burkinabé" },
  { value: "BI", label: "Burundian" },
  { value: "KH", label: "Cambodian" },
  { value: "CM", label: "Cameroonian" },
  { value: "CA", label: "Canadian" },
  { value: "CV", label: "Cape Verdean" },
  { value: "CF", label: "Central African" },
  { value: "TD", label: "Chadian" },
  { value: "CL", label: "Chilean" },
  { value: "CN", label: "Chinese (PRC)" },
  { value: "CO", label: "Colombian" },
  { value: "KM", label: "Comorian" },
  { value: "CG", label: "Congolese (Republic)" },
  { value: "CD", label: "Congolese (DRC)" },
  { value: "CR", label: "Costa Rican" },
  { value: "CI", label: "Ivorian" },
  { value: "HR", label: "Croatian" },
  { value: "CU", label: "Cuban" },
  { value: "CY", label: "Cypriot" },
  { value: "CZ", label: "Czech" },
  { value: "DK", label: "Danish" },
  { value: "DJ", label: "Djiboutian" },
  { value: "DM", label: "Dominican (Dominica)" },
  { value: "DO", label: "Dominican (DR)" },
  { value: "NL", label: "Dutch" },
  { value: "TL", label: "East Timorese" },
  { value: "EC", label: "Ecuadorian" },
  { value: "EG", label: "Egyptian" },
  { value: "SV", label: "Salvadoran" },
  { value: "AE", label: "Emirati" },
  { value: "GQ", label: "Equatorial Guinean" },
  { value: "ER", label: "Eritrean" },
  { value: "EE", label: "Estonian" },
  { value: "SZ", label: "Swazi (Eswatini)" },
  { value: "ET", label: "Ethiopian" },
  { value: "FJ", label: "Fijian" },
  { value: "FI", label: "Finnish" },
  { value: "FR", label: "French" },
  { value: "GA", label: "Gabonese" },
  { value: "GM", label: "Gambian" },
  { value: "GE", label: "Georgian" },
  { value: "DE", label: "German" },
  { value: "GH", label: "Ghanaian" },
  { value: "GR", label: "Greek" },
  { value: "GD", label: "Grenadian" },
  { value: "GT", label: "Guatemalan" },
  { value: "GN", label: "Guinean" },
  { value: "GW", label: "Guinea-Bissauan" },
  { value: "GY", label: "Guyanese" },
  { value: "HT", label: "Haitian" },
  { value: "HN", label: "Honduran" },
  { value: "HK", label: "Hong Konger" },
  { value: "HU", label: "Hungarian" },
  { value: "IS", label: "Icelander" },
  { value: "IN", label: "Indian" },
  { value: "ID", label: "Indonesian" },
  { value: "IR", label: "Iranian" },
  { value: "IQ", label: "Iraqi" },
  { value: "IE", label: "Irish" },
  { value: "IL", label: "Israeli" },
  { value: "IT", label: "Italian" },
  { value: "JM", label: "Jamaican" },
  { value: "JP", label: "Japanese" },
  { value: "JO", label: "Jordanian" },
  { value: "KZ", label: "Kazakhstani" },
  { value: "KE", label: "Kenyan" },
  { value: "KI", label: "I-Kiribati" },
  { value: "KP", label: "Korean (North)" },
  { value: "KR", label: "Korean (South)" },
  { value: "KW", label: "Kuwaiti" },
  { value: "KG", label: "Kyrgyz" },
  { value: "LA", label: "Lao" },
  { value: "LV", label: "Latvian" },
  { value: "LB", label: "Lebanese" },
  { value: "LS", label: "Mosotho (Lesotho)" },
  { value: "LR", label: "Liberian" },
  { value: "LY", label: "Libyan" },
  { value: "LI", label: "Liechtensteiner" },
  { value: "LT", label: "Lithuanian" },
  { value: "LU", label: "Luxembourger" },
  { value: "MO", label: "Macanese" },
  { value: "MG", label: "Malagasy" },
  { value: "MW", label: "Malawian" },
  { value: "MV", label: "Maldivian" },
  { value: "ML", label: "Malian" },
  { value: "MT", label: "Maltese" },
  { value: "MH", label: "Marshallese" },
  { value: "MR", label: "Mauritanian" },
  { value: "MU", label: "Mauritian" },
  { value: "MX", label: "Mexican" },
  { value: "FM", label: "Micronesian" },
  { value: "MD", label: "Moldovan" },
  { value: "MC", label: "Monégasque" },
  { value: "MN", label: "Mongolian" },
  { value: "ME", label: "Montenegrin" },
  { value: "MA", label: "Moroccan" },
  { value: "MZ", label: "Mozambican" },
  { value: "MM", label: "Myanmar (Burmese)" },
  { value: "NA", label: "Namibian" },
  { value: "NR", label: "Nauruan" },
  { value: "NP", label: "Nepali" },
  { value: "NZ", label: "New Zealander" },
  { value: "NI", label: "Nicaraguan" },
  { value: "NE", label: "Nigerien" },
  { value: "NG", label: "Nigerian" },
  { value: "MK", label: "North Macedonian" },
  { value: "NO", label: "Norwegian" },
  { value: "OM", label: "Omani" },
  { value: "PK", label: "Pakistani" },
  { value: "PW", label: "Palauan" },
  { value: "PS", label: "Palestinian" },
  { value: "PA", label: "Panamanian" },
  { value: "PG", label: "Papua New Guinean" },
  { value: "PY", label: "Paraguayan" },
  { value: "PE", label: "Peruvian" },
  { value: "PH", label: "Filipino" },
  { value: "PL", label: "Polish" },
  { value: "PT", label: "Portuguese" },
  { value: "QA", label: "Qatari" },
  { value: "RO", label: "Romanian" },
  { value: "RU", label: "Russian" },
  { value: "RW", label: "Rwandan" },
  { value: "KN", label: "Kittitian / Nevisian" },
  { value: "LC", label: "Saint Lucian" },
  { value: "VC", label: "Vincentian" },
  { value: "WS", label: "Samoan" },
  { value: "SM", label: "Sammarinese" },
  { value: "ST", label: "São Toméan" },
  { value: "SA", label: "Saudi" },
  { value: "SN", label: "Senegalese" },
  { value: "RS", label: "Serbian" },
  { value: "SC", label: "Seychellois" },
  { value: "SL", label: "Sierra Leonean" },
  { value: "SG", label: "Singaporean" },
  { value: "SK", label: "Slovak" },
  { value: "SI", label: "Slovenian" },
  { value: "SB", label: "Solomon Islander" },
  { value: "SO", label: "Somali" },
  { value: "ZA", label: "South African" },
  { value: "SS", label: "South Sudanese" },
  { value: "ES", label: "Spanish" },
  { value: "LK", label: "Sri Lankan" },
  { value: "SD", label: "Sudanese" },
  { value: "SR", label: "Surinamese" },
  { value: "SE", label: "Swedish" },
  { value: "CH", label: "Swiss" },
  { value: "SY", label: "Syrian" },
  { value: "TW", label: "Taiwanese" },
  { value: "TJ", label: "Tajik" },
  { value: "TZ", label: "Tanzanian" },
  { value: "TH", label: "Thai" },
  { value: "TG", label: "Togolese" },
  { value: "TO", label: "Tongan" },
  { value: "TT", label: "Trinidadian" },
  { value: "TN", label: "Tunisian" },
  { value: "TR", label: "Turkish" },
  { value: "TM", label: "Turkmen" },
  { value: "TV", label: "Tuvaluan" },
  { value: "UG", label: "Ugandan" },
  { value: "UA", label: "Ukrainian" },
  { value: "US", label: "American" },
  { value: "UY", label: "Uruguayan" },
  { value: "UZ", label: "Uzbek" },
  { value: "VU", label: "Vanuatuan" },
  { value: "VA", label: "Vatican" },
  { value: "VE", label: "Venezuelan" },
  { value: "VN", label: "Vietnamese" },
  { value: "YE", label: "Yemeni" },
  { value: "ZM", label: "Zambian" },
  { value: "ZW", label: "Zimbabwean" },
];

export const NATIONALITIES: RefOption[] = [
  { value: "MY", label: "Malaysian" },
  ...NATIONALITY_REST.sort((a, b) => a.label.localeCompare(b.label)),
  { value: "Other", label: "Other / Stateless" },
];

// ── Malaysian banks ────────────────────────────────────────────────────────
// All BNM-licensed commercial banks, Islamic banks, and retail-relevant
// development financial institutions that can hold accounts for agent
// commissions, tenant deposits, and owner payouts.
//
// Source: Bank Negara Malaysia — Licensed Financial Institutions
//   https://www.bnm.gov.my/regulations/fsact/financial-institutions-regulated-by-bnm
//
// Flat alphabetical list: we don't pre-group by tier because "why still need
// to choose?" — users should scan one list and pick. "Other" kept at the end
// as an escape hatch for rare cases (offshore accounts, legacy brands).

const BANK_LIST: RefOption[] = [
  { value: "Affin Bank",              label: "Affin Bank" },
  { value: "Affin Islamic Bank",      label: "Affin Islamic Bank" },
  { value: "Agrobank",                label: "Agrobank" },
  { value: "Al Rajhi Bank",           label: "Al Rajhi Bank" },
  { value: "Alliance Bank",           label: "Alliance Bank" },
  { value: "Alliance Islamic Bank",   label: "Alliance Islamic Bank" },
  { value: "AmBank",                  label: "AmBank" },
  { value: "AmBank Islamic",          label: "AmBank Islamic" },
  { value: "Bangkok Bank",            label: "Bangkok Bank" },
  { value: "Bank of America",         label: "Bank of America Malaysia" },
  { value: "Bank of China",           label: "Bank of China (Malaysia)" },
  { value: "Bank Islam",              label: "Bank Islam" },
  { value: "Bank Muamalat",           label: "Bank Muamalat" },
  { value: "Bank of Nova Scotia",     label: "Bank of Nova Scotia" },
  { value: "Bank Pembangunan Malaysia", label: "Bank Pembangunan Malaysia" },
  { value: "Bank Rakyat",             label: "Bank Rakyat" },
  { value: "Bank Simpanan Nasional",  label: "Bank Simpanan Nasional (BSN)" },
  { value: "BNP Paribas",             label: "BNP Paribas Malaysia" },
  { value: "China Construction Bank", label: "China Construction Bank (Malaysia)" },
  { value: "CIMB Bank",               label: "CIMB Bank" },
  { value: "CIMB Islamic Bank",       label: "CIMB Islamic Bank" },
  { value: "Citibank",                label: "Citibank Malaysia" },
  { value: "Deutsche Bank",           label: "Deutsche Bank (Malaysia)" },
  { value: "EXIM Bank",               label: "EXIM Bank Malaysia" },
  { value: "Hong Leong Bank",         label: "Hong Leong Bank" },
  { value: "Hong Leong Islamic Bank", label: "Hong Leong Islamic Bank" },
  { value: "HSBC Amanah",             label: "HSBC Amanah Malaysia" },
  { value: "HSBC Bank Malaysia",      label: "HSBC Bank Malaysia" },
  { value: "ICBC",                    label: "ICBC (Malaysia)" },
  { value: "India International Bank", label: "India International Bank (Malaysia)" },
  { value: "J.P. Morgan Chase",       label: "J.P. Morgan Chase Bank" },
  { value: "Kuwait Finance House",    label: "Kuwait Finance House" },
  { value: "Maybank",                 label: "Maybank" },
  { value: "Maybank Islamic",         label: "Maybank Islamic" },
  { value: "MBSB Bank",               label: "MBSB Bank" },
  { value: "Mizuho Bank",             label: "Mizuho Bank (Malaysia)" },
  { value: "MUFG Bank",               label: "MUFG Bank (Malaysia)" },
  { value: "OCBC Al-Amin Bank",       label: "OCBC Al-Amin Bank" },
  { value: "OCBC Bank",               label: "OCBC Bank (Malaysia)" },
  { value: "Public Bank",             label: "Public Bank" },
  { value: "Public Islamic Bank",     label: "Public Islamic Bank" },
  { value: "RHB Bank",                label: "RHB Bank" },
  { value: "RHB Islamic Bank",        label: "RHB Islamic Bank" },
  { value: "SME Bank",                label: "SME Bank" },
  { value: "SMBC",                    label: "Sumitomo Mitsui Banking Corporation (SMBC)" },
  { value: "Standard Chartered",      label: "Standard Chartered Malaysia" },
  { value: "Standard Chartered Saadiq", label: "Standard Chartered Saadiq" },
  { value: "UOB",                     label: "UOB (Malaysia)" },
];

export const MALAYSIAN_BANKS: RefOption[] = [
  ...BANK_LIST.sort((a, b) => a.label.localeCompare(b.label)),
  { value: "Other", label: "Other" },
];

// ── Helper: preserve legacy values ─────────────────────────────────────────
// If `currentValue` is set but not in `options`, returns a new list with the
// value prepended as an option. Use this for edit flows so pre-existing data
// never silently resets when we tighten a freeform field into a dropdown.
export function withExistingOption(
  options: RefOption[],
  currentValue: string | null | undefined,
): RefOption[] {
  if (!currentValue) return options;
  if (options.some((o) => o.value === currentValue)) return options;
  return [{ value: currentValue, label: `${currentValue} (legacy)` }, ...options];
}

// ── Helper: display label for a stored value ───────────────────────────────
// Use in tables and detail views so users see "Malaysian" instead of the raw
// "MY" code. Unknown values (e.g. legacy free-text rows) fall back to the
// stored value itself so we never display a blank.
export function labelOf(
  options: RefOption[],
  value: string | null | undefined,
): string {
  if (!value) return "";
  return options.find((o) => o.value === value)?.label ?? value;
}
