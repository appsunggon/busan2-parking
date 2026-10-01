// 1. HTML 요소와 조회 결과를 보관합니다.
const typeSelect = document.getElementById('type');
const refreshButton = document.getElementById('refresh');
const searchInput = document.getElementById('search');
const statusText = document.getElementById('status');
const listArea = document.getElementById('parking-list');
let parkingData = [];
let currentType = 'live';
let loading = false;

// 2. 비어 있는 값은 0으로 바꾸지 않습니다.
function text(value) {
  return value == null || String(value).trim() === '-' ? '' : String(value).trim();
}
function number(value) {
  return text(value) === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}
function normalize(value) {
  return text(value).replace(/\s/g, '').toLowerCase();
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

// 3. 브라우저는 공공데이터 API 대신 우리 Functions에 요청합니다.
async function requestData(type) {
  const response = await fetch('/api/parking?type=' + type);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '조회에 실패했습니다.');
  return data.items;
}
async function loadParking() {
  if (loading) return;
  loading = true;
  refreshButton.disabled = true;
  typeSelect.disabled = true;
  statusText.textContent = '조회 중입니다…';
  parkingData = [];
  listArea.replaceChildren();
  currentType = typeSelect.value;
  try {
    if (currentType === 'live') {
      // 시설공단 목록과 실시간 응답은 parkgcd로 연결합니다.
      const [list, live] = await Promise.all([requestData('list'), requestData('live')]);
      const liveMap = new Map(live.map(item => [item.parkgcd, item]));
      const names = new Map(list.map(item => [item.parkgcd, item.parknm]));
      parkingData = [...new Set([...names.keys(), ...liveMap.keys()])].map(code => ({
        ...(liveMap.get(code) || {}), parkgcd: code,
        parknm: names.get(code) || liveMap.get(code)?.parknm || code
      }));
    } else {
      parkingData = await requestData('city');
    }
    renderParking();
  } catch (error) {
    statusText.textContent = '조회 실패: ' + error.message;
  } finally {
    loading = false;
    refreshButton.disabled = false;
    typeSelect.disabled = false;
  }
}

// 4. 검색 조건에 맞는 카드를 표시합니다.
function renderParking() {
  const query = normalize(searchInput.value);
  const filtered = parkingData.filter(item => normalize(
    (item.parknm || item.pkNam || '') + ' ' + text(item.doroAddr) + ' ' + text(item.jibunAddr)
  ).includes(query));
  statusText.textContent = '전체 ' + parkingData.length + '곳 / 검색 결과 ' + filtered.length + '곳';
  listArea.innerHTML = filtered.map(item => {
    const name = escapeHtml(item.parknm || item.pkNam || '이름 없음');
    if (currentType === 'live') {
      const free = number(item.curravacnt);
      const capacity = number(item.maxcnt);
      const occupied = number(item.parkingcnt);
      const invalid = (capacity !== null && capacity <= 0) || (free !== null && free < 0)
        || (occupied !== null && occupied < 0) || (free !== null && capacity !== null && free > capacity)
        || (free !== null && occupied !== null && capacity !== null && free + occupied !== capacity);
      const stamp = Date.parse(text(item.lastupdatetime).replace(' ', 'T') + '+09:00');
      const stale = !Number.isFinite(stamp) || Date.now() - stamp > 15 * 60 * 1000 || stamp > Date.now() + 5 * 60 * 1000;
      const label = invalid ? '데이터 확인 필요' : free === null ? '정보 없음' : stale ? '갱신 지연' : free === 0 ? '만차' : '빈자리 있음';
      return `<article class="parking-card"><h2>${name}</h2>
        <p class="free">${invalid || free === null ? '—' : free + '면'} (${label})</p>
        <p>전체 주차구획: ${capacity ?? '—'}면</p>
        <p class="note">제공기관 갱신: ${escapeHtml(text(item.lastupdatetime) || '정보 없음')} (한국시간)</p>
        <p class="note">실제 현장과 다를 수 있습니다. 갱신 지연 시 마지막 보고값입니다.</p></article>`;
    }
    const address = text(item.doroAddr) || text(item.jibunAddr) || '정보 없음';
    const fee = number(item.tenMin);
    return `<article class="parking-card"><h2>${name}</h2>
      <p>주소: ${escapeHtml(address)}</p>
      <p>주차구획: ${number(item.pkCnt) ?? '—'}면</p>
      <p>기본요금: ${fee !== null && fee > 0 ? escapeHtml(text(item.pkBascTime) || '?') + '분 / ' + fee.toLocaleString() + '원' : '현장 확인'}</p>
      <p class="note">자료 기준일: ${escapeHtml(text(item.fnlDt) || '정보 없음')}</p></article>`;
  }).join('');
  if (!filtered.length) listArea.textContent = '표시할 주차장이 없습니다.';
}

// 5. 버튼과 검색 입력을 연결하고 처음 한 번 조회합니다.
refreshButton.addEventListener('click', loadParking);
typeSelect.addEventListener('change', loadParking);
searchInput.addEventListener('input', () => { if (!loading && parkingData.length) renderParking(); });
loadParking();
