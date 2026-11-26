import {realpath} from "node:fs/promises";
import {isAbsolute,relative,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {runScheduledSync} from "../src/scheduled-runner.mjs";

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
function usage(){process.stderr.write("usage: node scripts/run-configured-sync.mjs --host-module <absolute-path-outside-repository>\n");process.exitCode=2;}

async function main(){
  if(process.argv.length!==4||process.argv[2]!=="--host-module"||!isAbsolute(process.argv[3]))return usage();
  const modulePath=await realpath(process.argv[3]),fromRepo=relative(root,modulePath);
  if(fromRepo===""||(!fromRepo.startsWith("..")&&!isAbsolute(fromRepo))){process.stderr.write("host_module_must_be_outside_repository\n");process.exitCode=2;return;}
  let host;try{host=await import(pathToFileURL(modulePath).href);}catch{process.stderr.write("host_module_load_failed\n");process.exitCode=1;return;}
  if(typeof host.createSyncHost!=="function"){process.stderr.write("host_module_factory_missing\n");process.exitCode=2;return;}
  try{
    const ports=await host.createSyncHost();const result=await runScheduledSync(ports);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }catch(error){
    const summary=error?.runSummary;
    process.stderr.write(`${JSON.stringify(summary||{status:"failed",error_type:"sync_run_failed"})}\n`);process.exitCode=1;
  }
}
await main();
