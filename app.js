// 1. 화면 요소와 통합 목록입니다.
const searchInput = document.getElementById('search');
const refreshButton = document.getElementById('refresh');
const statusText = document.getElementById('status');
const listArea = document.getElementById('parking-list');
let parkingData = [];
let loading = false;
let notice = '';

function text(value) {
  return value == null || String(value).trim() === '-' ? '' : String(value).trim();
}
function number(value) {
  return text(value) === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}
function normalize(value) {
  return text(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

// 2. 시설공단 목록과 실시간 응답은 동일 코드로 연결합니다.
// 부산시 자료는 정리한 이름이 유일하고 주차면수도 같을 때만 연결합니다.
// 이름이 비슷한 정도로는 연결하지 않습니다.
function mergeParking(city, list, live) {
  const facilityMap = new Map();
  for (const item of list) facilityMap.set(item.parkgcd, { code: item.parkgcd, name: item.parknm, realtime: null });
  for (const item of live) {
    const row = facilityMap.get(item.parkgcd) || { code: item.parkgcd, name: item.parknm };
    row.realtime = item;
    facilityMap.set(item.parkgcd, row);
  }
  const facilities = [...facilityMap.values()];
  const cityNames = new Map();
  const facilityNames = new Map();
  for (const item of city) {
    const name = normalize(item.pkNam);
    cityNames.set(name, [...(cityNames.get(name) || []), item]);
  }
  for (const row of facilities) {
    const name = normalize(row.name);
    facilityNames.set(name, [...(facilityNames.get(name) || []), row]);
  }
  const used = new Set();
  const rows = city.map((item, index) => {
    const name = normalize(item.pkNam);
    const candidates = facilityNames.get(name) || [];
    const facility = candidates[0];
    const capacity = number(item.pkCnt);
    const match = name && cityNames.get(name).length === 1 && candidates.length === 1
      && capacity > 0 && capacity === number(facility.realtime?.maxcnt);
    if (match) used.add(facility.code);
    return {
      id: 'city-' + index, name: text(item.pkNam) || '이름 없음',
      basic: item, capacity, realtime: match ? facility.realtime : null,
      facility: Boolean(match)
    };
  });
  // 동일 시설로 확인하지 못한 주차장도 빠뜨리지 않고 표시합니다.
  for (const row of facilities) {
    if (!used.has(row.code)) rows.push({
      id: row.code, name: text(row.name) || row.code, basic: null,
      capacity: number(row.realtime?.maxcnt), realtime: row.realtime, facility: true
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

// 3. 세 가지 조회 결과를 한 목록으로 합칩니다.
async function requestData(type) {
  const response = await fetch('/api/parking?type=' + type, { signal: AbortSignal.timeout(90000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '조회 실패');
  return data.items;
}
async function loadParking() {
  if (loading) return;
  loading = true;
  refreshButton.disabled = true;
  statusText.textContent = '전체 주차장 정보를 조회하고 있습니다…';
  try {
    const results = await Promise.allSettled([
      requestData('city'), requestData('list'), requestData('live')
    ]);
    const labels = ['부산시 기본정보', '시설공단 목록', '시설공단 실시간'];
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [labels[index]] : []);
    if (results.every(result => result.status === 'rejected')) throw new Error(results[0].reason.message);
    const [city, list, live] = results.map(result => result.status === 'fulfilled' ? result.value : []);
    parkingData = mergeParking(city, list, live);
    notice = failed.length ? '일부 조회 실패: ' + failed.join(', ') + '. 조회된 자료만 표시합니다.' : '';
    renderParking();
  } catch (error) {
    parkingData = [];
    listArea.replaceChildren();
    statusText.textContent = '조회 실패: ' + error.message;
  } finally {
    loading = false;
    refreshButton.disabled = false;
  }
}

// 4. 제공기관 값이 이상하거나 오래됐는지 확인합니다.
function liveStatus(row) {
  if (!row.facility) return { label: '실시간 미제공', free: null, className: '' };
  const live = row.realtime;
  if (!live) return { label: '실시간 정보 없음', free: null, className: 'warn' };
  const free = number(live.curravacnt);
  const capacity = number(live.maxcnt);
  const occupied = number(live.parkingcnt);
  const invalid = (capacity !== null && capacity <= 0) || (free !== null && free < 0)
    || (occupied !== null && occupied < 0) || (free !== null && capacity !== null && free > capacity)
    || (free !== null && occupied !== null && capacity !== null && free + occupied !== capacity);
  if (invalid) return { label: '데이터 확인 필요', free: null, className: 'warn' };
  if (free === null) return { label: '실시간 정보 없음', free: null, className: '' };
  const stamp = Date.parse(text(live.lastupdatetime).replace(' ', 'T') + '+09:00');
  const stale = !Number.isFinite(stamp) || Date.now() - stamp > 15 * 60 * 1000 || stamp > Date.now() + 5 * 60 * 1000;
  if (stale) return { label: '갱신 지연', free, stale: true, className: 'warn' };
  return { label: free === 0 ? '만차' : '빈자리 있음', free, className: free > 0 ? 'good' : 'warn' };
}
function money(value) {
  const amount = number(value);
  return amount !== null && amount > 0 ? amount.toLocaleString() + '원' : '현장 확인';
}
function hours(start, end) {
  const valid = value => /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(text(value)) || text(value) === '24:00';
  if (!valid(start) || !valid(end)) return '현장 확인';
  if (text(start) === '00:00' && text(end) === '24:00') return '24시간';
  return text(start) + ' ~ ' + text(end);
}

// 5. 핵심정보와 펼칠 수 있는 상세정보를 표시합니다.
function renderParking() {
  const query = normalize(searchInput.value);
  const filtered = parkingData.filter(row => normalize(
    row.name + ' ' + text(row.basic?.doroAddr) + ' ' + text(row.basic?.jibunAddr) + ' ' + text(row.basic?.guNm)
  ).includes(query));
  statusText.textContent = (notice ? notice + '\n' : '')
    + '통합 목록 ' + parkingData.length + '곳 / 검색 결과 ' + filtered.length + '곳';
  listArea.innerHTML = filtered.map(row => {
    const basic = row.basic || {};
    const state = liveStatus(row);
    const address = text(basic.doroAddr) || text(basic.jibunAddr) || '주소 정보 없음';
    const capacity = number(row.realtime?.maxcnt) > 0 ? number(row.realtime.maxcnt) : row.capacity;
    const fee = number(basic.tenMin), minutes = number(basic.pkBascTime);
    const feeText = fee > 0 && minutes > 0 ? minutes + '분 / ' + fee.toLocaleString() + '원' : '현장 확인';
    const freeText = state.free === null ? '' : `<p class="free">${state.stale ? '마지막 보고 빈자리' : '빈자리'} ${state.free.toLocaleString()}면</p>`;
    const details = row.basic ? `
      <p>추가요금: ${number(basic.pkAddTime) > 0 && number(basic.feeAdd) > 0 ? escapeHtml(basic.pkAddTime) + '분 / ' + money(basic.feeAdd) : '현장 확인'}</p>
      <p>1일권: ${money(basic.ftDay)} / 월정기권: ${money(basic.ftMon)}</p>
      <p>토요일: ${escapeHtml(hours(basic.satSrtTe, basic.satEndTe))}</p>
      <p>공휴일: ${escapeHtml(hours(basic.hldSrtTe, basic.hldEndTe))}</p>
      <p>주차장 유형: ${escapeHtml(text(basic.pkFm) || '정보 없음')}</p>
      <p>전화번호: ${escapeHtml(text(basic.tponNum) || '정보 없음')}</p>
      <p>결제방법: ${escapeHtml(text(basic.payMtd) || '현장 확인')}</p>
      <p>특기사항: ${escapeHtml(text(basic.spclNote) || '제공 정보 없음')}</p>
      <p>관리기관: ${escapeHtml(text(basic.guNm) || '정보 없음')}</p>
      <p class="note">기본정보 기준일: ${escapeHtml(text(basic.fnlDt) || '정보 없음')}</p>`
      : '<p>부산시 기본정보와 동일 시설임을 확인하지 못해 주소·요금·운영시간을 표시하지 않습니다.</p>';
    return `<article class="parking-card">
      <span class="badge ${state.className}">${state.label}</span>
      <h2>${escapeHtml(row.name)}</h2>
      <p>${escapeHtml(address)}</p>${freeText}
      <p>전체 주차구획: ${capacity > 0 ? capacity.toLocaleString() : '—'}면</p>
      <p>기본요금: ${feeText}</p>
      <p>평일 운영: ${escapeHtml(hours(basic.svcSrtTe, basic.svcEndTe))}</p>
      ${row.realtime ? `<p class="note">실시간 갱신: ${escapeHtml(text(row.realtime.lastupdatetime) || '정보 없음')} (한국시간)</p>` : ''}
      <details><summary>상세정보 보기</summary>${details}</details>
    </article>`;
  }).join('');
  if (!filtered.length) listArea.textContent = '조건에 맞는 주차장이 없습니다.';
}
refreshButton.addEventListener('click', loadParking);
searchInput.addEventListener('input', () => { if (!loading) renderParking(); });
loadParking();
