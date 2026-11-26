import test from 'node:test';
import assert from 'node:assert/strict';
import {createFormalApiPorts} from '../src/formal-api-ports.mjs';

const config={freee:{companyId:'12345'},notion:{apiVersion:'2026-03-11',documentSources:{quotation:'q',quotationLine:'ql',quotationRelation:'Quotation',invoice:'i',invoiceLine:'il',invoiceRelation:'Invoice'},propertyMap:{},propertyTypes:{}},policy:{documentTypes:['quotation','invoice'],maxDocumentsPerRun:20}};
const response=value=>({ok:true,status:200,json:async()=>structuredClone(value)});

test('formal API ports normalize official freee quotation and invoice envelopes',async()=>{
  const doc={id:'9001',company_id:'12345',lines:[]},seen=[];
  const ports=createFormalApiPorts({config,notionTokenProvider:async()=>'fixture',freeeTokenProvider:async()=>'fixture',
    notionFetch:async()=>response({results:[],has_more:false}),
    freeeFetch:async(url,init)=>{seen.push({url:String(url),method:init.method});return response(String(url).includes('/quotations/')?{quotation:doc}:{invoice:doc});}});
  assert.deepEqual(await ports.freee.getDocument({documentType:'quotation',companyId:'12345',documentId:'9001'}),doc);
  assert.deepEqual(await ports.freee.getDocument({documentType:'invoice',companyId:'12345',documentId:'9001'}),doc);
  assert.equal(seen.length,2);assert.ok(seen.every(x=>x.method==='GET'));
});
