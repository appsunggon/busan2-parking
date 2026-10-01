const endpoints = {
 city: ['https://apis.data.go.kr/6260000/BusanPblcPrkngInfoService/getPblcPrkngInfo','DATA_GO_KR_SERVICE_KEY',3600],
 list: ['https://apis.data.go.kr/B552587/ParkingInfoService_v2/getParkingList_v2','DATA_GO_KR_SERVICE_KEY',3600],
 live: ['https://apis.data.go.kr/B552587/ParkingInfoService_v2/getParkingInfoList_v2','DATA_GO_KR_SERVICE_KEY',60]
};
export function parseBody(data) {
 const response=data?.response;
 if (!response?.header || String(response.header.resultCode)!=='00') throw new Error('API_ERROR');
 const body=response.body;
 if (!body || !Number.isFinite(Number(body.totalCount))) throw new Error('INVALID_RESPONSE');
 const item=body.items?.item;
 return {items: item ? (Array.isArray(item)?item:[item]) : [],totalCount:Number(body.totalCount)};
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
export async function onRequestGet({request,env,waitUntil}) {
 const type=new URL(request.url).searchParams.get('type') || 'live';
 if (!endpoints[type]) return json({error:'조회 종류가 올바르지 않습니다.'},400);
 const [endpoint,keyName,ttl]=endpoints[type];
 if (!env[keyName]) return json({error:`Cloudflare에 ${keyName} 인증키를 설정해 주세요.`},503);
 const cache=globalThis.caches?.default;
 const cacheKey=new Request(`${new URL(request.url).origin}/api/parking?type=${type}`);
 if(cache){const hit=await cache.match(cacheKey);if(hit)return hit;}
 try {
  let key=env[keyName].trim();
  if (/%[0-9a-f]{2}/i.test(key)) key=decodeURIComponent(key);
  const getPage=async(page)=>{
   const url=new URL(endpoint);url.search=new URLSearchParams({serviceKey:key,pageNo:String(page),numOfRows:'100',resultType:'json'});
   const res=await fetch(url,{signal:AbortSignal.timeout(12000)});
   if(!res.ok)throw new Error('HTTP_ERROR');
   return parseBody(await res.json());
  };
  const first=await getPage(1);let items=[...first.items];
  // API가 요청한 100건보다 적게 돌려주면 실제 응답 건수로 페이지 수를 계산합니다.
  const count=first.items.length;
  if(first.totalCount>0 && count===0)throw new Error('EMPTY_PAGE');
  const pages=count?Math.ceil(first.totalCount/count):1;
  if(pages>30)throw new Error('TOO_MANY_PAGES');
  for(let page=2;page<=pages;page+=3){
   const batch=await Promise.all(Array.from({length:Math.min(3,pages-page+1)},(_,i)=>getPage(page+i)));
   for(const b of batch)items.push(...b.items);
  }
  if(items.length!==first.totalCount)throw new Error('INCOMPLETE_DATA');
  const response=json({items,totalCount:first.totalCount,fetchedAt:new Date().toISOString(),source:type});
  response.headers.set('Cache-Control',`public, max-age=${ttl}`);
  if(cache)waitUntil(cache.put(cacheKey,response.clone()));
  return response;
 } catch {
  return json({error:'공공데이터 조회에 실패했습니다. 인증키·활용승인·요청한도·API 응답을 확인한 뒤 다시 시도해 주세요.'},502);
 }
}
