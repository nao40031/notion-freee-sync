import {createGateLedger} from "./formal-sync.mjs";
import {createFormalApiPorts} from "./formal-api-ports.mjs";
import {runFirstRegistration,reconcileFirstRegistration} from "./first-registration.mjs";

/** Compose the first-registration workflow with the same project-configured
 * API ports and SQLite ledger used by formal registered-document sync. The
 * host remains responsible for approval UI and duplicate preflight. */
export function createFormalRegistrationService({config,configPath,dbPath,notionTokenProvider,freeeTokenProvider,
  notionFetch=globalThis.fetch,freeeFetch=globalThis.fetch,notionBaseUrl,freeeBaseUrl,apiVersion=config?.notion?.apiVersion,
  approvalProvider,preflight,python="python"}={}){
  if(typeof approvalProvider!=="function"||typeof preflight!=="function")throw Error("formal_registration_host_ports_required");
  if(!config?.freee?.companyId||!config?.notion?.documentSources||!config?.policy?.documentTypes||!config?.policy?.allowedProperties)throw Error("formal_registration_project_scope_invalid");
  const api=createFormalApiPorts({config,notionTokenProvider,freeeTokenProvider,notionFetch,freeeFetch,notionBaseUrl,freeeBaseUrl,apiVersion});
  const ledger=createGateLedger({dbPath,configPath,python});
  function assertProjectScope(request){
    const type=request?.document_type,allowedHeader=new Set(config.policy.allowedProperties.header||[]),allowedLine=new Set(config.policy.allowedProperties.line||[]);
    if(String(request?.company_id)!==String(config.freee.companyId)||!config.policy.documentTypes.includes(type)||
      request?.notion_registration?.header?.datasource!==config.notion.documentSources[type]||
      !Array.isArray(request.notion_registration.lines)||request.notion_registration.lines.some(line=>line.datasource!==config.notion.documentSources[type+"Line"])||
      !Array.isArray(request.notion_line_ids)||request.notion_line_ids.length!==request.notion_registration.lines.length||
      Object.keys(request.notion_registration.header.properties||{}).some(key=>!allowedHeader.has(key))||
      request.notion_registration.lines.some(line=>Object.keys(line.properties||{}).some(key=>!allowedLine.has(key)))||
      !config.policy.allowedActions.includes("update"))throw Error("formal_registration_project_scope_mismatch");
    if(new Set([request.notion_header_id,...request.notion_line_ids].map(String)).size!==request.notion_line_ids.length+1)throw Error("formal_registration_duplicate_notion_page");
  }
  return Object.freeze({
    async run(request){
      assertProjectScope(request);
      return runFirstRegistration({request,approvalProvider,preflight,ledger,notion:api.notion,
        freeeGet:args=>api.freee.getDocument(args),
        freeePost:({documentType,body})=>api.freee.createDocument({documentType,companyId:request.company_id,body})});
    },
    reconcile(args){return reconcileFirstRegistration({ledger,...args});},
    ledger
  });
}
