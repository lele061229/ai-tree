export const LEVELS=['未接触','讨论过','有实践记录','实践已验证','独立掌握'];
export const STAGES=['讨论','计划','执行','待验证','已验证','已上线'];
export const taskKey=(version,id,index)=>`v${version}:${id}:${index}`;
export const clone=value=>JSON.parse(JSON.stringify(value));
export function ancestors(nodes,id){const byId=new Map(nodes.map(n=>[n.id,n])),found=new Set();function walk(key){if(found.has(key)||!byId.has(key))return;found.add(key);byId.get(key).prereqs.forEach(walk)}walk(id);return found}
export function validateGraph(nodes){const byId=new Map(nodes.map(n=>[n.id,n]));if(byId.size!==nodes.length)throw Error('节点标识重复');const seen=new Set(),active=new Set();function visit(n){if(active.has(n.id))throw Error('前置关系存在循环');if(seen.has(n.id))return;if(!Number.isInteger(n.level)||n.level<0||n.level>4)throw Error('能力状态无效');if(n.kind==='project'&&!STAGES.includes(n.stage))throw Error('项目状态无效');active.add(n.id);for(const id of n.prereqs){if(!byId.has(id))throw Error('前置节点不存在');visit(byId.get(id))}active.delete(n.id);seen.add(n.id)}nodes.forEach(visit);return true}
export function applyBatch(snapshot,batch,{ackConflict=false}={}){
 if(snapshot.applied.includes(batch.id))return{snapshot,changed:false};
 if(batch.conflict&&!ackConflict)throw Error('请先确认冲突处理方式');
 const next=clone(snapshot);
 for(const src of batch.sources){const old=next.sources.find(s=>s.id===src.id);if(old&&JSON.stringify(old)!==JSON.stringify(src))throw Error('原始来源不能被覆盖');if(!old)next.sources.push(clone(src))}
 for(const n of batch.addNodes||[]){if(next.nodes.some(old=>old.id===n.id))throw Error('已有节点必须补充，不能重复新建');next.nodes.push(clone(n))}
 for(const update of batch.updates||[]){const n=next.nodes.find(n=>n.id===update.id);if(!n)throw Error('补充节点不存在');for(const id of update.prereqs||[])if(!n.prereqs.includes(id))n.prereqs.push(id);for(const note of update.notes||[])n.notes.push(clone(note));for(const ref of update.refs||[])if(!n.refs.includes(ref))n.refs.push(ref);}
 if(batch.conflict){next.conflicts.push({...clone(batch.conflict),batchId:batch.id,resolution:'保留当前项目状态，未验证的推断仅作为冲突记录'});}
 validateGraph(next.nodes);next.applied.push(batch.id);next.version=snapshot.version+1;next.title=batch.title;next.time=new Date().toISOString();next.summary=batch.summary;
 return{snapshot:next,changed:true};
}
export function recommendedRoute(snapshot,target){const project=target==='ai'?'assistant':'archive',ids=ancestors(snapshot.nodes,project);return snapshot.nodes.filter(n=>ids.has(n.id)&&n.kind!=='project'&&n.level<3).sort((a,b)=>a.layer-b.layer||a.x-b.x)}
export function validateSnapshot(snapshot){validateGraph(snapshot.nodes);const sources=new Set(snapshot.sources.map(s=>s.id));for(const n of snapshot.nodes)for(const id of n.refs)if(!sources.has(id))throw Error('来源引用不存在');return true}
