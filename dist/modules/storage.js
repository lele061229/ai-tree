import {createInitial} from './seed.js';
import {validateSnapshot} from './domain.js';
const KEY='knowledge-os-baseline-v2';
export function loadStore(){try{const saved=JSON.parse(localStorage.getItem(KEY));if(saved?.schema===2&&Array.isArray(saved.snapshots)&&saved.snapshots.length){saved.snapshots.forEach(validateSnapshot);return{...saved,tasks:saved.tasks||{},answers:saved.answers||{},target:saved.target==='ai'?'ai':'backend'}}}catch{}return{schema:2,snapshots:[createInitial()],tasks:{},answers:{},target:'backend'}}
export function persist(store){try{localStorage.setItem(KEY,JSON.stringify(store));return true}catch{return false}}
