import {createFreeeReadClient,createNotionClient} from "./api-clients.mjs";
import {createFormalRegisteredDocumentLister} from "./formal-inventory.mjs";

function relationIds(page,name){const p=page?.properties?.[name];if(p?.type!=="relation"||p.has_more)throw Error("formal_api_relation_incomplete");return(p.relation||[]).map(x=>String(x.id));}
function encodeProperties(values,config){const inverse=Object.fromEntries(Object.entries(config.notion.propertyMap).map(([logical,name])=>[name,logical]));return Object.fromEntries(Object.entries(values).map(([name,value])=>{
  const date=/^date:(.+):start$/.exec(name);if(date)return[date[1],{date:{start:value==="<set-at-apply-time>"?new Date().toISOString():value}}];
  const logical=inverse[name],type=config.notion.propertyTypes?.[logical];if(!logical||!type)throw Error("formal_api_property_type_mapping_required");
  if(type==="title"||type==="rich_text")return[name,{[type]:value==null?[]:[{type:"text",text:{content:String(value)}}]}];
  if(type==="select"||type==="status")return[name,{[type]:value==null?null:{name:String(value)}}];
  if(type==="number")return[name,{number:value==null?null:Number(value)}];
  throw Error("formal_api_property_type_unsupported");
}));}

/** Bind the registered sync runner to the shared Notion/freee API clients.
 *  Mutation clients are created per operation with an exact temporary scope;
 *  the SQLite gate and plan binder remain the authority for whether a call is
 *  made. Credentials and the active approved policy are supplied by the host.
 */
export function createFormalApiPorts({config,notionTokenProvider,freeeTokenProvider,notionFetch=globalThis.fetch,freeeFetch=globalThis.fetch,notionBaseUrl,freeeBaseUrl,apiVersion=config?.notion?.apiVersion}={}){
  if(!config||typeof notionTokenProvider!=="function"||typeof freeeTokenProvider!=="function")throw Error("formal_api_port_config_invalid");
  const sources=config.notion.documentSources,properties=config.notion.propertyMap,policy=config.policy;
  const readNotion=createNotionClient({tokenProvider:notionTokenProvider,apiVersion,fetchImpl:notionFetch,baseUrl:notionBaseUrl});
  const inventory=createFormalRegisteredDocumentLister({queryDataSource:readNotion.queryDataSource,config});
  const freeeRead=createFreeeReadClient({tokenProvider:freeeTokenProvider,fetchImpl:freeeFetch,baseUrl:freeeBaseUrl});
  const writeClient=({operation,dataSourceId,pageId=null,propertyNames=[]})=>createNotionClient({tokenProvider:notionTokenProvider,apiVersion,fetchImpl:notionFetch,baseUrl:notionBaseUrl,
    writeScope:{enabled:true,operations:[operation],dataSourceIds:[dataSourceId],pageIds:pageId?[pageId]:[],properties:propertyNames,allowCreate:operation==="create_page"}});
  async function readLinePages(documentType,sourceLineId,parentId){
    const datasource=sources[documentType+"Line"],relation=sources[documentType+"Relation"],matches=[];let cursor;
    for(let i=0;i<20;i++){
      const result=await readNotion.queryDataSource(datasource,{page_size:100,...(cursor?{start_cursor:cursor}:{})});
      if(!Array.isArray(result?.results)||typeof result.has_more!=="boolean")throw Error("formal_api_query_invalid");
      for(const page of result.results){const prop=page?.properties?.[properties.lineFreeeId],raw=prop?.[prop?.type];const value=(raw||[]).map(x=>x.plain_text??x.text?.content??"").join("");
        if(page.archived!==true&&value===String(sourceLineId)&&relationIds(page,relation).length===1&&relationIds(page,relation)[0]===String(parentId))matches.push(page);}
      if(!result.has_more)return matches;if(!result.next_cursor)throw Error("formal_api_pagination_cursor_missing");cursor=result.next_cursor;
    }
    throw Error("formal_api_page_limit");
  }
  const notion=Object.freeze({
    queryDataSource:readNotion.queryDataSource,
    getPage:readNotion.getPage,
    listRegisteredDocuments:opts=>inventory.listRegisteredDocuments(opts),
    async updatePage({pageId,datasource,properties:values,approvalProvider}){await approvalProvider.assertApproved({action:"update",page_id:pageId,datasource,properties:values});const properties=encodeProperties(values,config);return writeClient({operation:"update_page",dataSourceId:datasource,pageId,propertyNames:Object.keys(properties)}).updatePage(pageId,{properties},datasource);},
    async createPage({datasource,properties:values,relations,approvalProvider}){const props=encodeProperties(values,config);for(const [name,ids] of Object.entries(relations||{}))props[name]={relation:ids.map(id=>({id:String(id)}))};await approvalProvider.assertApproved({action:"create",datasource,properties:values,relations});return writeClient({operation:"create_page",dataSourceId:datasource,propertyNames:Object.keys(props)}).createPage(datasource,{parent:{data_source_id:datasource},properties:props});},
    async archivePage({pageId,datasource,approvalProvider}){await approvalProvider.assertApproved({action:"archive",page_id:pageId,datasource,properties:{}});return writeClient({operation:"archive_page",dataSourceId:datasource,pageId}).archivePage(pageId,datasource);},
    async findCreateOutcome({requestId,sourceLineId,parentId,documentType}){void requestId;return readLinePages(documentType,sourceLineId,parentId);}
  });
  const freee=Object.freeze({async getDocument({documentType,companyId,documentId}){return freeeRead.getDocument(documentType,companyId,documentId);}});
  return Object.freeze({notion,freee});
}
