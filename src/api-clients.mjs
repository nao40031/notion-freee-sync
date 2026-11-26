import {SyncError} from "./sync-core.mjs";

async function requestJson(fetchImpl, url, {method="GET", token, headers={}, body, signal}={}) {
  if (!token) throw new SyncError("api_token_missing");
  const response = await fetchImpl(url, {method, signal, headers:{Authorization:`Bearer ${token}`, "Content-Type":"application/json", ...headers},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  if (!response.ok) throw new SyncError(response.status===401?"api_auth_failed":response.status===429?"api_rate_limited":response.status>=500?"api_server_error":"api_request_failed", {status:response.status});
  return response.status===204 ? null : response.json();
}

export async function safeGet(fetchImpl,url,options={}) {
  const attempts=options.maxAttempts??3;
  if(!Number.isInteger(attempts)||attempts<1||attempts>3)throw new SyncError("retry_limit_invalid");
  for(let attempt=1;attempt<=attempts;attempt++){
    try{
      const response=await fetchImpl(url,{method:"GET",headers:options.headers,signal:options.signal});
      if((response.status===429||response.status>=500)&&attempt<attempts){
        const raw=Number(response.headers?.get?.("retry-after"));
        const delay=Number.isFinite(raw)&&raw>=0?Math.min(2000,raw*1000):Math.min(1000,200*2**(attempt-1));
        const sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
        await sleep(delay);
        continue;
      }
      return response;
    }catch(error){if(attempt===attempts)throw new SyncError("get_transport_failed",{attempt});}
  }
}

export function createFreeeReadClient({baseUrl="https://api.freee.co.jp", tokenProvider, fetchImpl=globalThis.fetch, signal}={}) {
  if (typeof tokenProvider!=="function" || typeof fetchImpl!=="function") throw new SyncError("freee_client_config_invalid");
  return Object.freeze({
    async getDocument(type, companyId, documentId) {
      if (!new Set(["quotation","invoice"]).has(type) || !/^\d+$/.test(String(companyId)) || !/^\d+$/.test(String(documentId)))
        throw new SyncError("freee_get_identity_invalid");
      const path=type==="quotation"?"/api/1/quotations/":"/api/1/invoices/";
      const url=new URL(`${path}${encodeURIComponent(documentId)}`,baseUrl);
      url.searchParams.set("company_id",String(companyId));
      return requestJson(fetchImpl,url.toString(),{token:await tokenProvider(),signal});
    }
  });
}

export function createNotionClient({tokenProvider,apiVersion="2022-06-28",fetchImpl=globalThis.fetch,baseUrl="https://api.notion.com/v1",writeScope=null,signal}={}) {
  if (typeof tokenProvider!=="function" || typeof fetchImpl!=="function") throw new SyncError("notion_client_config_invalid");
  const read=async(path)=>{
    const response=await safeGet(fetchImpl,`${baseUrl}${path}`,{headers:{Authorization:`Bearer ${await tokenProvider()}`,"Notion-Version":apiVersion},signal});
    if(!response.ok)throw new SyncError(response.status===401?"api_auth_failed":response.status===429?"api_rate_limited":response.status>=500?"api_server_error":"api_request_failed",{status:response.status});
    return response.json();
  };
  const mutate=async({operation,objectId,dataSourceId,body})=>{
    if (!writeScope || writeScope.enabled!==true || !writeScope.operations?.includes(operation)) throw new SyncError("notion_write_not_authorized");
    if (!dataSourceId || !writeScope.dataSourceIds?.includes(dataSourceId)) throw new SyncError("notion_data_source_out_of_scope");
    if (objectId && !writeScope.pageIds?.includes(objectId)) throw new SyncError("notion_page_out_of_scope");
    if (operation === "create_page" && body?.parent?.data_source_id !== dataSourceId)
      throw new SyncError("notion_create_parent_mismatch");
    const props=body?.properties;
    if(props){
      const allowed=new Set(writeScope.properties??[]);
      const keys=Object.keys(props);
      if(keys.some(key=>!allowed.has(key)))throw new SyncError("notion_property_out_of_scope",{properties:keys.filter(key=>!allowed.has(key))});
    }
    if(operation==="create_page"&&!writeScope.allowCreate)throw new SyncError("notion_create_not_authorized");
    return requestJson(fetchImpl,`${baseUrl}${operation==="create_page"?"/pages":`/pages/${encodeURIComponent(objectId)}`}`,{
      method:operation==="create_page"?"POST":operation==="archive_page"?"PATCH":"PATCH",
      token:await tokenProvider(),signal,headers:{"Notion-Version":apiVersion},
      body:operation==="archive_page"?{archived:true}:body});
  };
  return Object.freeze({
    getPage:id=>read(`/pages/${encodeURIComponent(id)}`),
    async queryDataSource(id,body={}) { return requestJson(fetchImpl,`${baseUrl}/data_sources/${encodeURIComponent(id)}/query`,{method:"POST",token:await tokenProvider(),signal,headers:{"Notion-Version":apiVersion},body}); },
    updatePage:(id,body,dataSourceId)=>mutate({operation:"update_page",objectId:id,dataSourceId,body}),
    createPage:(dataSourceId,body)=>mutate({operation:"create_page",dataSourceId,body}),
    archivePage:(id,dataSourceId)=>mutate({operation:"archive_page",objectId:id,dataSourceId}),
  });
}
