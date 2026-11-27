import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {policyScopesMatch} from "../src/formal-sync.mjs";

const scope={company_id:7,document_types:["invoice","quotation"],
  header_datasources:["collection://quote-header","collection://invoice-header"],
  line_datasources:["collection://quote-line","collection://invoice-line"],
  actions:["create","update","archive"],header_properties:["Subject","Tax"],
  line_properties:["Quote relation","Invoice relation","Amount"],max_documents:100};
const reordered={...scope,document_types:[...scope.document_types].reverse(),header_datasources:[...scope.header_datasources].reverse(),
  line_datasources:[...scope.line_datasources].reverse(),actions:[...scope.actions].reverse(),
  header_properties:[...scope.header_properties].reverse(),line_properties:[...scope.line_properties].reverse()};
function pythonMatch(actual,expected){
  const py="import importlib.util,json,sys;p=sys.argv[1];s=importlib.util.spec_from_file_location('gate',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);a,e=json.loads(sys.stdin.read());print(json.dumps(m.policy_scopes_match(a,e)))";
  const r=spawnSync("python",["-c",py,"src/formal-sqlite-gate.py"],{cwd:fileURLToPath(new URL("..",import.meta.url)),encoding:"utf8",input:JSON.stringify([actual,expected])});
  assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}

test("JS and Python treat only approved policy arrays as unordered sets",()=>{
  for(const candidate of [scope,reordered]){assert.equal(policyScopesMatch(candidate,scope),true);assert.equal(pythonMatch(candidate,scope),true);}
  const swapped={...scope,header_datasources:["collection://quote-header","collection://wrong-header"]};
  const widened={...scope,line_properties:[...scope.line_properties,"Unexpected"]};
  const duplicate={...scope,actions:[...scope.actions,"update"]};
  const foreignCompany={...scope,company_id:8};
  const unexpectedField={...scope,unreviewed_scope:"extra"};
  const missingField={...scope};delete missingField.max_documents;
  for(const candidate of [swapped,widened,duplicate,foreignCompany,unexpectedField,missingField]){assert.equal(policyScopesMatch(candidate,scope),false);assert.equal(pythonMatch(candidate,scope),false);}
});
