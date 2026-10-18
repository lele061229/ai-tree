import {$,toast} from './ui.js';
import {request,platform} from './server-api.js';
export function installServerActions({store,ui,render,save,graph,snapshot}){
 if(!platform.enabled)return;
 async function refresh(){Object.assign(store,await request('/state'));ui.version=null;render();graph.fit()}
 async function analyze(id){ui.serverBusy=true;ui.serverError='';ui.serverPlan=null;render();try{const plan=await request('/sources/'+encodeURIComponent(id)+'/analyze',{method:'POST'});if(plan.status==='applied'){toast('这份资料已应用，没有重复创建版本。');return}ui.serverPlan=plan;ui.serverSource=id}catch(e){ui.serverError=e.message}finally{ui.serverBusy=false;render()}}
 document.addEventListener('input',e=>{if(e.target.id==='source-title-input')ui.sourceTitle=e.target.value;if(e.target.id==='source-body-input'){ui.sourceBody=e.target.value;ui.serverSource=null;ui.serverPlan=null}if(e.target.id==='mentor-question')ui.mentorQuestion=e.target.value});
 document.addEventListener('change',async e=>{if(e.target.id!=='source-file')return;const f=e.target.files[0];if(!f)return;if(f.size>200000){toast('请先拆分为较小的文档，单份最多约200 KB。');return}ui.sourceTitle=f.name;ui.sourceBody=await f.text();ui.serverSource=null;ui.serverPlan=null;if(ui.sourceBody.length>50000){ui.sourceBody='';toast('文本超过50000字符，请拆分后再导入。')}render()});
 document.addEventListener('click',async e=>{
  const retry=e.target.closest('[data-reanalyze]');if(retry){await analyze(retry.dataset.reanalyze);return}
  const action=e.target.closest('[data-server-action]')?.dataset.serverAction;if(!action||ui.serverBusy)return;
  if(action==='goal'){store.goalText=$('#goal-text-input').value.trim();store.target=$('#goal-select').value;if(await save())toast('目标已保存到服务器。');render();return}
  if(action==='analyze'){await analyze(ui.serverSource);return}
  if(action==='save-source'){
   if(!ui.sourceTitle?.trim()||!ui.sourceBody||ui.sourceBody.trim().length<10){toast('填写资料名称及至少10个字符的正文。');return}
   ui.serverBusy=true;ui.serverError='';render();try{const s=await request('/sources',{method:'POST',body:JSON.stringify({title:ui.sourceTitle,text:ui.sourceBody})});ui.serverSource=s.id;ui.serverPlan=null;ui.serverSources=await request('/sources');toast(s.duplicate?'这份原文已经保存，已定位到原记录。':'原始资料已保存到服务器。')}catch(e){ui.serverError=e.message}finally{ui.serverBusy=false;render()}return;
  }
  if(action==='apply'){
   if(ui.version!==null){toast('历史路线只读，请返回最新版本。');return}
   ui.serverBusy=true;ui.serverError='';render();try{await request('/imports/'+encodeURIComponent(ui.serverPlan.id)+'/apply',{method:'POST',body:JSON.stringify({acknowledge:true})});ui.serverPlan=null;await refresh();toast('新版本已保存，原始资料和历史继续保留。')}catch(e){ui.serverError=e.message}finally{ui.serverBusy=false;render()}return;
  }
  if(action==='mentor'){
   const question=ui.mentorQuestion?.trim();if(!question){toast('先输入一个具体问题。');return}
   const id=ui.selected;ui.serverBusy=true;ui.serverError='';render();try{ui.mentor[id]=await request('/mentor',{method:'POST',body:JSON.stringify({node_id:id,question})})}catch(e){ui.serverError=e.message}finally{ui.serverBusy=false;render()}
  }
 });
 request('/sources').then(s=>{ui.serverSources=s;if(ui.panel==='sync')render()}).catch(e=>toast(e.message));
}
