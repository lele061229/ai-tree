import {$,$$,esc,hydrateIcons,toast} from './modules/ui.js';
import {applyBatch,recommendedRoute,validateSnapshot} from './modules/domain.js';
import {BATCHES} from './modules/seed.js';
import {loadStore,persist} from './modules/storage.js';
import {platform,request,savePreferences,saveTask} from './modules/server-api.js';
import {realSync,realGoal} from './modules/server-ui.js';
import {installServerActions} from './modules/server-controller.js';
import {createGraph} from './modules/graph.js';
import {renderNode,renderSync,renderHistory,renderGoal,taskKey} from './modules/panels.js';
import {updateNavigation,renderTaskQueue,renderProjectIndex} from './modules/navigation.js';

const store=await loadStore().catch(e=>{document.body.innerHTML='<section class="login-card"><h1>暂时无法打开知识空间</h1><p id="startup-error"></p><a href="/">重新加载</a></section>';document.querySelector('#startup-error').textContent=e.message;throw e});
const ui={panel:null,selected:null,tab:'book',query:'',project:'all',level:'all',highlight:false,version:null,batch:'history',syncStep:'choose',ackConflict:false,mentor:{},taskScope:'pending',mode:store.mode,serverBusy:false,serverSources:[],sourceTitle:'',sourceBody:'',syncTab:'skill',newToken:null};
let syncApi=null;
const snapshot=()=>ui.version===null?store.snapshots.at(-1):store.snapshots.find(v=>v.version===ui.version);
const graph=createGraph(selectNode);
let sourceReturnFocus=null;
async function save(){try{if(platform.enabled){await savePreferences(store);return true}if(!persist(store))throw Error('浏览器未允许保存，当前会话仍可继续探索。');return true}catch(e){toast(e.message);return false}}
function render(){
 const s=snapshot();if(platform.enabled){$('#project-filter').innerHTML='<option value="all">全部项目</option>'+s.nodes.filter(n=>n.kind==='project').map(n=>`<option value="${n.id}">${esc(n.title)}</option>`).join('');$('#project-filter').value=ui.project}graph.render(s,ui);
 $('#version-pill').textContent='v'+s.version;
 $('#goal-label').textContent=platform.enabled?store.goalText:store.target==='ai'?'构建可靠的 AI 应用':'独立交付一个后端项目';
 const next=recommendedRoute(s,store.target)[0];$('#next-label').textContent=next?`下一步：${next.title}。${next.layer===1?'先夯实基础，再进入项目实践。':'补齐前置理解，再完成一次可核对的实践。'}`:(platform.enabled?'从一份真实资料开始，建立你的个人能力树。':'当前路径的示例证据已齐备，可以回到项目检验。');
 $('#history-banner').hidden=ui.version===null;
 $('#history-banner-text').textContent=`正在查看 v${s.version} 历史快照 · 只读`;
 const p=$('#side-panel');p.hidden=!ui.panel;
 if(ui.panel==='node'){const n=s.nodes.find(n=>n.id===ui.selected);if(n)p.innerHTML=renderNode(n,s,ui,store);else{ui.panel=null;ui.selected=null;p.hidden=true}}
 if(ui.panel==='sync')p.innerHTML=platform.enabled?realSync(ui):renderSync(s,ui);
 if(ui.panel==='history')p.innerHTML=renderHistory(store,ui);
 if(ui.panel==='goal')p.innerHTML=platform.enabled?realGoal(s,store):renderGoal(s,store);
 if(ui.panel==='tasks')p.innerHTML=renderTaskQueue(s,ui,store);
 if(ui.panel==='projects')p.innerHTML=renderProjectIndex(s,store.mode);
 updateNavigation(s,ui,store);
}
function selectNode(id,tab='book'){if(!snapshot().nodes.some(n=>n.id===id))return;ui.selected=id;ui.panel='node';ui.tab=tab;store.recents=[id,...(store.recents||['cicd','api']).filter(v=>v!==id)].slice(0,3);save();closeNavigation();render();graph.center(snapshot().nodes.find(n=>n.id===id))}
function openPanel(panel){closeNavigation();ui.panel=panel;if(panel==='sync'){if(ui.version!==null){toast('请返回当前路线后再同步资料。');ui.panel='history'}ui.syncStep='choose';ui.ackConflict=false;ui.serverError=''}render();if(panel==='sync'&&syncApi)syncApi.loadSync()}
function closeNavigation(){document.body.classList.remove('mobile-navigation-open');$('.sidebar-backdrop').hidden=true;$('.mobile-menu').setAttribute('aria-expanded','false')}
function toggleNavigation(){if(innerWidth<=760){const open=!document.body.classList.contains('mobile-navigation-open');document.body.classList.toggle('mobile-navigation-open',open);$('.sidebar-backdrop').hidden=!open;$('.mobile-menu').setAttribute('aria-expanded',String(open));if(open)$('.collapse-button').focus();return}store.navigationCollapsed=!store.navigationCollapsed;save();updateNavigation(snapshot(),ui,store);requestAnimationFrame(()=>graph.fit())}
function showSource(source){if(!source)return;sourceReturnFocus=document.activeElement;$('#source-title').textContent=source.title;$('#source-meta').textContent=`${source.type} · ${source.date} · ${source.locator} · ${source.fictional?'虚构示例':'原始资料'}`;$('#source-text').textContent=source.text;$('.source-note').textContent=(source.fictional?'虚构原始资料':'用户授权导入的原始资料')+' · 路线更新不会覆盖这段内容。';$('#source-modal').hidden=false;$('[data-action="close-source"]').focus()}
function closeSource(){$('#source-modal').hidden=true;if(sourceReturnFocus?.isConnected)sourceReturnFocus.focus()}
function latest(){ui.version=null;ui.selected=null;ui.highlight=false;ui.panel=null;clearFilters();render();graph.fit()}
function clearFilters(){ui.query='';ui.project='all';ui.level='all';$('#search').value='';$('#project-filter').value='all';$('#level-filter').value='all'}
function merge(){if(platform.enabled||ui.version!==null)return;const previous=snapshot(),batch=BATCHES[ui.batch];try{const result=applyBatch(previous,batch,{ackConflict:ui.ackConflict});if(!result.changed){toast('该批次已经同步，没有重复创建。');return}validateSnapshot(result.snapshot);for(const [key,value] of Object.entries(store.tasks)){if(key.startsWith(`v${previous.version}:`))store.tasks[key.replace(`v${previous.version}:`,`v${result.snapshot.version}:`)]=value}store.snapshots.push(result.snapshot);save();ui.selected=null;ui.highlight=false;render();graph.fit();toast(`已保存为 v${result.snapshot.version}，旧路线与原始资料仍保留。`)}catch(e){toast(e.message)}}

document.addEventListener('click',e=>{
 const source=e.target.closest('[data-source]');if(source){showSource(snapshot().sources.find(s=>s.id===source.dataset.source));return}
 const batchSource=e.target.closest('[data-batch-source]');if(batchSource){showSource(BATCHES[ui.batch].sources.find(s=>s.id===batchSource.dataset.batchSource));return}
 const node=e.target.closest('#side-panel [data-node], #sidebar [data-node]');if(node){selectNode(node.dataset.node,node.dataset.nodeTab||'book');return}
 const scope=e.target.closest('[data-task-scope]');if(scope){ui.taskScope=scope.dataset.taskScope;render();return}
 const tab=e.target.closest('[data-tab]');if(tab){ui.tab=tab.dataset.tab;render();$('#tab-'+ui.tab).focus();return}
 const batch=e.target.closest('[data-batch]');if(batch){ui.batch=batch.dataset.batch;ui.syncStep='choose';ui.ackConflict=false;render();return}
 const syncTab=e.target.closest('[data-sync-tab]');if(syncTab){ui.syncTab=syncTab.dataset.syncTab;ui.serverError='';render();return}
 const version=e.target.closest('[data-version]');if(version){const v=Number(version.dataset.version);ui.version=v===store.snapshots.at(-1).version?null:v;ui.selected=null;ui.highlight=false;clearFilters();render();graph.fit();return}
 const mentor=e.target.closest('[data-mentor]');if(mentor){ui.mentor[ui.selected]=mentor.dataset.mentor;render();return}
 const answer=e.target.closest('[data-answer]');if(answer&&ui.version===null){store.answers[taskKey(snapshot().version,ui.selected,'quiz')]=Number(answer.dataset.answer);save();render();return}
 const action=e.target.closest('[data-action]')?.dataset.action;if(!action)return;
 const syncPath=e.target.closest('[data-sync-path]')?.dataset.syncPath;if(syncPath)ui.syncTab=syncPath;
 if(['sync','history','goal','tasks','projects'].includes(action))openPanel(action);
 if(action==='home'){closeNavigation();ui.panel=null;ui.selected=null;ui.highlight=false;clearFilters();render();graph.fit()}
 if(action==='toggle-navigation')toggleNavigation();if(action==='close-navigation')closeNavigation();
 if(action==='close-panel'){ui.panel=null;render();graph.fit()}
 if(action==='close-source')closeSource();
 if(action==='highlight'){ui.highlight=!ui.highlight;clearFilters();render();graph.fit();if(innerWidth<760){ui.panel=null;render()}toast(ui.highlight?'已高亮当前节点的前置路径。':'已恢复全部依赖关系。')}
 if(action==='zoom-in')graph.zoom(.1);if(action==='zoom-out')graph.zoom(-.1);if(action==='fit')graph.fit();
 if(action==='clear-filters'){clearFilters();render();graph.fit()}
 if(action==='preview-batch'){ui.syncStep='review';render()}
 if(action==='sync-back'){ui.syncStep='choose';ui.ackConflict=false;render()}
 if(action==='apply-batch')merge();if(action==='latest')latest();
});
document.addEventListener('change',async e=>{
 if(e.target.id==='project-filter'){ui.project=e.target.value;ui.highlight=false;render();graph.fit()}
 if(e.target.id==='level-filter'){ui.level=e.target.value;ui.highlight=false;render()}
 if(e.target.id==='goal-select'&&!platform.enabled){store.target=e.target.value;save();render()}
 if(e.target.id==='conflict-ack'){ui.ackConflict=e.target.checked;const apply=$('[data-action="apply-batch"]');if(apply)apply.disabled=!ui.ackConflict}
 if(e.target.matches('[data-task]')&&ui.version===null){const id=e.target.dataset.taskNode||ui.selected,key=taskKey(snapshot().version,id,e.target.dataset.task),checked=e.target.checked;try{if(platform.enabled){e.target.disabled=true;await saveTask(snapshot().version,id,e.target.dataset.task,checked)}store.tasks[key]=checked;if(!platform.enabled)save();if(ui.panel==='tasks')render();else updateNavigation(snapshot(),ui,store);toast('练习进度已记录；能力等级保持原有证据判断。')}catch(error){e.target.checked=!checked;toast(error.message)}finally{e.target.disabled=false}}
});
$('#search').addEventListener('input',e=>{ui.query=e.target.value.trim().toLowerCase();ui.highlight=false;render()});
$('.brand-home').addEventListener('click',e=>{e.preventDefault();$('[data-action="home"]').click()});
$('#source-modal').addEventListener('click',e=>{if(e.target.id==='source-modal')closeSource()});
document.addEventListener('keydown',e=>{if(!$('#source-modal').hidden){if(e.key==='Escape')closeSource();if(e.key==='Tab'){e.preventDefault();$('[data-action="close-source"]').focus()}}else if(e.key==='Escape'&&document.body.classList.contains('mobile-navigation-open')){closeNavigation();$('.mobile-menu').focus()}else if(e.key==='Escape'&&ui.panel){ui.panel=null;render();graph.fit()}});
hydrateIcons();validateSnapshot(snapshot());render();requestAnimationFrame(()=>graph.fit());
if(platform.enabled){document.querySelector('.demo-tag').textContent='个人知识空间';document.querySelector('.sidebar-workspace>span').textContent='本机数据';document.querySelector('.context-meta').textContent='仅登录可见 · 数据保存在本机';document.querySelector('.prototype-note').textContent='私人平台 · 智能体同步可用'+(platform.aiReady?' · 模型接口已配置':' · 模型接口未配置（只影响平台分析与导师）');document.querySelector('#build-entry').hidden=false;document.querySelector('.sidebar-profile .avatar').textContent=platform.user.slice(0,1);document.querySelector('.profile-label').textContent=platform.user+'的知识空间';const logout=document.createElement('button');logout.className='text-button';logout.textContent='退出';logout.addEventListener('click',async()=>{try{await request('/logout',{method:'POST'});location.assign('/login')}catch(e){toast(e.message)}});document.querySelector('.sidebar-profile').append(logout);syncApi=installServerActions({store,ui,render,save,graph,snapshot})}
