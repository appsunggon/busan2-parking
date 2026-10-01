// 1. 조회 종류별 API 주소, 인증키 이름, 캐시 시간을 지정합니다.
const endpoints = {
  city: [
    'https://apis.data.go.kr/6260000/BusanPblcPrkngInfoService/getPblcPrkngInfo',
    'DATA_GO_KR_SERVICE_KEY',
    3600
  ],
  list: [
    'https://apis.data.go.kr/B552587/ParkingInfoService_v2/getParkingList_v2',
    'DATA_GO_KR_SERVICE_KEY',
    3600
  ],
  live: [
    'https://apis.data.go.kr/B552587/ParkingInfoService_v2/getParkingInfoList_v2',
    'DATA_GO_KR_SERVICE_KEY',
    60
  ]
};

// 2. 공공데이터 API 응답에서 목록과 전체 건수를 추출합니다.
export function parseBody(data) {
  const response = data?.response;

  if (
    !response?.header ||
    String(response.header.resultCode) !== '00'
  ) {
    throw new Error('API_ERROR');
  }

  const body = response.body;

  if (
    !body ||
    !Number.isFinite(Number(body.totalCount))
  ) {
    throw new Error('INVALID_RESPONSE');
  }

  const item = body.items?.item;

  return {
    items: item
      ? (Array.isArray(item) ? item : [item])
      : [],
    totalCount: Number(body.totalCount)
  };
}

// 3. 브라우저에 JSON 응답을 보냅니다.
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

// 4. /api/parking으로 들어온 GET 요청을 처리합니다.
export async function onRequestGet({
  request,
  env,
  waitUntil
}) {
  const requestUrl = new URL(request.url);
  const type = requestUrl.searchParams.get('type') || 'live';

  if (!endpoints[type]) {
    return json({
      error: '조회 종류가 올바르지 않습니다.'
    }, 400);
  }

  const [endpoint, keyName, ttl] = endpoints[type];

  // Cloudflare에 등록된 인증키를 읽습니다.
  if (!env[keyName]) {
    return json({
      error: `Cloudflare에 ${keyName} 인증키를 설정해 주세요.`
    }, 503);
  }

  // 5. 캐시된 응답이 있으면 먼저 반환합니다.
  const cache = globalThis.caches?.default;

  const cacheKey = new Request(
    `${requestUrl.origin}/api/parking?type=${type}`
  );

  if (cache) {
    const cachedResponse = await cache.match(cacheKey);

    if (cachedResponse) {
      return cachedResponse;
    }
  }

  try {
    let serviceKey = env[keyName].trim();

    // Encoding 인증키를 입력했으면 한 번 디코딩합니다.
    if (/%[0-9a-f]{2}/i.test(serviceKey)) {
      serviceKey = decodeURIComponent(serviceKey);
    }

    // 6. 공공데이터 API의 한 페이지를 조회합니다.
    async function getPage(pageNo) {
      const url = new URL(endpoint);

      url.search = new URLSearchParams({
        serviceKey,
        pageNo: String(pageNo),
        numOfRows: '100',
        resultType: 'json'
      }).toString();

      const response = await fetch(url, {
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) {
        throw new Error('HTTP_ERROR');
      }

      const data = await response.json();

      return parseBody(data);
    }

    // 7. 첫 페이지에서 전체 건수를 확인합니다.
    const firstPage = await getPage(1);
    const items = [...firstPage.items];
    const pageSize = firstPage.items.length;

    if (firstPage.totalCount > 0 && pageSize === 0) {
      throw new Error('EMPTY_PAGE');
    }

    // 요청한 100건보다 적게 반환되면 실제 건수를 기준으로 계산합니다.
    const totalPages = pageSize
      ? Math.ceil(firstPage.totalCount / pageSize)
      : 1;

    if (totalPages > 30) {
      throw new Error('TOO_MANY_PAGES');
    }

    // 8. 나머지 페이지를 최대 3개씩 동시에 조회합니다.
    for (let page = 2; page <= totalPages; page += 3) {
      const batchSize = Math.min(
        3,
        totalPages - page + 1
      );

      const requests = Array.from(
        { length: batchSize },
        (_, index) => getPage(page + index)
      );

      const results = await Promise.all(requests);

      for (const result of results) {
        items.push(...result.items);
      }
    }

    // 전체 자료가 조회되었는지 확인합니다.
    if (items.length !== firstPage.totalCount) {
      throw new Error('INCOMPLETE_DATA');
    }

    // 9. 조회 결과를 브라우저에 반환하고 캐시에 저장합니다.
    const response = json({
      items,
      totalCount: firstPage.totalCount,
      fetchedAt: new Date().toISOString(),
      source: type
    });

    response.headers.set(
      'Cache-Control',
      `public, max-age=${ttl}`
    );

    if (cache) {
      waitUntil(
        cache.put(cacheKey, response.clone())
      );
    }

    return response;
  } catch {
    // 인증키와 요청주소는 오류 응답에 포함하지 않습니다.
    return json({
      error:
        '공공데이터 조회에 실패했습니다. ' +
        '인증키·활용승인·요청한도·API 응답을 확인한 뒤 ' +
        '다시 시도해 주세요.'
    }, 502);
  }
}