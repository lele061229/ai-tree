export const platform={enabled:false,csrf:'',user:'',aiReady:false};
export async function request(path,options={}){
 const response=await fetch('/api'+path,{credentials:'same-origin',cache:'no-store',...options,headers:{'Content-Type':'application/json',...(platform.csrf?{'X-CSRF-Token':platform.csrf}:{}),...options.headers}});
 let body;try{body=await response.json()}catch{throw Error('服务器未返回有效响应。')}
 if(response.status===401){location.assign('/login');throw Error('登录已过期，请重新登录。')}
 if(!response.ok){
  const detail=body.detail, text=typeof detail==='string'?detail:(detail&&detail.message)||'请求未通过校验，请核对输入。';
  const error=Error(text);error.code=detail&&detail.code;error.info=detail;throw error;
 }
 return body;
}
export async function bootServer(){
 const response=await fetch('/api/runtime',{cache:'no-store',credentials:'same-origin'});
 if(response.status===404||!response.headers.get('content-type')?.includes('application/json'))return null;
 if(!response.ok)throw Error('服务器暂时不可用，请稍后刷新。');
 const config=await response.json();if(config.mode!=='server')throw Error('运行模式不匹配。');
 platform.enabled=true;platform.aiReady=config.aiReady;
 const session=await request('/session');platform.csrf=session.csrf;platform.user=session.user;
 return request('/state');
}
export const savePreferences=store=>request('/preferences',{method:'PATCH',body:JSON.stringify({target:store.target||'',goal_text:store.goalText||'建立我的个人能力树',navigation_collapsed:!!store.navigationCollapsed,recents:store.recents||[]})});
export const saveTask=(version,node_id,index,done)=>request('/progress',{method:'PUT',body:JSON.stringify({version,node_id,index:Number(index),done})});
