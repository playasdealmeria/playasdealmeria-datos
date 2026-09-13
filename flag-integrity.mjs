// Evidence policy for operational flags. Fetch time never renews source time.
export const FLAG_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const severity = { verde: 1, amarilla: 2, roja: 3, negra: 4 };
export const FLAG_FIELDS = ['oflag','oflagSource','ofiAt','oflagCheckedAt','oflagSourceAt','oflagSourceDay','oflagFreshness','oflagMunicipality','oflagSectorIds','oflagServiceActive'];
export function madridFlagDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function flagIsCurrent(record, now = Date.now()) {
  if (!record || !severity[record.oflag] || record.oflagServiceActive === false) return false;
  const today = madridFlagDay(now);
  const recent = value => {
    if (!value) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && time <= now + 5 * 60000 && now - time <= FLAG_MAX_AGE_MS;
  };
  if (record.oflagFreshness === 'source-time') return recent(record.oflagSourceAt) && madridFlagDay(record.oflagSourceAt) === today;
  if (record.oflagFreshness === 'source-day') return record.oflagSourceDay === today && recent(record.oflagCheckedAt);
  return false;
}
export function roquetasFlag(html, slug) {
  if (!/^[a-z_]+$/.test(slug)) return null;
  const marker = 'id="tooltip_' + slug + '"';
  const start = html.indexOf(marker);
  if (start < 0 || html.indexOf(marker, start + marker.length) >= 0) return null;
  const end = html.indexOf('id="tooltip_', start + marker.length);
  const block = html.slice(start, end < 0 ? start + 1500 : end);
  const flags = [...new Set([...block.matchAll(/bandera-(verde|amarilla|roja|negra)\b/g)].map(match => match[1]))];
  return flags.length === 1 ? flags[0] : null;
}
export function completeWorstFlag(flags) {
  if (!flags.length || flags.some(flag => !severity[flag])) return null;
  return flags.reduce((a, b) => severity[b] > severity[a] ? b : a);
}
function normalized(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); }
export function flagMatchesBeach(record, beach) {
  if (!record?.oflag) return false;
  // Municipal records must identify their municipality; fail closed on missing identity.
  if (String(record.oflagSource || '').startsWith('Ayuntamiento de ')) {
    return !!record.oflagMunicipality && normalized(record.oflagMunicipality) === normalized(beach.municipio);
  }
  return !record.oflagMunicipality || normalized(record.oflagMunicipality) === normalized(beach.municipio);
}
export function mergeOfficialFlag(scenario, junta, municipalCandidates, beach, now = Date.now()) {
  const merged = { ...scenario, ...(junta || {}) };
  for (const field of FLAG_FIELDS) delete merged[field];
  const candidates = [...municipalCandidates, junta].filter(record => flagMatchesBeach(record, beach));
  const selected = candidates.find(record => flagIsCurrent(record, now)) || candidates[0];
  if (selected) for (const field of FLAG_FIELDS) if (Object.hasOwn(selected, field)) merged[field] = selected[field];
  return merged;
}
export function flagMetrics(records, now = Date.now()) {
  const flags = Object.values(records).filter(record => severity[record?.oflag]);
  return {
    count_flags: flags.length,
    count_flags_timestamped: flags.filter(record => record.oflagSourceAt && Number.isFinite(Date.parse(record.oflagSourceAt))).length,
    count_flags_verified: flags.filter(record => flagIsCurrent(record, now)).length
  };
}
