/** Generic OAuth 2 token lifecycle. The host owns secure storage and user
 * authorization; token values are never returned in diagnostics or logs. */
export function createOAuthTokenProvider({tokenUrl,clientId,clientSecret,store,fetchImpl=globalThis.fetch,now=Date.now,refreshSkewMs=60000,authStyle="basic"}={}){
  if(!tokenUrl||typeof clientId!=="string"||!clientId||typeof clientSecret!=="string"||!clientSecret||
    typeof store?.load!=="function"||typeof store?.save!=="function"||typeof store?.withLock!=="function"||typeof fetchImpl!=="function")throw Error("oauth_provider_config_invalid");
  let inflight=null;
  async function request(fields){
    const body=new URLSearchParams({...fields,client_id:clientId,client_secret:clientSecret});
    const headers={"content-type":"application/x-www-form-urlencoded",accept:"application/json"};
    if(authStyle==="basic"){body.delete("client_id");body.delete("client_secret");headers.authorization=`Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;}
    else if(authStyle!=="body")throw Error("oauth_auth_style_invalid");
    let response;try{response=await fetchImpl(tokenUrl,{method:"POST",headers,body:body.toString()});}catch{throw Error("oauth_token_transport_failed");}
    if(!response?.ok)throw Error(response?.status===401?"oauth_client_auth_failed":`oauth_token_http_${Number(response?.status)||"unknown"}`);
    let result;try{result=await response.json();}catch{throw Error("oauth_token_response_invalid");}
    if(typeof result?.access_token!=="string"||!result.access_token||!Number.isFinite(Number(result.expires_in)))throw Error("oauth_token_response_invalid");
    const previous=await store.load()||{};
    const next={access_token:result.access_token,refresh_token:result.refresh_token||previous.refresh_token||null,
      token_type:result.token_type||"Bearer",expires_at:now()+Number(result.expires_in)*1000,scope:result.scope||previous.scope||null};
    await store.save(next);return next;
  }
  async function getAccessToken(){
    if(inflight)return inflight;
    inflight=(async()=>{
      const current=await store.load();if(current?.access_token&&Number(current.expires_at)>now()+refreshSkewMs)return current.access_token;
      return store.withLock(async()=>{
        // Re-read inside the host's cross-process lock: another scheduled/manual
        // run may have refreshed and rotated the token while this process waited.
        const locked=await store.load();if(locked?.access_token&&Number(locked.expires_at)>now()+refreshSkewMs)return locked.access_token;
        if(!locked?.refresh_token)throw Error("oauth_reauthorization_required");
        return (await request({grant_type:"refresh_token",refresh_token:locked.refresh_token})).access_token;
      });
    })();
    try{return await inflight;}finally{inflight=null;}
  }
  async function exchangeCode({code,redirectUri}){if(typeof code!=="string"||!code||typeof redirectUri!=="string"||!redirectUri)throw Error("oauth_code_exchange_input_invalid");return request({grant_type:"authorization_code",code,redirect_uri:redirectUri});}
  return Object.freeze({getAccessToken,exchangeCode});
}
