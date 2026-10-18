import {$,esc,icon} from './ui.js';
import {ancestors,LEVELS} from './domain.js';
export function createGraph(onSelect){
 const viewport=$('#graph-viewport'),world=$('#graph-world');let scale=.8,x=0,y=0,drag=null;
 function paint(){const w=1400*scale,h=855*scale;x=Math.max(Math.min(60,viewport.clientWidth-w-60),Math.min(viewport.clientWidth-60,x));y=Math.max(Math.min(45,viewport.clientHeight-h-45),Math.min(viewport.clientHeight-45,y));world.style.transform=`translate(${x}px,${y}px) scale(${scale})`;$('#zoom-label').textContent=Math.round(scale*100)+'%'}
 function fit(){if(!viewport.clientWidth)return;scale=Math.min((viewport.clientWidth-28)/1400,(viewport.clientHeight-20)/855,1.1);scale=Math.max(innerWidth<700?.65:.4,scale);x=(viewport.clientWidth-1400*scale)/2;y=(viewport.clientHeight-855*scale)/2;paint()}
 function zoom(amount,cx=viewport.clientWidth/2,cy=viewport.clientHeight/2){const next=Math.max(.4,Math.min(1.7,scale+amount)),r=next/scale;x=cx-(cx-x)*r;y=cy-(cy-y)*r;scale=next;paint()}
 function center(n){const panelWidth=innerWidth>760&&!$('#side-panel').hidden?Math.min(440,viewport.clientWidth*.45):0;x=(viewport.clientWidth-panelWidth)/2-(n.x+87)*scale;y=viewport.clientHeight/2-(n.y+45)*scale;paint()}
 function render(snapshot,ui){
  const path=ui.highlight?ancestors(snapshot.nodes,ui.selected):null,project=ui.project==='all'?null:ancestors(snapshot.nodes,ui.project);
  const match=n=>(!ui.query||[n.title,n.en,n.tag].some(s=>s.toLowerCase().includes(ui.query)))&&(!project||project.has(n.id))&&(ui.level==='all'||(n.kind!=='project'&&String(n.level)===ui.level));
  const byId=new Map(snapshot.nodes.map(n=>[n.id,n]));
  $('#nodes').innerHTML=snapshot.nodes.map(n=>`<button class="node level-${n.level} ${n.kind==='project'?'project-node':''} ${n.id===ui.selected?'selected':''} ${path&&path.has(n.id)?'path-node':''} ${(!match(n)||(path&&!path.has(n.id)))?'dimmed':''}" style="left:${n.x}px;top:${n.y}px" data-testid="node-${n.id}" data-node="${n.id}" aria-label="${esc(n.title)} · ${n.kind==='project'?n.stage:LEVELS[n.level]}" aria-pressed="${ui.selected===n.id}" ${!match(n)?'tabindex="-1" aria-disabled="true"':''}><span class="node-top"><span class="node-icon">${icon(n.icon)}</span><strong>${esc(n.title)}</strong>${n.gap?'<span class="node-gap" title="存在知识缺口">!</span>':''}</span><span class="node-en">${esc(n.en)}</span><span class="node-bottom">${n.kind==='project'?`<span class="project-stage">${n.stage}</span><small>项目状态</small>`:`<span class="level-symbol">${['○','◌','◐','●','●'][n.level]}</span>${LEVELS[n.level]}${n.recommended?'<span class="node-recommended">◇</span>':''}`}</span></button>`).join('');
  $('#connections').innerHTML='<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="4" markerHeight="4" orient="auto"><path d="m1 1 6 3-6 3" fill="none" stroke="#8b9b7b" stroke-width="1.2"/></marker></defs>'+snapshot.nodes.flatMap(n=>n.prereqs.map(pId=>{const p=byId.get(pId);let d;if(p.y===n.y){const forward=p.x<n.x,start=forward?p.x+174:p.x,end=forward?n.x:n.x+174,mid=(start+end)/2;d=`M${start} ${p.y+45} C${mid} ${p.y+45},${mid} ${n.y+45},${end} ${n.y+45}`}else{const a=p.x+87,b=p.y,c=n.x+87,e=n.y+94,m=(b+e)/2;d=`M${a} ${b} C${a} ${m},${c} ${m},${c} ${e}`}return`<path class="edge ${path&&path.has(pId)&&path.has(n.id)?'highlight':''} ${(!match(n)||!match(p)||(path&&(!path.has(n.id)||!path.has(pId))))?'dimmed':''}" d="${d}" marker-end="url(#arrow)"/>`})).join('');
  $('#layer-labels').innerHTML=[['04','项目实践','能力的落点',38],['03','工程实践','从能运行到能交付',258],['02','专业开发','建立可复用的能力',473],['01','基础能力','从这里生长',688]].map(([num,title,sub,top])=>`<div class="layer-label" style="top:${top}px"><span>${num}</span><strong>${title}</strong><small>${sub}</small></div>`).join('');
  $('#node-count').textContent=snapshot.nodes.length+' 个节点';$('#empty-state').hidden=snapshot.nodes.some(match);
 }
 viewport.addEventListener('click',e=>{const n=e.target.closest('[data-node]');if(n&&n.getAttribute('aria-disabled')!=='true')onSelect(n.dataset.node)});
 viewport.addEventListener('pointerdown',e=>{if(e.target.closest('button')||e.button!==0)return;drag={cx:e.clientX,cy:e.clientY,x,y};viewport.setPointerCapture(e.pointerId);viewport.classList.add('dragging')});
 viewport.addEventListener('pointermove',e=>{if(!drag)return;x=drag.x+e.clientX-drag.cx;y=drag.y+e.clientY-drag.cy;paint()});
 for(const type of ['pointerup','pointercancel'])viewport.addEventListener(type,()=>{drag=null;viewport.classList.remove('dragging')});
 viewport.addEventListener('wheel',e=>{if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();const r=viewport.getBoundingClientRect();zoom(e.deltaY<0?.05:-.05,e.clientX-r.left,e.clientY-r.top)},{passive:false});
 viewport.addEventListener('keydown',e=>{if(e.key==='Home'){e.preventDefault();fit()}if(['+','=','-'].includes(e.key)){e.preventDefault();zoom(e.key==='-'?-.1:.1)}});
 new ResizeObserver(fit).observe(viewport);return{render,fit,zoom,center};
}
