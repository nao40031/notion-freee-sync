import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {resolve,sep} from "node:path";

/** Optional integration hook: initialize a temporary test DB with another
 * compatible writer's exported connect(path) function before candidate tests.
 */
export function bootstrapExistingLedger(dbPath){
  const modulePath=process.env.NFS_EXISTING_LEDGER_BOOTSTRAP;
  if(!modulePath)return false;
  const db=resolve(dbPath),temp=resolve(tmpdir())+sep;
  if(!db.toLowerCase().startsWith(temp.toLowerCase()))throw Error("test_ledger_bootstrap_requires_temporary_database");
  const script='import importlib.util,sys;s=importlib.util.spec_from_file_location("existing_writer",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);c=m.connect(sys.argv[2]);c.close()';
  const result=spawnSync("python",["-X","utf8","-c",script,resolve(modulePath),db],{encoding:"utf8",windowsHide:true,timeout:30000});
  if(result.error||result.status!==0)throw Error("test_existing_ledger_bootstrap_failed");
  return true;
}
