import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalSyncMonitor} from '../src/local-monitor.mjs';

test('persistent monitor suppresses repeated incident across restarts and resets on recovery', async () => {
  const dir=mkdtempSync(join(tmpdir(),'sync-monitor-'));
  try {
    const path=join(dir,'events.jsonl'), messages=[];
    const options={path,notify:()=>{},emailNotify:async event=>messages.push(event)};
    let monitor=createLocalSyncMonitor(options);
    const failed={event:'sync_unknown',run_id:'run1',document_type:'quotation',freee_id:'42',reason:'response_lost'};
    await monitor.emit(failed);
    monitor=createLocalSyncMonitor(options);
    await monitor.emit({...failed,run_id:'run2'});
    assert.equal(messages.length,1);
    await monitor.emit({event:'sync_no_change',run_id:'run3',document_type:'quotation',freee_id:'42'});
    await monitor.emit({...failed,run_id:'run4'});
    assert.equal(messages.length,2);
    const log=readFileSync(path,'utf8');
    assert.match(log,/sync_email_sent/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('notification failure is recorded without changing the sync result', async () => {
  const dir=mkdtempSync(join(tmpdir(),'sync-monitor-'));
  try {
    const path=join(dir,'events.jsonl');
    const monitor=createLocalSyncMonitor({path,notify:()=>{},emailNotify:async()=>{throw new Error('smtp_failed');}});
    const record=await monitor.emit({event:'sync_failed',run_id:'run1',reason:'api_error'});
    assert.equal(record.reason,'api_error');
    assert.match(readFileSync(path,'utf8'),/sync_email_failed/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
