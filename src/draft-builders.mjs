/** Pure draft mapping for project-configured quotation and invoice workflows.
 * No API, approval, database, or Notion writes are performed here.
 */
const fail=(code)=>{throw Object.assign(new Error(code),{code});};
const dec=(value,key)=>{const raw=String(value??"");if(!/^-?\d+(?:\.\d+)?$/.test(raw))fail(`draft_decimal_invalid:${key}`);const n=Number(raw);if(!Number.isFinite(n))fail(`draft_decimal_invalid:${key}`);return n;};
const SCALE=10n**6n;
function micros(value,key){const raw=String(value??"");const match=/^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);if(!match||(match[3]||"").length>6)fail(`draft_decimal_invalid:${key}`);const fraction=(match[3]||"").padEnd(6,"0");return BigInt(`${match[1]}${match[2]}`)*SCALE+BigInt(`${match[1]}${fraction||"0"}`);}
function roundMicros(value,unit){const divisor=unit;const abs=value<0n?-value:value;const rounded=(abs+divisor/2n)/divisor;return value<0n?-rounded:rounded;}
const cents=(value,key)=>{const result=roundMicros(micros(value,key),10n**4n);if(result>BigInt(Number.MAX_SAFE_INTEGER)||result<BigInt(Number.MIN_SAFE_INTEGER))fail(`draft_money_invalid:${key}`);return Number(result);};
const productCents=(a,b,key)=>{const product=micros(a,`${key}:quantity`)*micros(b,`${key}:unit_price`);const result=roundMicros(product,10n**10n);if(result>BigInt(Number.MAX_SAFE_INTEGER)||result<BigInt(Number.MIN_SAFE_INTEGER))fail(`draft_money_invalid:${key}`);return Number(result);};
const money=value=>Number((value/100).toFixed(2));
function required(value,key){if(value===undefined||value===null||value==="")fail(`draft_required:${key}`);return value;}
function positiveId(value,key){if(!/^\d+$/.test(String(value??""))||BigInt(value)<=0n)fail(`draft_id_invalid:${key}`);return Number(value);}
function date(value,key){const raw=String(value??"");if(!/^\d{4}-\d{2}-\d{2}$/.test(raw)||new Date(`${raw}T00:00:00Z`).toISOString().slice(0,10)!==raw)fail(`draft_date_invalid:${key}`);return raw;}
function validateDraft(draft){
  if(!draft||!['quotation','invoice'].includes(draft.kind)||draft.freee_id)fail("draft_registered_or_type_invalid");
  if(!String(draft.document_key||"").trim()||!String(draft.currency||"").trim()||!Array.isArray(draft.lines)||!draft.lines.length)fail("draft_identity_or_lines_missing");
  const company=positiveId(draft.company_id,"company_id");
  let net=0,tax=0;const seen=new Set();
  for(const line of draft.lines){
    const id=String(line.line_id||"");if(!id||seen.has(id)||!String(line.description||"").trim())fail("draft_line_identity_invalid");seen.add(id);
    const q=dec(line.quantity,"quantity"),p=dec(line.unit_price,"unit_price");if(q<=0||p<0||productCents(line.quantity,line.unit_price,"line_amount")!==cents(line.amount,"amount"))fail("draft_line_amount_mismatch");
    if(![0,8,10].includes(Number(line.tax_rate))||dec(line.tax_amount,"tax_amount")<0)fail("draft_line_tax_invalid");
    net+=cents(line.amount,"amount");tax+=cents(line.tax_amount,"tax_amount");
  }
  if(net!==cents(draft.subtotal,"subtotal")||tax!==cents(draft.tax_total,"tax_total")||net+tax!==cents(draft.total,"total"))fail("draft_header_totals_mismatch");
  return company;
}

/** Build the freee POST body and an inspectable envelope from normalized draft data. */
export function buildFreeeCreatePayload({draft,generationRequestId,metadata={}}={}){
  const companyId=validateDraft(draft);if(!String(generationRequestId||"").trim())fail("draft_generation_request_id_required");
  const metaCompany=positiveId(required(metadata.company_id,"company_id"),"company_id");if(metaCompany!==companyId)fail("draft_company_mismatch");
  if(metadata.partner_id!==undefined&&metadata.partner_id!==null&&metadata.partner_id!==""&&metadata.partner_code)fail("draft_partner_selector_ambiguous");
  const body={company_id:companyId,tax_entry_method:required(metadata.tax_entry_method,"tax_entry_method"),tax_fraction:required(metadata.tax_fraction,"tax_fraction"),withholding_tax_entry_method:required(metadata.withholding_tax_entry_method,"withholding_tax_entry_method"),partner_title:required(metadata.partner_title,"partner_title")};
  if(!['in','out'].includes(body.tax_entry_method)||!['omit','round_up','round'].includes(body.tax_fraction)||!['in','out'].includes(body.withholding_tax_entry_method)||!['御中','様','(空白)','（空白）'].includes(body.partner_title))fail("draft_accounting_option_invalid");
  if(metadata.template_id!==undefined&&metadata.template_id!==null&&metadata.template_id!=="")body.template_id=positiveId(metadata.template_id,"template_id");
  for(const key of ['company_contact_name','company_name'])if(Object.hasOwn(metadata,key))body[key]=String(metadata[key]??"");
  const partnerId=metadata.partner_id??draft.partner_id;
  if(metadata.partner_id!==undefined&&metadata.partner_id!==null&&metadata.partner_id!=="")body.partner_id=positiveId(metadata.partner_id,"partner_id");
  else if(metadata.partner_code)body.partner_code=String(metadata.partner_code);
  else if(partnerId!==undefined&&partnerId!==null&&partnerId!=="")body.partner_id=positiveId(partnerId,"partner_id");
  else fail("draft_partner_required");
  for(const key of ['subject','memo'])if(metadata[key]!==undefined&&metadata[key]!==null)body[key]=String(metadata[key]);
  if(metadata.line_amount_fraction!==undefined&&metadata.line_amount_fraction!==null){if(!['omit','round_up','round'].includes(metadata.line_amount_fraction))fail("draft_line_fraction_invalid");body.line_amount_fraction=metadata.line_amount_fraction;}
  body.lines=draft.lines.map(line=>{
    const taxRate=Number(line.tax_rate),reduced=Boolean(line.reduced_tax_rate),withholding=Boolean(line.withholding);
    if(reduced&&taxRate!==8)fail("draft_reduced_tax_rate_invalid");
    const out={type:'item',description:String(line.description),quantity:dec(line.quantity,"quantity"),unit_price:String(line.unit_price),tax_rate:taxRate,reduced_tax_rate:reduced,withholding};
    if(line.unit)out.unit=String(line.unit);
    if(draft.kind==='invoice'&&line.sales_date)out.sales_date=date(line.sales_date,"sales_date");
    if(draft.kind==='invoice'&&metadata.invoice_line_tag_ids?.[line.line_id])out.tag_ids=metadata.invoice_line_tag_ids[line.line_id].map(x=>positiveId(x,"tag_id"));
    return out;
  });
  let path;
  if(draft.kind==='invoice'){
    body.billing_date=date(required(metadata.billing_date,"billing_date"),"billing_date");
    if(metadata.invoice_number)body.invoice_number=String(metadata.invoice_number);
    for(const key of ['issue_date','payment_date'])if(metadata[key])body[key]=date(metadata[key],key);
    for(const key of ['payment_type','invoice_note'])if(metadata[key]!==undefined&&metadata[key]!==null)body[key]=metadata[key];
    if(body.payment_type!==undefined&&!['transfer','direct_debit','card'].includes(body.payment_type))fail("draft_payment_type_invalid");path='/invoices';
  }else{
    body.quotation_date=date(required(metadata.quotation_date,"quotation_date"),"quotation_date");
    if(metadata.quotation_number)body.quotation_number=String(metadata.quotation_number);
    if(metadata.expiration_date)body.expiration_date=date(metadata.expiration_date,"expiration_date");
    if(metadata.delivery_deadline)body.delivery_deadline=String(metadata.delivery_deadline);
    for(const key of ['delivery_location','quotation_note'])if(metadata[key]!==undefined&&metadata[key]!==null)body[key]=metadata[key];path='/quotations';
  }
  return Object.freeze({operation:'dry_run_create',service:'freee',method:'POST',path,document_type:draft.kind,company_id:companyId,partner_id:body.partner_id??null,partner_code:body.partner_code??null,generation_request_id:String(generationRequestId),freee_id:null,request_body:body,idempotency_note:'request identity is enforced by the local ledger, not sent as a freee API idempotency key'});
}

function relationIds(value){if(value==null||value==="")return[];const raw=Array.isArray(value)?value:[value];return raw.map(x=>String(typeof x==='object'?(x.id??x.url??""):x).trim().replace(/\/$/,"").split(/[\/#]/).at(-1)).filter(Boolean);}
function roundProductToUnit(qty,unitPrice,mode){if(!['omit','round','round_up'].includes(mode))fail("task_line_rounding_required");const product=micros(qty,"task_quantity")*micros(unitPrice,"price_unit"),denominator=SCALE*SCALE,sign=product<0n?-1n:1n,abs=product<0n?-product:product,whole=abs/denominator,remainder=abs%denominator;const rounded=mode==='omit'?whole:mode==='round_up'?(remainder?whole+1n:whole):(remainder*2n>=denominator?whole+1n:whole);const result=sign*rounded;if(result>BigInt(Number.MAX_SAFE_INTEGER)||result<BigInt(Number.MIN_SAFE_INTEGER))fail("project_task_amount_invalid");return Number(result);}

/** Map explicitly selected project tasks and their linked price items to draft lines. */
export function buildProjectTaskLines({projectId,selectedTaskIds,tasks,priceItems,documentType,taxRate,lineAmountFraction,reducedTaxRate=false,withholding=false,mapping}={}){
  const m=mapping;if(!m||!['quotation','invoice'].includes(documentType)||!Array.isArray(selectedTaskIds)||!Array.isArray(tasks)||!Array.isArray(priceItems))fail("project_task_mapping_invalid");
  const project=String(projectId||"").trim(),selected=selectedTaskIds.map(String);if(!project||!selected.length||selected.some(x=>!x)||new Set(selected).size!==selected.length)fail("project_task_selection_invalid");
  if(![0,8,10].includes(Number(taxRate))||reducedTaxRate&&Number(taxRate)!==8)fail("project_task_tax_invalid");
  const fields={projectRelation:m.taskProjectRelation,priceRelation:m.taskPriceRelation,taskQuantity:m.taskQuantity?.[documentType],taskPrice:m.taskPrice,priceUnitPrice:m.priceUnitPrice,taskTitle:m.taskTitle,priceTitle:m.priceTitle,taskMemo:m.taskMemo,taskUnit:m.taskUnit,taskCheckAmount:m.taskCheckAmount};
  if(Object.values(fields).some(x=>!x))fail("project_task_mapping_incomplete");
  const taskMap=new Map(tasks.map(x=>[String(x.id),x])),priceMap=new Map(priceItems.map(x=>[String(x.id),x]));if(taskMap.size!==tasks.length||priceMap.size!==priceItems.length)fail("project_task_duplicate_identity");
  const lines=[];let exactTotal=0,candidateTotal=0;
  for(const taskId of selected){const task=taskMap.get(taskId);if(!task)fail("project_task_not_found");if(relationIds(task[fields.projectRelation]).join('|')!==project)fail("project_task_relation_mismatch");
    const ids=relationIds(task[fields.priceRelation]);if(ids.length!==1)fail("project_task_price_relation_ambiguous");const price=priceMap.get(ids[0]);if(!price)fail("project_task_price_missing");
    const quantity=dec(task[fields.taskQuantity],"task_quantity"),unitPrice=dec(price[fields.priceUnitPrice],"price_unit");if(quantity<=0||unitPrice<0)fail("project_task_amount_invalid");
    if(task[fields.taskPrice]!==undefined&&task[fields.taskPrice]!==null&&task[fields.taskPrice]!==""&&dec(task[fields.taskPrice],"task_price")!==unitPrice)fail("project_task_price_conflict");
    const exactProduct=micros(task[fields.taskQuantity],"task_quantity")*micros(price[fields.priceUnitPrice],"price_unit"),amount=roundProductToUnit(task[fields.taskQuantity],price[fields.priceUnitPrice],lineAmountFraction),exact=Number(exactProduct)/Number(SCALE*SCALE),title=String(task[fields.taskTitle]||"").trim();if(!title)fail("project_task_title_missing");
    if(task[fields.taskCheckAmount]!==undefined&&task[fields.taskCheckAmount]!==null&&task[fields.taskCheckAmount]!==""){const check=micros(task[fields.taskCheckAmount],"task_check_amount");if(check*SCALE!==exactProduct&&check!==BigInt(amount)*SCALE)fail("project_task_formula_amount_conflict");}
    lines.push({draft_line_id:taskId,source_task_id:taskId,price_item_id:ids[0],price_item_title:String(price[fields.priceTitle]||""),description:title,memo:String(task[fields.taskMemo]||"").trim(),quantity:String(quantity),unit_price:String(unitPrice),amount_exact:String(exact),amount_candidate:String(amount),tax_rate:Number(taxRate),reduced_tax_rate:Boolean(reducedTaxRate),withholding:Boolean(withholding),unit:task[fields.taskUnit]||null});exactTotal+=exact;candidateTotal+=amount;
  }
  return Object.freeze({document_type:documentType,project_id:project,lines,amount_exact:String(exactTotal),amount_candidate:String(candidateTotal),tax_rate:Number(taxRate),line_amount_fraction:lineAmountFraction});
}
