import test from 'node:test';
import assert from 'node:assert/strict';
import {taskSummary} from '../dist/modules/navigation.js';
import {createInitial,HISTORY_BATCH} from '../dist/modules/seed.js';
import {applyBatch,taskKey} from '../dist/modules/domain.js';
test('sidebar pending count reflects actual tasks in the viewed snapshot',()=>{const s=createInitial(),tasks={};const expected=s.nodes.reduce((sum,n)=>sum+n.tasks.length,0);assert.deepEqual(taskSummary(s,tasks),{total:expected,completed:0,pending:expected});tasks[taskKey(1,'os',0)]=true;tasks[taskKey(1,'nonexistent',0)]=true;tasks[taskKey(1,'os',999)]=true;assert.deepEqual(taskSummary(s,tasks),{total:expected,completed:1,pending:expected-1});assert.equal(s.nodes.find(n=>n.id==='os').level,2)});
test('historical counts are scoped to that version and newly imported tasks are included',()=>{const v1=createInitial(),v2=applyBatch(v1,HISTORY_BATCH).snapshot,tasks={[taskKey(1,'os',0)]:true,[taskKey(2,'python',0)]:true,[taskKey(2,'fastapi',0)]:true};assert.equal(taskSummary(v1,tasks).completed,1);assert.equal(taskSummary(v2,tasks).completed,2);assert.equal(taskSummary(v2,tasks).total,taskSummary(v1,tasks).total+6)});
