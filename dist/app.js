import {$,$$,hydrateIcons,toast} from './modules/ui.js';
import {applyBatch,recommendedRoute,validateSnapshot} from './modules/domain.js';
import {BATCHES} from './modules/seed.js';
import {loadStore,persist} from './modules/storage.js';
import {createGraph} from './modules/graph.js';
import {renderNode,renderSync,renderHistory,renderGoal,taskKey} from './modules/panels.js';

const store=loadStore();
const ui={panel:null,selected:null,tab:'book',query:'',project:'all',level:'all',highlight:false,version:null,batch:'history',syncStep:'choose',ackConflict:false,mentor:{}};
const snapshot=()=>ui.version===null?store.snapshots.at(-1):store.snapshots.find(v=>v.version===ui.version);
const graph=createGraph(selectNode);
let sourceReturnFocus=null;
function save(){if(!persist(store))toast('浏览器未允许保存，当前会话仍可继续探索。')}
function render(){
 const s=snapshot();graph.render(s,ui);
 $('#version-pill').textContent='v'+s.version;
 $('#goal-label').textContent=store.target==='ai'?'构建可靠的 AI 应用':'独立交付一个后端项目';
 const next=recommendedRoute(s,store.target)[0];$('#next-label').textContent=next?`下一步：${next.title}。${next.layer===1?'先夯实基础，再进入项目实践。':'补齐前置理解，再完成一次可核对的实践。'}`:'当前路径的示例证据已齐备，可以回到项目检验。';
 $('#history-banner').hidden=ui.version===null;
 $('#history-banner-text').textContent=`正在查看 v${s.version} 历史快照 · 只读`;
 const p=$('#side-panel');p.hidden=!ui.panel;
 if(ui.panel==='node'){const n=s.nodes.find(n=>n.id===ui.selected);if(n)p.innerHTML=renderNode(n,s,ui,store);else{ui.panel=null;ui.selected=null;p.hidden=true}}
 if(ui.panel==='sync')p.innerHTML=renderSync(s,ui);
 if(ui.panel==='history')p.innerHTML=renderHistory(store,ui);
 if(ui.panel==='goal')p.innerHTML=renderGoal(s,store);
}
function selectNode(id,tab='book'){if(!snapshot().nodes.some(n=>n.id===id))return;ui.selected=id;ui.panel='node';ui.tab=tab;render();graph.center(snapshot().nodes.find(n=>n.id===id))}
function openPanel(panel){ui.panel=panel;if(panel==='sync'){if(ui.version!==null){toast('请返回当前路线后再同步资料。');ui.panel='history'}ui.syncStep='choose';ui.ackConflict=false}render()}
function showSource(source){if(!source)return;sourceReturnFocus=document.activeElement;$('#source-title').textContent=source.title;$('#source-meta').textContent=`${source.type} · ${source.date} · ${source.locator} · 虚构示例`;$('#source-text').textContent=source.text;$('#source-modal').hidden=false;$('[data-action="close-source"]').focus()}
function closeSource(){$('#source-modal').hidden=true;if(sourceReturnFocus?.isConnected)sourceReturnFocus.focus()}
function latest(){ui.version=null;ui.selected=null;ui.highlight=false;ui.panel=null;clearFilters();render();graph.fit()}
function clearFilters(){ui.query='';ui.project='all';ui.level='all';$('#search').value='';$('#project-filter').value='all';$('#level-filter').value='all'}
function merge(){if(ui.version!==null)return;const previous=snapshot(),batch=BATCHES[ui.batch];try{const result=applyBatch(previous,batch,{ackConflict:ui.ackConflict});if(!result.changed){toast('该批次已经同步，没有重复创建。');return}validateSnapshot(result.snapshot);for(const [key,value] of Object.entries(store.tasks)){if(key.startsWith(`v${previous.version}:`))store.tasks[key.replace(`v${previous.version}:`,`v${result.snapshot.version}:`)]=value}store.snapshots.push(result.snapshot);save();ui.selected=null;ui.highlight=false;render();graph.fit();toast(`已保存为 v${result.snapshot.version}，旧路线与原始资料仍保留。`)}catch(e){toast(e.message)}}

document.addEventListener('click',e=>{
 const source=e.target.closest('[data-source]');if(source){showSource(snapshot().sources.find(s=>s.id===source.dataset.source));return}
 const batchSource=e.target.closest('[data-batch-source]');if(batchSource){showSource(BATCHES[ui.batch].sources.find(s=>s.id===batchSource.dataset.batchSource));return}
 const node=e.target.closest('#side-panel [data-node]');if(node){selectNode(node.dataset.node,node.dataset.nodeTab||'book');return}
 const tab=e.target.closest('[data-tab]');if(tab){ui.tab=tab.dataset.tab;render();$('#tab-'+ui.tab).focus();return}
 const batch=e.target.closest('[data-batch]');if(batch){ui.batch=batch.dataset.batch;ui.syncStep='choose';ui.ackConflict=false;render();return}
 const version=e.target.closest('[data-version]');if(version){const v=Number(version.dataset.version);ui.version=v===store.snapshots.at(-1).version?null:v;ui.selected=null;ui.highlight=false;clearFilters();render();graph.fit();return}
 const mentor=e.target.closest('[data-mentor]');if(mentor){ui.mentor[ui.selected]=mentor.dataset.mentor;render();return}
 const answer=e.target.closest('[data-answer]');if(answer&&ui.version===null){store.answers[taskKey(snapshot().version,ui.selected,'quiz')]=Number(answer.dataset.answer);save();render();return}
 const action=e.target.closest('[data-action]')?.dataset.action;if(!action)return;
 if(['sync','history','goal'].includes(action))openPanel(action);
 if(action==='home'){ui.panel=null;ui.selected=null;ui.highlight=false;clearFilters();render();graph.fit()}
 if(action==='close-panel'){ui.panel=null;render();graph.fit()}
 if(action==='close-source')closeSource();
 if(action==='highlight'){ui.highlight=!ui.highlight;clearFilters();render();graph.fit();if(innerWidth<760){ui.panel=null;render()}toast(ui.highlight?'已高亮当前节点的前置路径。':'已恢复全部依赖关系。')}
 if(action==='zoom-in')graph.zoom(.1);if(action==='zoom-out')graph.zoom(-.1);if(action==='fit')graph.fit();
 if(action==='clear-filters'){clearFilters();render();graph.fit()}
 if(action==='preview-batch'){ui.syncStep='review';render()}
 if(action==='sync-back'){ui.syncStep='choose';ui.ackConflict=false;render()}
 if(action==='apply-batch')merge();if(action==='latest')latest();
});
document.addEventListener('change',e=>{
 if(e.target.id==='project-filter'){ui.project=e.target.value;ui.highlight=false;render();graph.fit()}
 if(e.target.id==='level-filter'){ui.level=e.target.value;ui.highlight=false;render()}
 if(e.target.id==='goal-select'){store.target=e.target.value;save();render()}
 if(e.target.id==='conflict-ack'){ui.ackConflict=e.target.checked;const apply=$('[data-action="apply-batch"]');if(apply)apply.disabled=!ui.ackConflict}
 if(e.target.matches('[data-task]')&&ui.version===null){store.tasks[taskKey(snapshot().version,ui.selected,e.target.dataset.task)]=e.target.checked;save();toast('练习进度已记录；能力等级保持原有证据判断。')}
});
$('#search').addEventListener('input',e=>{ui.query=e.target.value.trim().toLowerCase();ui.highlight=false;render()});
$('.mark').addEventListener('click',e=>{e.preventDefault();$('[data-action="home"]').click()});
$('#source-modal').addEventListener('click',e=>{if(e.target.id==='source-modal')closeSource()});
document.addEventListener('keydown',e=>{if(!$('#source-modal').hidden){if(e.key==='Escape')closeSource();if(e.key==='Tab'){e.preventDefault();$('[data-action="close-source"]').focus()}}else if(e.key==='Escape'&&ui.panel){ui.panel=null;render();graph.fit()}});
hydrateIcons();validateSnapshot(snapshot());render();requestAnimationFrame(()=>graph.fit());
