/** Read-only registry extraction for already-linked documents. */
const norm=x=>String(x??"").replace(/^collection:\/\//,"").replaceAll("-","").toLowerCase();
function value(page,name){const p=page?.properties?.[name];if(!p?.type)return null;const x=p[p.type];if(p.type==="title"||p.type==="rich_text")return(x||[]).map(y=>y.plain_text??y.text?.content??"").join("");if(p.type==="select"||p.type==="status")return x?.name??null;if(p.type==="relation"){if(p.has_more)throw Error("formal_inventory_relation_incomplete");return(x||[]).map(y=>y.id);}return x??null;}
async function queryAll(query,id,pageSize,maxPages){const rows=[];let cursor;for(let page=0;page<maxPages;page++){const r=await query(id,{page_size:pageSize,...(cursor?{start_cursor:cursor}:{})});if(!Array.isArray(r?.results)||typeof r.has_more!=="boolean")throw Error("formal_inventory_query_invalid");rows.push(...r.results);if(!r.has_more)return rows;if(!r.next_cursor||rows.length>pageSize*maxPages)throw Error("formal_inventory_pagination_invalid");cursor=r.next_cursor;}throw Error("formal_inventory_page_limit");}

export function createFormalRegisteredDocumentLister({queryDataSource,config,pageSize=100,maxPages=20}={}){
  if(typeof queryDataSource!=="function"||!config?.notion?.documentSources||!config?.policy)throw Error("formal_inventory_config_required");
  const company=String(config.freee.companyId),props=config.notion.propertyMap,types=config.policy.documentTypes,ds=config.notion.documentSources;
  return Object.freeze({async listRegisteredDocuments({companyId=company,documentTypes=types,limit=config.policy.maxDocumentsPerRun}={}){
    if(String(companyId)!==company||!Number.isInteger(limit)||limit<1||limit>config.policy.maxDocumentsPerRun)throw Error("formal_inventory_scope_invalid");
    const all=[];
    for(const type of documentTypes){if(!types.includes(type))throw Error("formal_inventory_type_out_of_scope");const headerDs=ds[type],lineDs=ds[type+"Line"],relation=ds[type+"Relation"];
      const [headers,lines]=await Promise.all([queryAll(queryDataSource,headerDs,pageSize,maxPages),queryAll(queryDataSource,lineDs,pageSize,maxPages)]);
      const scoped=headers.filter(p=>p.archived!==true&&norm(p.parent?.data_source_id)===norm(headerDs)&&value(p,props.companyId)!=null&&String(value(p,props.companyId))===company&&value(p,props.inputState)===config.policy.registeredStateValue&&/^\d+$/.test(String(value(p,props.freeeId)||""))&&Boolean(String(value(p,props.documentNumber)||"")));
      if(scoped.some(p=>value(p,props.documentType)!==type))throw Error("formal_inventory_document_type_mapping_mismatch");
      const registered=scoped;
      const byPage=new Map(),byFreee=new Set();for(const h of registered){const id=value(h,props.freeeId),pageId=String(h.id);if(byPage.has(norm(pageId))||byFreee.has(String(id)))throw Error("formal_inventory_duplicate_registered_identity");byPage.set(norm(pageId),{registered:true,document_type:type,company_id:company,freee_id:String(id),document_number:String(value(h,props.documentNumber)),header_page_id:pageId,line_page_ids:[]});byFreee.add(String(id));}
      for(const line of lines){if(norm(line.parent?.data_source_id)!==norm(lineDs))throw Error("formal_inventory_line_datasource_mismatch");if(line.archived===true)continue;const rel=value(line,relation)||[],targets=rel.map(norm).filter(x=>byPage.has(x));if(!targets.length)continue;if(targets.length!==1||rel.length!==1)throw Error("formal_inventory_line_relation_ambiguous");if(!String(value(line,props.lineFreeeId)||"")||!String(value(line,props.lineTitle)||""))throw Error("formal_inventory_line_identity_invalid");byPage.get(targets[0]).line_page_ids.push(String(line.id));}
      for(const d of byPage.values()){if(!d.line_page_ids.length||new Set(d.line_page_ids.map(norm)).size!==d.line_page_ids.length)throw Error("formal_inventory_lines_missing_or_duplicate");all.push(d);}
    }
    const keys=all.map(d=>`${d.company_id}:${d.document_type}:${d.freee_id}`);if(new Set(keys).size!==keys.length)throw Error("formal_inventory_cross_type_duplicate");if(all.length>limit)throw Error("formal_inventory_limit_exceeded");return all;
  }});
}
