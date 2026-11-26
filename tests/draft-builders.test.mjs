import test from "node:test";
import assert from "node:assert/strict";
import {buildFreeeCreatePayload,buildProjectTaskLines} from "../src/draft-builders.mjs";

const draft=(kind="quotation",overrides={})=>({document_key:"draft-a",kind,company_id:"6312345",partner_id:"42",currency:"JPY",subtotal:"150",tax_total:"15",total:"165",lines:[{line_id:"line-a",description:"Consulting",quantity:"1.5",unit_price:"100",amount:"150",tax_amount:"15",tax_rate:"10",unit:"day"}],...overrides});
const common={company_id:"6312345",partner_title:"様",tax_entry_method:"out",tax_fraction:"omit",withholding_tax_entry_method:"out",subject:"Synthetic title"};

test("generic freee payload builder emits a quotation body from normalized draft data",()=>{
 const result=buildFreeeCreatePayload({draft:draft(),generationRequestId:"request-quote-a",metadata:{...common,quotation_date:"2029-02-01",quotation_number:"Q-DEMO"}});
 assert.equal(result.path,"/quotations");assert.equal(result.request_body.quotation_number,"Q-DEMO");assert.equal(result.request_body.lines[0].quantity,1.5);assert.equal(result.request_body.lines[0].unit_price,"100");assert.equal(result.freee_id,null);assert.equal("generation_request_id" in result.request_body,false);
});

test("generic freee payload builder emits invoice dates, tags and no ambiguous partner selector",()=>{
 const invoice=draft("invoice",{partner_id:null,lines:[{line_id:"line-a",description:"Consulting",quantity:"1.5",unit_price:"100",amount:"150",tax_amount:"15",tax_rate:"10",unit:"day",sales_date:"2029-02-01"}]});
 const result=buildFreeeCreatePayload({draft:invoice,generationRequestId:"request-invoice-a",metadata:{...common,partner_code:"PARTNER-DEMO",billing_date:"2029-02-01",payment_date:"2029-03-01",payment_type:"transfer",invoice_line_tag_ids:{"line-a":["7"]}}});
 assert.equal(result.path,"/invoices");assert.equal(result.request_body.partner_code,"PARTNER-DEMO");assert.equal(result.request_body.lines[0].tag_ids[0],7);assert.equal(result.request_body.lines[0].sales_date,"2029-02-01");
});

test("payload builder rejects registered drafts, wrong office and unbalanced totals",()=>{
 assert.throws(()=>buildFreeeCreatePayload({draft:draft("quotation",{freee_id:"42"}),generationRequestId:"request-a",metadata:{...common,quotation_date:"2029-02-01"}}),/draft_registered_or_type_invalid/);
 assert.throws(()=>buildFreeeCreatePayload({draft:draft(),generationRequestId:"request-a",metadata:{...common,company_id:"6312346",quotation_date:"2029-02-01"}}),/draft_company_mismatch/);
 assert.throws(()=>buildFreeeCreatePayload({draft:draft("quotation",{total:"166"}),generationRequestId:"request-a",metadata:{...common,quotation_date:"2029-02-01"}}),/draft_header_totals_mismatch/);
});

test("draft money validation rounds decimal products exactly to cents",()=>{
 const rounded=draft("quotation",{subtotal:"1.01",tax_total:"0",total:"1.01",lines:[{line_id:"line-a",description:"Fractional unit price",quantity:"1",unit_price:"1.005",amount:"1.01",tax_amount:"0",tax_rate:"0"}]});
 const result=buildFreeeCreatePayload({draft:rounded,generationRequestId:"request-rounding",metadata:{...common,quotation_date:"2029-02-01"}});
 assert.equal(result.request_body.lines[0].unit_price,"1.005");
});

test("project task lines use explicit project selection, mapping, linked prices and rounding",()=>{
 const result=buildProjectTaskLines({projectId:"project-a",selectedTaskIds:["task-a"],documentType:"quotation",taxRate:10,lineAmountFraction:"round",tasks:[{id:"task-a",projectRef:["project-a"],priceRef:["price-a"],qty:"1.555",title:"Synthetic work",memo:"scope",unit:"day"}],priceItems:[{id:"price-a",name:"Day rate",unitPrice:"100"}],mapping:{taskProjectRelation:"projectRef",taskPriceRelation:"priceRef",taskQuantity:{quotation:"qty",invoice:"qty"},taskPrice:"unitPrice",priceUnitPrice:"unitPrice",taskTitle:"title",priceTitle:"name",taskMemo:"memo",taskUnit:"unit",taskCheckAmount:"check"}});
 assert.equal(result.lines.length,1);assert.equal(result.lines[0].amount_candidate,"156");assert.equal(result.lines[0].price_item_id,"price-a");assert.equal(result.amount_candidate,"156");
 assert.throws(()=>buildProjectTaskLines({projectId:"project-b",selectedTaskIds:["task-a"],documentType:"invoice",taxRate:10,lineAmountFraction:"round",tasks:[{id:"task-a",projectRef:["project-a"],priceRef:["price-a"],qty:1,title:"x"}],priceItems:[{id:"price-a",unitPrice:100}],mapping:{taskProjectRelation:"projectRef",taskPriceRelation:"priceRef",taskQuantity:{invoice:"qty"},taskPrice:"unitPrice",priceUnitPrice:"unitPrice",taskTitle:"title",priceTitle:"name",taskMemo:"memo",taskUnit:"unit",taskCheckAmount:"check"}}),/project_task_relation_mismatch/);
});
